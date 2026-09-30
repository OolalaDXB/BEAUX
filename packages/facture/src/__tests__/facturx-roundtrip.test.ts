import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { buildFacturXCII, type FacturXInvoiceInput } from '../facturx-xml';
import { embedFacturXInPdfA3, sha256Hex } from '../facturx-pdfa';
import { extractStructuredInvoice } from '../facturx-extract';
import { parseFacturXCII } from '../facturx-parse';

/* The whole Factur-X chain, inside the package, with no host: an invoice becomes
   CII XML, is embedded into a PDF/A-3 container, and comes back out — extracted
   from the PDF and parsed — with the same numbers. In SILLON this chain was only
   exercised by app-level tests (jsPDF, the app's fonts); here the base PDF is a
   blank pdf-lib page, because the container, not the rendering, is under test.

   The fixture is a service sold by an independent to a company: a package of
   coaching sessions, VAT 20 %. */
function coachingInvoice(): FacturXInvoiceInput {
  return {
    invoiceNumber: 'F2026-0017',
    issueDate: '2026-09-30',
    dueDate: '2026-10-30',
    currency: 'EUR',
    orderNumber: null,
    seller: {
      name: 'Coach Exemple EI', siren: '912345678', vatNumber: 'FR45912345678',
      addressLine1: '4 rue du Stade', postalCode: '33000', city: 'Bordeaux', countryCode: 'FR',
      iban: 'FR76 3000 4000 0500 0001 2345 678', bic: 'BNPAFRPP', paymentTermsText: 'Paiement à réception',
    },
    buyer: {
      name: 'Société Cliente SAS', siren: '823456789', vatNumber: 'FR12823456789',
      addressLine1: '1 place de la Bourse', postalCode: '33000', city: 'Bordeaux', countryCode: 'FR',
    },
    lines: [
      { description: 'Forfait 10 séances de coaching', quantity: 1, unitPrice: 500, totalPrice: 500, taxRate: 0.2, lineType: 'fee' },
    ],
    subtotal: 500,
    taxAmount: 100,
    total: 600,
    regime: { exempt: false, regimeCode: null, legalMention: null },
    vatOnDebits: false,
    transactionNature: 'services',
    profile: 'en16931',
  } as FacturXInvoiceInput;
}

async function blankPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]); // A4
  return doc.save();
}

describe('Factur-X round trip: build → embed (PDF/A-3) → extract → parse', () => {
  it('comes back with the same invoice', async () => {
    const input = coachingInvoice();
    const xml = buildFacturXCII(input);
    const pdf = await embedFacturXInPdfA3({ pdfBytes: await blankPdf(), xml, title: 'Facture F2026-0017', profile: 'en16931', now: new Date('2026-09-30T10:00:00Z') });

    const out = await extractStructuredInvoice(pdf);
    expect(out.attachmentName).toBe('factur-x.xml');
    expect(out.xml).toBe(xml);                       // byte for byte: the container does not alter the data

    const parsed = parseFacturXCII(out.xml!);
    expect(parsed.typeCode).toBe('380');
    expect(parsed.invoiceNumber).toBe('F2026-0017');
    expect(parsed.issueDate).toBe('2026-09-30');
    expect(parsed.currency).toBe('EUR');
    expect(parsed.seller.vatNumber).toBe('FR45912345678');
    expect(parsed.subtotal).toBe(500);
    expect(parsed.taxTotal).toBe(100);
    expect(parsed.total).toBe(600);
    expect(parsed.lines).toHaveLength(1);
  });

  /* Not deterministic, on purpose: each generation draws a fresh document /ID
     (both entries equal). Idempotence therefore rests on the hash of the canonical
     PDF as STORED (outbound:{invoice_id}:{pdf_hash}) — a host generates it once and
     never regenerates it for a resend. Pinned here so nobody "fixes" the ID into a
     constant, nor builds a key on a regenerated file. */
  it('each generation is a new document: same content, a new /ID, a different hash', async () => {
    const xml = buildFacturXCII(coachingInvoice());
    const base = await blankPdf();
    const now = new Date('2026-09-30T10:00:00Z');
    const a = await embedFacturXInPdfA3({ pdfBytes: base, xml, title: 'Facture F2026-0017', profile: 'en16931', now });
    const b = await embedFacturXInPdfA3({ pdfBytes: base, xml, title: 'Facture F2026-0017', profile: 'en16931', now });
    expect(await sha256Hex(a)).not.toBe(await sha256Hex(b));
    const ids = await Promise.all([a, b].map(async (bytes) => {
      const d = await PDFDocument.load(bytes);
      const arr = d.context.trailerInfo.ID as unknown as { asArray(): { toString(): string }[] };
      return arr.asArray().map((x) => x.toString());
    }));
    expect(ids[0][0]).toBe(ids[0][1]);                 // the two halves of one document's ID agree
    expect(ids[0][0]).not.toBe(ids[1][0]);             // two generations are two documents
    expect((await extractStructuredInvoice(a)).xml).toBe((await extractStructuredInvoice(b)).xml);
  });

  it('a plain PDF has no structured invoice in it', async () => {
    const out = await extractStructuredInvoice(await blankPdf());
    expect(out.xml).toBeNull();
  });
});
