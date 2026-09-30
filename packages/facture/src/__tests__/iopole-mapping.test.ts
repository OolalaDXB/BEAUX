import { describe, it, expect } from 'vitest';
import { IOPOLE_STATUS_CODES, mapIopoleStatus, mapIopoleFormat } from '../iopole-mapping';
import { canTransition, type EInvoicingStatus } from '../provider';

describe('iopole — mapping des statuts du cycle de vie (section G)', () => {
  it('chaque code du référentiel iopole a un statut interne', () => {
    for (const code of IOPOLE_STATUS_CODES) {
      expect(mapIopoleStatus(code), code).not.toBeNull();
    }
  });

  it.each([
    ['SUBMITTED', 'SUBMITTED'],
    ['ISSUED', 'SUBMITTED'],
    ['RECEIVED', 'DELIVERED'],
    ['MADE_AVAILABLE', 'DELIVERED'],
    ['IN_HAND', 'DELIVERED'],
    ['DISPUTED', 'DELIVERED'], // litige = non terminal, le brut est conservé
    ['SUSPENDED', 'DELIVERED'],
    ['APPROVED', 'ACCEPTED'],
    ['PARTIALLY_APPROVED', 'ACCEPTED'],
    ['COMPLETED', 'ACCEPTED'],
    ['PAYMENT_SENT', 'ACCEPTED'],
    ['PAYMENT_RECEIVED', 'ACCEPTED'],
    ['REFUSED', 'REJECTED'],
    ['REJECTED', 'REJECTED'],
    ['UNACCEPTABLE', 'REJECTED'],
  ])('%s → %s', (code, expected) => {
    expect(mapIopoleStatus(code)).toBe(expected);
  });

  it('adversarial : code inconnu → null, jamais de transition inventée', () => {
    expect(mapIopoleStatus('BANANA')).toBeNull();
    expect(mapIopoleStatus('')).toBeNull();
  });

  it('cohérence : depuis SUBMITTED, tout statut mappé est atteignable ou no-op', () => {
    // Un cycle nominal iopole ne doit jamais produire une transition que
    // notre modèle refuse : depuis SUBMITTED tous les mappings sont légaux.
    for (const code of IOPOLE_STATUS_CODES) {
      const to = mapIopoleStatus(code) as EInvoicingStatus;
      const legal = to === 'SUBMITTED' || canTransition('SUBMITTED', to);
      expect(legal, `${code} → ${to}`).toBe(true);
    }
  });

  it('un litige (DISPUTED→DELIVERED) laisse APPROVED et REFUSED atteignables', () => {
    const disputed = mapIopoleStatus('DISPUTED') as EInvoicingStatus;
    expect(canTransition(disputed, mapIopoleStatus('APPROVED') as EInvoicingStatus)).toBe(true);
    expect(canTransition(disputed, mapIopoleStatus('REFUSED') as EInvoicingStatus)).toBe(true);
  });
});

describe('iopole — mapping des formats entrants (section F)', () => {
  it.each([
    ['FACTURX', 'facturx'],
    // Constaté en sandbox : l'API réelle rend « FacturX » (CamelCase).
    ['FacturX', 'facturx'],
    ['CII', 'cii-xml'],
    ['Cii', 'cii-xml'],
    ['UBL', 'ubl'],
    ['Ubl', 'ubl'],
    ['EDIFACT', 'unknown'],
    ['', 'unknown'],
  ])('%s → %s', (raw, expected) => {
    expect(mapIopoleFormat(raw)).toBe(expected);
  });
});
