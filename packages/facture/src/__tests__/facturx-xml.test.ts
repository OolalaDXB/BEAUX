import { describe, it, expect } from 'vitest';
import {
  buildFacturXCII,
  facturxMissingFields,
  sirenFromSiret,
  FacturXError,
  FACTURX_PROFILE_URN,
  type FacturXInvoiceInput,
  type FacturXLine,
} from '../facturx-xml';

// ============================================================================
// Fixtures métier (les 5 cas du sprint, analysis/SPRINT-FACTURX.md J2)
// ============================================================================

const SELLER = {
  name: 'Outrenational SARL',
  siren: '901234567',
  vatNumber: 'FR32901234567',
  addressLine1: '12 rue des Disquaires',
  postalCode: '75011',
  city: 'Paris',
  countryCode: 'FR',
  iban: 'FR76 3000 4000 0500 0001 2345 678',
  bic: 'BNPAFRPP',
  paymentTermsText: 'Paiement à 30 jours',
};

function productLine(overrides: Partial<FacturXLine> = {}): FacturXLine {
  return {
    description: 'LP — pressage 180g',
    quantity: 2,
    unitPrice: 25,
    totalPrice: 50,
    taxRate: 0.2,
    lineType: 'product',
    ...overrides,
  };
}

/** FR B2C standard : 2 LP à 25 €, TVA 20 %. */
function fixtureFrB2C(): FacturXInvoiceInput {
  return {
    invoiceNumber: 'FC2026042',
    issueDate: '2026-09-04',
    dueDate: '2026-10-04',
    currency: 'EUR',
    orderNumber: 'CMD-1042',
    seller: { ...SELLER },
    buyer: {
      name: 'Client Particulier',
      addressLine1: '3 avenue de la République',
      postalCode: '69001',
      city: 'Lyon',
      countryCode: 'FR',
    },
    lines: [productLine()],
    subtotal: 50,
    taxAmount: 10,
    total: 60,
    regime: { exempt: false, regimeCode: null, legalMention: null },
    vatOnDebits: false,
    transactionNature: 'goods',
    profile: 'en16931',
  };
}

/** FR B2B : société avec SIREN/TVA, TVA 20 %. */
function fixtureFrB2B(): FacturXInvoiceInput {
  const f = fixtureFrB2C();
  f.buyer = {
    name: 'Disques & Cie SAS',
    siren: '842567123',
    vatNumber: 'FR11842567123',
    addressLine1: '8 quai de la Loire',
    postalCode: '44000',
    city: 'Nantes',
    countryCode: 'FR',
  };
  return f;
}

/** Intracom B2B (262 ter I) : catégorie K, taux 0, mention légale. */
function fixtureIntracom(): FacturXInvoiceInput {
  const f = fixtureFrB2C();
  f.buyer = {
    name: 'Plattenladen GmbH',
    vatNumber: 'DE129273398',
    addressLine1: 'Torstraße 99',
    postalCode: '10119',
    city: 'Berlin',
    countryCode: 'DE',
  };
  f.lines = [productLine({ taxRate: 0 })];
  f.subtotal = 50;
  f.taxAmount = 0;
  f.total = 50;
  f.regime = {
    exempt: true,
    regimeCode: '262 ter I',
    legalMention:
      'Exonération de TVA — article 262 ter, I du CGI (livraison intracommunautaire). Autoliquidation par le preneur.',
  };
  return f;
}

/** Export hors UE (262 I) : catégorie G, taux 0. */
function fixtureExport(): FacturXInvoiceInput {
  const f = fixtureFrB2C();
  f.buyer = {
    name: 'Brooklyn Records LLC',
    addressLine1: '55 Water St',
    postalCode: '11201',
    city: 'New York',
    countryCode: 'US',
  };
  f.lines = [productLine({ taxRate: 0 })];
  f.subtotal = 50;
  f.taxAmount = 0;
  f.total = 50;
  f.regime = {
    exempt: true,
    regimeCode: '262 I',
    legalMention: 'Exonération de TVA — article 262, I du CGI (exportation hors Union européenne).',
  };
  return f;
}

/** Remise + port : lignes shipping (charge) et discount (allowance). */
function fixtureRemisePort(): FacturXInvoiceInput {
  const f = fixtureFrB2C();
  f.lines = [
    productLine(),
    {
      description: 'Frais de port',
      quantity: 1,
      unitPrice: 8,
      totalPrice: 8,
      taxRate: 0.2,
      lineType: 'shipping',
    },
    {
      description: 'Remise',
      quantity: 1,
      unitPrice: -5,
      totalPrice: -5,
      taxRate: 0.2,
      lineType: 'discount',
    },
  ];
  f.subtotal = 53; // 50 + 8 - 5
  f.taxAmount = 10.6;
  f.total = 63.6;
  return f;
}

// ============================================================================
// Invariants transverses
// ============================================================================

const ALL_FIXTURES: Array<[string, () => FacturXInvoiceInput]> = [
  ['FR B2C', fixtureFrB2C],
  ['FR B2B', fixtureFrB2B],
  ['intracom 262 ter I', fixtureIntracom],
  ['export 262 I', fixtureExport],
  ['remise + port', fixtureRemisePort],
];

describe('buildFacturXCII — invariants sur les 5 fixtures métier', () => {
  it.each(ALL_FIXTURES)('%s : XML bien formé, profil EN 16931, totaux cohérents', (_name, make) => {
    const input = make();
    const xml = buildFacturXCII(input);

    // Profil EN 16931 — jamais minimum/basicwl.
    expect(xml).toContain(`<ram:ID>${FACTURX_PROFILE_URN.en16931}</ram:ID>`);
    expect(xml).not.toContain('minimum');
    expect(xml).not.toContain('basicwl');

    // Type 380, numéro, date 102.
    expect(xml).toContain('<ram:TypeCode>380</ram:TypeCode>');
    expect(xml).toContain(`<ram:ID>${input.invoiceNumber}</ram:ID>`);
    expect(xml).toContain('<udt:DateTimeString format="102">20260904</udt:DateTimeString>');

    // Totaux du résumé strictement égaux à la facture stockée.
    expect(xml).toContain(`<ram:TaxBasisTotalAmount>${input.subtotal.toFixed(2)}</ram:TaxBasisTotalAmount>`);
    expect(xml).toContain(`<ram:GrandTotalAmount>${input.total.toFixed(2)}</ram:GrandTotalAmount>`);
    expect(xml).toContain(`<ram:DuePayableAmount>${input.total.toFixed(2)}</ram:DuePayableAmount>`);
    expect(xml).toContain(
      `<ram:TaxTotalAmount currencyID="EUR">${input.taxAmount.toFixed(2)}</ram:TaxTotalAmount>`,
    );

    // Vendeur : SIREN schemeID 0002 + TVA schemeID VA.
    expect(xml).toContain('<ram:ID schemeID="0002">901234567</ram:ID>');
    expect(xml).toContain('<ram:ID schemeID="VA">FR32901234567</ram:ID>');

    // Balises strictement équilibrées et bien imbriquées (parseur à pile —
    // la déclaration <?xml ?> est ignorée car elle ne commence pas par une lettre).
    const stack: string[] = [];
    const tagRe = /<(\/?)([a-zA-Z][\w:.-]*)(?:"[^"]*"|[^">])*>/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(xml)) !== null) {
      if (m[1]) {
        expect(stack.pop()).toBe(m[2]);
      } else {
        stack.push(m[2]);
      }
    }
    expect(stack).toEqual([]);
  });
});

// ============================================================================
// Cas fiscaux
// ============================================================================

describe('catégories de TVA', () => {
  it('FR standard → catégorie S à 20 %', () => {
    const xml = buildFacturXCII(fixtureFrB2C());
    expect(xml).toContain('<ram:CategoryCode>S</ram:CategoryCode>');
    expect(xml).toContain('<ram:RateApplicablePercent>20.00</ram:RateApplicablePercent>');
    expect(xml).toContain('<ram:CalculatedAmount>10.00</ram:CalculatedAmount>');
    expect(xml).not.toContain('ExemptionReason');
  });

  it('intracom 262 ter I → catégorie K + VATEX-EU-IC + mention + TVA acheteur', () => {
    const xml = buildFacturXCII(fixtureIntracom());
    expect(xml).toContain('<ram:CategoryCode>K</ram:CategoryCode>');
    expect(xml).toContain('<ram:ExemptionReasonCode>VATEX-EU-IC</ram:ExemptionReasonCode>');
    expect(xml).toContain('article 262 ter, I du CGI');
    expect(xml).toContain('<ram:ID schemeID="VA">DE129273398</ram:ID>');
    expect(xml).toContain('<ram:CalculatedAmount>0.00</ram:CalculatedAmount>');
  });

  it('export 262 I → catégorie G + VATEX-EU-G', () => {
    const xml = buildFacturXCII(fixtureExport());
    expect(xml).toContain('<ram:CategoryCode>G</ram:CategoryCode>');
    expect(xml).toContain('<ram:ExemptionReasonCode>VATEX-EU-G</ram:ExemptionReasonCode>');
    expect(xml).toContain('article 262, I du CGI');
  });

  it('intracom sans n° TVA acheteur → FacturXError avec buyer_vat_number', () => {
    const f = fixtureIntracom();
    f.buyer.vatNumber = null;
    expect(() => buildFacturXCII(f)).toThrowError(FacturXError);
    expect(facturxMissingFields(f)).toContain('buyer_vat_number');
  });
});

describe('remise et port (BG-20 / BG-21)', () => {
  it('port → charge, remise → allowance, ventilation ajustée', () => {
    const xml = buildFacturXCII(fixtureRemisePort());
    expect(xml).toContain('<udt:Indicator>true</udt:Indicator>'); // charge (port)
    expect(xml).toContain('<udt:Indicator>false</udt:Indicator>'); // allowance (remise)
    expect(xml).toContain('<ram:ChargeTotalAmount>8.00</ram:ChargeTotalAmount>');
    expect(xml).toContain('<ram:AllowanceTotalAmount>5.00</ram:AllowanceTotalAmount>');
    // Ligne produits seule dans LineTotalAmount ; base TVA = 53.
    expect(xml).toContain('<ram:LineTotalAmount>50.00</ram:LineTotalAmount>');
    expect(xml).toContain('<ram:BasisAmount>53.00</ram:BasisAmount>');
    expect(xml).toContain('<ram:CalculatedAmount>10.60</ram:CalculatedAmount>');
  });

  it('les lignes remise/port ne créent pas de ligne de facture BG-25', () => {
    const xml = buildFacturXCII(fixtureRemisePort());
    const lineCount = xml.match(/<ram:IncludedSupplyChainTradeLineItem>/g)?.length ?? 0;
    expect(lineCount).toBe(1);
  });
});

describe('mentions réglementaires 2026', () => {
  it('nature de l’opération dans les notes', () => {
    const xml = buildFacturXCII(fixtureFrB2C());
    expect(xml).toContain('livraison de biens');
  });

  it('option TVA sur les débits → note + DueDateTypeCode 5', () => {
    const f = fixtureFrB2C();
    f.vatOnDebits = true;
    const xml = buildFacturXCII(f);
    expect(xml).toContain("TVA d&apos;après les débits");
    expect(xml).toContain('<ram:DueDateTypeCode>5</ram:DueDateTypeCode>');
  });

  it('sans option débits → pas de DueDateTypeCode', () => {
    const xml = buildFacturXCII(fixtureFrB2C());
    expect(xml).not.toContain('DueDateTypeCode');
  });

  it('adresse de livraison différente → ShipToTradeParty', () => {
    const f = fixtureFrB2B();
    f.delivery = {
      addressLine1: 'Entrepôt 4, ZI des Landes',
      postalCode: '44300',
      city: 'Nantes',
      countryCode: 'FR',
    };
    const xml = buildFacturXCII(f);
    expect(xml).toContain('<ram:ShipToTradeParty>');
    expect(xml).toContain('Entrepôt 4, ZI des Landes');
  });

  it('sans adresse de livraison différente → pas de ShipToTradeParty (catégorie S)', () => {
    const xml = buildFacturXCII(fixtureFrB2B());
    expect(xml).not.toContain('ShipToTradeParty');
  });

  it('intracom (K) → BT-80 pays de livraison + BT-72 date de livraison, même sans adresse distincte (BR-IC-11/12)', () => {
    const xml = buildFacturXCII(fixtureIntracom());
    expect(xml).toContain('<ram:ShipToTradeParty>');
    expect(xml).toContain('<ram:CountryID>DE</ram:CountryID>');
    expect(xml).toContain('<ram:ActualDeliverySupplyChainEvent>');
    // Repli : date de facture quand deliveryDate absent.
    expect(xml).toContain('<ram:OccurrenceDateTime><udt:DateTimeString format="102">20260904</udt:DateTimeString></ram:OccurrenceDateTime>');
  });

  it('deliveryDate explicite (order.shipped_at) prioritaire sur le repli', () => {
    const f = fixtureIntracom();
    f.deliveryDate = '2026-09-02';
    const xml = buildFacturXCII(f);
    expect(xml).toContain('<udt:DateTimeString format="102">20260902</udt:DateTimeString>');
  });
});

describe('garde-fous', () => {
  it('vendeur incomplet → liste stable de champs manquants', () => {
    const f = fixtureFrB2C();
    f.seller = { ...f.seller, siren: null, vatNumber: null, addressLine1: null };
    const missing = facturxMissingFields(f);
    expect(missing).toEqual(
      expect.arrayContaining(['seller_siren', 'seller_vat_number', 'seller_address']),
    );
    expect(() => buildFacturXCII(f)).toThrowError(FacturXError);
  });

  it('totaux stockés incohérents avec les lignes → FacturXError (jamais de XML ≠ facture)', () => {
    const f = fixtureFrB2C();
    f.subtotal = 45; // les lignes font 50
    expect(() => buildFacturXCII(f)).toThrowError(/Incohérence subtotal/);
  });

  it('tax_amount stocké incohérent → FacturXError', () => {
    const f = fixtureFrB2C();
    f.taxAmount = 9; // 50 × 20 % = 10
    f.total = 59;
    expect(() => buildFacturXCII(f)).toThrowError(/Incohérence tax_amount/);
  });

  it('écart d’arrondi ≤ 2 centimes absorbé par le plus gros groupe de TVA', () => {
    const f = fixtureFrB2C();
    f.lines = [productLine({ quantity: 3, unitPrice: 3.33, totalPrice: 9.99 })];
    f.subtotal = 9.99;
    f.taxAmount = 2.01; // 9.99 × 0.2 = 1.998 → arrondi 2.00 ; on force 2.01 (± 1 ct)
    f.total = 12.0;
    const xml = buildFacturXCII(f);
    expect(xml).toContain('<ram:CalculatedAmount>2.01</ram:CalculatedAmount>');
    expect(xml).toContain('<ram:TaxTotalAmount currencyID="EUR">2.01</ram:TaxTotalAmount>');
  });

  it('échappement XML des données métier (nom d’artiste avec & et <)', () => {
    const f = fixtureFrB2C();
    f.lines = [productLine({ description: 'Mingus & Dolphy — <Live>' })];
    const xml = buildFacturXCII(f);
    expect(xml).toContain('Mingus &amp; Dolphy — &lt;Live&gt;');
    expect(xml).not.toContain('<Live>');
  });
});

describe('multi-taux', () => {
  it('deux taux → deux ApplicableTradeTax avec bases distinctes', () => {
    const f = fixtureFrB2C();
    f.lines = [
      productLine(), // 50 à 20 %
      productLine({ description: 'Fanzine', quantity: 1, unitPrice: 10, totalPrice: 10, taxRate: 0.055 }),
    ];
    f.subtotal = 60;
    f.taxAmount = 10.55;
    f.total = 70.55;
    const xml = buildFacturXCII(f);
    const taxBlocks = xml.match(/<ram:ApplicableHeaderTradeSettlement>.*<\/ram:ApplicableHeaderTradeSettlement>/s)![0];
    expect(taxBlocks).toContain('<ram:RateApplicablePercent>20.00</ram:RateApplicablePercent>');
    expect(taxBlocks).toContain('<ram:RateApplicablePercent>5.50</ram:RateApplicablePercent>');
    expect(taxBlocks).toContain('<ram:BasisAmount>50.00</ram:BasisAmount>');
    expect(taxBlocks).toContain('<ram:BasisAmount>10.00</ram:BasisAmount>');
  });
});

describe('sirenFromSiret', () => {
  it('extrait les 9 premiers chiffres', () => {
    expect(sirenFromSiret('901 234 567 00012')).toBe('901234567');
    expect(sirenFromSiret('90123456700012')).toBe('901234567');
  });
  it('null si absent ou trop court', () => {
    expect(sirenFromSiret(null)).toBeNull();
    expect(sirenFromSiret('1234')).toBeNull();
  });
});

// ============================================================================
// Avoirs (TypeCode 381) — même moteur que la facture 380
// ============================================================================

describe('avoirs — TypeCode 381', () => {
  /** Avoir TOTAL sur la facture FR B2C (mêmes montants, positifs). */
  function fixtureAvoirTotal(): FacturXInvoiceInput {
    const f = fixtureFrB2C();
    f.docType = 'credit_note';
    f.invoiceNumber = 'AV2026007';
    f.originalInvoiceNumber = 'FC2026042';
    return f;
  }

  /** Avoir PARTIEL : un seul LP sur les deux. */
  function fixtureAvoirPartiel(): FacturXInvoiceInput {
    const f = fixtureAvoirTotal();
    f.invoiceNumber = 'AV2026008';
    f.lines = [productLine({ quantity: 1, unitPrice: 25, totalPrice: 25 })];
    f.subtotal = 25;
    f.taxAmount = 5;
    f.total = 30;
    return f;
  }

  it('avoir total → TypeCode 381 + référence facture d’origine (BG-3), montants positifs', () => {
    const xml = buildFacturXCII(fixtureAvoirTotal());
    expect(xml).toContain('<ram:TypeCode>381</ram:TypeCode>');
    expect(xml).toContain(
      '<ram:InvoiceReferencedDocument><ram:IssuerAssignedID>FC2026042</ram:IssuerAssignedID></ram:InvoiceReferencedDocument>',
    );
    expect(xml).toContain('<ram:GrandTotalAmount>60.00</ram:GrandTotalAmount>');
    expect(xml).not.toContain('-60.00');
  });

  it('avoir partiel → mêmes règles de cohérence stricte', () => {
    const xml = buildFacturXCII(fixtureAvoirPartiel());
    expect(xml).toContain('<ram:TypeCode>381</ram:TypeCode>');
    expect(xml).toContain('<ram:GrandTotalAmount>30.00</ram:GrandTotalAmount>');
    expect(xml).toContain('<ram:CalculatedAmount>5.00</ram:CalculatedAmount>');
  });

  it('avoir intracommunautaire → 381 + catégorie K + BR-IC-11/12 conservés', () => {
    const f = fixtureIntracom();
    f.docType = 'credit_note';
    f.invoiceNumber = 'AV2026009';
    f.originalInvoiceNumber = 'FC2026044';
    const xml = buildFacturXCII(f);
    expect(xml).toContain('<ram:TypeCode>381</ram:TypeCode>');
    expect(xml).toContain('<ram:CategoryCode>K</ram:CategoryCode>');
    expect(xml).toContain('<ram:ShipToTradeParty>');
    expect(xml).toContain('<ram:ActualDeliverySupplyChainEvent>');
  });

  it('avoir SANS référence à la facture d’origine → FacturXError (jamais émis)', () => {
    const f = fixtureAvoirTotal();
    f.originalInvoiceNumber = null;
    expect(facturxMissingFields(f)).toContain('original_invoice_number');
    expect(() => buildFacturXCII(f)).toThrowError(FacturXError);
  });

  it('une facture 380 n’émet PAS de BG-3 par accident', () => {
    const xml = buildFacturXCII(fixtureFrB2C());
    expect(xml).toContain('<ram:TypeCode>380</ram:TypeCode>');
    expect(xml).not.toContain('InvoiceReferencedDocument');
  });
});
