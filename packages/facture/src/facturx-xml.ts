/**
 * Factur-X — générateur XML CII (UN/CEFACT Cross Industry Invoice D22B).
 *
 * Références applicables (2026) : Factur-X 1.09.2 / ZUGFeRD 2.5.2, AFNOR
 * XP Z12-012, spécifications externes DGFiP v3.2. Cible produit : profil
 * EN 16931 (`urn:cen.eu:en16931:2017`) ; BASIC n'est qu'un fallback technique
 * de développement — MINIMUM/BASIC WL ne sont jamais émis.
 *
 * Module volontairement sans dépendance (ni React, ni Supabase) : il doit
 * tourner à l'identique dans le navigateur (preview J3), sous vitest et dans
 * l'edge function Deno `facturx-generate` (document canonique, J4).
 *
 * Correspondance fiscale SILLON → EN 16931 (cf. analysis/SPRINT-FACTURX.md §2.2) :
 *   TVA FR standard            → catégorie S (taux par ligne)
 *   262 ter I (intracom. B2B)  → catégorie K + VATEX-EU-IC
 *   262 I (export hors UE)     → catégorie G + VATEX-EU-G
 *
 * Mapping des lignes SILLON (invoice_items.line_type) :
 *   product / fee → lignes de facture (BG-25)
 *   shipping      → charge de document (BG-21, ChargeIndicator=true)
 *   discount      → remise de document (BG-20, ChargeIndicator=false)
 */

export const FACTURX_SPEC_VERSION = '1.09.2'; // Factur-X (= ZUGFeRD 2.5.2)
export const FACTURX_CII_VERSION = 'D22B';
export const FACTURX_XML_FILENAME = 'factur-x.xml';

export type FacturXProfile = 'en16931' | 'basic';

export const FACTURX_PROFILE_URN: Record<FacturXProfile, string> = {
  en16931: 'urn:cen.eu:en16931:2017',
  basic: 'urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic',
};

/** Fraction (0.20) — cohérent avec invoice_items.tax_rate. */
export interface FacturXLine {
  description: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  taxRate: number;
  lineType: 'product' | 'shipping' | 'fee' | 'discount' | 'other';
}

export interface FacturXParty {
  /** Nom légal (BT-27 / BT-44). Pour un acheteur B2B : la raison sociale. */
  name: string;
  siren?: string | null;
  vatNumber?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  /** ISO 3166-1 alpha-2 (BT-40 / BT-55). */
  countryCode?: string | null;
  /**
   * Adresse électronique de routage (BT-34 vendeur / BT-49 acheteur), au
   * format EAS. Défaut pour une partie française avec SIREN : 0225:SIREN —
   * la réforme FR route par cette adresse, un document sans BT-34/BT-49 est
   * rejeté par la PA (« Participant ID (electronic address) must exist »,
   * constaté en sandbox iopole le 07/09/2026).
   */
  electronicAddress?: { scheme: string; value: string } | null;
}

export interface FacturXDeliveryAddress {
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  countryCode?: string | null;
}

export interface FacturXVatRegime {
  exempt: boolean;
  /** '262 ter I' | '262 I' | null — cf. getInvoiceVatRegime (vat-utils.ts). */
  regimeCode: string | null;
  legalMention: string | null;
}

/**
 * Type de document électronique — UN SEUL moteur pour les deux :
 *   invoice      → TypeCode 380 (facture commerciale)
 *   credit_note  → TypeCode 381 (avoir), référence à la facture d'origine
 *                  OBLIGATOIRE (règle SILLON, au-delà d'EN 16931 : un avoir
 *                  sans facture d'origine n'est pas émis).
 * Les montants d'un avoir restent POSITIFS (sémantique portée par le TypeCode).
 */
export type FacturXDocType = 'invoice' | 'credit_note';

export interface FacturXInvoiceInput {
  /** Défaut : 'invoice' (380). */
  docType?: FacturXDocType;
  /** Facture d'origine (BG-3) — requise quand docType = 'credit_note'. */
  originalInvoiceNumber?: string | null;
  /**
   * Date d'émission de la facture d'origine (BT-26), ISO YYYY-MM-DD.
   * BR-FR-CO-05 : un avoir doit porter la référence BT-25 AVEC sa date —
   * le chemin canonique serveur la fournit toujours (facturx-generate).
   */
  originalInvoiceDate?: string | null;
  invoiceNumber: string;
  /** ISO YYYY-MM-DD. */
  issueDate: string;
  /**
   * Date de livraison effective (BT-72), ISO YYYY-MM-DD — passer
   * order.shipped_at quand il existe. Obligatoire en intracommunautaire
   * (BR-IC-11) : à défaut, la date de facture est utilisée pour la
   * catégorie K.
   */
  deliveryDate?: string | null;
  dueDate?: string | null;
  currency: string;
  /** Référence de commande (BT-13), si la facture vient d'une commande. */
  orderNumber?: string | null;
  seller: FacturXParty & {
    iban?: string | null;
    bic?: string | null;
    paymentTermsText?: string | null;
  };
  buyer: FacturXParty;
  /** Adresse de livraison SEULEMENT lorsqu'elle diffère de l'adresse acheteur (BG-15). */
  delivery?: FacturXDeliveryAddress | null;
  lines: FacturXLine[];
  /** Totaux stockés sur la facture — le XML doit leur être strictement égal. */
  subtotal: number;
  taxAmount: number;
  total: number;
  regime: FacturXVatRegime;
  /** Option TVA d'après les débits (snapshot invoices.vat_on_debits). */
  vatOnDebits: boolean;
  /** Nature de l'opération (snapshot invoices.transaction_nature). */
  transactionNature: 'goods' | 'services' | 'mixed';
  profile: FacturXProfile;
  notes?: string | null;
  /**
   * Cadre de facturation BT-23 (BR-FR-08) — codes réforme FR (B1/S1/M1…).
   * Défaut dérivé de transactionNature : goods→B1, services→S1, mixed→M1.
   */
  businessProcessId?: string | null;
  /**
   * Mentions légales FR obligatoires en BG-1 (BR-FR-05), avec SubjectCode :
   * PMD pénalités de retard, PMT frais de recouvrement, AAB escompte.
   * Défauts B2B français si absent ; chaque texte est surchargeable.
   */
  frMentions?: { pmd?: string; pmt?: string; aab?: string } | null;
}

// ============================================================================
// Garde-fou : champs obligatoires avant émission
// ============================================================================

/**
 * Champs manquants pour émettre un Factur-X EN 16931 valide. Vide = prêt.
 * Sert aussi à la checklist de la carte Settings (J3) : chaque entrée est une
 * clé stable, pas un message.
 */
export function facturxMissingFields(input: FacturXInvoiceInput): string[] {
  const missing: string[] = [];
  const { seller, buyer } = input;

  if (!input.invoiceNumber) missing.push('invoice_number');
  if (!input.issueDate) missing.push('issue_date');
  if (!input.currency) missing.push('currency');
  if (input.lines.filter((l) => l.lineType !== 'shipping' && l.lineType !== 'discount').length === 0) {
    missing.push('lines');
  }

  if (!seller.name) missing.push('seller_legal_name');
  if (!seller.siren) missing.push('seller_siren');
  // BT-31 : identifiant TVA vendeur — requis dès qu'une TVA est facturée, et
  // exigé aussi en exonération (la mention d'exonération s'y réfère).
  if (!seller.vatNumber) missing.push('seller_vat_number');
  if (!seller.addressLine1) missing.push('seller_address');
  if (!seller.postalCode) missing.push('seller_postal_code');
  if (!seller.city) missing.push('seller_city');
  if (!seller.countryCode) missing.push('seller_country_code');

  // Avoir (381) : référence explicite à la facture d'origine, toujours.
  if (input.docType === 'credit_note' && !input.originalInvoiceNumber) {
    missing.push('original_invoice_number');
  }

  if (!buyer.name) missing.push('buyer_name');
  if (!buyer.countryCode) missing.push('buyer_country_code');
  // Intracom B2B (catégorie K) : le n° TVA acheteur est obligatoire (BR-K de
  // la norme — l'autoliquidation se justifie par l'identification du preneur).
  if (input.regime.regimeCode === '262 ter I' && !buyer.vatNumber) {
    missing.push('buyer_vat_number');
  }

  return missing;
}

export class FacturXError extends Error {
  readonly missingFields: string[];
  constructor(message: string, missingFields: string[] = []) {
    super(message);
    this.name = 'FacturXError';
    this.missingFields = missingFields;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Montant à 2 décimales (format EN 16931). */
function amt(n: number): string {
  // Évite les artefacts IEEE (-0.00, 19.999999…).
  const rounded = Math.round(n * 100) / 100;
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(2);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Taux en pourcentage à 2 décimales (RateApplicablePercent). */
function pct(fraction: number): string {
  return (Math.round(fraction * 10000) / 100).toFixed(2);
}

/** Date ISO → format CII 102 (YYYYMMDD). */
function date102(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, '');
}

function tag(name: string, content: string, attrs = ''): string {
  return `<${name}${attrs}>${content}</${name}>`;
}

/** SIREN = 9 premiers chiffres du SIRET. */
export function sirenFromSiret(siret: string | null | undefined): string | null {
  if (!siret) return null;
  const digits = siret.replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(0, 9) : null;
}

// ============================================================================
// Ventilation TVA
// ============================================================================

interface VatBreakdownEntry {
  categoryCode: 'S' | 'K' | 'G';
  /** Fraction. */
  rate: number;
  basis: number;
  tax: number;
}

function vatCategory(regime: FacturXVatRegime): 'S' | 'K' | 'G' {
  if (regime.regimeCode === '262 ter I') return 'K';
  if (regime.regimeCode === '262 I') return 'G';
  return 'S';
}

const EXEMPTION_REASON_CODE: Record<'K' | 'G', string> = {
  K: 'VATEX-EU-IC',
  G: 'VATEX-EU-G',
};

/**
 * Ventilation par (catégorie, taux) : lignes + charge de port − remise.
 * La TVA de chaque groupe est calculée sur la base arrondie (BR-CO-17), puis
 * le plus gros groupe absorbe l'éventuel centime d'écart avec le tax_amount
 * stocké, pour que le XML reste strictement égal à la facture.
 */
function computeVatBreakdown(
  input: FacturXInvoiceInput,
  category: 'S' | 'K' | 'G',
): VatBreakdownEntry[] {
  const byRate = new Map<number, number>();
  const add = (rate: number, amount: number) => {
    byRate.set(rate, (byRate.get(rate) ?? 0) + amount);
  };

  for (const line of input.lines) {
    if (line.lineType === 'discount') {
      add(line.taxRate, -Math.abs(line.totalPrice)); // remise = base négative
    } else {
      add(line.taxRate, line.totalPrice); // produits, fees, port
    }
  }

  const entries: VatBreakdownEntry[] = [...byRate.entries()]
    .map(([rate, basis]) => ({
      categoryCode: category,
      rate,
      basis: round2(basis),
      tax: category === 'S' ? round2(round2(basis) * rate) : 0,
    }))
    .sort((a, b) => b.rate - a.rate);

  // Réconciliation au centime avec le montant stocké sur la facture.
  const taxSum = round2(entries.reduce((s, e) => s + e.tax, 0));
  const delta = round2(input.taxAmount - taxSum);
  if (delta !== 0 && Math.abs(delta) <= 0.02 && entries.length > 0) {
    const biggest = entries.reduce((a, b) => (b.basis > a.basis ? b : a));
    biggest.tax = round2(biggest.tax + delta);
  }

  return entries;
}

// ============================================================================
// Générateur
// ============================================================================

const TRANSACTION_NATURE_NOTE: Record<FacturXInvoiceInput['transactionNature'], string> = {
  goods: "Nature de l'opération : livraison de biens.",
  services: "Nature de l'opération : prestation de services.",
  mixed: "Nature de l'opération : opération mixte (biens et services).",
};

const VAT_ON_DEBITS_NOTE = "Option pour le paiement de la TVA d'après les débits.";

/** BT-23 (BR-FR-08) : cadre de facturation par défaut selon la nature. */
const BUSINESS_PROCESS_BY_NATURE: Record<FacturXInvoiceInput['transactionNature'], string> = {
  goods: 'B1',
  services: 'S1',
  mixed: 'M1',
};

/**
 * Mentions FR obligatoires (BR-FR-05) — BG-1 avec SubjectCode. Textes par
 * défaut conformes aux articles L441-10 et D441-5 du Code de commerce ;
 * surchargeables par facture via input.frMentions.
 */
const FR_MENTION_DEFAULTS: Record<'PMD' | 'PMT' | 'AAB', string> = {
  PMD:
    'Pénalités de retard : trois fois le taux d’intérêt légal, exigibles ' +
    'sans qu’un rappel soit nécessaire (art. L441-10 du Code de commerce).',
  PMT:
    'Indemnité forfaitaire pour frais de recouvrement en cas de retard de ' +
    'paiement : 40 € (art. D441-5 du Code de commerce).',
  AAB: 'Pas d’escompte pour paiement anticipé.',
};

/**
 * Construit le XML CII D22B de la facture. Lève une FacturXError si des champs
 * obligatoires manquent ou si les totaux recalculés ne collent pas aux totaux
 * stockés (subtotal / tax_amount / total) à 2 centimes près.
 */
export function buildFacturXCII(input: FacturXInvoiceInput): string {
  const missing = facturxMissingFields(input);
  if (missing.length > 0) {
    throw new FacturXError(
      `Champs obligatoires Factur-X manquants : ${missing.join(', ')}`,
      missing,
    );
  }

  const category = vatCategory(input.regime);

  // --- Découpage des lignes ---------------------------------------------------
  const itemLines = input.lines.filter(
    (l) => l.lineType !== 'shipping' && l.lineType !== 'discount',
  );
  const shippingLines = input.lines.filter((l) => l.lineType === 'shipping');
  const discountLines = input.lines.filter((l) => l.lineType === 'discount');

  const lineTotal = round2(itemLines.reduce((s, l) => s + l.totalPrice, 0));
  const chargeTotal = round2(shippingLines.reduce((s, l) => s + l.totalPrice, 0));
  const allowanceTotal = round2(
    discountLines.reduce((s, l) => s + Math.abs(l.totalPrice), 0),
  );
  const taxBasis = round2(lineTotal + chargeTotal - allowanceTotal);

  // --- Cohérence avec les totaux stockés (jamais de XML ≠ facture) -------------
  if (Math.abs(taxBasis - input.subtotal) > 0.02) {
    throw new FacturXError(
      `Incohérence subtotal : lignes=${taxBasis} facture=${input.subtotal}`,
    );
  }
  const breakdown = computeVatBreakdown(input, category);
  const taxTotal = round2(breakdown.reduce((s, e) => s + e.tax, 0));
  if (Math.abs(taxTotal - input.taxAmount) > 0.02) {
    throw new FacturXError(
      `Incohérence tax_amount : ventilation=${taxTotal} facture=${input.taxAmount}`,
    );
  }
  const grandTotal = round2(input.subtotal + input.taxAmount);
  if (Math.abs(grandTotal - input.total) > 0.02) {
    throw new FacturXError(
      `Incohérence total : calculé=${grandTotal} facture=${input.total}`,
    );
  }

  // --- Notes de document (BG-1) ------------------------------------------------
  const notes: Array<{ content: string; subjectCode?: string }> = [];
  if (input.regime.legalMention) notes.push({ content: input.regime.legalMention });
  notes.push({ content: TRANSACTION_NATURE_NOTE[input.transactionNature] });
  if (input.vatOnDebits) notes.push({ content: VAT_ON_DEBITS_NOTE });
  if (input.notes && input.notes !== input.regime.legalMention) {
    notes.push({ content: input.notes });
  }
  // BR-FR-05 : les trois mentions FR sont OBLIGATOIRES (SubjectCode PMD/PMT/AAB) —
  // constaté au schematron de la PA en sandbox (REJ_SEMAN sans elles).
  notes.push({ content: input.frMentions?.pmd ?? FR_MENTION_DEFAULTS.PMD, subjectCode: 'PMD' });
  notes.push({ content: input.frMentions?.pmt ?? FR_MENTION_DEFAULTS.PMT, subjectCode: 'PMT' });
  notes.push({ content: input.frMentions?.aab ?? FR_MENTION_DEFAULTS.AAB, subjectCode: 'AAB' });

  const includedNotes = notes
    .map((n) =>
      tag(
        'ram:IncludedNote',
        tag('ram:Content', escapeXml(n.content)) +
          (n.subjectCode ? tag('ram:SubjectCode', n.subjectCode) : ''),
      ),
    )
    .join('');

  // --- Lignes (BG-25) ----------------------------------------------------------
  const lineItemsXml = itemLines
    .map((line, i) => {
      const unitNet = line.quantity !== 0 ? line.totalPrice / line.quantity : line.totalPrice;
      return tag(
        'ram:IncludedSupplyChainTradeLineItem',
        tag('ram:AssociatedDocumentLineDocument', tag('ram:LineID', String(i + 1))) +
          tag('ram:SpecifiedTradeProduct', tag('ram:Name', escapeXml(line.description))) +
          tag(
            'ram:SpecifiedLineTradeAgreement',
            tag('ram:NetPriceProductTradePrice', tag('ram:ChargeAmount', amt(unitNet))),
          ) +
          tag(
            'ram:SpecifiedLineTradeDelivery',
            tag('ram:BilledQuantity', String(line.quantity), ' unitCode="C62"'),
          ) +
          tag(
            'ram:SpecifiedLineTradeSettlement',
            tag(
              'ram:ApplicableTradeTax',
              tag('ram:TypeCode', 'VAT') +
                tag('ram:CategoryCode', category) +
                tag('ram:RateApplicablePercent', pct(category === 'S' ? line.taxRate : 0)),
            ) +
              tag(
                'ram:SpecifiedTradeSettlementLineMonetarySummation',
                tag('ram:LineTotalAmount', amt(line.totalPrice)),
              ),
          ),
      );
    })
    .join('');

  // --- Parties -----------------------------------------------------------------
  const partyXml = (party: FacturXParty): string => {
    let xml = tag('ram:Name', escapeXml(party.name));
    if (party.siren) {
      xml += tag(
        'ram:SpecifiedLegalOrganization',
        tag('ram:ID', escapeXml(party.siren), ' schemeID="0002"'),
      );
    }
    xml += tag(
      'ram:PostalTradeAddress',
      (party.postalCode ? tag('ram:PostcodeCode', escapeXml(party.postalCode)) : '') +
        (party.addressLine1 ? tag('ram:LineOne', escapeXml(party.addressLine1)) : '') +
        (party.addressLine2 ? tag('ram:LineTwo', escapeXml(party.addressLine2)) : '') +
        (party.city ? tag('ram:CityName', escapeXml(party.city)) : '') +
        tag('ram:CountryID', escapeXml(party.countryCode ?? '')),
    );
    // BT-34/BT-49 — adresse électronique de routage (ordre CII : après
    // PostalTradeAddress, avant SpecifiedTaxRegistration). Repli FR : 0225:SIREN.
    const eAddr =
      party.electronicAddress ??
      (party.siren && (party.countryCode ?? 'FR') === 'FR'
        ? { scheme: '0225', value: party.siren }
        : null);
    if (eAddr) {
      xml += tag(
        'ram:URIUniversalCommunication',
        tag('ram:URIID', escapeXml(eAddr.value), ` schemeID="${escapeXml(eAddr.scheme)}"`),
      );
    }
    if (party.vatNumber) {
      xml += tag(
        'ram:SpecifiedTaxRegistration',
        tag('ram:ID', escapeXml(party.vatNumber.replace(/\s/g, '')), ' schemeID="VA"'),
      );
    }
    return xml;
  };

  const agreementXml = tag(
    'ram:ApplicableHeaderTradeAgreement',
    tag('ram:SellerTradeParty', partyXml(input.seller)) +
      tag('ram:BuyerTradeParty', partyXml(input.buyer)) +
      (input.orderNumber
        ? tag(
            'ram:BuyerOrderReferencedDocument',
            tag('ram:IssuerAssignedID', escapeXml(input.orderNumber)),
          )
        : ''),
  );

  // --- Livraison ---------------------------------------------------------------
  // ShipToTradeParty (BG-13/BG-15) : émis quand l'adresse de livraison diffère,
  // et TOUJOURS en intracommunautaire — BR-IC-12 exige le pays de livraison
  // (BT-80) pour la catégorie K (repli : pays de l'acheteur).
  const shipTo = input.delivery
    ? input.delivery
    : category === 'K'
      ? { countryCode: input.buyer.countryCode }
      : null;
  const shipToXml = shipTo
    ? tag(
        'ram:ShipToTradeParty',
        tag(
          'ram:PostalTradeAddress',
          ((shipTo as FacturXDeliveryAddress).postalCode
            ? tag('ram:PostcodeCode', escapeXml((shipTo as FacturXDeliveryAddress).postalCode!))
            : '') +
            ((shipTo as FacturXDeliveryAddress).addressLine1
              ? tag('ram:LineOne', escapeXml((shipTo as FacturXDeliveryAddress).addressLine1!))
              : '') +
            ((shipTo as FacturXDeliveryAddress).addressLine2
              ? tag('ram:LineTwo', escapeXml((shipTo as FacturXDeliveryAddress).addressLine2!))
              : '') +
            ((shipTo as FacturXDeliveryAddress).city
              ? tag('ram:CityName', escapeXml((shipTo as FacturXDeliveryAddress).city!))
              : '') +
            tag('ram:CountryID', escapeXml(shipTo.countryCode ?? '')),
        ),
      )
    : '';
  // Date de livraison effective (BT-72) : émise si fournie, et obligatoire en
  // intracommunautaire (BR-IC-11) — repli sur la date de facture.
  const deliveryDate = input.deliveryDate ?? (category === 'K' ? input.issueDate : null);
  const deliveryEventXml = deliveryDate
    ? tag(
        'ram:ActualDeliverySupplyChainEvent',
        tag(
          'ram:OccurrenceDateTime',
          tag('udt:DateTimeString', date102(deliveryDate), ' format="102"'),
        ),
      )
    : '';
  const deliveryXml = tag('ram:ApplicableHeaderTradeDelivery', shipToXml + deliveryEventXml);

  // --- Règlement ---------------------------------------------------------------
  const paymentMeansXml = input.seller.iban
    ? tag(
        'ram:SpecifiedTradeSettlementPaymentMeans',
        tag('ram:TypeCode', '30') + // virement (UNTDID 4461)
          tag(
            'ram:PayeePartyCreditorFinancialAccount',
            tag('ram:IBANID', escapeXml(input.seller.iban.replace(/\s/g, ''))),
          ) +
          (input.seller.bic
            ? tag(
                'ram:PayeeSpecifiedCreditorFinancialInstitution',
                tag('ram:BICID', escapeXml(input.seller.bic)),
              )
            : ''),
      )
    : '';

  const taxesXml = breakdown
    .map((entry) =>
      tag(
        'ram:ApplicableTradeTax',
        tag('ram:CalculatedAmount', amt(entry.tax)) +
          tag('ram:TypeCode', 'VAT') +
          (category !== 'S' && input.regime.legalMention
            ? tag('ram:ExemptionReason', escapeXml(input.regime.legalMention))
            : '') +
          tag('ram:BasisAmount', amt(entry.basis)) +
          tag('ram:CategoryCode', entry.categoryCode) +
          (category !== 'S'
            ? tag('ram:ExemptionReasonCode', EXEMPTION_REASON_CODE[category])
            : '') +
          // Option TVA sur les débits → exigibilité à la date de facture (code 5).
          (input.vatOnDebits && category === 'S' ? tag('ram:DueDateTypeCode', '5') : '') +
          tag('ram:RateApplicablePercent', pct(category === 'S' ? entry.rate : 0)),
      ),
    )
    .join('');

  const allowanceChargeXml =
    shippingLines
      .map((line) =>
        tag(
          'ram:SpecifiedTradeAllowanceCharge',
          tag('ram:ChargeIndicator', tag('udt:Indicator', 'true')) +
            tag('ram:ActualAmount', amt(line.totalPrice)) +
            tag('ram:Reason', escapeXml(line.description || 'Frais de port')) +
            tag(
              'ram:CategoryTradeTax',
              tag('ram:TypeCode', 'VAT') +
                tag('ram:CategoryCode', category) +
                tag('ram:RateApplicablePercent', pct(category === 'S' ? line.taxRate : 0)),
            ),
        ),
      )
      .join('') +
    discountLines
      .map((line) =>
        tag(
          'ram:SpecifiedTradeAllowanceCharge',
          tag('ram:ChargeIndicator', tag('udt:Indicator', 'false')) +
            tag('ram:ActualAmount', amt(Math.abs(line.totalPrice))) +
            tag('ram:Reason', escapeXml(line.description || 'Remise')) +
            tag(
              'ram:CategoryTradeTax',
              tag('ram:TypeCode', 'VAT') +
                tag('ram:CategoryCode', category) +
                tag('ram:RateApplicablePercent', pct(category === 'S' ? line.taxRate : 0)),
            ),
        ),
      )
      .join('');

  const paymentTermsXml =
    input.dueDate || input.seller.paymentTermsText
      ? tag(
          'ram:SpecifiedTradePaymentTerms',
          (input.seller.paymentTermsText
            ? tag('ram:Description', escapeXml(input.seller.paymentTermsText))
            : '') +
            (input.dueDate
              ? tag(
                  'ram:DueDateDateTime',
                  tag('udt:DateTimeString', date102(input.dueDate), ' format="102"'),
                )
              : ''),
        )
      : '';

  const summationXml = tag(
    'ram:SpecifiedTradeSettlementHeaderMonetarySummation',
    tag('ram:LineTotalAmount', amt(lineTotal)) +
      (chargeTotal > 0 ? tag('ram:ChargeTotalAmount', amt(chargeTotal)) : '') +
      (allowanceTotal > 0 ? tag('ram:AllowanceTotalAmount', amt(allowanceTotal)) : '') +
      tag('ram:TaxBasisTotalAmount', amt(input.subtotal)) +
      tag('ram:TaxTotalAmount', amt(input.taxAmount), ` currencyID="${input.currency}"`) +
      tag('ram:GrandTotalAmount', amt(input.total)) +
      tag('ram:DuePayableAmount', amt(input.total)),
  );

  // BG-3 — facture d'origine (avoir). Ordre CII : après la somme monétaire.
  // BT-26 (BR-FR-CO-05) : la date accompagne la référence quand elle est connue.
  const invoiceRefXml = input.originalInvoiceNumber
    ? tag(
        'ram:InvoiceReferencedDocument',
        tag('ram:IssuerAssignedID', escapeXml(input.originalInvoiceNumber)) +
          (input.originalInvoiceDate
            ? tag(
                'ram:FormattedIssueDateTime',
                tag('qdt:DateTimeString', date102(input.originalInvoiceDate), ' format="102"'),
              )
            : ''),
      )
    : '';

  const settlementXml = tag(
    'ram:ApplicableHeaderTradeSettlement',
    tag('ram:InvoiceCurrencyCode', input.currency) +
      paymentMeansXml +
      taxesXml +
      allowanceChargeXml +
      paymentTermsXml +
      summationXml +
      invoiceRefXml,
  );

  // --- Document ----------------------------------------------------------------
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<rsm:CrossIndustryInvoice' +
    ' xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"' +
    ' xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"' +
    ' xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"' +
    ' xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100">' +
    tag(
      'rsm:ExchangedDocumentContext',
      // BT-23 (BR-FR-08) : cadre de facturation réforme FR — AVANT le
      // Guideline (ordre CII).
      tag(
        'ram:BusinessProcessSpecifiedDocumentContextParameter',
        tag(
          'ram:ID',
          escapeXml(
            input.businessProcessId ?? BUSINESS_PROCESS_BY_NATURE[input.transactionNature],
          ),
        ),
      ) +
        tag(
          'ram:GuidelineSpecifiedDocumentContextParameter',
          tag('ram:ID', FACTURX_PROFILE_URN[input.profile]),
        ),
    ) +
    tag(
      'rsm:ExchangedDocument',
      tag('ram:ID', escapeXml(input.invoiceNumber)) +
        // 380 facture commerciale / 381 avoir (UNTDID 1001)
        tag('ram:TypeCode', input.docType === 'credit_note' ? '381' : '380') +
        tag(
          'ram:IssueDateTime',
          tag('udt:DateTimeString', date102(input.issueDate), ' format="102"'),
        ) +
        includedNotes,
    ) +
    tag(
      'rsm:SupplyChainTradeTransaction',
      lineItemsXml + agreementXml + deliveryXml + settlementXml,
    ) +
    '</rsm:CrossIndustryInvoice>'
  );
}
