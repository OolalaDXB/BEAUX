import { describe, it, expect } from 'vitest';
import {
  B2BrouterEReporting, getConfiguredB2BrouterEReporting, mapB2BrouterTaxReportState, B2B_PAYMENT_METHOD, B2B_VAT_REGIME,
} from '../b2brouter-ereporting';
import type { B2BrouterConfig } from '../b2brouter';

/* A fake B2Brouter: records every request, keeps the payments of each
   invoice, answers like the OpenAPI v2026-06-26 says. No network. */
function fakeB2B() {
  const calls: { method: string; url: string; headers: Headers; body?: unknown }[] = [];
  const payments: Record<number, { id: number; invoice_id: number; amount: number; reference: string | null; date?: string; payment_method?: number }[]> = {};
  let next = 900;
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, headers: new Headers(init.headers), body });
    const u = new URL(url);
    if (method === 'GET' && u.pathname.endsWith('/payments')) {
      const inv = Number(u.searchParams.get('invoice_id'));
      return new Response(JSON.stringify({ payments: payments[inv] ?? [] }), { status: 200 });
    }
    if (method === 'POST' && u.pathname.endsWith('/payments')) {
      const p = body.payment;
      if (p.invoice_id === 404) return new Response('{"errors":["Not found"]}', { status: 404 });
      const rec = { id: next++, ...p };
      (payments[p.invoice_id] ??= []).push(rec);
      return new Response(JSON.stringify({ payment: { ...rec, currency: 'EUR' } }), { status: 201 });
    }
    if (method === 'GET' && u.pathname.endsWith('/tax_reports')) {
      return new Response(JSON.stringify({ tax_reports: [
        { id: 1, state: 'registered', ledger_id: 7 }, { id: 2, state: 'processing' }, { id: 3, state: 'registered_with_errors' }, { id: 4, state: 'refused' },
      ] }), { status: 200 });
    }
    if (method === 'GET' && u.pathname.startsWith('/ledgers/')) {
      return new Response(JSON.stringify({ ledger: { id: 7, type: 'F10', state: 'registered' } }), { status: 200 });
    }
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
  return { fetchFn, calls, payments };
}

const cfg: B2BrouterConfig = { baseUrl: 'https://api.example.test', apiKey: 'test_dummy', accountId: '42', apiVersion: '2026-06-26', sandboxKey: true, sendAfterImport: true };

describe('B2Brouter e-reporting — payments', () => {
  it('records a payment on the invoice, with the documented body and headers', async () => {
    const f = fakeB2B();
    const c = new B2BrouterEReporting(cfg, f.fetchFn);
    const r = await c.recordPayment({ invoiceId: 12345, reference: 'pay_abc', amount: 450, date: '2026-10-05', method: 'credit_card', methodText: 'Stripe' });
    expect(r.created).toBe(true);
    const post = f.calls.find((x) => x.method === 'POST')!;
    expect(post.url).toBe('https://api.example.test/accounts/42/payments');
    expect(post.body).toEqual({ payment: { invoice_id: 12345, amount: 450, date: '2026-10-05', payment_method: 54, payment_method_text: 'Stripe', reference: 'pay_abc' } });
    expect(post.headers.get('X-B2B-API-Key')).toBe('test_dummy');
    expect(post.headers.get('X-B2B-API-Version')).toBe('2026-06-26');
  });

  it('never declares the same receipt twice: same reference → no second POST', async () => {
    const f = fakeB2B();
    const c = new B2BrouterEReporting(cfg, f.fetchFn);
    await c.recordPayment({ invoiceId: 1, reference: 'pay_1', amount: 60, date: '2026-10-05', method: 'cash' });
    const again = await c.recordPayment({ invoiceId: 1, reference: 'pay_1', amount: 60, date: '2026-10-05', method: 'cash' });
    expect(again.created).toBe(false);
    expect(f.calls.filter((x) => x.method === 'POST')).toHaveLength(1);
    expect(f.payments[1]).toHaveLength(1);
    // a different receipt on the same invoice is a second payment
    await c.recordPayment({ invoiceId: 1, reference: 'pay_2', amount: 40, date: '2026-10-06', method: 'cash' });
    expect(f.payments[1]).toHaveLength(2);
  });

  it('refuses what it cannot declare, before any call', async () => {
    const f = fakeB2B();
    const c = new B2BrouterEReporting(cfg, f.fetchFn);
    await expect(c.recordPayment({ invoiceId: 1, reference: '', amount: 10, date: '2026-10-05', method: 'cash' })).rejects.toThrow(/référence/);
    await expect(c.recordPayment({ invoiceId: 1, reference: 'x', amount: 0, date: '2026-10-05', method: 'cash' })).rejects.toThrow(/montant/);
    await expect(c.recordPayment({ invoiceId: 1, reference: 'x', amount: 10, date: '05/10/2026', method: 'cash' })).rejects.toThrow(/date/);
    expect(f.calls).toHaveLength(0);
  });

  it('an API error says the operation and the status, never the key', async () => {
    const f = fakeB2B();
    const c = new B2BrouterEReporting(cfg, f.fetchFn);
    const err = await c.recordPayment({ invoiceId: 404, reference: 'p', amount: 10, date: '2026-10-05', method: 'cash' }).catch((e) => e);
    expect(String(err.message)).toMatch(/POST payments : HTTP 404/);
    expect(String(err.message)).not.toContain('test_dummy');
  });
});

describe('B2Brouter e-reporting — following the reports', () => {
  it('maps every documented state to an internal status', () => {
    expect(mapB2BrouterTaxReportState('registered')).toEqual({ status: 'ACCEPTED', warnings: false });
    expect(mapB2BrouterTaxReportState('registered_with_errors')).toEqual({ status: 'ACCEPTED', warnings: true });
    for (const s of ['error', 'refused', 'invalid', 'annulled']) expect(mapB2BrouterTaxReportState(s).status).toBe('REJECTED');
    expect(mapB2BrouterTaxReportState('new').status).toBe('GENERATED');
    for (const s of ['processing', 'signed', 'sending', 'sent', 'acknowledged', 'deposited', 'clearing', 'annullating']) {
      expect(mapB2BrouterTaxReportState(s).status).toBe('SUBMITTED');
    }
  });
  it('reads the reports of an invoice and a ledger', async () => {
    const f = fakeB2B();
    const c = new B2BrouterEReporting(cfg, f.fetchFn);
    const reps = await c.taxReportsForInvoice(12345);
    expect(reps.map((r) => r.internalStatus)).toEqual(['ACCEPTED', 'SUBMITTED', 'ACCEPTED', 'REJECTED']);
    expect(reps[2].warnings).toBe(true);
    expect(f.calls[0].url).toBe('https://api.example.test/accounts/42/tax_reports?invoice_id=12345');
    expect((await c.ledger(7)).state).toBe('registered');
  });
  it('our VAT regimes map to B2Brouter\'s vat_regime values', () => {
    expect(B2B_VAT_REGIME).toEqual({ reel_normal_mensuel: 'reel_normal_mensuel', reel_normal_trimestriel: 'reel_normal_trimestriel', reel_simplifie: 'simplifie', franchise: 'franchise_en_base' });
  });
  it('payment method codes are B2Brouter\'s own table', () => {
    expect(B2B_PAYMENT_METHOD).toMatchObject({ cash: 1, bank_transfer: 4, bank_card: 19, credit_card: 54, sepa_transfer: 58 });
  });
});

describe('B2Brouter e-reporting — configuration', () => {
  const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
  it('inert without key or account, and with a live key unless explicitly allowed', () => {
    expect(getConfiguredB2BrouterEReporting(env({})).client).toBeNull();
    expect(getConfiguredB2BrouterEReporting(env({ B2BROUTER_API_KEY: 'live_x', B2BROUTER_ACCOUNT_ID: '1' })).client).toBeNull();
    expect(getConfiguredB2BrouterEReporting(env({ B2BROUTER_API_KEY: 'live_x', B2BROUTER_ACCOUNT_ID: '1', B2BROUTER_ALLOW_LIVE: 'true' })).client).not.toBeNull();
    expect(getConfiguredB2BrouterEReporting(env({ B2BROUTER_API_KEY: 'test_x', B2BROUTER_ACCOUNT_ID: '1' })).client).not.toBeNull();
  });
});
