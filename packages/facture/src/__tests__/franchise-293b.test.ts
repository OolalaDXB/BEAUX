import { describe, it, expect } from 'vitest';
import {
  buildFacturXCII, facturxMissingFields, FacturXError,
  FRANCHISE_REGIME_CODE, FRANCHISE_LEGAL_MENTION, type FacturXInvoiceInput,
} from '../facturx-xml';
import { parseFacturXCII } from '../facturx-parse';

/* Franchise en base de TVA (art. 293 B du CGI): the regime of most
   micro-entrepreneurs — no VAT charged, a mandatory mention, and often no VAT
   number. EN 16931 category E, exemption code VATEX-FR-FRANCHISE; BR-E-02 then
   needs BT-31, BT-32 or BT-63 — here BT-32 (taxRegistrationId, scheme FC) when
   there is no VAT number. The fixture: a coach selling ten sessions to a person. */
function franchiseInvoice(over: Partial<FacturXInvoiceInput> = {}): FacturXInvoiceInput {
  return {
    invoiceNumber: 'F2026-0042',
    issueDate: '2026-09-30',
    currency: 'EUR',
    seller: {
      name: 'Camille Exemple EI', siren: '912345678', vatNumber: null, taxRegistrationId: '912345678',
      addressLine1: '4 rue du Stade', postalCode: '33000', city: 'Bordeaux', countryCode: 'FR',
    },
    buyer: { name: 'Client Particulier', countryCode: 'FR', addressLine1: '1 cours Victor Hugo', postalCode: '33000', city: 'Bordeaux' },
    lines: [{ description: 'Forfait 10 séances de coaching', quantity: 1, unitPrice: 450, totalPrice: 450, taxRate: 0, lineType: 'fee' }],
    subtotal: 450, taxAmount: 0, total: 450,
    regime: { exempt: true, regimeCode: FRANCHISE_REGIME_CODE, legalMention: null },
    vatOnDebits: false,
    transactionNature: 'services',
    profile: 'en16931',
    ...over,
  } as FacturXInvoiceInput;
}

const taxBlocks = (xml: string) => [...xml.matchAll(/<ram:ApplicableTradeTax>(.*?)<\/ram:ApplicableTradeTax>/g)].map((m) => m[1]);

describe('VAT franchise (art. 293 B CGI)', () => {
  it('is category E, 0 %, with the VATEX franchise code and the legal mention', () => {
    const xml = buildFacturXCII(franchiseInvoice());
    const header = taxBlocks(xml).filter((b) => b.includes('<ram:BasisAmount>'));
    expect(header).toHaveLength(1);
    expect(header[0]).toContain('<ram:CategoryCode>E</ram:CategoryCode>');
    expect(header[0]).toContain('<ram:ExemptionReasonCode>VATEX-FR-FRANCHISE</ram:ExemptionReasonCode>');
    expect(header[0]).toContain(`<ram:ExemptionReason>${FRANCHISE_LEGAL_MENTION}</ram:ExemptionReason>`);
    expect(header[0]).toContain('<ram:CalculatedAmount>0.00</ram:CalculatedAmount>');
    expect(header[0]).toContain('<ram:RateApplicablePercent>0.00</ram:RateApplicablePercent>');
    expect(xml).toContain(`<ram:Content>${FRANCHISE_LEGAL_MENTION}</ram:Content>`);   // the mention on the invoice, in BG-1
    expect(xml).not.toMatch(/<ram:CategoryCode>S<\/ram:CategoryCode>/);                 // no line slips back into S
  });

  it('keeps a mention the seller wrote themselves', () => {
    const own = 'TVA non applicable, article 293 B du Code général des impôts';
    const xml = buildFacturXCII(franchiseInvoice({ regime: { exempt: true, regimeCode: FRANCHISE_REGIME_CODE, legalMention: own } }));
    expect(xml).toContain(`<ram:ExemptionReason>${own}</ram:ExemptionReason>`);
    expect(xml).not.toContain(FRANCHISE_LEGAL_MENTION);
  });

  it('needs no VAT number, but then needs BT-32, emitted with scheme FC', () => {
    expect(facturxMissingFields(franchiseInvoice())).toEqual([]);
    const xml = buildFacturXCII(franchiseInvoice());
    expect(xml).toContain('<ram:ID schemeID="FC">912345678</ram:ID>');
    expect(xml).not.toContain('schemeID="VA"');
    const none = franchiseInvoice({ seller: { ...franchiseInvoice().seller, taxRegistrationId: null } });
    expect(facturxMissingFields(none)).toContain('seller_tax_registration');
    expect(() => buildFacturXCII(none)).toThrow(FacturXError);
  });

  it('a franchise seller who does have a VAT number (intra-EU purchases) uses it', () => {
    const inv = franchiseInvoice({ seller: { ...franchiseInvoice().seller, vatNumber: 'FR45912345678', taxRegistrationId: null } });
    expect(facturxMissingFields(inv)).toEqual([]);
    expect(buildFacturXCII(inv)).toContain('<ram:ID schemeID="VA">FR45912345678</ram:ID>');
  });

  it('refuses an invoice that charges VAT under the franchise', () => {
    expect(() => buildFacturXCII(franchiseInvoice({ taxAmount: 90, total: 540 }))).toThrow(/tax_amount/);
  });

  it('a rate typed by mistake on a line does not create a second breakdown', () => {
    const inv = franchiseInvoice({
      lines: [
        { description: 'Séance', quantity: 1, unitPrice: 50, totalPrice: 50, taxRate: 0.2, lineType: 'fee' },
        { description: 'Forfait', quantity: 1, unitPrice: 400, totalPrice: 400, taxRate: 0, lineType: 'fee' },
      ],
    });
    const header = taxBlocks(buildFacturXCII(inv)).filter((b) => b.includes('<ram:BasisAmount>'));
    expect(header).toHaveLength(1);
    expect(header[0]).toContain('<ram:BasisAmount>450.00</ram:BasisAmount>');
  });

  it('reads back with no tax', () => {
    const p = parseFacturXCII(buildFacturXCII(franchiseInvoice()));
    expect(p.subtotal).toBe(450);
    expect(p.taxTotal).toBe(0);
    expect(p.total).toBe(450);
  });

  it('outside the franchise, the VAT number is still required', () => {
    const std = franchiseInvoice({ regime: { exempt: false, regimeCode: null, legalMention: null } });
    expect(facturxMissingFields(std)).toContain('seller_vat_number');
  });
});
