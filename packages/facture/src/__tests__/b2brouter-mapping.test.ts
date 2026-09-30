import { describe, it, expect } from 'vitest';
import {
  B2BROUTER_STATE_CODES,
  mapB2BrouterState,
  sniffIncomingFormat,
} from '../b2brouter-mapping';
import { canTransition, type EInvoicingStatus } from '../provider';

describe('b2brouter — mapping des états du cycle de vie (mandat provider #2)', () => {
  it('chaque état du référentiel B2Brouter a un statut interne', () => {
    for (const code of B2BROUTER_STATE_CODES) {
      expect(mapB2BrouterState(code), code).not.toBeNull();
    }
  });

  it.each([
    ['new', 'SUBMITTED'],
    ['sending', 'SUBMITTED'],
    ['sent', 'SUBMITTED'],
    ['registered', 'DELIVERED'],
    ['received', 'DELIVERED'],
    ['downloaded', 'DELIVERED'],
    ['read', 'DELIVERED'],
    ['annotated', 'DELIVERED'], // litige (CDV 207) = non terminal, le brut est conservé
    ['accepted', 'ACCEPTED'],
    ['allegedly_paid', 'ACCEPTED'],
    ['paid', 'ACCEPTED'],
    ['closed', 'ACCEPTED'],
    ['refused', 'REJECTED'],
    ['error', 'REJECTED'], // validation/transmission échouée — correct-and-resend
    ['invalid', 'REJECTED'],
  ])('%s → %s', (code, expected) => {
    expect(mapB2BrouterState(code)).toBe(expected);
  });

  it('adversarial : état inconnu → null, jamais de transition inventée', () => {
    expect(mapB2BrouterState('BANANA')).toBeNull();
    expect(mapB2BrouterState('')).toBeNull();
    // La casse compte : le référentiel B2Brouter est en minuscules.
    expect(mapB2BrouterState('Accepted')).toBeNull();
  });

  it('cohérence : depuis SUBMITTED, tout état mappé est atteignable ou no-op', () => {
    for (const code of B2BROUTER_STATE_CODES) {
      const to = mapB2BrouterState(code) as EInvoicingStatus;
      const legal = to === 'SUBMITTED' || canTransition('SUBMITTED', to);
      expect(legal, `${code} → ${to}`).toBe(true);
    }
  });

  it('un litige (annotated→DELIVERED) laisse accepted et refused atteignables', () => {
    const annotated = mapB2BrouterState('annotated') as EInvoicingStatus;
    expect(canTransition(annotated, mapB2BrouterState('accepted') as EInvoicingStatus)).toBe(true);
    expect(canTransition(annotated, mapB2BrouterState('refused') as EInvoicingStatus)).toBe(true);
  });
});

describe('b2brouter — détection de format des entrants (octets)', () => {
  const utf8 = (s: string) => new TextEncoder().encode(s);

  it('PDF (%PDF) → facturx (l’extraction tranchera)', () => {
    expect(sniffIncomingFormat(utf8('%PDF-1.7 …'))).toBe('facturx');
  });

  it('CII → cii-xml (avec ou sans préfixe de namespace)', () => {
    expect(
      sniffIncomingFormat(utf8('<?xml version="1.0"?><rsm:CrossIndustryInvoice xmlns:rsm="…">')),
    ).toBe('cii-xml');
    expect(sniffIncomingFormat(utf8('<CrossIndustryInvoice>'))).toBe('cii-xml');
  });

  it('UBL Invoice / CreditNote → ubl', () => {
    expect(
      sniffIncomingFormat(
        utf8('<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">'),
      ),
    ).toBe('ubl');
    expect(sniffIncomingFormat(utf8('<CreditNote xmlns="urn:x">'))).toBe('ubl');
  });

  it('adversarial : binaire quelconque ou texte plat → unknown, jamais d’exception', () => {
    expect(sniffIncomingFormat(new Uint8Array([0x00, 0xff, 0x13, 0x37]))).toBe('unknown');
    expect(sniffIncomingFormat(utf8('bonjour, ceci n’est pas une facture'))).toBe('unknown');
    expect(sniffIncomingFormat(new Uint8Array(0))).toBe('unknown');
  });
});
