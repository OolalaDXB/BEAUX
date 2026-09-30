/**
 * B2Brouter — mapping PUR des référentiels provider vers le modèle interne
 * SILLON (mandat provider #2, sandbox). Module sans I/O, testé sous vitest,
 * copié byte-identique dans les edge functions einvoicing-* (test de sync).
 *
 * Source de vérité : OpenAPI « B2Brouter API » v2026-06-26
 * (https://app.b2brouter.net/api/v20260626/bundled/openapi.yaml, lu le
 * 09/09/2026) + guide DGFiP (developer.b2brouter.net/docs/dgfip) : table
 * « States ↔ CDV for issued invoices ».
 *
 * Décisions de mapping (documentées au rapport §18) :
 *   • new/sending/sent → SUBMITTED : le document est pris en charge côté
 *     émission (l'import B2Brouter crée la facture en `new`, l'envoi est
 *     asynchrone ; `sent` = CDV 200 Déposée) ;
 *   • registered/received/downloaded/read → DELIVERED : parvenu côté
 *     acheteur ou enregistré par le réseau (`read` = CDV 204 Prise en
 *     charge ; `registered` = issue « Registered successfully » du réseau) ;
 *   • annotated → DELIVERED : litige (CDV 207 En litige), état NON terminal —
 *     même décision que DISPUTED chez iopole ; le code provider BRUT est
 *     conservé dans provider_status, aucune information n'est perdue ;
 *   • accepted/allegedly_paid/paid/closed → ACCEPTED (CDV 205/206 puis 212 —
 *     les événements de paiement après ACCEPTED sont des no-ops côté
 *     transitions, le brut reste journalisé) ;
 *   • refused → REJECTED (CDV 210, motif dans refuse_reason[_code]) ;
 *   • error → REJECTED : la validation pré-envoi ou la transmission a échoué,
 *     le champ `errors` porte le motif — le chemin B2Brouter est
 *     « correct-and-resend », exactement notre retry après rejet ;
 *   • invalid → REJECTED (documents dont la validation échoue) ;
 *   • code inconnu → null : on n'invente JAMAIS de transition.
 */

import type { EInvoicingStatus } from './provider';

/** Référentiel des états de facture B2Brouter (cycle de vie émis). */
export const B2BROUTER_STATE_CODES = [
  'new',
  'sending',
  'sent',
  'registered',
  'received',
  'downloaded',
  'read',
  'annotated',
  'accepted',
  'allegedly_paid',
  'paid',
  'closed',
  'refused',
  'error',
  'invalid',
] as const;

export type B2BrouterStateCode = (typeof B2BROUTER_STATE_CODES)[number];

const STATE_MAP: Record<B2BrouterStateCode, EInvoicingStatus> = {
  new: 'SUBMITTED',
  sending: 'SUBMITTED',
  sent: 'SUBMITTED',
  registered: 'DELIVERED',
  received: 'DELIVERED',
  downloaded: 'DELIVERED',
  read: 'DELIVERED',
  annotated: 'DELIVERED',
  accepted: 'ACCEPTED',
  allegedly_paid: 'ACCEPTED',
  paid: 'ACCEPTED',
  closed: 'ACCEPTED',
  refused: 'REJECTED',
  error: 'REJECTED',
  invalid: 'REJECTED',
};

/** Statut interne pour un état B2Brouter — null si l'état est inconnu. */
export function mapB2BrouterState(state: string): EInvoicingStatus | null {
  return (STATE_MAP as Record<string, EInvoicingStatus>)[state] ?? null;
}

/**
 * Détection de format d'un document entrant à partir de ses OCTETS.
 * B2Brouter n'annonce pas de `originalFormat` dans la représentation
 * facture (contrairement à iopole) : le fichier récupéré via
 * GET /invoices/{id}/as/original est sniffé — PDF ⇒ Factur-X potentiel
 * (l'extraction tranchera), XML ⇒ CII ou UBL selon l'élément racine.
 * Fonction pure (pas d'I/O), l'ORIGINAL n'est jamais altéré.
 */
export function sniffIncomingFormat(
  bytes: Uint8Array,
): 'facturx' | 'cii-xml' | 'ubl' | 'unknown' {
  if (
    bytes.length > 4 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 // F
  ) {
    return 'facturx';
  }
  let head = '';
  try {
    head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 4096));
  } catch {
    return 'unknown';
  }
  if (!head.includes('<')) return 'unknown';
  if (head.includes('CrossIndustryInvoice')) return 'cii-xml';
  if (
    head.includes('urn:oasis:names:specification:ubl') ||
    /<(\w+:)?(Invoice|CreditNote)[\s>]/.test(head)
  ) {
    return 'ubl';
  }
  return 'unknown';
}
