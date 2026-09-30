/**
 * Connecteur B2Brouter — provider #2 (mandat « Sandbox Proof », §4).
 *
 * Implémente le MÊME contrat EInvoicingProvider que iopole, derrière le MÊME
 * orchestrateur : la preuve recherchée est que le cœur ne bouge pas quand le
 * provider change. Copie BYTE-IDENTIQUE partagée entre les fonctions
 * einvoicing-* (garantie par facturx-shared-sync.test.ts).
 *
 * Source de vérité des endpoints : OpenAPI « B2Brouter API » v2026-06-26
 * (https://app.b2brouter.net/api/v20260626/bundled/openapi.yaml) + guides
 * officiels docs.b2brouter.net / developer.b2brouter.net, lus le 09/09/2026.
 * Points structurels — et écarts avec iopole, ASSUMÉS dans cet adaptateur :
 *   • auth : clé API statique (header X-B2B-API-Key) — pas d'OAuth ; le
 *     routage sandbox est porté par le PRÉFIXE de la clé (`test_`), même URL
 *     de base que la production ;
 *   • envoi : POST /accounts/{id}/invoices/import?send_after_import=true,
 *     corps = octets BRUTS du document, Content-Type application/octet-stream
 *     (EXIGÉ par l'endpoint import — constaté en sandbox : application/pdf
 *     renvoie 406 ; B2Brouter renifle lui-même Factur-X/CII/UBL du contenu) ;
 *     notre canonique part tel quel, 380 comme 381 ; SYNCHRONE : 201 →
 *     représentation complète { invoice: { id, state } } ;
 *   • statuts : GET /invoices/{id} → state (new/sending/sent/registered/…),
 *     mappé par b2brouter-mapping.ts (l'état BRUT est conservé) ; motif de
 *     refus dans refuse_reason[_code], erreurs de validation dans errors[] ;
 *   • entrants : GET /accounts/{id}/invoices?type=ReceivedInvoice&ack=false,
 *     téléchargement de l'ORIGINAL via GET /invoices/{id}/as/original,
 *     acquittement POST /invoices/{id}/ack — appelé par l'orchestrateur
 *     APRÈS persistance uniquement ;
 *   • ⚠️ pas de clé d'idempotence côté API (comme iopole) : la garantie
 *     « jamais deux envois » est portée à 100 % par le journal SILLON.
 *     Réconciliation déterministe : filtre `number` de la liste (préfixe —
 *     l'égalité stricte est REvérifiée ici) + hash de l'original re-téléchargé.
 *
 * Configuration EXCLUSIVEMENT par secrets d'edge function — jamais dans le
 * repo, les logs ni une table :
 *   B2BROUTER_API_KEY     (obligatoire — sandbox `test_…` attendu)
 *   B2BROUTER_ACCOUNT_ID  (obligatoire — id du compte société côté provider)
 *   B2BROUTER_BASE_URL    (défaut : https://api.b2brouter.net)
 *   B2BROUTER_API_VERSION (défaut : 2026-06-26, header X-B2B-API-Version)
 * GARDE-FOU ARGENT (mandat §2, sandbox-only) : une clé qui ne commence pas
 * par `test_` est REFUSÉE (connecteur inerte) tant que B2BROUTER_ALLOW_LIVE
 * n'est pas explicitement posé à 'true' — la production ne peut pas être
 * atteinte par accident. En cas d'erreur API, seul le code HTTP et le corps
 * d'erreur métier tronqué sont remontés — jamais la clé.
 */

import {
  type DocumentStatusResult,
  type EInvoicingProvider,
  type IncomingDocument,
  type OutboundDocument,
  type SubmissionResult,
  ProviderRejectedError,
} from './provider';
import { mapB2BrouterState, sniffIncomingFormat } from './b2brouter-mapping';

const sha256HexLocal = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const DEFAULT_BASE_URL = 'https://api.b2brouter.net';
const DEFAULT_API_VERSION = '2026-06-26';

export interface B2BrouterConfig {
  baseUrl: string;
  apiKey: string;
  accountId: string;
  apiVersion: string;
  /** true si la clé porte le préfixe sandbox `test_` (diagnostic). */
  sandboxKey: boolean;
  /** false = import crée seulement (state new) sans transmettre (défaut true). */
  sendAfterImport: boolean;
}

interface EnvReader {
  get(key: string): string | undefined;
}

/** null si clé API / account id manquent — la fonction répond alors 503. */
export function readB2BrouterConfig(env: EnvReader): B2BrouterConfig | null {
  const apiKey = env.get('B2BROUTER_API_KEY');
  const accountId = env.get('B2BROUTER_ACCOUNT_ID');
  if (!apiKey || !accountId) return null;
  return {
    baseUrl: (env.get('B2BROUTER_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey,
    accountId,
    apiVersion: env.get('B2BROUTER_API_VERSION') ?? DEFAULT_API_VERSION,
    sandboxKey: apiKey.startsWith('test_'),
    // Défaut : transmet à l'import (submit = import + envoi). Un déploiement
    // « créer puis relire avant d'envoyer » peut poser B2BROUTER_SEND_AFTER_IMPORT=false.
    sendAfterImport: env.get('B2BROUTER_SEND_AFTER_IMPORT') !== 'false',
  };
}

export class B2BrouterApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    detail?: string,
  ) {
    super(`b2brouter ${operation} : HTTP ${status}${detail ? ` — ${detail}` : ''}`);
    this.name = 'B2BrouterApiError';
  }
}

/** Représentation facture B2Brouter (sous-ensemble exploité). */
interface B2BrouterInvoice {
  id: number | string;
  type?: string;
  number?: string | null;
  state?: string;
  state_updated_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  refuse_reason?: string | null;
  refuse_reason_code?: string | null;
  errors?: string[] | null;
}

export class B2BrouterProvider implements EInvoicingProvider {
  readonly slug = 'b2brouter';

  constructor(private readonly cfg: B2BrouterConfig) {}

  private async api(operation: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('X-B2B-API-Key', this.cfg.apiKey);
    headers.set('X-B2B-API-Version', this.cfg.apiVersion);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    const res = await fetch(`${this.cfg.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) {
      // Corps d'erreur métier B2Brouter ({errors:[…]}), exploitable et sans
      // secret — tronqué par prudence.
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new B2BrouterApiError(operation, res.status, detail);
    }
    return res;
  }

  // ------------------------------------------------------------------ outbound

  private async send(doc: OutboundDocument): Promise<SubmissionResult> {
    let res: Response;
    try {
      res = await this.api(
        'POST invoices/import',
        `/accounts/${this.cfg.accountId}/invoices/import?send_after_import=${this.cfg.sendAfterImport ? 'true' : 'false'}`,
        {
          method: 'POST',
          // octet-stream EXIGÉ (application/pdf → 406) ; B2Brouter renifle le format.
          headers: { 'Content-Type': 'application/octet-stream' },
          body: doc.pdfBytes as unknown as BodyInit,
        },
      );
    } catch (e) {
      // Classification pour l'orchestrateur : une réponse 4xx (hors 408/429)
      // est un refus CERTAIN prononcé par le provider ; tout le reste
      // (timeout, panne, 5xx, 408/429) est une issue INCONNUE — le document
      // a pu être accepté sans que la réponse nous parvienne.
      if (
        e instanceof B2BrouterApiError &&
        e.status >= 400 &&
        e.status < 500 &&
        e.status !== 408 &&
        e.status !== 429
      ) {
        throw new ProviderRejectedError(e.message);
      }
      throw e;
    }
    const body = (await res.json()) as { invoice?: B2BrouterInvoice };
    const invoice = body.invoice;
    if (!invoice?.id) throw new Error('b2brouter POST invoices/import : réponse sans invoice.id');
    const state = invoice.state ?? 'new';
    return {
      providerDocumentId: String(invoice.id),
      providerStatus: state,
      // État inconnu → on N'INVENTE PAS : SUBMITTED (le poll tranchera).
      internalStatus: mapB2BrouterState(state) ?? 'SUBMITTED',
      evidenceRef: String(invoice.id),
    };
  }

  /** 380 et 381 passent par le même endpoint : le TypeCode est DANS le document. */
  sendInvoice(doc: OutboundDocument, _idempotencyKey: string): Promise<SubmissionResult> {
    return this.send(doc);
  }

  sendCreditNote(doc: OutboundDocument, _idempotencyKey: string): Promise<SubmissionResult> {
    return this.send(doc);
  }

  /**
   * Réconciliation DÉTERMINISTE après issue inconnue (mandat §10) : l'API
   * B2Brouter n'ayant pas de clé d'idempotence, la primitive la plus forte
   * documentée est le filtre `number` de GET /accounts/{id}/invoices —
   * recherche par PRÉFIXE d'après l'OpenAPI, donc l'égalité stricte du
   * numéro est revérifiée ici, puis la preuve est le hash de l'ORIGINAL
   * re-téléchargé (GET /invoices/{id}/as/original, repli /as/legal). Un
   * document trouvé avec le hash exact ⇒ id adopté ; rien trouvé ⇒ prouvé
   * absent ; candidat invérifiable ⇒ l'issue RESTE inconnue (jamais de
   * ré-envoi sur un doute).
   */
  async reconcileOutbound(
    invoiceNumber: string,
    pdfHash: string,
  ): Promise<{ providerDocumentId: string } | null> {
    const seen = new Set<string>();
    let unverifiable = 0;
    let offset = 0;
    for (let page = 0; page < 10; page++) {
      const res = await this.api(
        'GET invoices (reconcile)',
        `/accounts/${this.cfg.accountId}/invoices?type=IssuedInvoice` +
          `&number=${encodeURIComponent(invoiceNumber)}&limit=100&offset=${offset}`,
      );
      const body = (await res.json()) as {
        invoices?: B2BrouterInvoice[];
        total_count?: number;
      };
      const rows = body.invoices ?? [];
      for (const row of rows) {
        const id = String(row.id);
        if (seen.has(id)) continue;
        seen.add(id);
        // Filtre provider = préfixe : on exige l'égalité stricte du numéro.
        if (row.number !== invoiceNumber) continue;
        // Vérification irréfutable : l'ORIGINAL re-téléchargé doit avoir
        // EXACTEMENT les octets du canonique.
        try {
          const bytes = await this.downloadOriginal(id);
          if ((await sha256HexLocal(bytes)) === pdfHash) {
            return { providerDocumentId: id };
          }
        } catch {
          // Original momentanément indisponible : candidat invérifiable —
          // jamais adopté, mais on ne pourra pas non plus conclure « absent ».
          unverifiable++;
        }
      }
      const total = body.total_count ?? rows.length;
      offset += 100;
      if (offset >= total || rows.length === 0) break;
    }
    if (unverifiable > 0) {
      // Un candidat au bon numéro n'a pas pu être vérifié : on ne peut PAS
      // conclure « absent » — l'issue reste inconnue, pas de ré-envoi.
      throw new B2BrouterApiError(
        'reconcileOutbound',
        409,
        `${unverifiable} candidat(s) ${invoiceNumber} invérifiable(s) — issue toujours inconnue`,
      );
    }
    return null;
  }

  /**
   * Octets ORIGINAUX d'un document (émis importé ou reçu) :
   * /as/original d'abord (fichier tel qu'importé/reçu), repli /as/legal
   * (document légal archivé, disponible après envoi).
   */
  private async downloadOriginal(providerDocumentId: string): Promise<Uint8Array> {
    try {
      const res = await this.api(
        'GET as/original',
        `/invoices/${providerDocumentId}/as/original`,
        { headers: { Accept: '*/*' } },
      );
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (e instanceof B2BrouterApiError && (e.status === 404 || e.status === 422)) {
        const res = await this.api(
          'GET as/legal',
          `/invoices/${providerDocumentId}/as/legal`,
          { headers: { Accept: '*/*' } },
        );
        return new Uint8Array(await res.arrayBuffer());
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------- statuts

  async getInvoice(providerDocumentId: string): Promise<B2BrouterInvoice> {
    const res = await this.api('GET invoice', `/invoices/${providerDocumentId}`);
    const body = (await res.json()) as { invoice?: B2BrouterInvoice };
    if (!body.invoice) {
      throw new B2BrouterApiError('GET invoice', 404, `document ${providerDocumentId} sans corps`);
    }
    return body.invoice;
  }

  async getDocumentStatus(providerDocumentId: string): Promise<DocumentStatusResult> {
    const invoice = await this.getInvoice(providerDocumentId);
    const state = invoice.state ?? '';
    const internal = mapB2BrouterState(state);
    // Motif exploitable : refus métier (refuse_reason[_code]) ou erreurs de
    // validation/transmission (errors[]) — jamais un dump technique.
    const refusal = [invoice.refuse_reason_code, invoice.refuse_reason]
      .filter(Boolean)
      .join(': ');
    const validation = (invoice.errors ?? []).filter(Boolean).join(' · ');
    const reason = [refusal, validation].filter(Boolean).join(' · ') || null;
    return {
      providerDocumentId,
      providerStatus: state,
      // État inconnu → on N'INVENTE PAS de transition : on renvoie l'état
      // le plus faible (SUBMITTED) que l'orchestrateur traitera en no-op.
      internalStatus: internal ?? 'SUBMITTED',
      rejectionReason: internal === 'REJECTED' ? reason : null,
      statusAt: invoice.state_updated_at ?? invoice.updated_at ?? null,
    };
  }

  // ------------------------------------------------------------------ entrants

  /**
   * Entrants non acquittés : liste type=ReceivedInvoice (les documents ÉMIS
   * n'y figurent jamais — filtrage par type côté provider, contrairement à
   * iopole où le flux notSeen mélange les deux sens), puis téléchargement de
   * l'ORIGINAL. Les documents REÇUS ne sont JAMAIS acquittés ici :
   * l'orchestrateur acquitte après persistance.
   */
  async fetchIncomingDocuments(): Promise<IncomingDocument[]> {
    const res = await this.api(
      'GET invoices (incoming)',
      `/accounts/${this.cfg.accountId}/invoices?type=ReceivedInvoice&ack=false&limit=50`,
    );
    const body = (await res.json()) as { invoices?: B2BrouterInvoice[] };
    const incoming: IncomingDocument[] = [];
    for (const row of body.invoices ?? []) {
      const id = String(row.id);
      const bytes = await this.downloadOriginal(id);
      const format = sniffIncomingFormat(bytes);
      const ext = format === 'facturx' ? 'pdf' : format === 'unknown' ? 'bin' : 'xml';
      incoming.push({
        providerDocumentId: id,
        format,
        originalBytes: bytes,
        originalFilename: `${row.number ?? id}.${ext}`,
        providerStatus: row.state ?? 'RECEIVED',
        receivedAt: row.created_at ?? null,
        senderIdentity: null, // l'identité vendeur est extraite de l'ORIGINAL
      });
    }
    return incoming;
  }

  async acknowledgeIncomingDocument(providerDocumentId: string): Promise<void> {
    await this.api('POST ack', `/invoices/${providerDocumentId}/ack`, { method: 'POST' });
  }

  // ------------------------------------------- opérations pilote / entrants (acheteur)

  /**
   * Statut côté acheteur (accepted/refused/paid/annotated) sur un document
   * reçu — POST /invoices/{id}/mark_as, avec motif structuré DGFiP optionnel
   * (reason_code, ex. MONTANTTOTAL_ERR) sur un refus.
   */
  async markAs(
    providerDocumentId: string,
    state: string,
    reason?: string,
    reasonCode?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = { state };
    if (reason) body.reason = reason;
    if (reasonCode) body.reason_code = reasonCode;
    await this.api('POST mark_as', `/invoices/${providerDocumentId}/mark_as`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** Comptes de l'espace courant (diagnostic connectivité — jamais de secret). */
  async listAccounts(): Promise<unknown> {
    const res = await this.api('GET accounts', '/accounts?limit=25');
    return await res.json();
  }

  /**
   * Sonde d'import BRUTE — OUTILLAGE PILOTE uniquement : importe des octets
   * avec contrôle explicite de send_after_import et de issued (émise/reçue),
   * et renvoie le statut + le corps EXACT (jamais tronqué) pour diagnostiquer
   * la négociation de l'API. Sert aussi à INJECTER un document entrant
   * (issued=false) là où la sandbox ne simule pas la réception réseau.
   */
  async importProbe(
    bytes: Uint8Array,
    opts: { send?: boolean; issued?: boolean; contentType?: string } = {},
  ): Promise<{ status: number; body: unknown }> {
    const qs = new URLSearchParams();
    if (opts.send !== undefined) qs.set('send_after_import', opts.send ? 'true' : 'false');
    if (opts.issued !== undefined) qs.set('issued', opts.issued ? 'true' : 'false');
    const headers = new Headers();
    headers.set('X-B2B-API-Key', this.cfg.apiKey);
    headers.set('X-B2B-API-Version', this.cfg.apiVersion);
    headers.set('Accept', 'application/json');
    headers.set('Content-Type', opts.contentType ?? 'application/octet-stream');
    const res = await fetch(
      `${this.cfg.baseUrl}/accounts/${this.cfg.accountId}/invoices/import?${qs.toString()}`,
      { method: 'POST', headers, body: bytes as unknown as BodyInit },
    );
    const t = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      parsed = t.slice(0, 1500);
    }
    return { status: res.status, body: parsed };
  }

  /**
   * Appel API brut authentifié — OUTILLAGE PILOTE uniquement (invoqué par la
   * fonction einvoicing-pilot, gardée par la clé service). Sert à explorer
   * la sandbox (contacts de test, webhooks…) sans redéployer ; jamais
   * utilisé par les flux de production.
   */
  async rawCall(
    method: string,
    path: string,
    payload?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const init: RequestInit = { method };
    if (payload !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(payload);
    }
    const res = await this.api(`${method} ${path}`, path, init);
    const t = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      parsed = t.trim();
    }
    return { status: res.status, body: parsed };
  }
}

export type B2BrouterResolution =
  | { provider: B2BrouterProvider; reason: null }
  | { provider: null; reason: string };

/** Résout le connecteur B2Brouter — null (503) tant que la config manque. */
export function getConfiguredB2BrouterProvider(env: EnvReader): B2BrouterResolution {
  const cfg = readB2BrouterConfig(env);
  if (!cfg) {
    return {
      provider: null,
      reason:
        'PA non configurée : secrets B2BROUTER_API_KEY / B2BROUTER_ACCOUNT_ID absents — ' +
        'le connecteur reste inerte en attendant les credentials.',
    };
  }
  // GARDE-FOU ARGENT (mandat §2) : sandbox-only tant que le déblocage
  // production n'est pas EXPLICITE — une clé prod_ ne part jamais par accident.
  if (!cfg.sandboxKey && env.get('B2BROUTER_ALLOW_LIVE') !== 'true') {
    return {
      provider: null,
      reason:
        'B2BROUTER_API_KEY n\'est pas une clé sandbox (préfixe test_) et ' +
        'B2BROUTER_ALLOW_LIVE n\'est pas posé — connecteur inerte (mandat sandbox-only).',
    };
  }
  return { provider: new B2BrouterProvider(cfg), reason: null };
}

/**
 * Résolution de BOOTSTRAP — OUTILLAGE PILOTE uniquement (jamais les flux de
 * production) : clé API seule, sans B2BROUTER_ACCOUNT_ID, pour créer le
 * compte société via l'API (POST /accounts, rawCall) AVANT de poser l'id en
 * secret. Le GARDE-FOU ARGENT (clé sandbox `test_` exigée) s'applique à
 * l'identique.
 */
export function getBootstrapB2BrouterProvider(env: EnvReader): B2BrouterResolution {
  const apiKey = env.get('B2BROUTER_API_KEY');
  if (!apiKey) {
    return { provider: null, reason: 'B2BROUTER_API_KEY absent — bootstrap impossible.' };
  }
  if (!apiKey.startsWith('test_') && env.get('B2BROUTER_ALLOW_LIVE') !== 'true') {
    return {
      provider: null,
      reason:
        'B2BROUTER_API_KEY n\'est pas une clé sandbox (préfixe test_) et ' +
        'B2BROUTER_ALLOW_LIVE n\'est pas posé — connecteur inerte (mandat sandbox-only).',
    };
  }
  return {
    provider: new B2BrouterProvider({
      baseUrl: (env.get('B2BROUTER_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
      apiKey,
      accountId: env.get('B2BROUTER_ACCOUNT_ID') ?? '',
      apiVersion: env.get('B2BROUTER_API_VERSION') ?? DEFAULT_API_VERSION,
      sandboxKey: apiKey.startsWith('test_'),
      sendAfterImport: env.get('B2BROUTER_SEND_AFTER_IMPORT') !== 'false',
    }),
    reason: null,
  };
}
