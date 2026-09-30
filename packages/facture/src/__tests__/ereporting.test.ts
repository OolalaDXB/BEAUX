import { describe, it, expect } from 'vitest';
import {
  parisDay, reportingPeriod, paymentReportingRequired, aggregateSales, aggregatePayments,
  buildEReport, ereportIdempotencyKey, reconcileAggregates, EReportingError,
  type EReportedSale, type EReportedPayment,
} from '../ereporting';

/* A coach in réel simplifié sells session packages to individuals (TPS1, 20 %)
   and a book now and then (TLB1, 5.5 %); a franchise micro-entrepreneur sells
   the same sessions with no VAT. */
const sale = (id: string, at: string, lines: EReportedSale['lines'], category: EReportedSale['category'] = 'TPS1'): EReportedSale =>
  ({ id, occurredAt: at, currency: 'EUR', category, lines });
const pay = (id: string, at: string, amount: number, saleCategory: EReportedPayment['saleCategory'] = 'TPS1', vatRate = 0.2): EReportedPayment =>
  ({ id, receivedAt: at, currency: 'EUR', saleCategory, amounts: [{ vatRate, amount }] });

describe('days are Paris days', () => {
  it('23:30 UTC on 30 Sept is already 1 Oct in Paris (summer time)', () => {
    expect(parisDay('2026-09-30T23:30:00Z')).toBe('2026-10-01');
    expect(parisDay('2026-09-30T21:59:59Z')).toBe('2026-09-30');
  });
  it('and in winter the offset is one hour', () => {
    expect(parisDay('2026-12-31T23:30:00Z')).toBe('2027-01-01');
    expect(parisDay('2026-12-31T22:59:00Z')).toBe('2026-12-31');
  });
});

describe('periods follow the VAT regime', () => {
  it('réel normal mensuel: décades, the third one to the end of the month', () => {
    expect(reportingPeriod('reel_normal_mensuel', '2026-02-10', 'transactions')).toEqual({ id: '2026-02-D1', start: '2026-02-01', end: '2026-02-10' });
    expect(reportingPeriod('reel_normal_mensuel', '2026-02-11', 'transactions')!.id).toBe('2026-02-D2');
    expect(reportingPeriod('reel_normal_mensuel', '2026-02-28', 'transactions')).toEqual({ id: '2026-02-D3', start: '2026-02-21', end: '2026-02-28' });
    expect(reportingPeriod('reel_normal_mensuel', '2028-02-29', 'transactions')!.end).toBe('2028-02-29');
  });
  it('réel normal trimestriel and réel simplifié: the month', () => {
    for (const r of ['reel_normal_trimestriel', 'reel_simplifie'] as const) {
      expect(reportingPeriod(r, '2026-10-17', 'transactions')).toEqual({ id: '2026-10', start: '2026-10-01', end: '2026-10-31' });
    }
  });
  it('franchise: two months, January–February first', () => {
    expect(reportingPeriod('franchise', '2026-01-05', 'transactions')).toEqual({ id: '2026-B1', start: '2026-01-01', end: '2026-02-28' });
    expect(reportingPeriod('franchise', '2026-10-17', 'transactions')).toEqual({ id: '2026-B5', start: '2026-09-01', end: '2026-10-31' });
    expect(reportingPeriod('franchise', '2026-12-31', 'transactions')!.id).toBe('2026-B6');
  });
  it('payments are monthly, and not due under the franchise', () => {
    expect(reportingPeriod('reel_normal_mensuel', '2026-10-03', 'payments')!.id).toBe('2026-10');
    expect(paymentReportingRequired('franchise')).toBe(false);
    expect(reportingPeriod('franchise', '2026-10-03', 'payments')).toBeNull();
  });
});

describe('flux 10.3 — daily B2C transaction aggregates', () => {
  it('one line per day, currency, category and rate, with the number of sales', () => {
    const agg = aggregateSales([
      sale('F1', '2026-10-05T08:00:00Z', [{ vatRate: 0.2, taxExclusive: 375, tax: 75 }]),
      sale('F2', '2026-10-05T17:00:00Z', [{ vatRate: 0.2, taxExclusive: 50, tax: 10 }]),
      sale('F3', '2026-10-05T12:00:00Z', [{ vatRate: 0.055, taxExclusive: 20, tax: 1.1 }], 'TLB1'),
      sale('F4', '2026-10-06T09:00:00Z', [{ vatRate: 0.2, taxExclusive: 50, tax: 10 }]),
    ], 'reel_simplifie');
    expect(agg).toEqual([
      { day: '2026-10-05', currency: 'EUR', category: 'TLB1', vatRate: 0.055, count: 1, taxExclusive: 20, tax: 1.1 },
      { day: '2026-10-05', currency: 'EUR', category: 'TPS1', vatRate: 0.2, count: 2, taxExclusive: 425, tax: 85 },
      { day: '2026-10-06', currency: 'EUR', category: 'TPS1', vatRate: 0.2, count: 1, taxExclusive: 50, tax: 10 },
    ]);
  });
  it('no cent drift over many small sales', () => {
    const many = Array.from({ length: 300 }, (_, i) => sale(`T${i}`, '2026-10-05T10:00:00Z', [{ vatRate: 0.2, taxExclusive: 0.1, tax: 0.02 }]));
    const [a] = aggregateSales(many, 'reel_simplifie');
    expect(a.taxExclusive).toBe(30);
    expect(a.tax).toBe(6);
    expect(a.count).toBe(300);
  });
  it('refuses a sale twice, a tax that does not follow base × rate, and VAT under the franchise', () => {
    const f = sale('F1', '2026-10-05T08:00:00Z', [{ vatRate: 0.2, taxExclusive: 100, tax: 20 }]);
    expect(() => aggregateSales([f, f], 'reel_simplifie')).toThrow(EReportingError);
    expect(() => aggregateSales([sale('F2', '2026-10-05T08:00:00Z', [{ vatRate: 0.2, taxExclusive: 100, tax: 19 }])], 'reel_simplifie')).toThrow(/base × taux/);
    expect(() => aggregateSales([f], 'franchise')).toThrow(/franchise/);
    expect(aggregateSales([sale('F3', '2026-10-05T08:00:00Z', [{ vatRate: 0, taxExclusive: 450, tax: 0 }])], 'franchise')[0].taxExclusive).toBe(450);
  });
});

describe('flux 10.4 — daily B2C payments, services only', () => {
  it('counts only services; goods have no payment data', () => {
    const agg = aggregatePayments([
      pay('P1', '2026-10-05T08:00:00Z', 450),
      pay('P2', '2026-10-05T19:00:00Z', 60),
      pay('P3', '2026-10-05T19:00:00Z', 21.1, 'TLB1', 0.055),
    ]);
    expect(agg).toEqual([{ day: '2026-10-05', currency: 'EUR', vatRate: 0.2, count: 2, amount: 510 }]);
  });
});

describe('a period report', () => {
  const sales = [
    sale('F1', '2026-10-05T08:00:00Z', [{ vatRate: 0.2, taxExclusive: 375, tax: 75 }]),
    sale('F2', '2026-10-12T08:00:00Z', [{ vatRate: 0.2, taxExclusive: 50, tax: 10 }]),
  ];
  const period = reportingPeriod('reel_simplifie', '2026-10-05', 'transactions')!;

  it('same content, same hash, same idempotency key — whatever the input order', async () => {
    const a = await buildEReport({ sellerId: 's1', regime: 'reel_simplifie', flux: '10.3', period, sales });
    const b = await buildEReport({ sellerId: 's1', regime: 'reel_simplifie', flux: '10.3', period, sales: [...sales].reverse() });
    expect(a.contentHash).toBe(b.contentHash);
    expect(ereportIdempotencyKey(a)).toBe(`ereport:s1:10.3:2026-10:${a.contentHash}`);
    expect(a.itemIds).toEqual(['F1', 'F2']);
  });
  it('a correction is a different report', async () => {
    const a = await buildEReport({ sellerId: 's1', regime: 'reel_simplifie', flux: '10.3', period, sales });
    const b = await buildEReport({ sellerId: 's1', regime: 'reel_simplifie', flux: '10.3', period, sales: sales.slice(0, 1) });
    expect(ereportIdempotencyKey(a)).not.toBe(ereportIdempotencyKey(b));
  });
  it('refuses an operation outside the period instead of moving it', async () => {
    const d1 = reportingPeriod('reel_normal_mensuel', '2026-10-05', 'transactions')!;
    await expect(buildEReport({ sellerId: 's1', regime: 'reel_normal_mensuel', flux: '10.3', period: d1, sales })).rejects.toThrow(/hors période 2026-10-D1/);
  });
  it('refuses a payment report under the franchise', async () => {
    const p = reportingPeriod('reel_simplifie', '2026-10-05', 'payments')!;
    await expect(buildEReport({ sellerId: 's1', regime: 'franchise', flux: '10.4', period: p, payments: [] })).rejects.toThrow(/franchise/);
  });
});

describe('reconciling with what the platform computed', () => {
  it('agreement is an empty list; each difference is one readable line', () => {
    const ours = aggregateSales([sale('F1', '2026-10-05T08:00:00Z', [{ vatRate: 0.2, taxExclusive: 375, tax: 75 }])], 'reel_simplifie');
    expect(reconcileAggregates(ours, ours)).toEqual([]);
    const theirs = [{ ...ours[0], tax: 74.99 }];
    expect(reconcileAggregates(ours, theirs)).toEqual([
      '2026-10-05|EUR|TPS1|0.2 : attendu {"count":1,"taxExclusive":375,"tax":75}, reçu {"count":1,"taxExclusive":375,"tax":74.99}',
    ]);
    expect(reconcileAggregates(ours, [])).toHaveLength(1);
    expect(reconcileAggregates([], ours)[0]).toMatch(/non déclaré ici/);
  });
});
