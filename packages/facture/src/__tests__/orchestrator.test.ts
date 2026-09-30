import { describe, it, expect } from 'vitest';
import {
  submitOutbound,
  applyStatusUpdate,
  ingestInbound,
  EInvoicingError,
  type TransmissionJournal,
  type TransmissionRecord,
  type OutboundInvoiceRef,
} from '../orchestrator';
import {
  type EInvoicingProvider,
  type OutboundDocument,
  type SubmissionResult,
  type IncomingDocument,
  ProviderRejectedError,
} from '../provider';

/**
 * Suite ADVERSARIALE de l'orchestrateur (mandat V1, section I).
 * MockProvider + journal en mémoire qui reproduit les contraintes d'unicité
 * de einvoicing_transmissions — chaque test correspond à un scénario du
 * mandat : double submit, retry après timeout, webhook rejoué, rejet
 * provider, régression de statut, canonique altéré, entrant rejoué.
 */

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

// ---------------------------------------------------------------------------
// Journal en mémoire — mêmes contraintes que la table (unicité clé + doc id)
// ---------------------------------------------------------------------------

class MockJournal implements TransmissionJournal {
  rows: (TransmissionRecord & Record<string, unknown>)[] = [];
  private seq = 0;
  /** Simule une course : l'insert échoue N fois sur la contrainte d'unicité. */
  raceLosses = 0;

  async findByIdempotencyKey(tenantId: string, key: string): Promise<TransmissionRecord | null> {
    return this.rows.find((r) => r.tenant_id === tenantId && r.idempotency_key === key) ?? null;
  }

  async insert(record: Omit<TransmissionRecord, 'id'> & Record<string, unknown>): Promise<TransmissionRecord> {
    if (this.raceLosses > 0) {
      this.raceLosses--;
      throw new Error('duplicate key value violates unique constraint "uq_einv_idempotency"');
    }
    if (this.rows.some((r) => r.tenant_id === record.tenant_id && r.idempotency_key === record.idempotency_key)) {
      throw new Error('duplicate key value violates unique constraint "uq_einv_idempotency"');
    }
    if (
      record.provider_document_id &&
      this.rows.some((r) => r.provider === record.provider && r.provider_document_id === record.provider_document_id)
    ) {
      throw new Error('duplicate key value violates unique constraint "uq_einv_provider_document"');
    }
    const row = { ...record, id: `tx-${++this.seq}` } as TransmissionRecord & Record<string, unknown>;
    this.rows.push(row);
    return row;
  }

  async update(id: string, patch: Record<string, unknown>): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error(`update: transmission ${id} inconnue`);
    Object.assign(row, patch);
  }
}

// ---------------------------------------------------------------------------
// Provider mock — compte chaque appel réseau, rejouable, saboteur sur demande
// ---------------------------------------------------------------------------

class MockProvider implements EInvoicingProvider {
  readonly slug = 'mock';
  sendCalls: { doc: OutboundDocument; key: string }[] = [];
  nextResult: Partial<SubmissionResult> = {};
  incoming: IncomingDocument[] = [];
  acked: string[] = [];

  private async send(doc: OutboundDocument, key: string): Promise<SubmissionResult> {
    this.sendCalls.push({ doc, key });
    return {
      providerDocumentId: this.nextResult.providerDocumentId ?? `mock-doc-${this.sendCalls.length}`,
      providerStatus: this.nextResult.providerStatus ?? 'submitted',
      internalStatus: this.nextResult.internalStatus ?? 'SUBMITTED',
      evidenceRef: this.nextResult.evidenceRef ?? null,
    };
  }

  sendInvoice = (doc: OutboundDocument, key: string) => this.send(doc, key);
  sendCreditNote = (doc: OutboundDocument, key: string) => this.send(doc, key);

  async getDocumentStatus(providerDocumentId: string) {
    return { providerDocumentId, providerStatus: 'submitted', internalStatus: 'SUBMITTED' as const };
  }
  async fetchIncomingDocuments() {
    return this.incoming;
  }
  async acknowledgeIncomingDocument(id: string) {
    this.acked.push(id);
  }
}

// ---------------------------------------------------------------------------
// Fabrique de facture sortante avec un vrai hash cohérent
// ---------------------------------------------------------------------------

const CANONICAL = new TextEncoder().encode('%PDF-1.7 canonique SILLON immuable');

async function outboundRef(over: Partial<OutboundInvoiceRef> = {}): Promise<OutboundInvoiceRef> {
  return {
    tenantId: 'tenant-1',
    invoiceId: 'inv-1',
    invoiceNumber: 'FC2026042',
    docType: 'invoice',
    pdfHash: await sha256Hex(CANONICAL),
    xmlHash: 'xmlhash',
    recipientSiren: '842567123',
    loadCanonicalPdf: async () => CANONICAL,
    ...over,
  };
}

describe('outbound — idempotence et retry sûr (I-1, I-2)', () => {
  it('soumission nominale : un appel provider, une ligne journal SUBMITTED', async () => {
    const journal = new MockJournal();
    const provider = new MockProvider();
    const res = await submitOutbound(journal, provider, await outboundRef());
    expect(res.deduplicated).toBe(false);
    expect(res.internalStatus).toBe('SUBMITTED');
    expect(provider.sendCalls).toHaveLength(1);
    expect(journal.rows).toHaveLength(1);
    expect(journal.rows[0].idempotency_key).toBe(`outbound:inv-1:${await sha256Hex(CANONICAL)}`);
  });

  it('adversarial : double submit → UN SEUL appel provider, deuxième absorbé', async () => {
    const journal = new MockJournal();
    const provider = new MockProvider();
    const ref = await outboundRef();
    const first = await submitOutbound(journal, provider, ref);
    const second = await submitOutbound(journal, provider, ref);
    expect(provider.sendCalls).toHaveLength(1);
    expect(second.deduplicated).toBe(true);
    expect(second.transmissionId).toBe(first.transmissionId);
    expect(journal.rows).toHaveLength(1);
  });

  it('adversarial : course entre deux workers → le perdant de la RÉSERVATION n’envoie RIEN', async () => {
    const journal = new MockJournal();
    const provider = new MockProvider();
    const ref = await outboundRef();
    // Journal-first : la réservation précède l'envoi. Le perdant échoue à
    // l'insert et relit la ligne gagnante — zéro appel provider de sa part.
    journal.raceLosses = 1;
    const winnerRow = {
      id: 'tx-winner',
      tenant_id: ref.tenantId,
      direction: 'outbound' as const,
      invoice_id: ref.invoiceId,
      supplier_invoice_id: null,
      provider: 'mock',
      provider_document_id: 'mock-doc-winner',
      provider_status: 'submitted',
      internal_status: 'SUBMITTED' as const,
      idempotency_key: `outbound:${ref.invoiceId}:${ref.pdfHash}`,
      retries: 0,
      rejection_reason: null,
    };
    const origInsert = journal.insert.bind(journal);
    journal.insert = async (rec) => {
      const p = origInsert(rec);
      await p.catch(() => journal.rows.push(winnerRow)); // le gagnant écrit "pendant" l'échec
      return p;
    };
    const res = await submitOutbound(journal, provider, ref);
    expect(res.deduplicated).toBe(true);
    expect(res.transmissionId).toBe('tx-winner');
    expect(journal.rows).toHaveLength(1);
    expect(provider.sendCalls).toHaveLength(0); // la réservation a précédé tout réseau
  });

  it('adversarial : canonique altéré (hash ≠ octets) → transmission REFUSÉE, zéro appel provider', async () => {
    const journal = new MockJournal();
    const provider = new MockProvider();
    const ref = await outboundRef({ pdfHash: 'deadbeef'.repeat(8) });
    await expect(submitOutbound(journal, provider, ref)).rejects.toMatchObject({
      code: 'CANONICAL_HASH_MISMATCH',
    });
    expect(provider.sendCalls).toHaveLength(0);
    expect(journal.rows).toHaveLength(0);
  });

  it('adversarial : facture sans canonique figé → refusée avant tout', async () => {
    const journal = new MockJournal();
    const provider = new MockProvider();
    const ref = await outboundRef({ pdfHash: '' });
    await expect(submitOutbound(journal, provider, ref)).rejects.toMatchObject({ code: 'NO_CANONICAL' });
    expect(provider.sendCalls).toHaveLength(0);
  });

  it('un avoir passe par sendCreditNote avec la même discipline', async () => {
    const journal = new MockJournal();
    const provider = new MockProvider();
    const ref = await outboundRef({ docType: 'credit_note', invoiceId: 'avoir-1', invoiceNumber: 'AV2026007' });
    const res = await submitOutbound(journal, provider, ref);
    expect(res.internalStatus).toBe('SUBMITTED');
    expect(provider.sendCalls).toHaveLength(1);
    // même clé → dédupliqué aussi
    const again = await submitOutbound(journal, provider, ref);
    expect(again.deduplicated).toBe(true);
    expect(provider.sendCalls).toHaveLength(1);
  });
});

describe('outbound — rejet provider et re-soumission (I-7)', () => {
  it('rejet → REJECTED avec motif ; re-submit = transition légale, retries+1, motif purgé', async () => {
    const journal = new MockJournal();
    const provider = new MockProvider();
    const ref = await outboundRef();
    const res = await submitOutbound(journal, provider, ref);
    const record = journal.rows[0];

    const rejection = await applyStatusUpdate(journal, record, {
      internalStatus: 'REJECTED',
      providerStatus: 'rejected',
      rejectionReason: 'SIREN destinataire inconnu de l’annuaire',
    });
    expect(rejection).toEqual({ applied: true, reason: 'updated' });
    expect(record.internal_status).toBe('REJECTED');
    expect(record.rejection_reason).toBe('SIREN destinataire inconnu de l’annuaire');

    const retry = await submitOutbound(journal, provider, ref);
    expect(retry.deduplicated).toBe(false);
    expect(retry.transmissionId).toBe(res.transmissionId); // même record, pas de doublon
    expect(provider.sendCalls).toHaveLength(2);
    expect(record.internal_status).toBe('SUBMITTED');
    expect(record.retries).toBe(1);
    expect(record.rejection_reason).toBeNull();
    expect(journal.rows).toHaveLength(1);
  });

  it('adversarial : re-soumission avec canonique altéré → refusée même après rejet', async () => {
    const journal = new MockJournal();
    const provider = new MockProvider();
    const ref = await outboundRef();
    await submitOutbound(journal, provider, ref);
    await applyStatusUpdate(journal, journal.rows[0], { internalStatus: 'REJECTED', providerStatus: 'rejected' });
    const tampered = { ...ref, loadCanonicalPdf: async () => new TextEncoder().encode('AUTRE CONTENU') };
    await expect(submitOutbound(journal, provider, tampered)).rejects.toMatchObject({
      code: 'CANONICAL_HASH_MISMATCH',
    });
    expect(provider.sendCalls).toHaveLength(1); // pas de second envoi
  });
});

describe('outbound — issue INCONNUE (accepté provider / timeout client)', () => {
  // iopole n'a pas de clé d'idempotence : après un timeout POST-envoi, seul
  // reconcileOutbound (numéro + hash de l'original re-téléchargé) permet de
  // trancher. Jamais de ré-envoi aveugle.

  /** Provider qui accepte le document côté PA puis « perd » la réponse. */
  function ghostingProvider(mode: 'after' | 'before') {
    const accepted: string[] = [];
    const base = new MockProvider();
    const p = Object.create(base) as MockProvider & { accepted: string[] };
    p.accepted = accepted;
    p.sendInvoice = async (doc, _k) => {
      if (mode === 'after') accepted.push(`ghost-${doc.invoiceNumber}`);
      throw new Error('timeout réseau (réponse perdue)');
    };
    p.sendCreditNote = p.sendInvoice;
    return p;
  }

  it('timeout après envoi → UNKNOWN_OUTCOME, réservation GENERATED sans id provider', async () => {
    const journal = new MockJournal();
    const provider = ghostingProvider('after');
    await expect(submitOutbound(journal, provider, await outboundRef())).rejects.toMatchObject({
      code: 'UNKNOWN_OUTCOME',
    });
    expect(journal.rows).toHaveLength(1);
    expect(journal.rows[0].internal_status).toBe('GENERATED');
    expect(journal.rows[0].provider_document_id).toBeNull();
    expect(journal.rows[0].provider_status).toBe('UNKNOWN_OUTCOME');
  });

  it('retry après inconnue : le document AVAIT été pris → id ADOPTÉ par réconciliation, zéro ré-envoi', async () => {
    const journal = new MockJournal();
    const ghost = ghostingProvider('after');
    const ref = await outboundRef();
    await submitOutbound(journal, ghost, ref).catch(() => {});
    // Deuxième tentative avec un provider sain SACHANT réconcilier.
    const healthy = new MockProvider() as MockProvider & {
      reconcileOutbound?: (n: string, h: string) => Promise<{ providerDocumentId: string } | null>;
    };
    healthy.reconcileOutbound = async (n, h) => {
      expect(n).toBe(ref.invoiceNumber);
      expect(h).toBe(ref.pdfHash);
      return { providerDocumentId: 'ghost-FC2026042' };
    };
    const res = await submitOutbound(journal, healthy, ref);
    expect(res.reconciled).toBe(true);
    expect(res.deduplicated).toBe(true);
    expect(res.providerDocumentId).toBe('ghost-FC2026042');
    expect(res.internalStatus).toBe('SUBMITTED');
    expect(healthy.sendCalls).toHaveLength(0); // AUCUN second envoi
    expect(journal.rows[0].internal_status).toBe('SUBMITTED');
    expect(journal.rows[0].provider_document_id).toBe('ghost-FC2026042');
  });

  it('retry après inconnue : prouvé ABSENT côté PA → re-soumission sûre (1 envoi)', async () => {
    const journal = new MockJournal();
    const ghost = ghostingProvider('before'); // l’envoi n’était jamais parti
    const ref = await outboundRef();
    await submitOutbound(journal, ghost, ref).catch(() => {});
    const healthy = new MockProvider() as MockProvider & {
      reconcileOutbound?: (n: string, h: string) => Promise<{ providerDocumentId: string } | null>;
    };
    healthy.reconcileOutbound = async () => null;
    const res = await submitOutbound(journal, healthy, ref);
    expect(res.deduplicated).toBe(false);
    expect(res.internalStatus).toBe('SUBMITTED');
    expect(healthy.sendCalls).toHaveLength(1);
    expect(journal.rows).toHaveLength(1); // même réservation, pas de doublon
  });

  it('adversarial : provider SANS réconciliation → re-soumission automatique REFUSÉE', async () => {
    const journal = new MockJournal();
    const ghost = ghostingProvider('after');
    const ref = await outboundRef();
    await submitOutbound(journal, ghost, ref).catch(() => {});
    const noReconcile = new MockProvider(); // pas de reconcileOutbound
    await expect(submitOutbound(journal, noReconcile, ref)).rejects.toMatchObject({
      code: 'UNKNOWN_OUTCOME',
    });
    expect(noReconcile.sendCalls).toHaveLength(0); // jamais de ré-envoi aveugle
    expect(journal.rows[0].internal_status).toBe('GENERATED');
  });

  it('refus CERTAIN (ProviderRejectedError) → REJECTED avec motif, jamais UNKNOWN', async () => {
    const journal = new MockJournal();
    const provider = new MockProvider();
    provider.sendInvoice = async () => {
      throw new ProviderRejectedError('SIREN destinataire inconnu de l’annuaire');
    };
    const res = await submitOutbound(journal, provider, await outboundRef());
    expect(res.internalStatus).toBe('REJECTED');
    expect(res.rejectionReason).toMatch(/annuaire/);
    expect(journal.rows[0].internal_status).toBe('REJECTED');
    // …et le chemin de retry légal depuis REJECTED reste ouvert.
    const healthy = new MockProvider();
    const retry = await submitOutbound(journal, healthy, await outboundRef());
    expect(retry.internalStatus).toBe('SUBMITTED');
    expect(journal.rows[0].retries).toBe(1);
  });
});

describe('statuts — webhooks/polls dupliqués et transitions illégales (I-3)', () => {
  async function submitted(): Promise<{ journal: MockJournal; record: TransmissionRecord }> {
    const journal = new MockJournal();
    const provider = new MockProvider();
    await submitOutbound(journal, provider, await outboundRef());
    return { journal, record: journal.rows[0] };
  }

  it('cycle nominal SUBMITTED → DELIVERED → ACCEPTED avec horodatages', async () => {
    const { journal, record } = await submitted();
    expect(
      await applyStatusUpdate(journal, record, { internalStatus: 'DELIVERED', providerStatus: 'delivered' }),
    ).toEqual({ applied: true, reason: 'updated' });
    expect((record as Record<string, unknown>).delivered_at).toBeTruthy();
    expect(
      await applyStatusUpdate(journal, record, { internalStatus: 'ACCEPTED', providerStatus: 'accepted' }),
    ).toEqual({ applied: true, reason: 'updated' });
    expect((record as Record<string, unknown>).accepted_at).toBeTruthy();
  });

  it('adversarial : webhook reçu deux fois (même statut) → no-op, rien réécrit', async () => {
    const { journal, record } = await submitted();
    await applyStatusUpdate(journal, record, { internalStatus: 'DELIVERED', providerStatus: 'delivered' });
    const at = (record as Record<string, unknown>).last_status_at;
    const replay = await applyStatusUpdate(journal, record, {
      internalStatus: 'DELIVERED',
      providerStatus: 'delivered',
    });
    expect(replay).toEqual({ applied: false, reason: 'duplicate' });
    expect((record as Record<string, unknown>).last_status_at).toBe(at);
  });

  it('adversarial : régression depuis ACCEPTED → transition REFUSÉE, état intact', async () => {
    const { journal, record } = await submitted();
    await applyStatusUpdate(journal, record, { internalStatus: 'ACCEPTED', providerStatus: 'accepted' });
    const regression = await applyStatusUpdate(journal, record, {
      internalStatus: 'SUBMITTED',
      providerStatus: 'submitted',
    });
    expect(regression).toEqual({ applied: false, reason: 'illegal_transition' });
    expect(record.internal_status).toBe('ACCEPTED');
  });

  it('adversarial : ACCEPTED → REJECTED (rejet tardif après acceptation) → refusé', async () => {
    const { journal, record } = await submitted();
    await applyStatusUpdate(journal, record, { internalStatus: 'ACCEPTED', providerStatus: 'accepted' });
    const late = await applyStatusUpdate(journal, record, {
      internalStatus: 'REJECTED',
      providerStatus: 'rejected',
      rejectionReason: 'trop tard',
    });
    expect(late).toEqual({ applied: false, reason: 'illegal_transition' });
    expect(record.internal_status).toBe('ACCEPTED');
    expect(record.rejection_reason).toBeNull();
  });
});

describe('inbound — dédup provider et REVIEW (I-4, I-5)', () => {
  const incomingDoc = (over: Partial<IncomingDocument> = {}): IncomingDocument => ({
    providerDocumentId: 'pa-in-001',
    format: 'facturx',
    originalBytes: new TextEncoder().encode('%PDF entrant'),
    originalFilename: 'facture-fournisseur.pdf',
    receivedAt: '2026-09-05T10:00:00Z',
    ...over,
  });

  it('ingestion nominale : callback appelé, journal REVIEW_REQUIRED', async () => {
    const journal = new MockJournal();
    let ingested = 0;
    const res = await ingestInbound(journal, 'mock', 'tenant-1', incomingDoc(), async () => {
      ingested++;
      return { supplierInvoiceId: 'si-1' };
    });
    expect(res.outcome).toBe('ingested');
    expect(ingested).toBe(1);
    expect(journal.rows[0].internal_status).toBe('REVIEW_REQUIRED');
    expect(journal.rows[0].supplier_invoice_id).toBe('si-1');
    expect(journal.rows[0].idempotency_key).toBe('inbound:mock:pa-in-001');
  });

  it('entrant sans facture créée (doublon avéré en aval) → RECEIVED, jamais auto-validé', async () => {
    const journal = new MockJournal();
    const res = await ingestInbound(journal, 'mock', 'tenant-1', incomingDoc(), async () => ({
      supplierInvoiceId: null,
    }));
    expect(res.outcome).toBe('ingested');
    expect(journal.rows[0].internal_status).toBe('RECEIVED');
  });

  it('entrant inexploitable ou non rapproché (requiresReview) → REVIEW_REQUIRED sans création', async () => {
    const journal = new MockJournal();
    const res = await ingestInbound(journal, 'mock', 'tenant-1', incomingDoc(), async () => ({
      supplierInvoiceId: null,
      requiresReview: true,
    }));
    expect(res.outcome).toBe('ingested');
    expect(journal.rows[0].internal_status).toBe('REVIEW_REQUIRED');
    expect(journal.rows[0].supplier_invoice_id).toBeNull();
  });

  it('adversarial : même document provider rejoué (webhook/poll) → duplicate, callback JAMAIS rappelé', async () => {
    const journal = new MockJournal();
    let ingested = 0;
    const ingest = async () => {
      ingested++;
      return { supplierInvoiceId: 'si-1' };
    };
    const first = await ingestInbound(journal, 'mock', 'tenant-1', incomingDoc(), ingest);
    const replay = await ingestInbound(journal, 'mock', 'tenant-1', incomingDoc(), ingest);
    expect(replay.outcome).toBe('duplicate');
    expect(replay.transmissionId).toBe(first.transmissionId);
    expect(ingested).toBe(1);
    expect(journal.rows).toHaveLength(1);
  });

  it('deux documents distincts du même provider → deux ingestions', async () => {
    const journal = new MockJournal();
    await ingestInbound(journal, 'mock', 'tenant-1', incomingDoc(), async () => ({ supplierInvoiceId: 's1' }));
    await ingestInbound(journal, 'mock', 'tenant-1', incomingDoc({ providerDocumentId: 'pa-in-002' }), async () => ({
      supplierInvoiceId: 's2',
    }));
    expect(journal.rows).toHaveLength(2);
  });

  it('adversarial : même provider_document_id revendiqué par un AUTRE tenant → bloqué par l’unicité globale', async () => {
    const journal = new MockJournal();
    await ingestInbound(journal, 'mock', 'tenant-1', incomingDoc(), async () => ({ supplierInvoiceId: 's1' }));
    // tenant-2 a une clé d'idempotence différente (scopée tenant) mais le même
    // provider_document_id : la contrainte globale uq_einv_provider_document
    // doit faire échouer l'insert — et il n'y a PAS de gagnant pour SA clé.
    await expect(
      ingestInbound(journal, 'mock', 'tenant-2', incomingDoc(), async () => ({ supplierInvoiceId: 's-evil' })),
    ).rejects.toThrow(/uq_einv_provider_document/);
    expect(journal.rows).toHaveLength(1);
    expect(journal.rows[0].tenant_id).toBe('tenant-1');
  });
});

describe('EInvoicingError', () => {
  it('porte un code exploitable', () => {
    const e = new EInvoicingError('NO_CANONICAL', 'msg');
    expect(e.code).toBe('NO_CANONICAL');
    expect(e.name).toBe('EInvoicingError');
    expect(e).toBeInstanceOf(Error);
  });
});
