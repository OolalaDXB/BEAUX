/**
 * E-invoicing — orchestrateur de transmission (mandat V1, section D).
 *
 * Cœur PROVIDER-AGNOSTIQUE des flux sortants et entrants, à dépendances
 * injectées (journal, provider, horloge) : il tourne à l'identique sous
 * vitest (MockProvider — tests adversariaux) et dans les edge functions
 * Deno (provider réel). Le connecteur iopole n'est qu'un adaptateur.
 *
 * Garanties portées ICI (et éprouvées par les tests) :
 *   • idempotence : la clé outbound est dérivée du canonique exact
 *     (invoice_id + pdf_hash) — un double submit ne part JAMAIS deux fois ;
 *   • retry sûr : si la soumission provider a réussi mais que l'écriture du
 *     journal a suivi, le rejeu retombe sur la ligne existante (upsert par
 *     clé) — jamais de second envoi ;
 *   • transitions de statut légales uniquement (canTransition) — un statut
 *     provider inconnu ou régressif n'écrase jamais un état terminal ;
 *   • webhooks/polls dupliqués = no-op (même statut) ;
 *   • le document transmis EST le canonique SILLON (octets du bucket,
 *     vérifiés contre facturx_pdf_hash avant envoi) ;
 *   • entrants : dédup par clé inbound(provider, provider_document_id) —
 *     un document rejoué n'est jamais ré-ingéré ;
 *   • AUCUN secret ni payload sensible ne transite par le journal.
 */

import {
  type EInvoicingProvider,
  type EInvoicingStatus,
  type IncomingDocument,
  type OutboundDocument,
  ProviderRejectedError,
  canTransition,
  outboundIdempotencyKey,
  inboundIdempotencyKey,
} from './provider';

// ============================================================================
// Dépendances injectées
// ============================================================================

export interface TransmissionRecord {
  id: string;
  tenant_id: string;
  direction: 'outbound' | 'inbound';
  invoice_id: string | null;
  supplier_invoice_id: string | null;
  provider: string;
  provider_document_id: string | null;
  provider_status: string | null;
  internal_status: EInvoicingStatus;
  idempotency_key: string;
  retries: number;
  rejection_reason: string | null;
}

/** Journal einvoicing_transmissions — implémenté sur Supabase (service_role). */
export interface TransmissionJournal {
  findByIdempotencyKey(tenantId: string, key: string): Promise<TransmissionRecord | null>;
  /** Insertion qui ÉCHOUE si la clé existe déjà (contrainte DB) — jamais d'upsert silencieux. */
  insert(record: Omit<TransmissionRecord, 'id'> & {
    submitted_at?: string | null;
    last_status_at?: string | null;
    evidence_ref?: string | null;
    evidence_path?: string | null;
    received_at?: string | null;
  }): Promise<TransmissionRecord>;
  update(id: string, patch: Partial<{
    provider_document_id: string | null;
    provider_status: string | null;
    internal_status: EInvoicingStatus;
    submitted_at: string | null;
    delivered_at: string | null;
    accepted_at: string | null;
    rejected_at: string | null;
    last_status_at: string | null;
    retries: number;
    rejection_reason: string | null;
    evidence_ref: string | null;
    evidence_path: string | null;
  }>): Promise<void>;
}

/** Facture prête à transmettre — le canonique est OBLIGATOIRE. */
export interface OutboundInvoiceRef {
  tenantId: string;
  invoiceId: string;
  invoiceNumber: string;
  docType: 'invoice' | 'credit_note';
  pdfHash: string;
  xmlHash: string;
  recipientSiren?: string | null;
  recipientVatNumber?: string | null;
  /** Octets du canonique, lus depuis le bucket customer-invoices. */
  loadCanonicalPdf(): Promise<Uint8Array>;
}

export class EInvoicingError extends Error {
  readonly code:
    | 'NO_CANONICAL'
    | 'CANONICAL_HASH_MISMATCH'
    | 'ALREADY_SUBMITTED'
    | 'ILLEGAL_TRANSITION'
    | 'UNKNOWN_PROVIDER_DOCUMENT'
    | 'UNKNOWN_OUTCOME';
  constructor(code: EInvoicingError['code'], message: string) {
    super(message);
    this.name = 'EInvoicingError';
    this.code = code;
  }
}

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

// ============================================================================
// Outbound
// ============================================================================

export interface SubmitResult {
  transmissionId: string;
  providerDocumentId: string;
  internalStatus: EInvoicingStatus;
  /** true si l'appel a été absorbé par l'idempotence (rien renvoyé au provider). */
  deduplicated: boolean;
  /** true si une issue inconnue a été résolue par réconciliation (id adopté). */
  reconciled?: boolean;
  /** Motif quand la PA a répondu un refus certain à l'envoi. */
  rejectionReason?: string | null;
}

/** Octets vérifiés contre le hash + document provider prêt à l'envoi. */
async function loadVerifiedDoc(invoice: OutboundInvoiceRef): Promise<OutboundDocument> {
  const pdfBytes = await invoice.loadCanonicalPdf();
  const actualHash = await sha256Hex(pdfBytes);
  if (actualHash !== invoice.pdfHash) {
    throw new EInvoicingError(
      'CANONICAL_HASH_MISMATCH',
      `Canonique ${invoice.invoiceNumber} : hash stocké ${invoice.pdfHash} ≠ fichier ${actualHash} — transmission refusée`,
    );
  }
  return {
    tenantId: invoice.tenantId,
    invoiceId: invoice.invoiceId,
    docType: invoice.docType,
    invoiceNumber: invoice.invoiceNumber,
    pdfBytes,
    pdfHash: invoice.pdfHash,
    xmlHash: invoice.xmlHash,
    recipientSiren: invoice.recipientSiren,
    recipientVatNumber: invoice.recipientVatNumber,
  };
}

/**
 * Soumet le document canonique d'une facture/avoir à la PA.
 * Rejouable sans danger : double clic, retry après timeout, worker dupliqué —
 * un seul envoi provider possible par canonique.
 *
 * JOURNAL-FIRST : la ligne de journal est RÉSERVÉE (GENERATED, sans id
 * provider) AVANT l'appel réseau. Conséquences :
 *   • deux workers concurrents ne peuvent JAMAIS envoyer deux fois — seul le
 *     gagnant de la réservation appelle le provider ;
 *   • un timeout/panne APRÈS l'envoi laisse une trace « issue inconnue »
 *     (GENERATED + provider_document_id NULL) : iopole n'ayant pas de clé
 *     d'idempotence, le document a PU être accepté sans que la réponse nous
 *     parvienne. Une tentative ultérieure ne ré-envoie JAMAIS aveuglément :
 *     elle passe par reconcileOutbound (recherche côté PA + comparaison du
 *     hash de l'ORIGINAL re-téléchargé) — id adopté si le document a bien été
 *     pris, re-soumission seulement s'il est prouvé absent. Si le connecteur
 *     ne sait pas réconcilier, la re-soumission automatique est REFUSÉE
 *     (EInvoicingError UNKNOWN_OUTCOME, décision humaine).
 */
export async function submitOutbound(
  journal: TransmissionJournal,
  provider: EInvoicingProvider,
  invoice: OutboundInvoiceRef,
  now: () => Date = () => new Date(),
): Promise<SubmitResult> {
  if (!invoice.pdfHash) {
    throw new EInvoicingError('NO_CANONICAL', `Facture ${invoice.invoiceNumber} sans canonique figé`);
  }
  const key = outboundIdempotencyKey(invoice.invoiceId, invoice.pdfHash);

  // 1) Idempotence AVANT tout appel réseau.
  const existing = await journal.findByIdempotencyKey(invoice.tenantId, key);
  if (existing) {
    if (existing.internal_status === 'REJECTED') {
      // Re-soumission après rejet certain : transition légale, même record.
      const doc = await loadVerifiedDoc(invoice);
      return performSend(journal, provider, doc, existing, existing.retries + 1, now);
    }
    if (existing.internal_status === 'GENERATED' && !existing.provider_document_id) {
      // Issue INCONNUE d'une tentative précédente : réconcilier avant tout.
      return resolveUnknownOutcome(journal, provider, invoice, existing, now);
    }
    return {
      transmissionId: existing.id,
      providerDocumentId: existing.provider_document_id ?? '',
      internalStatus: existing.internal_status,
      deduplicated: true,
    };
  }

  // 2) Le document transmis EST le canonique — vérifié octets contre hash.
  const doc = await loadVerifiedDoc(invoice);

  // 3) RÉSERVATION journal-first. Si l'insert échoue sur la clé (course entre
  //    deux workers passés ensemble à l'étape 1), le perdant relit la ligne
  //    gagnante et n'envoie RIEN.
  let record: TransmissionRecord;
  try {
    record = await journal.insert({
      tenant_id: invoice.tenantId,
      direction: 'outbound',
      invoice_id: invoice.invoiceId,
      supplier_invoice_id: null,
      provider: provider.slug,
      provider_document_id: null,
      provider_status: null,
      internal_status: 'GENERATED',
      idempotency_key: key,
      retries: 0,
      rejection_reason: null,
      last_status_at: now().toISOString(),
    });
  } catch (e) {
    const winner = await journal.findByIdempotencyKey(invoice.tenantId, key);
    if (winner) {
      return {
        transmissionId: winner.id,
        providerDocumentId: winner.provider_document_id ?? '',
        internalStatus: winner.internal_status,
        deduplicated: true,
      };
    }
    throw e;
  }

  // 4) Envoi + enregistrement de l'issue.
  return performSend(journal, provider, doc, record, 0, now);
}

/** Envoie le document et journalise l'issue (ACK / rejet certain / inconnue). */
async function performSend(
  journal: TransmissionJournal,
  provider: EInvoicingProvider,
  doc: OutboundDocument,
  record: TransmissionRecord,
  retries: number,
  now: () => Date,
): Promise<SubmitResult> {
  try {
    const result =
      doc.docType === 'credit_note'
        ? await provider.sendCreditNote(doc, record.idempotency_key)
        : await provider.sendInvoice(doc, record.idempotency_key);
    await journal.update(record.id, {
      provider_document_id: result.providerDocumentId,
      provider_status: result.providerStatus,
      internal_status: result.internalStatus,
      retries,
      rejection_reason: null,
      submitted_at: now().toISOString(),
      last_status_at: now().toISOString(),
      evidence_ref: result.evidenceRef ?? null,
    });
    return {
      transmissionId: record.id,
      providerDocumentId: result.providerDocumentId,
      internalStatus: result.internalStatus,
      deduplicated: false,
    };
  } catch (e) {
    if (e instanceof ProviderRejectedError) {
      // Refus CERTAIN (réponse reçue) : REJECTED avec motif — retry légal.
      const at = now().toISOString();
      await journal.update(record.id, {
        provider_document_id: null,
        provider_status: 'REJECTED',
        internal_status: 'REJECTED',
        retries,
        rejection_reason: e.reason,
        rejected_at: at,
        last_status_at: at,
      });
      return {
        transmissionId: record.id,
        providerDocumentId: '',
        internalStatus: 'REJECTED',
        deduplicated: false,
        rejectionReason: e.reason,
      };
    }
    // Issue INCONNUE (timeout, panne réseau, 5xx…) : la réservation reste
    // marquée GENERATED sans id provider — aucune re-soumission automatique
    // ne sera possible sans réconciliation préalable.
    await journal.update(record.id, {
      provider_document_id: null,
      provider_status: 'UNKNOWN_OUTCOME',
      internal_status: 'GENERATED',
      retries,
      last_status_at: now().toISOString(),
    });
    throw new EInvoicingError(
      'UNKNOWN_OUTCOME',
      `Envoi ${doc.invoiceNumber} : issue inconnue (${e instanceof Error ? e.message : e}). ` +
        `Le document a pu être accepté par la PA — la prochaine tentative réconciliera avant tout ré-envoi.`,
    );
  }
}

/**
 * Résout une issue inconnue : réconciliation déterministe côté PA (numéro +
 * hash de l'original re-téléchargé), adoption de l'id si le document a été
 * pris, re-soumission SEULEMENT s'il est prouvé absent.
 */
async function resolveUnknownOutcome(
  journal: TransmissionJournal,
  provider: EInvoicingProvider,
  invoice: OutboundInvoiceRef,
  record: TransmissionRecord,
  now: () => Date,
): Promise<SubmitResult> {
  if (!provider.reconcileOutbound) {
    throw new EInvoicingError(
      'UNKNOWN_OUTCOME',
      `Envoi ${invoice.invoiceNumber} : issue inconnue et connecteur « ${provider.slug} » sans ` +
        `réconciliation déterministe — re-soumission automatique INTERDITE (décision humaine requise).`,
    );
  }
  const found = await provider.reconcileOutbound(invoice.invoiceNumber, invoice.pdfHash);
  if (found) {
    // Le document AVAIT été accepté : on adopte son id, zéro ré-envoi.
    const at = now().toISOString();
    await journal.update(record.id, {
      provider_document_id: found.providerDocumentId,
      provider_status: 'SUBMITTED',
      internal_status: 'SUBMITTED',
      submitted_at: at,
      last_status_at: at,
      evidence_ref: found.providerDocumentId,
    });
    return {
      transmissionId: record.id,
      providerDocumentId: found.providerDocumentId,
      internalStatus: 'SUBMITTED',
      deduplicated: true,
      reconciled: true,
    };
  }
  // Prouvé absent côté PA : la re-soumission est sûre (même réservation).
  const doc = await loadVerifiedDoc(invoice);
  return performSend(journal, provider, doc, record, record.retries, now);
}

// ============================================================================
// Statuts (poll / webhook)
// ============================================================================

export interface StatusUpdateOutcome {
  applied: boolean;
  reason: 'updated' | 'duplicate' | 'illegal_transition';
}

/**
 * Applique un statut provider (poll OU webhook) sur une transmission.
 * Un événement dupliqué (même statut) est un no-op ; une transition illégale
 * (ex. régression depuis ACCEPTED) est REFUSÉE et signalée — jamais appliquée.
 */
export async function applyStatusUpdate(
  journal: TransmissionJournal,
  record: TransmissionRecord,
  update: {
    internalStatus: EInvoicingStatus;
    providerStatus: string;
    rejectionReason?: string | null;
    statusAt?: string | null;
  },
  now: () => Date = () => new Date(),
): Promise<StatusUpdateOutcome> {
  if (update.internalStatus === record.internal_status) {
    return { applied: false, reason: 'duplicate' };
  }
  if (!canTransition(record.internal_status, update.internalStatus)) {
    return { applied: false, reason: 'illegal_transition' };
  }
  const at = update.statusAt ?? now().toISOString();
  await journal.update(record.id, {
    internal_status: update.internalStatus,
    provider_status: update.providerStatus,
    last_status_at: at,
    ...(update.internalStatus === 'DELIVERED' ? { delivered_at: at } : {}),
    ...(update.internalStatus === 'ACCEPTED' ? { accepted_at: at } : {}),
    ...(update.internalStatus === 'REJECTED'
      ? { rejected_at: at, rejection_reason: update.rejectionReason ?? null }
      : {}),
  });
  return { applied: true, reason: 'updated' };
}

// ============================================================================
// Inbound
// ============================================================================

export interface InboundIngestOutcome {
  providerDocumentId: string;
  outcome: 'ingested' | 'duplicate';
  transmissionId: string;
}

/**
 * Enregistre un document entrant dans le journal (RECEIVED) puis délègue
 * l'ingestion métier (E-core : original immuable, hash, dédup, REVIEW) au
 * callback `ingest`. Un document provider déjà vu (clé inbound) est un no-op
 * — le webhook/poll rejoué ne ré-ingère jamais.
 */
export async function ingestInbound(
  journal: TransmissionJournal,
  providerSlug: string,
  tenantId: string,
  doc: IncomingDocument,
  ingest: (doc: IncomingDocument) => Promise<{
    supplierInvoiceId: string | null;
    /** true = revue humaine requise même sans facture créée (fournisseur
     *  non rapproché, conflit de dédup…) — jamais d'auto-validation. */
    requiresReview?: boolean;
  }>,
  now: () => Date = () => new Date(),
): Promise<InboundIngestOutcome> {
  const key = inboundIdempotencyKey(providerSlug, doc.providerDocumentId);
  const existing = await journal.findByIdempotencyKey(tenantId, key);
  if (existing) {
    return { providerDocumentId: doc.providerDocumentId, outcome: 'duplicate', transmissionId: existing.id };
  }

  const { supplierInvoiceId, requiresReview } = await ingest(doc);
  try {
    const record = await journal.insert({
      tenant_id: tenantId,
      direction: 'inbound',
      invoice_id: null,
      supplier_invoice_id: supplierInvoiceId,
      provider: providerSlug,
      provider_document_id: doc.providerDocumentId,
      provider_status: doc.providerStatus ?? null,
      internal_status: supplierInvoiceId || requiresReview ? 'REVIEW_REQUIRED' : 'RECEIVED',
      idempotency_key: key,
      retries: 0,
      rejection_reason: null,
      last_status_at: now().toISOString(),
    });
    return { providerDocumentId: doc.providerDocumentId, outcome: 'ingested', transmissionId: record.id };
  } catch (e) {
    const winner = await journal.findByIdempotencyKey(tenantId, key);
    if (winner) {
      return { providerDocumentId: doc.providerDocumentId, outcome: 'duplicate', transmissionId: winner.id };
    }
    throw e;
  }
}
