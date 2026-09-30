/**
 * E-invoicing entrant — logique PURE de rapprochement fournisseur et de
 * déduplication (mandat V1, section E, étapes 6 et 8).
 *
 * Fonctions sans I/O, testables exhaustivement. Les règles :
 *   • rapprochement fournisseur par n° TVA, puis SIREN/SIRET, puis nom exact
 *     (insensible à la casse) — dans cet ordre, jamais de fuzzy silencieux ;
 *   • déduplication sur (fournisseur + n° de facture) ET sur le hash du
 *     fichier :
 *       - même n° + même hash  → DOUBLON (ignorer, ne rien créer) ;
 *       - même n° + hash différent → CONFLIT (REVIEW obligatoire — un
 *         fournisseur qui renvoie un fichier différent sous le même numéro
 *         n'écrase JAMAIS silencieusement l'existant) ;
 *       - même hash sous un autre n° → DOUBLON (même fichier re-déposé) ;
 *   • aucun paiement automatique, aucune validation comptable automatique :
 *     tout entrant naît en REVIEW (imposé par l'appelant, rappelé ici).
 */

import type { ParsedIncomingInvoice } from './facturx-parse';

export interface SupplierCandidate {
  id: string;
  name: string;
  vat_number?: string | null;
  siren?: string | null;
  siret?: string | null;
}

export type SupplierMatch =
  | { kind: 'matched'; supplierId: string; matchedBy: 'vat_number' | 'siren' | 'siret' | 'exact_name' }
  | { kind: 'unmatched' };

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s/g, '').toUpperCase();

/** Rapprochement fournisseur — identifiants fiscaux d'abord, nom exact en dernier. */
export function matchSupplier(
  parsed: Pick<ParsedIncomingInvoice, 'seller'>,
  candidates: SupplierCandidate[],
): SupplierMatch {
  const vat = norm(parsed.seller.vatNumber);
  if (vat) {
    const hit = candidates.find((c) => norm(c.vat_number) === vat);
    if (hit) return { kind: 'matched', supplierId: hit.id, matchedBy: 'vat_number' };
  }
  const siren = norm(parsed.seller.siren);
  if (siren) {
    const hit = candidates.find(
      (c) => norm(c.siren) === siren || norm(c.siret).slice(0, 9) === siren,
    );
    if (hit) return { kind: 'matched', supplierId: hit.id, matchedBy: 'siren' };
  }
  const siret = norm(parsed.seller.siret);
  if (siret) {
    const hit = candidates.find((c) => norm(c.siret) === siret);
    if (hit) return { kind: 'matched', supplierId: hit.id, matchedBy: 'siret' };
  }
  const name = (parsed.seller.name ?? '').trim().toLowerCase();
  if (name) {
    const hits = candidates.filter((c) => c.name.trim().toLowerCase() === name);
    // Un nom ambigu (0 ou >1) ne matche pas : la revue humaine tranchera.
    if (hits.length === 1) return { kind: 'matched', supplierId: hits[0].id, matchedBy: 'exact_name' };
  }
  return { kind: 'unmatched' };
}

export interface ExistingInvoiceRef {
  id: string;
  supplier_id: string;
  invoice_number: string;
  received_file_hash?: string | null;
}

export type DedupVerdict =
  | { kind: 'new' }
  | { kind: 'duplicate'; existingId: string; reason: 'same_number_same_hash' | 'same_hash' }
  | { kind: 'conflict'; existingId: string; reason: 'same_number_different_hash' };

/**
 * Verdict de déduplication pour un document entrant (fournisseur résolu).
 * `existing` = les factures de CE fournisseur (tenant courant).
 * L'appelant ne crée que sur 'new' ; 'conflict' part en REVIEW sans écraser.
 */
export function dedupVerdict(
  invoiceNumber: string,
  fileHash: string,
  existing: ExistingInvoiceRef[],
): DedupVerdict {
  const sameNumber = existing.find(
    (e) => e.invoice_number.trim().toUpperCase() === invoiceNumber.trim().toUpperCase(),
  );
  if (sameNumber) {
    if (sameNumber.received_file_hash && sameNumber.received_file_hash === fileHash) {
      return { kind: 'duplicate', existingId: sameNumber.id, reason: 'same_number_same_hash' };
    }
    return { kind: 'conflict', existingId: sameNumber.id, reason: 'same_number_different_hash' };
  }
  const sameHash = existing.find((e) => e.received_file_hash && e.received_file_hash === fileHash);
  if (sameHash) {
    return { kind: 'duplicate', existingId: sameHash.id, reason: 'same_hash' };
  }
  return { kind: 'new' };
}
