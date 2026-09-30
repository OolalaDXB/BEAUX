/**
 * Factur-X — post-traitement PDF/A-3 (pdf-lib).
 *
 * Prend le PDF rendu par jsPDF (inchangé visuellement) et en fait un conteneur
 * Factur-X : PDF/A-3 avec `factur-x.xml` attaché (AFRelationship=Data), paquet
 * XMP (pdfaid part 3 / conformance B + schéma d'extension Factur-X) et
 * OutputIntent sRGB. Références : Factur-X 1.09.2 / ZUGFeRD 2.5.2.
 *
 * ⚠️ Un PDF passé ici mais qui ne passe pas veraPDF/Mustang n'est PAS un
 * Factur-X livrable : la validation (npm run facturx:validate, J4) est le
 * juge de paix, pas ce module. `facturx_enabled` reste OFF tant qu'elle ne
 * passe pas.
 *
 * Comme facturx-xml.ts, ce module doit tourner dans le navigateur (preview),
 * sous vitest et en Deno (edge function facturx-generate) : pas d'API Node.
 */

import {
  AFRelationship,
  PDFDocument,
  PDFName,
  PDFString,
  PDFHexString,
} from 'pdf-lib';
import { FACTURX_XML_FILENAME, type FacturXProfile } from './facturx-xml';

/**
 * Profil ICC sRGB compact (sRGB-v2-micro, 456 octets, CC0 —
 * saucecontrol/Compact-ICC-Profiles) pour l'OutputIntent exigé par PDF/A.
 * Inliné ici pour que ce module reste auto-contenu (copie byte-identique
 * déployée dans l'edge function facturx-generate).
 */
const SRGB_ICC_BASE64 =
  'AAAByGxjbXMCEAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5knZEAPUCAsD1AdCyBnqUijgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJZGVzYwAAAPAAAABfY3BydAAAAQwAAAAMd3RwdAAAARgAAAAUclhZWgAAASwAAAAUZ1hZWgAAAUAAAAAUYlhZWgAAAVQAAAAUclRSQwAAAWgAAABgZ1RSQwAAAWgAAABgYlRSQwAAAWgAAABgZGVzYwAAAAAAAAAFdVJHQgAAAAAAAAAAAAAAAHRleHQAAAAAQ0MwAFhZWiAAAAAAAADzVAABAAAAARbJWFlaIAAAAAAAAG+gAAA48gAAA49YWVogAAAAAAAAYpYAALeJAAAY2lhZWiAAAAAAAAAkoAAAD4UAALbEY3VydgAAAAAAAAAqAAAAfAD4AZwCdQODBMkGTggSChgMYg70Ec8U9hhqHC4gQySsKWoufjPrObM/1kZXTTZUdlwXZB1shnVWfo2ILJI2nKunjLLbvpnKx9dl5Hfx+f//';

/** Niveau de conformité déclaré dans le XMP (fx:ConformanceLevel). */
const XMP_CONFORMANCE_LEVEL: Record<FacturXProfile, string> = {
  en16931: 'EN 16931',
  basic: 'BASIC',
};

export interface EmbedFacturXOptions {
  /** Sortie jsPDF (doc.output('arraybuffer')). */
  pdfBytes: Uint8Array | ArrayBuffer;
  /** XML CII produit par buildFacturXCII(). */
  xml: string;
  /** Titre du document (dc:title + Info), ex. « Facture FC2026042 ». */
  title: string;
  profile: FacturXProfile;
  /** Horodatage de génération — injectable pour des tests déterministes. */
  now?: Date;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Date au format XMP (ISO 8601 sans millisecondes, UTC). */
function xmpDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const PRODUCER = 'SILLON';

/**
 * Paquet XMP PDF/A-3B + schéma d'extension Factur-X (obligatoire : `fx:` est
 * un espace de noms custom, PDF/A exige sa déclaration pdfaExtension).
 */
function buildXmp(title: string, profile: FacturXProfile, now: Date): string {
  const date = xmpDate(now);
  return `<?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdfaid:part>3</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(title)}</rdf:li></rdf:Alt></dc:title>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:CreatorTool>${PRODUCER}</xmp:CreatorTool>
   <xmp:CreateDate>${date}</xmp:CreateDate>
   <xmp:ModifyDate>${date}</xmp:ModifyDate>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdf:Producer>${PRODUCER}</pdf:Producer>
  </rdf:Description>
  <rdf:Description rdf:about=""
    xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"
    xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"
    xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
   <pdfaExtension:schemas>
    <rdf:Bag>
     <rdf:li rdf:parseType="Resource">
      <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
      <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
      <pdfaSchema:prefix>fx</pdfaSchema:prefix>
      <pdfaSchema:property>
       <rdf:Seq>
        <rdf:li rdf:parseType="Resource">
         <pdfaProperty:name>DocumentFileName</pdfaProperty:name>
         <pdfaProperty:valueType>Text</pdfaProperty:valueType>
         <pdfaProperty:category>external</pdfaProperty:category>
         <pdfaProperty:description>The name of the embedded XML document</pdfaProperty:description>
        </rdf:li>
        <rdf:li rdf:parseType="Resource">
         <pdfaProperty:name>DocumentType</pdfaProperty:name>
         <pdfaProperty:valueType>Text</pdfaProperty:valueType>
         <pdfaProperty:category>external</pdfaProperty:category>
         <pdfaProperty:description>The type of the hybrid document in capital letters, e.g. INVOICE or ORDER</pdfaProperty:description>
        </rdf:li>
        <rdf:li rdf:parseType="Resource">
         <pdfaProperty:name>Version</pdfaProperty:name>
         <pdfaProperty:valueType>Text</pdfaProperty:valueType>
         <pdfaProperty:category>external</pdfaProperty:category>
         <pdfaProperty:description>The actual version of the standard applying to the embedded XML document</pdfaProperty:description>
        </rdf:li>
        <rdf:li rdf:parseType="Resource">
         <pdfaProperty:name>ConformanceLevel</pdfaProperty:name>
         <pdfaProperty:valueType>Text</pdfaProperty:valueType>
         <pdfaProperty:category>external</pdfaProperty:category>
         <pdfaProperty:description>The conformance level of the embedded XML document</pdfaProperty:description>
        </rdf:li>
       </rdf:Seq>
      </pdfaSchema:property>
     </rdf:li>
    </rdf:Bag>
   </pdfaExtension:schemas>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
   <fx:DocumentType>INVOICE</fx:DocumentType>
   <fx:DocumentFileName>${FACTURX_XML_FILENAME}</fx:DocumentFileName>
   <fx:Version>1.0</fx:Version>
   <fx:ConformanceLevel>${XMP_CONFORMANCE_LEVEL[profile]}</fx:ConformanceLevel>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/**
 * Transforme le PDF jsPDF en conteneur Factur-X PDF/A-3B.
 * Rendu visuel inchangé ; retourne les octets du fichier final.
 */
export async function embedFacturXInPdfA3(opts: EmbedFacturXOptions): Promise<Uint8Array> {
  const now = opts.now ?? new Date();
  const pdfDoc = await PDFDocument.load(
    opts.pdfBytes instanceof Uint8Array ? opts.pdfBytes : new Uint8Array(opts.pdfBytes),
  );
  const context = pdfDoc.context;

  // 1) Pièce jointe factur-x.xml, AFRelationship=Data (pdf-lib gère /AF,
  //    /EmbeddedFiles et les entrées /UF requises par PDF/A-3).
  const xmlBytes = new TextEncoder().encode(opts.xml);
  await pdfDoc.attach(xmlBytes, FACTURX_XML_FILENAME, {
    mimeType: 'text/xml',
    description: 'Factur-X invoice data (CII)',
    creationDate: now,
    modificationDate: now,
    afRelationship: AFRelationship.Data,
  });

  // 2) Info dict synchronisé avec le XMP (exigence PDF/A quand Info existe).
  pdfDoc.setTitle(opts.title);
  pdfDoc.setProducer(PRODUCER);
  pdfDoc.setCreator(PRODUCER);
  pdfDoc.setCreationDate(now);
  pdfDoc.setModificationDate(now);
  // jsPDF écrit un champ Subject/Keywords vide selon les versions — les
  // retirer pour ne pas avoir à les répliquer dans le XMP.
  const infoRef = pdfDoc.context.trailerInfo.Info;
  if (infoRef) {
    const info = pdfDoc.context.lookup(infoRef);
    if (info && 'delete' in (info as object)) {
      (info as unknown as { delete(k: PDFName): void }).delete(PDFName.of('Subject'));
      (info as unknown as { delete(k: PDFName): void }).delete(PDFName.of('Keywords'));
    }
  }

  // 3) Métadonnées XMP (flux non compressé — exigence PDF/A).
  const xmp = buildXmp(opts.title, opts.profile, now);
  const xmpStream = context.stream(new TextEncoder().encode(xmp), {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  pdfDoc.catalog.set(PDFName.of('Metadata'), context.register(xmpStream));

  // 4) OutputIntent sRGB (profil ICC compact embarqué).
  const iccBytes = base64ToBytes(SRGB_ICC_BASE64);
  const iccStream = context.stream(iccBytes, { N: 3 });
  const iccRef = context.register(iccStream);
  const outputIntent = context.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: PDFString.of('sRGB'),
    Info: PDFString.of('sRGB IEC61966-2.1'),
    DestOutputProfile: iccRef,
  });
  pdfDoc.catalog.set(
    PDFName.of('OutputIntents'),
    context.obj([context.register(outputIntent)]),
  );

  // 5) Identifiant de document stable (les deux entrées du tableau ID).
  const idHex = PDFHexString.of(
    [...crypto.getRandomValues(new Uint8Array(16))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase(),
  );
  pdfDoc.context.trailerInfo.ID = context.obj([idHex, idHex]);

  return pdfDoc.save({ useObjectStreams: false });
}

/** SHA-256 hex (WebCrypto : navigateur, Deno, Node ≥ 18) — preuve du canonique (J4). */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
