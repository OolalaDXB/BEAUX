/**
 * Connecteur iopole — implémentation RÉELLE (mandat V1, section D).
 *
 * Provider pilote validé au human gate §C : iopole (PA immatriculée n°0018).
 * Fallback officiel : B2BRouter. Copie BYTE-IDENTIQUE partagée entre les
 * fonctions einvoicing-* (garantie par facturx-shared-sync.test.ts).
 *
 * Source de vérité des endpoints : OpenAPI « Invoicing operator Iopole API »
 * et « Configuration operator Iopole API » v1.0.0 (docs.ppd.iopole.fr,
 * lus le 07/09/2026). Points structurels :
 *   • auth : OAuth2 client_credentials (Keycloak) ;
 *   • envoi : POST /v1/invoice en multipart (le fichier EST le document —
 *     notre canonique Factur-X part tel quel, 380 comme 381) ; asynchrone,
 *     201 → { id } = provider_document_id à conserver ;
 *   • statuts : GET /v1/invoice/{id}/status-history — codes du référentiel
 *     réforme, mappés par iopole-mapping.ts (le code BRUT est conservé) ;
 *   • entrants (mode PULL) : GET /v1/invoice/notSeen → ids ; métadonnées
 *     (way EMITTED/RECEIVED) ; téléchargement de l'ORIGINAL ; acquittement
 *     PUT /v1/invoice/{id}/markAsSeen — appelé par l'orchestrateur APRÈS
 *     persistance uniquement ;
 *   • ⚠️ l'API iopole n'expose PAS de clé d'idempotence : la garantie
 *     « jamais deux envois » est portée à 100 % par le journal SILLON
 *     (idempotence AVANT réseau dans l'orchestrateur) — documenté §L.
 *
 * Configuration EXCLUSIVEMENT par secrets d'edge function — jamais dans le
 * repo, les logs ni une table :
 *   IOPOLE_CLIENT_ID / IOPOLE_CLIENT_SECRET   (obligatoires)
 *   IOPOLE_BASE_URL   (défaut : sandbox https://api.ppd.iopole.fr)
 *   IOPOLE_TOKEN_URL  (défaut : Keycloak preprod)
 *   IOPOLE_CUSTOMER_ID (optionnel — header customer-id multi-tenant)
 * Les défauts pointent la SANDBOX : la production exigera des URLs
 * explicites, jamais l'inverse. En cas d'échec OAuth, seul le code HTTP est
 * remonté — jamais le corps ni les credentials.
 */

import {
  type DocumentStatusResult,
  type EInvoicingProvider,
  type IncomingDocument,
  type OutboundDocument,
  type SubmissionResult,
  ProviderRejectedError,
} from './provider';
import { mapIopoleStatus, mapIopoleFormat } from './iopole-mapping';

const sha256HexLocal = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const SANDBOX_BASE_URL = 'https://api.ppd.iopole.fr';
const SANDBOX_TOKEN_URL =
  'https://auth.preprod.iopole.fr/realms/iopole/protocol/openid-connect/token';

export interface IopoleConfig {
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  customerId: string | null;
  /** true si base/token viennent des défauts sandbox (diagnostic). */
  sandboxDefaults: boolean;
}

interface EnvReader {
  get(key: string): string | undefined;
}

/** null si client id/secret manquent — la fonction répond alors 503. */
export function readIopoleConfig(env: EnvReader): IopoleConfig | null {
  const clientId = env.get('IOPOLE_CLIENT_ID');
  const clientSecret = env.get('IOPOLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  const baseUrl = env.get('IOPOLE_BASE_URL');
  const tokenUrl = env.get('IOPOLE_TOKEN_URL');
  return {
    baseUrl: (baseUrl ?? SANDBOX_BASE_URL).replace(/\/+$/, ''),
    tokenUrl: tokenUrl ?? SANDBOX_TOKEN_URL,
    clientId,
    clientSecret,
    customerId: env.get('IOPOLE_CUSTOMER_ID') ?? null,
    sandboxDefaults: !baseUrl || !tokenUrl,
  };
}

export class IopoleApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    detail?: string,
  ) {
    super(`iopole ${operation} : HTTP ${status}${detail ? ` — ${detail}` : ''}`);
    this.name = 'IopoleApiError';
  }
}

interface IopoleStatusItem {
  statusId: string;
  date: string;
  status: { code: string };
  json?: {
    notes?: Array<{ content?: string }>;
    responses?: Array<{
      // Constaté en sandbox : rejectionDetail est un objet {reason, message} ;
      // la forme {errors: [...]} des specs est conservée par tolérance.
      rejectionDetail?: {
        reason?: string;
        message?: string;
        errors?: Array<{ reason?: string; detail?: string; message?: string }>;
      };
    }>;
  };
}

interface IopoleInvoiceMeta {
  invoiceId: string;
  date: string;
  originalFormat: string;
  way: 'RECEIVED' | 'EMITTED';
  businessData?: { invoiceId?: string };
}

export class IopoleProvider implements EInvoicingProvider {
  readonly slug = 'iopole';
  private token: { value: string; expiresAtMs: number } | null = null;

  constructor(private readonly cfg: IopoleConfig) {}

  private tokenRequest(mode: 'post' | 'basic'): Promise<Response> {
    const params = new URLSearchParams({ grant_type: 'client_credentials' });
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (mode === 'post') {
      params.set('client_id', this.cfg.clientId);
      params.set('client_secret', this.cfg.clientSecret);
    } else {
      // client_secret_basic (RFC 6749 §2.3.1) : credentials dans le header.
      headers['Authorization'] = 'Basic ' + btoa(`${this.cfg.clientId}:${this.cfg.clientSecret}`);
    }
    return fetch(this.cfg.tokenUrl, { method: 'POST', headers, body: params });
  }

  /**
   * OAuth2 client_credentials — jamais de corps de réponse dans l'erreur.
   * Essaie client_secret_post (défaut Keycloak) puis client_secret_basic :
   * certains clients confidentiels n'acceptent qu'une des deux formes.
   */
  protected async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAtMs - 30_000 > Date.now()) {
      return this.token.value;
    }
    let res = await this.tokenRequest('post');
    if (res.status === 400 || res.status === 401) {
      res = await this.tokenRequest('basic');
    }
    if (!res.ok) {
      throw new IopoleApiError('OAuth2', res.status);
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('iopole OAuth2 : réponse sans access_token');
    this.token = {
      value: body.access_token,
      expiresAtMs: Date.now() + (body.expires_in ?? 300) * 1000,
    };
    return this.token.value;
  }

  private async api(operation: string, path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.accessToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (this.cfg.customerId) headers.set('customer-id', this.cfg.customerId);
    const res = await fetch(`${this.cfg.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) {
      // Le corps d'erreur iopole est un {statusMessage} métier, exploitable
      // et sans secret — tronqué par prudence.
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new IopoleApiError(operation, res.status, detail);
    }
    return res;
  }

  // ------------------------------------------------------------------ outbound

  private async send(doc: OutboundDocument): Promise<SubmissionResult> {
    const isPdf = doc.pdfBytes.length > 4 && doc.pdfBytes[0] === 0x25; // '%PDF'
    const form = new FormData();
    form.append(
      'file',
      new Blob([doc.pdfBytes as BlobPart], {
        type: isPdf ? 'application/pdf' : 'application/xml',
      }),
      `${doc.invoiceNumber}.${isPdf ? 'pdf' : 'xml'}`,
    );
    let res: Response;
    try {
      res = await this.api('POST /v1/invoice', '/v1/invoice', {
        method: 'POST',
        body: form,
      });
    } catch (e) {
      // Classification pour l'orchestrateur : une réponse 4xx (hors 408/429)
      // est un refus CERTAIN prononcé par la PA ; tout le reste (timeout,
      // panne, 5xx, 408/429) est une issue INCONNUE — le document a pu être
      // accepté sans que la réponse nous parvienne.
      if (
        e instanceof IopoleApiError &&
        e.status >= 400 &&
        e.status < 500 &&
        e.status !== 408 &&
        e.status !== 429
      ) {
        throw new ProviderRejectedError(e.message);
      }
      throw e;
    }
    const body = (await res.json()) as { id: string; type: string };
    if (!body.id) throw new Error('iopole POST /v1/invoice : réponse sans id');
    return {
      providerDocumentId: body.id,
      providerStatus: 'SUBMITTED',
      internalStatus: 'SUBMITTED',
      evidenceRef: body.id,
    };
  }

  /**
   * Réconciliation DÉTERMINISTE après issue inconnue (mandat V1 §I, preuve
   * « accepté provider / timeout client ») : l'API iopole n'ayant pas de clé
   * d'idempotence, on cherche si le document a déjà été pris, puis on VÉRIFIE
   * par le hash de l'ORIGINAL re-téléchargé — la recherche n'a besoin que de
   * rappel, la preuve est le hash. Requête ciblée sur le numéro d'abord ;
   * repli : balayage paginé des documents ÉMIS (borné). Un document trouvé
   * avec le hash exact ⇒ id adopté ; rien trouvé ⇒ prouvé absent.
   */
  async reconcileOutbound(
    invoiceNumber: string,
    pdfHash: string,
  ): Promise<{ providerDocumentId: string } | null> {
    const queries = [
      `businessData.invoiceId:"${invoiceNumber}"`,
      `invoice.direction:"OUTBOUND"`,
    ];
    const seen = new Set<string>();
    let unverifiable = 0;
    for (const q of queries) {
      let offset = 0;
      let targetedWorked = true;
      for (let page = 0; page < 10; page++) {
        let body: {
          data?: Array<{
            metadata?: { invoiceId?: string; direction?: string };
            businessData?: { invoiceId?: string };
          }>;
          meta?: { count?: number };
        };
        try {
          const res = await this.api(
            'GET search',
            `/v1.1/invoice/search?q=${encodeURIComponent(q)}&expand=businessData&limit=200&offset=${offset}`,
          );
          body = await res.json();
        } catch {
          // Syntaxe de champ refusée par la PA : on passe au repli.
          targetedWorked = false;
          break;
        }
        const rows = body.data ?? [];
        for (const row of rows) {
          const id = row.metadata?.invoiceId;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          if (row.businessData?.invoiceId !== invoiceNumber) continue;
          if (row.metadata?.direction === 'INBOUND') continue;
          // Vérification irréfutable : l'ORIGINAL re-téléchargé doit avoir
          // EXACTEMENT les octets du canonique.
          try {
            const dl = await this.api('GET download', `/v1/invoice/${id}/download`);
            const bytes = new Uint8Array(await dl.arrayBuffer());
            if ((await sha256HexLocal(bytes)) === pdfHash) {
              return { providerDocumentId: id };
            }
          } catch {
            // Original momentanément indisponible : candidat invérifiable —
            // jamais adopté, mais on ne pourra pas non plus conclure « absent ».
            unverifiable++;
          }
        }
        const count = body.meta?.count ?? rows.length;
        offset += 200;
        if (offset >= count || rows.length === 0) break;
      }
      if (targetedWorked && q === queries[0]) {
        // La requête ciblée a répondu : son verdict (trouvé ou non) suffit,
        // pas besoin du balayage large.
        break;
      }
    }
    if (unverifiable > 0) {
      // Un candidat au bon numéro n'a pas pu être vérifié : on ne peut PAS
      // conclure « absent » — l'issue reste inconnue, pas de ré-envoi.
      throw new IopoleApiError(
        'reconcileOutbound',
        409,
        `${unverifiable} candidat(s) ${invoiceNumber} invérifiable(s) — issue toujours inconnue`,
      );
    }
    return null;
  }

  /** 380 et 381 passent par le même endpoint : le TypeCode est DANS le document. */
  sendInvoice(doc: OutboundDocument, _idempotencyKey: string): Promise<SubmissionResult> {
    return this.send(doc);
  }

  sendCreditNote(doc: OutboundDocument, _idempotencyKey: string): Promise<SubmissionResult> {
    return this.send(doc);
  }

  // ------------------------------------------------------------------- statuts

  async getStatusHistory(providerDocumentId: string): Promise<IopoleStatusItem[]> {
    const res = await this.api(
      'GET status-history',
      `/v1/invoice/${providerDocumentId}/status-history`,
    );
    return (await res.json()) as IopoleStatusItem[];
  }

  async getDocumentStatus(providerDocumentId: string): Promise<DocumentStatusResult> {
    const history = await this.getStatusHistory(providerDocumentId);
    if (!Array.isArray(history) || history.length === 0) {
      return {
        providerDocumentId,
        providerStatus: 'SUBMITTED',
        internalStatus: 'SUBMITTED',
      };
    }
    const latest = [...history].sort((a, b) => (a.date < b.date ? -1 : 1)).at(-1)!;
    const code = latest.status?.code ?? '';
    const internal = mapIopoleStatus(code);
    // Motif exploitable : notes + détails de rejet éventuels.
    const notes = (latest.json?.notes ?? [])
      .map((n) => n.content)
      .filter(Boolean)
      .join(' · ');
    const rejectErrors = (latest.json?.responses ?? [])
      .flatMap((r) => {
        const d = r.rejectionDetail;
        if (!d) return [];
        const flat = [d.reason, d.message].filter(Boolean).join(': ');
        const errs = (d.errors ?? []).map((e) =>
          [e.reason, e.message ?? e.detail].filter(Boolean).join(': '),
        );
        return [flat, ...errs].filter(Boolean);
      })
      .join(' · ');
    const reason = [notes, rejectErrors].filter(Boolean).join(' · ') || null;
    return {
      providerDocumentId,
      providerStatus: code,
      // Code inconnu → on N'INVENTE PAS de transition : on renvoie l'état
      // le plus faible (SUBMITTED) que l'orchestrateur traitera en no-op.
      internalStatus: internal ?? 'SUBMITTED',
      rejectionReason: internal === 'REJECTED' ? reason : null,
      statusAt: latest.date ?? null,
    };
  }

  // ------------------------------------------------------------------ entrants

  async getInvoiceMeta(providerDocumentId: string): Promise<IopoleInvoiceMeta> {
    const res = await this.api('GET invoice meta', `/v1/invoice/${providerDocumentId}`);
    const body = (await res.json()) as IopoleInvoiceMeta | IopoleInvoiceMeta[];
    // Constaté en sandbox : la réponse est un TABLEAU de flux (streams) —
    // on retient celui qui porte l'id demandé (repli : le premier).
    if (Array.isArray(body)) {
      const hit = body.find((m) => m?.invoiceId === providerDocumentId) ?? body[0];
      if (!hit) {
        throw new IopoleApiError('GET invoice meta', 404, `document ${providerDocumentId} sans flux`);
      }
      return hit;
    }
    return body;
  }

  /**
   * Mode PULL : notSeen → métadonnées → téléchargement de l'ORIGINAL.
   * Les documents ÉMIS (nos propres envois, way=EMITTED) sont acquittés
   * silencieusement — ils ne sont pas des entrants. Les documents REÇUS ne
   * sont JAMAIS acquittés ici : l'orchestrateur acquitte après persistance.
   */
  async fetchIncomingDocuments(): Promise<IncomingDocument[]> {
    const res = await this.api('GET notSeen', '/v1/invoice/notSeen');
    const ids = (await res.json()) as string[];
    const incoming: IncomingDocument[] = [];
    for (const id of ids) {
      const meta = await this.getInvoiceMeta(id);
      if (meta.way === 'EMITTED') {
        await this.acknowledgeIncomingDocument(id);
        continue;
      }
      const dl = await this.api('GET download', `/v1/invoice/${id}/download`);
      const bytes = new Uint8Array(await dl.arrayBuffer());
      const format = mapIopoleFormat(meta.originalFormat ?? '');
      const ext = format === 'facturx' ? 'pdf' : format === 'unknown' ? 'bin' : 'xml';
      incoming.push({
        providerDocumentId: id,
        format,
        originalBytes: bytes,
        originalFilename: `${meta.businessData?.invoiceId ?? id}.${ext}`,
        providerStatus: 'RECEIVED',
        receivedAt: meta.date ?? null,
        senderIdentity: null, // l'identité vendeur est extraite de l'ORIGINAL
      });
    }
    return incoming;
  }

  async acknowledgeIncomingDocument(providerDocumentId: string): Promise<void> {
    await this.api('PUT markAsSeen', `/v1/invoice/${providerDocumentId}/markAsSeen`, {
      method: 'PUT',
    });
  }

  // ------------------------------------------- opérations pilote / entrants (acheteur)

  /** Statut côté acheteur (IN_HAND/APPROVED/REFUSED…) sur un document reçu. */
  async sendBuyerStatus(
    providerDocumentId: string,
    code: string,
    message?: string,
    rejectionReason?: string,
  ): Promise<{ id: string }> {
    const body: Record<string, unknown> = { code };
    if (message) body.message = message;
    if (rejectionReason) body.rejectionDetail = { reason: rejectionReason, message };
    const res = await this.api(
      'POST invoice status',
      `/v1/invoice/${providerDocumentId}/status`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    return (await res.json()) as { id: string };
  }

  /** Id client opérateur courant (config API) — renvoyé en texte brut. */
  async getCustomerId(): Promise<unknown> {
    const res = await this.api('GET customer id', '/v1/config/customer/id');
    const t = await res.text();
    try {
      return JSON.parse(t);
    } catch {
      return t.trim();
    }
  }

  /** Annuaire interne de l'opérateur (entités business gérées). */
  async listBusinessEntities(): Promise<unknown> {
    const res = await this.api('GET business entities', '/v1/config/business/entity?limit=50');
    return await res.json();
  }

  /**
   * Appel API brut authentifié — OUTILLAGE PILOTE uniquement (invoqué par la
   * fonction einvoicing-pilot, gardée par la clé service). Sert à explorer
   * les endpoints de configuration sandbox (claim, annuaire…) sans
   * redéployer ; jamais utilisé par les flux de production.
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

  /** Enrôlement d'une entité française (sandbox : registrationStrategy AUTO). */
  async enrollFrench(payload: Record<string, unknown>): Promise<unknown> {
    const res = await this.api('POST french enrollment', '/v1/config/french/enrollment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await res.json();
  }
}

export type ProviderResolution =
  | { provider: IopoleProvider; reason: null }
  | { provider: null; reason: string };

/** Résout le provider PA configuré — null (503) tant que les secrets manquent. */
export function getConfiguredProvider(env: EnvReader): ProviderResolution {
  const cfg = readIopoleConfig(env);
  if (!cfg) {
    return {
      provider: null,
      reason:
        'PA non configurée : secrets IOPOLE_CLIENT_ID / IOPOLE_CLIENT_SECRET absents — ' +
        'le connecteur reste inerte en attendant les credentials.',
    };
  }
  return { provider: new IopoleProvider(cfg), reason: null };
}
