/**
 * iopole — mapping PUR des référentiels provider vers le modèle interne
 * SILLON (mandat V1, sections D et G). Module sans I/O, testé sous vitest,
 * copié byte-identique dans les edge functions einvoicing-* (test de sync).
 *
 * Source de vérité : OpenAPI « Invoicing operator Iopole API » v1.0.0
 * (https://api.ppd.iopole.fr/v1/api/operator/invoicing, lu le 07/09/2026).
 *
 * Décisions de mapping (documentées au rapport §L) :
 *   • SUBMITTED/ISSUED → SUBMITTED (pris en charge côté émission) ;
 *   • RECEIVED/MADE_AVAILABLE/IN_HAND → DELIVERED (parvenu côté acheteur) ;
 *   • DISPUTED/SUSPENDED → DELIVERED : ce sont des états NON terminaux du
 *     référentiel réforme (un litige peut se résoudre en APPROVED) ; le
 *     modèle interne n'a pas d'état « litige », on reste donc à DELIVERED —
 *     le code provider BRUT est conservé tel quel dans provider_status,
 *     aucune information n'est perdue ;
 *   • APPROVED/PARTIALLY_APPROVED/COMPLETED/PAYMENT_SENT/PAYMENT_RECEIVED
 *     → ACCEPTED (les événements de paiement arrivant après ACCEPTED sont
 *     des no-ops côté transitions, le brut reste journalisé) ;
 *   • REFUSED/REJECTED/UNACCEPTABLE → REJECTED ;
 *   • code inconnu → null : on n'invente JAMAIS de transition.
 */

import type { EInvoicingStatus } from './provider';

/** Référentiel des statuts du cycle de vie iopole (réforme FR). */
export const IOPOLE_STATUS_CODES = [
  'SUBMITTED',
  'ISSUED',
  'RECEIVED',
  'MADE_AVAILABLE',
  'IN_HAND',
  'APPROVED',
  'PARTIALLY_APPROVED',
  'DISPUTED',
  'SUSPENDED',
  'COMPLETED',
  'REFUSED',
  'PAYMENT_SENT',
  'PAYMENT_RECEIVED',
  'REJECTED',
  'UNACCEPTABLE',
] as const;

export type IopoleStatusCode = (typeof IOPOLE_STATUS_CODES)[number];

const STATUS_MAP: Record<IopoleStatusCode, EInvoicingStatus> = {
  SUBMITTED: 'SUBMITTED',
  ISSUED: 'SUBMITTED',
  RECEIVED: 'DELIVERED',
  MADE_AVAILABLE: 'DELIVERED',
  IN_HAND: 'DELIVERED',
  DISPUTED: 'DELIVERED',
  SUSPENDED: 'DELIVERED',
  APPROVED: 'ACCEPTED',
  PARTIALLY_APPROVED: 'ACCEPTED',
  COMPLETED: 'ACCEPTED',
  PAYMENT_SENT: 'ACCEPTED',
  PAYMENT_RECEIVED: 'ACCEPTED',
  REFUSED: 'REJECTED',
  REJECTED: 'REJECTED',
  UNACCEPTABLE: 'REJECTED',
};

/** Statut interne pour un code iopole — null si le code est inconnu. */
export function mapIopoleStatus(code: string): EInvoicingStatus | null {
  return (STATUS_MAP as Record<string, EInvoicingStatus>)[code] ?? null;
}

/**
 * Formats annoncés par GET /v1/invoice/{id} (originalFormat).
 * Constaté en sandbox : l'API renvoie « FacturX » (CamelCase) là où l'OpenAPI
 * annonce « FACTURX » — la comparaison est donc insensible à la casse.
 */
export function mapIopoleFormat(format: string): 'facturx' | 'cii-xml' | 'ubl' | 'unknown' {
  switch (format.toUpperCase()) {
    case 'FACTURX':
      return 'facturx';
    case 'CII':
      return 'cii-xml';
    case 'UBL':
      return 'ubl';
    default:
      return 'unknown';
  }
}
