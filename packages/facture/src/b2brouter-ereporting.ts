/**
 * E-reporting via B2Brouter — flux 10, France (DGFiP).
 *
 * Source : OpenAPI « B2Brouter API » v2026-06-26, lue le 30/09/2026 (spec
 * complète, 489 Ko). Le modèle de B2Brouter N'EST PAS « on lui pousse des
 * agrégats » : la déclaration est DÉRIVÉE de ce qui vit chez lui.
 *   • Réglage société, une fois : Tax Report Setting `dgfip`
 *     (PUT /accounts/{account}/tax_report_settings/dgfip) — `vat_regime`
 *     (reel_normal_mensuel | reel_normal_trimestriel | simplifie |
 *     franchise_en_base, qui fixe la périodicité, identique à ereporting.ts),
 *     `type_operation` (services | goods | mixed), `enterprise_size`,
 *     `naf_code`, `auto_generate` / `auto_send` (défaut true),
 *     `reason_vat_exempt` (défaut VATEX-FR-FRANCHISE).
 *   • TRANSACTIONS (10.1 / 10.3) : générées automatiquement à partir des
 *     factures émises par le compte — y compris B2C — et agrégées par
 *     B2Brouter en « Ledgers » transmis à la période. La vente B2C passe donc
 *     par le MÊME import de facture que le flux 1 (B2BrouterProvider.send).
 *   • PAIEMENTS (10.2 / 10.4) : POST /accounts/{account}/payments
 *     { payment: { invoice_id, amount, date, payment_method, reference } } —
 *     « a cross-border or B2C payment creates an F10 payment tax report »
 *     (un paiement domestique B2B émet un CDV 212). Seul `amount` est déclaré
 *     encaissé ; un escompte ne l'est jamais.
 *   • Suivi : GET /accounts/{account}/tax_reports?invoice_id=… → `state`
 *     (new, processing, sending, sent, acknowledged, deposited, registered,
 *     registered_with_errors, error, refused, invalid, annulled…) ;
 *     GET /ledgers/{id}, /ledgers/{id}/download (XML transmis),
 *     /ledgers/{id}/download_response (réponse de l'administration).
 *
 * ⚠️ POST /payments n'a PAS de clé d'idempotence. La garantie « un
 * encaissement n'est déclaré qu'une fois » est portée ici : la `reference`
 * du paiement est l'identifiant de l'encaissement chez l'hôte, et avant tout
 * POST on liste les paiements de la facture (GET …/payments?invoice_id=) :
 * s'il existe déjà sous cette référence, on le renvoie sans rien créer.
 *
 * Même configuration et même GARDE-FOU ARGENT que le connecteur flux 1
 * (clé `test_` exigée tant que B2BROUTER_ALLOW_LIVE n'est pas posé).
 */

import { B2BrouterApiError, readB2BrouterConfig, type B2BrouterConfig } from './b2brouter';
import type { EReportStatus, EReportingVatRegime } from './ereporting';

interface EnvReader {
  get(key: string): string | undefined;
}

/**
 * `vat_regime` du Tax Report Setting dgfip. B2Brouter précise : `simplifie`
 * est supprimé le 01/01/2027 — ses valeurs sont ensuite traitées comme
 * `reel_normal_trimestriel` (même périodicité mensuelle).
 */
export const B2B_VAT_REGIME: Record<EReportingVatRegime, string> = {
  reel_normal_mensuel: 'reel_normal_mensuel',
  reel_normal_trimestriel: 'reel_normal_trimestriel',
  reel_simplifie: 'simplifie',
  franchise: 'franchise_en_base',
};

/** Code B2Brouter du moyen de paiement (BT-81, table interne B2Brouter). */
export const B2B_PAYMENT_METHOD = {
  cash: 1,
  direct_debit: 2,
  bank_transfer: 4,
  cheque: 11,
  other: 13,
  bank_card: 19,
  credit_card: 54,
  sepa_transfer: 58,
  sepa_direct_debit: 59,
} as const;
export type B2BPaymentMethodKey = keyof typeof B2B_PAYMENT_METHOD;

export interface B2BrouterPayment {
  id: number;
  invoice_id: number;
  amount: number;
  currency?: string;
  date?: string;
  payment_method?: number | null;
  reference?: string | null;
}

export interface B2BrouterTaxReport {
  id: number;
  state: string;
  ledger_id?: number | null;
  fiscal_period?: string | null;
  [k: string]: unknown;
}

/** État B2Brouter d'un rapport → statut interne. L'état brut est conservé à côté. */
export function mapB2BrouterTaxReportState(state: string): { status: EReportStatus; warnings: boolean } {
  switch (state) {
    case 'registered':
      return { status: 'ACCEPTED', warnings: false };
    case 'registered_with_errors':
      return { status: 'ACCEPTED', warnings: true };
    case 'error':
    case 'refused':
    case 'invalid':
    case 'annulled':
      return { status: 'REJECTED', warnings: false };
    case 'new':
      return { status: 'GENERATED', warnings: false };
    default: // processing, signed, sending, sent, acknowledged, deposited, clearing, annullating
      return { status: 'SUBMITTED', warnings: false };
  }
}

export class B2BrouterEReporting {
  readonly slug = 'b2brouter';

  constructor(
    private readonly cfg: B2BrouterConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async api<T>(operation: string, path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('X-B2B-API-Key', this.cfg.apiKey);
    headers.set('X-B2B-API-Version', this.cfg.apiVersion);
    headers.set('Accept', 'application/json');
    const res = await this.fetchFn(`${this.cfg.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new B2BrouterApiError(operation, res.status, detail);
    }
    return (await res.json()) as T;
  }

  /**
   * Le réglage e-reporting de la société (Tax Report Setting `dgfip`) — lu,
   * jamais écrit ici : l'activer publie la société à l'annuaire DGFiP (propagé
   * en 24 h), c'est une décision de l'exploitant, prise dans l'interface
   * B2Brouter. null si le compte n'en a pas.
   */
  async taxReportSetting(): Promise<Record<string, unknown> | null> {
    try {
      const body = await this.api<{ tax_report_setting?: Record<string, unknown> }>(
        'GET tax_report_settings/dgfip',
        `/accounts/${this.cfg.accountId}/tax_report_settings/dgfip`,
      );
      return body.tax_report_setting ?? null;
    } catch (e) {
      if (e instanceof B2BrouterApiError && e.status === 404) return null;
      throw e;
    }
  }

  /** Paiements enregistrés sur une facture B2Brouter. */
  async paymentsForInvoice(invoiceId: number): Promise<B2BrouterPayment[]> {
    const body = await this.api<{ payments?: B2BrouterPayment[] }>(
      'GET payments',
      `/accounts/${this.cfg.accountId}/payments?invoice_id=${encodeURIComponent(String(invoiceId))}&limit=100`,
    );
    return body.payments ?? [];
  }

  /**
   * Enregistre un encaissement sur la facture — ce qui déclenche, pour une
   * vente B2C ou internationale, le rapport de paiement F10. `reference` =
   * identifiant de l'encaissement chez l'hôte : c'est la clé de dédoublonnage.
   */
  async recordPayment(p: {
    invoiceId: number;
    reference: string;
    amount: number;
    /** Jour de l'encaissement (YYYY-MM-DD, jour civil à Paris). */
    date: string;
    method: B2BPaymentMethodKey;
    methodText?: string | null;
  }): Promise<{ payment: B2BrouterPayment; created: boolean }> {
    if (!p.reference) throw new Error('recordPayment : référence d\'encaissement obligatoire (clé de dédoublonnage)');
    if (!(p.amount > 0)) throw new Error('recordPayment : montant > 0 attendu');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new Error('recordPayment : date YYYY-MM-DD attendue');
    const existing = (await this.paymentsForInvoice(p.invoiceId)).find((x) => x.reference === p.reference);
    if (existing) return { payment: existing, created: false };
    const body = await this.api<{ payment: B2BrouterPayment }>('POST payments', `/accounts/${this.cfg.accountId}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment: {
          invoice_id: p.invoiceId,
          amount: Math.round(p.amount * 100) / 100,
          date: p.date,
          payment_method: B2B_PAYMENT_METHOD[p.method],
          ...(p.methodText ? { payment_method_text: p.methodText.slice(0, 255) } : {}),
          reference: p.reference.slice(0, 255),
        },
      }),
    });
    return { payment: body.payment, created: true };
  }

  /** Rapports fiscaux d'une facture, avec leur statut interne. */
  async taxReportsForInvoice(invoiceId: number): Promise<(B2BrouterTaxReport & { internalStatus: EReportStatus; warnings: boolean })[]> {
    const body = await this.api<{ tax_reports?: B2BrouterTaxReport[] }>(
      'GET tax_reports',
      `/accounts/${this.cfg.accountId}/tax_reports?invoice_id=${encodeURIComponent(String(invoiceId))}`,
    );
    return (body.tax_reports ?? []).map((r) => {
      const m = mapB2BrouterTaxReportState(String(r.state));
      return { ...r, internalStatus: m.status, warnings: m.warnings };
    });
  }

  /** Cycle de vie d'un Ledger (lot transmis à l'administration). */
  async ledger(ledgerId: number): Promise<Record<string, unknown>> {
    const body = await this.api<{ ledger: Record<string, unknown> }>('GET ledger', `/ledgers/${encodeURIComponent(String(ledgerId))}`);
    return body.ledger;
  }
}

export type B2BrouterEReportingResolution =
  | { client: B2BrouterEReporting; reason: null }
  | { client: null; reason: string };

/** Même résolution et même garde-fou que le connecteur flux 1. */
export function getConfiguredB2BrouterEReporting(env: EnvReader, fetchFn: typeof fetch = fetch): B2BrouterEReportingResolution {
  const cfg = readB2BrouterConfig(env);
  if (!cfg) return { client: null, reason: 'PA non configurée : B2BROUTER_API_KEY / B2BROUTER_ACCOUNT_ID absents.' };
  if (!cfg.sandboxKey && env.get('B2BROUTER_ALLOW_LIVE') !== 'true') {
    return { client: null, reason: 'Clé non sandbox (préfixe test_) sans B2BROUTER_ALLOW_LIVE — connecteur inerte.' };
  }
  return { client: new B2BrouterEReporting(cfg, fetchFn), reason: null };
}
