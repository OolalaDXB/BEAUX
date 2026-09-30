/**
 * E-invoicing entrant — parsing d'un XML CII (Factur-X / CII nu) vers une
 * structure neutre exploitable pour le rapprochement fournisseur (mandat V1,
 * section E, étape 7).
 *
 * Extrait UNIQUEMENT ce qui sert à préremplir/rapprocher une facture
 * fournisseur : numéro, dates, identité vendeur (nom, SIREN/SIRET/TVA),
 * devise, totaux, échéance, lignes. L'ORIGINAL reste la seule référence —
 * ce parsing n'autorise ni paiement automatique ni validation comptable
 * automatique : tout entrant finit en REVIEW.
 *
 * fast-xml-parser (zéro dépendance, browser/Deno/node). Les nombres sont
 * REparsés depuis leur texte (parseTagValue: false) pour ne jamais dépendre
 * d'une coercition implicite.
 */

import { XMLParser } from 'fast-xml-parser';

export interface ParsedIncomingLine {
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  /** Fraction (0.20) — convention invoice_items/supplier_invoice_lines. */
  taxRate: number;
}

export interface ParsedIncomingInvoice {
  /** '380' facture, '381' avoir, autre = tel quel. */
  typeCode: string;
  invoiceNumber: string;
  issueDate: string | null; // ISO YYYY-MM-DD
  dueDate: string | null;
  currency: string | null;
  seller: {
    name: string | null;
    siren: string | null;
    siret: string | null;
    vatNumber: string | null;
    countryCode: string | null;
  };
  buyerVatNumber: string | null;
  subtotal: number | null; // TaxBasisTotalAmount
  taxTotal: number | null;
  total: number | null; // GrandTotalAmount
  originalInvoiceNumber: string | null; // BG-3 (avoir entrant)
  lines: ParsedIncomingLine[];
}

export class FacturXParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FacturXParseError';
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true, // rsm:/ram:/udt: → noms nus
  parseTagValue: false, // les montants sont reparsés explicitement
  trimValues: true,
});

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function text(node: unknown): string | null {
  if (node === undefined || node === null) return null;
  if (typeof node === 'string') return node || null;
  if (typeof node === 'object' && '#text' in (node as Record<string, unknown>)) {
    const t = (node as Record<string, unknown>)['#text'];
    return typeof t === 'string' && t !== '' ? t : null;
  }
  return null;
}

function num(node: unknown): number | null {
  const t = text(node);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Format CII 102 (YYYYMMDD) → ISO. */
function date102ToIso(node: unknown): string | null {
  const raw = text(node);
  if (!raw || !/^\d{8}$/.test(raw)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/**
 * Parse un XML CII (D16B→D22B : mêmes chemins pour ce sous-ensemble).
 * Lève FacturXParseError si le document n'est pas une CrossIndustryInvoice
 * ou s'il n'a ni numéro ni total (inexploitable pour un rapprochement).
 */
export function parseFacturXCII(xml: string): ParsedIncomingInvoice {
  let root: Record<string, unknown>;
  try {
    root = parser.parse(xml);
  } catch (e) {
    throw new FacturXParseError(`XML illisible : ${e instanceof Error ? e.message : String(e)}`);
  }

  const cii = (root as Record<string, any>).CrossIndustryInvoice;
  if (!cii) throw new FacturXParseError('Pas une CrossIndustryInvoice (CII)');

  const doc = cii.ExchangedDocument ?? {};
  const tx = cii.SupplyChainTradeTransaction ?? {};
  const agreement = tx.ApplicableHeaderTradeAgreement ?? {};
  const settlement = tx.ApplicableHeaderTradeSettlement ?? {};
  const summation = settlement.SpecifiedTradeSettlementHeaderMonetarySummation ?? {};
  const seller = agreement.SellerTradeParty ?? {};
  const buyer = agreement.BuyerTradeParty ?? {};

  const invoiceNumber = text(doc.ID);
  const total = num(summation.GrandTotalAmount);
  if (!invoiceNumber || total === null) {
    throw new FacturXParseError('Facture inexploitable : numéro ou total absent');
  }

  // Identité vendeur : SIREN (schemeID 0002) ou SIRET (0009) via
  // SpecifiedLegalOrganization ; TVA via SpecifiedTaxRegistration schemeID VA.
  let siren: string | null = null;
  let siret: string | null = null;
  const legalId = seller.SpecifiedLegalOrganization?.ID;
  for (const idNode of asArray(legalId)) {
    const scheme = (idNode as Record<string, unknown>)?.['@_schemeID'];
    const value = text(idNode);
    if (!value) continue;
    if (scheme === '0002') siren = value;
    else if (scheme === '0009') siret = value;
    else if (!siren && /^\d{9}$/.test(value)) siren = value;
    else if (!siret && /^\d{14}$/.test(value)) siret = value;
  }
  if (!siren && siret) siren = siret.slice(0, 9);

  let sellerVat: string | null = null;
  for (const reg of asArray(seller.SpecifiedTaxRegistration)) {
    const idNode = (reg as Record<string, any>)?.ID;
    if ((idNode as Record<string, unknown>)?.['@_schemeID'] === 'VA') {
      sellerVat = text(idNode);
      break;
    }
  }
  let buyerVat: string | null = null;
  for (const reg of asArray(buyer.SpecifiedTaxRegistration)) {
    const idNode = (reg as Record<string, any>)?.ID;
    if ((idNode as Record<string, unknown>)?.['@_schemeID'] === 'VA') {
      buyerVat = text(idNode);
      break;
    }
  }

  const lines: ParsedIncomingLine[] = asArray(tx.IncludedSupplyChainTradeLineItem).map((li) => {
    const l = li as Record<string, any>;
    const lineSettlement = l.SpecifiedLineTradeSettlement ?? {};
    const ratePct = num(lineSettlement.ApplicableTradeTax?.RateApplicablePercent) ?? 0;
    return {
      description: text(l.SpecifiedTradeProduct?.Name) ?? '',
      quantity: num(l.SpecifiedLineTradeDelivery?.BilledQuantity) ?? 1,
      unitPrice: num(l.SpecifiedLineTradeAgreement?.NetPriceProductTradePrice?.ChargeAmount) ?? 0,
      lineTotal: num(lineSettlement.SpecifiedTradeSettlementLineMonetarySummation?.LineTotalAmount) ?? 0,
      taxRate: ratePct / 100,
    };
  });

  return {
    typeCode: text(doc.TypeCode) ?? '380',
    invoiceNumber,
    issueDate: date102ToIso(doc.IssueDateTime?.DateTimeString),
    dueDate: date102ToIso(settlement.SpecifiedTradePaymentTerms?.DueDateDateTime?.DateTimeString),
    currency: text(settlement.InvoiceCurrencyCode),
    seller: {
      name: text(seller.Name),
      siren,
      siret,
      vatNumber: sellerVat ? sellerVat.replace(/\s/g, '') : null,
      countryCode: text(seller.PostalTradeAddress?.CountryID),
    },
    buyerVatNumber: buyerVat ? buyerVat.replace(/\s/g, '') : null,
    subtotal: num(summation.TaxBasisTotalAmount),
    taxTotal: num(summation.TaxTotalAmount),
    total,
    originalInvoiceNumber: text(settlement.InvoiceReferencedDocument?.IssuerAssignedID),
    lines,
  };
}
