/**
 * E-invoicing — abstraction Plateforme Agréée (mandat V1, section B).
 *
 * SILLON ne se couple à AUCUN fournisseur : tout connecteur implémente cette
 * interface, et les statuts propriétaires de la PA sont mappés vers le modèle
 * interne stable ci-dessous (section G). Le reste de l'application ne connaît
 * que ce module — jamais l'API d'une PA.
 *
 * Module sans dépendance (browser / vitest / Deno), comme facturx-xml.ts.
 *
 * Règles non négociables portées par le schéma (einvoicing_transmissions) :
 *   • idempotence : outbound = `outbound:{invoice_id}:{pdf_hash}` — le
 *     document canonique EXACT ; un canonique regénéré (impossible par
 *     ailleurs) ou un double clic ne partent jamais deux fois ;
 *   • un provider_document_id appartient à UN tenant (unicité globale) ;
 *   • le document transmis EST le canonique SILLON (pdf_url du bucket),
 *     jamais un rendu alternatif ;
 *   • preuve : référence + payload archivé en bucket privé — jamais de
 *     secret ni de payload sensible loggé ou stocké en table.
 */

/** Statuts internes SILLON (section G) — l'UI n'affiche RIEN d'autre. */
export const EINVOICING_STATUSES = [
  'GENERATED', // canonique produit, pas encore transmis
  'SUBMITTED', // remis à la PA (accusé technique)
  'DELIVERED', // délivré au destinataire par le réseau
  'ACCEPTED', // accepté par le destinataire / la plateforme
  'REJECTED', // rejeté (technique) ou refusé (métier) — motif exploitable
  'RECEIVED', // entrant : document reçu de la PA
  'REVIEW_REQUIRED', // entrant : en attente de revue humaine (jamais auto-validé)
] as const;

export type EInvoicingStatus = (typeof EINVOICING_STATUSES)[number];

/** Transitions légales — tout le reste est un bug de connecteur. */
export const ALLOWED_TRANSITIONS: Record<EInvoicingStatus, readonly EInvoicingStatus[]> = {
  GENERATED: ['SUBMITTED', 'REJECTED'],
  SUBMITTED: ['DELIVERED', 'ACCEPTED', 'REJECTED'],
  DELIVERED: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: [],
  REJECTED: ['SUBMITTED'], // re-soumission après correction
  RECEIVED: ['REVIEW_REQUIRED'],
  REVIEW_REQUIRED: [],
};

export function canTransition(from: EInvoicingStatus, to: EInvoicingStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Document sortant : TOUJOURS le canonique SILLON, identifié par ses hashes. */
export interface OutboundDocument {
  tenantId: string;
  invoiceId: string;
  /** 'invoice' (380) ou 'credit_note' (381). */
  docType: 'invoice' | 'credit_note';
  invoiceNumber: string;
  /** Octets EXACTS du canonique (bucket customer-invoices) — jamais un rendu alternatif. */
  pdfBytes: Uint8Array;
  pdfHash: string;
  xmlHash: string;
  /** SIREN destinataire pour le routage annuaire (B2B France). */
  recipientSiren?: string | null;
  recipientVatNumber?: string | null;
}

/** Résultat d'une soumission — la référence provider, jamais le payload brut. */
export interface SubmissionResult {
  providerDocumentId: string;
  providerStatus: string;
  /** Statut interne mappé par le connecteur. */
  internalStatus: EInvoicingStatus;
  /** Référence de preuve (id de réponse) — le payload part en bucket, pas en table. */
  evidenceRef?: string | null;
}

export interface DocumentStatusResult {
  providerDocumentId: string;
  providerStatus: string;
  internalStatus: EInvoicingStatus;
  /** Motif de rejet EXPLOITABLE par un utilisateur (pas un dump technique). */
  rejectionReason?: string | null;
  statusAt?: string | null;
  evidenceRef?: string | null;
}

/** Document entrant tel que délivré par la PA — l'original n'est JAMAIS altéré. */
export interface IncomingDocument {
  providerDocumentId: string;
  /** Format annoncé par la PA — le modèle interne ne présume pas du Factur-X. */
  format: 'facturx' | 'cii-xml' | 'ubl' | 'unknown';
  /** Octets ORIGINAUX (PDF ou XML) — archivés immuablement, hash calculé. */
  originalBytes: Uint8Array;
  originalFilename?: string | null;
  providerStatus?: string | null;
  receivedAt?: string | null;
  /** Métadonnées provider utiles au rapprochement (émetteur annoncé…). */
  senderIdentity?: { name?: string; siren?: string; vatNumber?: string } | null;
}

/**
 * Rejet DÉFINITIF prononcé par la PA — une réponse a été reçue et elle dit
 * NON (erreur de validation, destinataire inconnu…). À distinguer d'un échec
 * réseau/timeout/5xx dont l'issue est INCONNUE : le document a pu être
 * accepté sans que la réponse nous parvienne. Les connecteurs ne lèvent
 * cette erreur QUE sur un refus certain ; toute autre erreur d'envoi est
 * traitée par l'orchestrateur comme une issue inconnue (pas de re-soumission
 * automatique sans réconciliation).
 */
export class ProviderRejectedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ProviderRejectedError';
  }
}

/**
 * Contrat de connecteur PA. UN connecteur réel sera implémenté après le
 * human gate (choix du provider) — aucun code propriétaire avant.
 */
export interface EInvoicingProvider {
  /** Slug stable ('mock', puis le provider pilote). */
  readonly slug: string;

  /** Soumet une facture (380). Idempotent côté SILLON via idempotency_key. */
  sendInvoice(doc: OutboundDocument, idempotencyKey: string): Promise<SubmissionResult>;

  /** Soumet un avoir (381). Même contrat. */
  sendCreditNote(doc: OutboundDocument, idempotencyKey: string): Promise<SubmissionResult>;

  /**
   * Réconciliation DÉTERMINISTE après issue inconnue (timeout/panne APRÈS un
   * envoi peut-être accepté) : dit si un document portant ce numéro ET ces
   * octets exacts (hash du canonique, vérifié en re-téléchargeant l'original
   * côté PA) existe déjà chez le provider. Optionnelle : un connecteur qui ne
   * sait pas réconcilier ne la fournit pas, et l'orchestrateur REFUSE alors
   * toute re-soumission automatique (décision humaine requise).
   */
  reconcileOutbound?(
    invoiceNumber: string,
    pdfHash: string,
  ): Promise<{ providerDocumentId: string } | null>;

  /** Interroge le statut d'un document transmis. */
  getDocumentStatus(providerDocumentId: string): Promise<DocumentStatusResult>;

  /** Récupère les documents entrants non encore acquittés. */
  fetchIncomingDocuments(): Promise<IncomingDocument[]>;

  /** Acquitte un entrant (ne sera plus servi par fetchIncomingDocuments). */
  acknowledgeIncomingDocument(providerDocumentId: string): Promise<void>;
}

/** Clé d'idempotence outbound : le canonique exact, rien d'autre. */
export function outboundIdempotencyKey(invoiceId: string, pdfHash: string): string {
  return `outbound:${invoiceId}:${pdfHash}`;
}

/** Clé d'idempotence inbound : le document provider, rien d'autre. */
export function inboundIdempotencyKey(provider: string, providerDocumentId: string): string {
  return `inbound:${provider}:${providerDocumentId}`;
}
