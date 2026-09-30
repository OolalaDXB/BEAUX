import { describe, it, expect } from 'vitest';
import {
  EINVOICING_STATUSES,
  ALLOWED_TRANSITIONS,
  canTransition,
  outboundIdempotencyKey,
  inboundIdempotencyKey,
} from '../provider';

describe('modèle de statuts internes (G)', () => {
  it('les transitions légales sont fermées sur le référentiel', () => {
    for (const [from, tos] of Object.entries(ALLOWED_TRANSITIONS)) {
      expect(EINVOICING_STATUSES).toContain(from);
      for (const to of tos) expect(EINVOICING_STATUSES).toContain(to);
    }
  });

  it('nominal outbound : GENERATED → SUBMITTED → DELIVERED → ACCEPTED', () => {
    expect(canTransition('GENERATED', 'SUBMITTED')).toBe(true);
    expect(canTransition('SUBMITTED', 'DELIVERED')).toBe(true);
    expect(canTransition('DELIVERED', 'ACCEPTED')).toBe(true);
  });

  it('rejet exploitable puis re-soumission après correction', () => {
    expect(canTransition('SUBMITTED', 'REJECTED')).toBe(true);
    expect(canTransition('REJECTED', 'SUBMITTED')).toBe(true);
  });

  it('adversarial : aucune transition depuis un état terminal', () => {
    expect(canTransition('ACCEPTED', 'REJECTED')).toBe(false);
    expect(canTransition('ACCEPTED', 'SUBMITTED')).toBe(false);
    expect(canTransition('REVIEW_REQUIRED', 'ACCEPTED')).toBe(false);
  });

  it('adversarial : un entrant ne devient jamais un sortant', () => {
    expect(canTransition('RECEIVED', 'SUBMITTED')).toBe(false);
    expect(canTransition('RECEIVED', 'DELIVERED')).toBe(false);
    expect(canTransition('RECEIVED', 'REVIEW_REQUIRED')).toBe(true);
  });
});

describe('clés d’idempotence (B) — aucun double envoi possible', () => {
  it('outbound : même canonique ⇒ même clé (double submit = no-op)', () => {
    expect(outboundIdempotencyKey('inv-1', 'hashA')).toBe(outboundIdempotencyKey('inv-1', 'hashA'));
  });

  it('adversarial : hash différent avec même facture ⇒ clés différentes (canonique altéré détectable)', () => {
    expect(outboundIdempotencyKey('inv-1', 'hashA')).not.toBe(outboundIdempotencyKey('inv-1', 'hashB'));
  });

  it('inbound : même document provider ⇒ même clé (webhook reçu deux fois = no-op)', () => {
    expect(inboundIdempotencyKey('pa-x', 'doc-42')).toBe(inboundIdempotencyKey('pa-x', 'doc-42'));
    expect(inboundIdempotencyKey('pa-x', 'doc-42')).not.toBe(inboundIdempotencyKey('pa-y', 'doc-42'));
  });
});
