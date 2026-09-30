/**
 * E-reporting (réforme française, flux 10) — cœur INDÉPENDANT de la PA.
 *
 * Ce qui est déclaré ici, et pourquoi ce module existe à côté de la facture
 * électronique : une vente à un particulier (B2C) ne donne pas lieu à une
 * facture électronique transmise ; ce sont ses DONNÉES qui sont transmises à
 * l'administration, agrégées par jour, via la plateforme agréée (PA) :
 *   • flux 10.3 — transactions B2C : agrégat quotidien par jour, devise,
 *     catégorie de transaction et taux de TVA ;
 *   • flux 10.4 — paiements B2C : encaissements quotidiens, pour les
 *     PRESTATIONS DE SERVICES seulement (TVA exigible à l'encaissement) ;
 *   (10.1 / 10.2 — international B2B — hors périmètre de ce module pour l'instant.)
 *
 * Règles réglementaires encodées (sources publiques DGFiP relayées, lues le
 * 30/09/2026 — à reconfirmer contre les spécifications externes en vigueur) :
 *   • catégories : TLB1 livraison de biens soumise à TVA · TPS1 prestation de
 *     services soumise à TVA · TNT1 non soumis à la TVA française · TMA1
 *     régime de la marge ; une opération mixte suit l'opération principale ;
 *   • périodicité des TRANSACTIONS : réel normal mensuel → par décade
 *     (1–10, 11–20, 21–fin) ; réel normal trimestriel et réel simplifié →
 *     mensuelle ; franchise en base → tous les deux mois ;
 *   • périodicité des PAIEMENTS : mensuelle (réel normal, réel simplifié).
 *     Franchise en base : aucune TVA n'est exigible, la table DGFiP ne prévoit
 *     pas de données de paiement — À CONFIRMER avant de s'en remettre à ce
 *     choix (paymentReportingRequired).
 *   • le jour d'une opération est le jour CIVIL À PARIS, pas en UTC ;
 *   • le réel simplifié est supprimé au 01/01/2027 (traité ensuite comme le
 *     réel normal trimestriel — même périodicité mensuelle).
 * Les périodicités et le code d'exonération VATEX-FR-FRANCHISE sont
 * identiques à ceux de l'OpenAPI B2Brouter v2026-06-26 (Tax Report Setting
 * dgfip), lue le 30/09/2026.
 *
 * Ce module ne parle à aucune PA. Il produit des rapports déterministes,
 * vérifiables et idempotents ; un connecteur (EReportingProvider) les
 * transmet. Certaines PA (B2Brouter) reçoivent les transactions unitaires et
 * agrègent elles-mêmes : les agrégats servent alors de TOTAUX DE CONTRÔLE à
 * rapprocher du « ledger » renvoyé par la PA.
 */

export type EReportingVatRegime =
  | 'reel_normal_mensuel'
  | 'reel_normal_trimestriel'
  | 'reel_simplifie'
  | 'franchise';

export type TransactionCategory = 'TLB1' | 'TPS1' | 'TNT1' | 'TMA1';

export type EReportingFlux = '10.3' | '10.4';

export class EReportingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EReportingError';
  }
}

// ============================================================================
// Jours et périodes
// ============================================================================

const PARIS_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Jour civil à Paris (YYYY-MM-DD) d'un instant ISO 8601. */
export function parisDay(isoInstant: string): string {
  const d = new Date(isoInstant);
  if (Number.isNaN(d.getTime())) throw new EReportingError(`date invalide : ${isoInstant}`);
  return PARIS_DAY.format(d);
}

export interface ReportingPeriod {
  /** Identifiant stable, ex. 2026-10-D2 (décade), 2026-10 (mois), 2026-B5 (bimestre). */
  id: string;
  /** Premier et dernier jour inclus (YYYY-MM-DD). */
  start: string;
  end: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m : 1–12

/** Les données de paiement (10.4) sont-elles dues pour ce régime ? */
export function paymentReportingRequired(regime: EReportingVatRegime): boolean {
  return regime !== 'franchise';
}

/**
 * Période de déclaration contenant `day` (YYYY-MM-DD) pour un régime et un
 * type de données. Null quand ce type n'est pas dû pour ce régime.
 */
export function reportingPeriod(
  regime: EReportingVatRegime,
  day: string,
  kind: 'transactions' | 'payments',
): ReportingPeriod | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new EReportingError(`jour attendu au format YYYY-MM-DD : ${day}`);
  const y = +m[1], mo = +m[2], d = +m[3];
  const month = (): ReportingPeriod => ({
    id: `${y}-${pad(mo)}`, start: `${y}-${pad(mo)}-01`, end: `${y}-${pad(mo)}-${pad(lastDayOfMonth(y, mo))}`,
  });

  if (kind === 'payments') return paymentReportingRequired(regime) ? month() : null;

  switch (regime) {
    case 'reel_normal_mensuel': {
      const dec = d <= 10 ? 1 : d <= 20 ? 2 : 3;
      const from = dec === 1 ? 1 : dec === 2 ? 11 : 21;
      const to = dec === 1 ? 10 : dec === 2 ? 20 : lastDayOfMonth(y, mo);
      return { id: `${y}-${pad(mo)}-D${dec}`, start: `${y}-${pad(mo)}-${pad(from)}`, end: `${y}-${pad(mo)}-${pad(to)}` };
    }
    case 'reel_normal_trimestriel':
    case 'reel_simplifie':
      return month();
    case 'franchise': {
      const b = Math.ceil(mo / 2); // 1 : janv.–févr., … 6 : nov.–déc.
      const m1 = b * 2 - 1, m2 = b * 2;
      return { id: `${y}-B${b}`, start: `${y}-${pad(m1)}-01`, end: `${y}-${pad(m2)}-${pad(lastDayOfMonth(y, m2))}` };
    }
  }
}

// ============================================================================
// Données déclarées
// ============================================================================

export interface EReportedAmountLine {
  /** Fraction (0.2 = 20 %). */
  vatRate: number;
  /** Base hors taxe, en unités monétaires (2 décimales). */
  taxExclusive: number;
  /** TVA de la ligne. */
  tax: number;
}

/** Une vente à un particulier (ticket, facture B2C). */
export interface EReportedSale {
  /** Identifiant stable chez l'hôte (n° de facture/ticket). */
  id: string;
  /** Instant de l'opération (ISO 8601) — le jour est pris à Paris. */
  occurredAt: string;
  currency: string;
  category: TransactionCategory;
  lines: EReportedAmountLine[];
}

/** Un encaissement B2C. Seuls ceux d'une prestation de services (TPS1) se déclarent. */
export interface EReportedPayment {
  id: string;
  receivedAt: string;
  currency: string;
  /** Catégorie de l'opération payée. */
  saleCategory: TransactionCategory;
  /** Montants encaissés TTC, par taux. */
  amounts: { vatRate: number; amount: number }[];
}

export interface DailyTransactionAggregate {
  day: string;
  currency: string;
  category: TransactionCategory;
  vatRate: number;
  /** Nombre d'opérations ayant au moins une ligne à ce taux. */
  count: number;
  taxExclusive: number;
  tax: number;
}

export interface DailyPaymentAggregate {
  day: string;
  currency: string;
  vatRate: number;
  count: number;
  amount: number;
}

const r2 = (n: number) => {
  const v = Math.round(n * 100) / 100;
  return Object.is(v, -0) ? 0 : v;
};

function checkCurrency(c: string, id: string) {
  if (!/^[A-Z]{3}$/.test(c)) throw new EReportingError(`${id} : devise ISO 4217 attendue, reçu « ${c} »`);
}

/** Flux 10.3 : agrégat quotidien des ventes B2C. */
export function aggregateSales(sales: EReportedSale[], regime: EReportingVatRegime): DailyTransactionAggregate[] {
  const seen = new Set<string>();
  const acc = new Map<string, DailyTransactionAggregate & { ids: Set<string> }>();
  for (const s of sales) {
    if (seen.has(s.id)) throw new EReportingError(`vente ${s.id} déclarée deux fois`);
    seen.add(s.id);
    checkCurrency(s.currency, s.id);
    if (!s.lines.length) throw new EReportingError(`vente ${s.id} sans ligne`);
    const day = parisDay(s.occurredAt);
    for (const l of s.lines) {
      if (!(l.vatRate >= 0 && l.vatRate < 1)) throw new EReportingError(`vente ${s.id} : taux ${l.vatRate} hors [0, 1)`);
      if (regime === 'franchise' && (l.vatRate !== 0 || r2(l.tax) !== 0)) {
        throw new EReportingError(`vente ${s.id} : aucune TVA sous la franchise en base (293 B)`);
      }
      // la TVA d'une ligne suit sa base et son taux, au centime près
      if (Math.abs(r2(l.taxExclusive * l.vatRate) - r2(l.tax)) > 0.01) {
        throw new EReportingError(`vente ${s.id} : TVA ${l.tax} ≠ ${r2(l.taxExclusive * l.vatRate)} (base × taux)`);
      }
      const k = `${day}|${s.currency}|${s.category}|${l.vatRate}`;
      const a = acc.get(k) ?? { day, currency: s.currency, category: s.category, vatRate: l.vatRate, count: 0, taxExclusive: 0, tax: 0, ids: new Set<string>() };
      a.taxExclusive += l.taxExclusive;
      a.tax += l.tax;
      a.ids.add(s.id);
      acc.set(k, a);
    }
  }
  return [...acc.values()]
    .map(({ ids, ...a }) => ({ ...a, count: ids.size, taxExclusive: r2(a.taxExclusive), tax: r2(a.tax) }))
    .sort((a, b) => (a.day + a.currency + a.category).localeCompare(b.day + b.currency + b.category) || b.vatRate - a.vatRate);
}

/** Flux 10.4 : encaissements quotidiens des prestations de services B2C. */
export function aggregatePayments(payments: EReportedPayment[]): DailyPaymentAggregate[] {
  const seen = new Set<string>();
  const acc = new Map<string, DailyPaymentAggregate & { ids: Set<string> }>();
  for (const p of payments) {
    if (seen.has(p.id)) throw new EReportingError(`encaissement ${p.id} déclaré deux fois`);
    seen.add(p.id);
    checkCurrency(p.currency, p.id);
    if (p.saleCategory !== 'TPS1') continue; // biens, hors champ, marge : pas de donnée de paiement
    const day = parisDay(p.receivedAt);
    for (const x of p.amounts) {
      const k = `${day}|${p.currency}|${x.vatRate}`;
      const a = acc.get(k) ?? { day, currency: p.currency, vatRate: x.vatRate, count: 0, amount: 0, ids: new Set<string>() };
      a.amount += x.amount;
      a.ids.add(p.id);
      acc.set(k, a);
    }
  }
  return [...acc.values()]
    .map(({ ids, ...a }) => ({ ...a, count: ids.size, amount: r2(a.amount) }))
    .sort((a, b) => (a.day + a.currency).localeCompare(b.day + b.currency) || b.vatRate - a.vatRate);
}

// ============================================================================
// Rapport d'une période
// ============================================================================

export interface EReport {
  sellerId: string;
  regime: EReportingVatRegime;
  flux: EReportingFlux;
  period: ReportingPeriod;
  /** Opérations couvertes (ids triés) — la preuve de ce qui a été déclaré. */
  itemIds: string[];
  aggregates: DailyTransactionAggregate[] | DailyPaymentAggregate[];
  /** SHA-256 du contenu canonique (période + agrégats + ids). */
  contentHash: string;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Construit le rapport d'UNE période. Refuse une opération hors période (elle
 * appartient à un autre rapport) plutôt que de la déplacer en silence.
 * Même contenu → même hash → même clé d'idempotence ; un rectificatif
 * (contenu différent) a une clé différente.
 */
export async function buildEReport(input: {
  sellerId: string;
  regime: EReportingVatRegime;
  flux: EReportingFlux;
  period: ReportingPeriod;
  sales?: EReportedSale[];
  payments?: EReportedPayment[];
}): Promise<EReport> {
  const { sellerId, regime, flux, period } = input;
  if (!sellerId) throw new EReportingError('vendeur manquant');
  const inPeriod = (day: string) => day >= period.start && day <= period.end;
  let itemIds: string[];
  let aggregates: EReport['aggregates'];
  if (flux === '10.3') {
    const sales = input.sales ?? [];
    for (const s of sales) {
      const day = parisDay(s.occurredAt);
      if (!inPeriod(day)) throw new EReportingError(`vente ${s.id} du ${day} hors période ${period.id}`);
    }
    aggregates = aggregateSales(sales, regime);
    itemIds = sales.map((s) => s.id).sort();
  } else {
    if (!paymentReportingRequired(regime)) throw new EReportingError(`pas de données de paiement pour le régime ${regime}`);
    const pays = input.payments ?? [];
    for (const p of pays) {
      const day = parisDay(p.receivedAt);
      if (!inPeriod(day)) throw new EReportingError(`encaissement ${p.id} du ${day} hors période ${period.id}`);
    }
    aggregates = aggregatePayments(pays);
    itemIds = pays.filter((p) => p.saleCategory === 'TPS1').map((p) => p.id).sort();
  }
  const contentHash = await sha256Hex(JSON.stringify({ sellerId, regime, flux, period, itemIds, aggregates }));
  return { sellerId, regime, flux, period, itemIds, aggregates, contentHash };
}

/** Clé d'idempotence : le vendeur, le flux, la période, le contenu exact. */
export function ereportIdempotencyKey(r: Pick<EReport, 'sellerId' | 'flux' | 'period' | 'contentHash'>): string {
  return `ereport:${r.sellerId}:${r.flux}:${r.period.id}:${r.contentHash}`;
}

// ============================================================================
// Contrat de connecteur
// ============================================================================

/** Statuts internes d'un rapport — l'UI n'affiche rien d'autre. */
export type EReportStatus = 'GENERATED' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED';

export interface EReportSubmission {
  providerReportId: string;
  providerStatus: string;
  internalStatus: EReportStatus;
  rejectionReason?: string | null;
}

/**
 * Ce qu'une PA doit savoir faire pour l'e-reporting. Deux familles :
 *   • la PA reçoit les AGRÉGATS (submitReport) ;
 *   • la PA reçoit les opérations UNITAIRES et agrège elle-même
 *     (submitSales / submitPayments) — les agrégats du rapport servent alors
 *     de totaux de contrôle, rapprochés de ce que la PA renvoie (getLedger).
 * Un connecteur implémente l'une ou l'autre, et getReportStatus.
 */
export interface EReportingProvider {
  readonly slug: string;
  submitReport?(report: EReport, idempotencyKey: string): Promise<EReportSubmission>;
  submitSales?(sales: EReportedSale[], report: EReport, idempotencyKey: string): Promise<EReportSubmission>;
  submitPayments?(payments: EReportedPayment[], report: EReport, idempotencyKey: string): Promise<EReportSubmission>;
  getReportStatus(providerReportId: string): Promise<EReportSubmission>;
  /** Agrégats tels que la PA les a calculés, pour rapprochement. */
  getLedger?(providerReportId: string): Promise<EReport['aggregates']>;
}

/**
 * Rapproche les agrégats renvoyés par la PA de ceux calculés ici. Vide = accord.
 * Chaque écart est une ligne lisible (jour, clé, attendu, reçu).
 */
export function reconcileAggregates(expected: EReport['aggregates'], received: EReport['aggregates']): string[] {
  type Row = Record<string, unknown>;
  const key = (a: Row): string => ['day', 'currency', 'category', 'vatRate'].map((k) => a[k] ?? '').join('|');
  const val = (a: Row): Row =>
    'amount' in a ? { count: a.count, amount: a.amount } : { count: a.count, taxExclusive: a.taxExclusive, tax: a.tax };
  // Construit à la main plutôt que par new Map(entries) : un projet non strict
  // (SILLON) n'infère pas les paires [clé, valeur] d'un .map() et refuse l'appel.
  const index = (rows: EReport['aggregates']): Map<string, Row> => {
    const m = new Map<string, Row>();
    for (const r of rows as unknown as Row[]) m.set(key(r), val(r));
    return m;
  };
  const exp = index(expected);
  const rec = index(received);
  const out: string[] = [];
  for (const [k, v] of exp) {
    const r = rec.get(k);
    if (!r) out.push(`${k} : attendu ${JSON.stringify(v)}, absent chez la PA`);
    else if (JSON.stringify(r) !== JSON.stringify(v)) out.push(`${k} : attendu ${JSON.stringify(v)}, reçu ${JSON.stringify(r)}`);
  }
  for (const [k, r] of rec) if (!exp.has(k)) out.push(`${k} : reçu ${JSON.stringify(r)}, non déclaré ici`);
  return out;
}
