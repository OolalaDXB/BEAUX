/**
 * E-invoicing entrant — détection de format et extraction du XML embarqué.
 *
 * Le modèle interne ne présume PAS que tout entrant est du Factur-X (mandat
 * V1, section F) : un document reçu peut être un PDF Factur-X, un XML CII nu,
 * un XML UBL, ou un PDF sans données structurées. Ce module ne fait que
 * l'identifier et en extraire le XML quand il existe — l'ORIGINAL n'est
 * jamais modifié ni reconstruit.
 *
 * Sans dépendance framework (browser / vitest / Deno).
 */

import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

export type IncomingFormat = 'facturx' | 'cii-xml' | 'ubl' | 'pdf-plain' | 'unknown';

export interface ExtractionResult {
  format: IncomingFormat;
  /** XML structuré si présent (contenu de factur-x.xml, ou le fichier XML lui-même). */
  xml: string | null;
  /** Nom de la pièce jointe extraite le cas échéant. */
  attachmentName: string | null;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF

function isPdf(bytes: Uint8Array): boolean {
  return PDF_MAGIC.every((b, i) => bytes[i] === b);
}

function sniffXmlFormat(xml: string): 'cii-xml' | 'ubl' | 'unknown' {
  if (xml.includes('CrossIndustryInvoice')) return 'cii-xml';
  // UBL : Invoice / CreditNote dans l'espace de noms oasis.
  if (/urn:oasis:names:specification:ubl/.test(xml)) return 'ubl';
  return 'unknown';
}

/** Noms de pièce jointe considérés comme données de facture (Factur-X/ZUGFeRD). */
const STRUCTURED_ATTACHMENT_NAMES = ['factur-x.xml', 'zugferd-invoice.xml', 'xrechnung.xml'];

/**
 * Extrait toutes les pièces jointes (nom → octets) d'un PDF via l'arbre
 * Names/EmbeddedFiles. Résiliant : un PDF sans pièce jointe rend [].
 */
async function extractPdfAttachments(bytes: Uint8Array): Promise<Array<{ name: string; data: Uint8Array }>> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const out: Array<{ name: string; data: Uint8Array }> = [];
  try {
    const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
    const embedded = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
    const pairs = embedded?.lookupMaybe(PDFName.of('Names'), PDFArray);
    if (!pairs) return out;
    for (let i = 0; i + 1 < pairs.size(); i += 2) {
      try {
        const rawName = pairs.lookup(i);
        const fileSpec = pairs.lookup(i + 1, PDFDict);
        const ef = fileSpec.lookup(PDFName.of('EF'), PDFDict);
        const stream = ef.lookup(PDFName.of('F'));
        if (!(stream instanceof PDFRawStream)) continue;
        const data = decodePDFRawStream(stream).decode();
        const name =
          rawName && 'decodeText' in (rawName as object)
            ? (rawName as unknown as { decodeText(): string }).decodeText()
            : String(rawName);
        out.push({ name, data });
      } catch {
        // pièce jointe illisible : on continue — l'original reste la référence
      }
    }
  } catch {
    // arbre Names absent/corrompu : PDF sans pièces jointes exploitables
  }
  return out;
}

/**
 * Identifie le format d'un document entrant et en extrait le XML structuré.
 * Ne lève jamais pour un contenu inattendu : format 'unknown'/'pdf-plain'.
 */
export async function extractStructuredInvoice(bytes: Uint8Array): Promise<ExtractionResult> {
  // XML nu ?
  if (!isPdf(bytes)) {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 4096));
    if (head.trimStart().startsWith('<')) {
      const xml = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const fmt = sniffXmlFormat(xml);
      return { format: fmt, xml: fmt === 'unknown' ? null : xml, attachmentName: null };
    }
    return { format: 'unknown', xml: null, attachmentName: null };
  }

  // PDF : chercher une pièce jointe structurée.
  let attachments: Array<{ name: string; data: Uint8Array }> = [];
  try {
    attachments = await extractPdfAttachments(bytes);
  } catch {
    return { format: 'pdf-plain', xml: null, attachmentName: null };
  }

  const structured =
    attachments.find((a) => STRUCTURED_ATTACHMENT_NAMES.includes(a.name.toLowerCase())) ??
    attachments.find((a) => a.name.toLowerCase().endsWith('.xml'));
  if (!structured) {
    return { format: 'pdf-plain', xml: null, attachmentName: null };
  }

  const xml = new TextDecoder('utf-8', { fatal: false }).decode(structured.data);
  const fmt = sniffXmlFormat(xml);
  if (fmt === 'cii-xml') {
    return { format: 'facturx', xml, attachmentName: structured.name };
  }
  if (fmt === 'ubl') {
    return { format: 'ubl', xml, attachmentName: structured.name };
  }
  return { format: 'pdf-plain', xml: null, attachmentName: structured.name };
}
