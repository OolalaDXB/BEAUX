/**
 * Branche « PDF non structuré » de l'ingestion entrante.
 *
 * Le module de format Factur-X (facturx-extract/parse) couvre les documents
 * porteurs d'un XML : le XML fait foi, l'extraction est déterministe. Pour un
 * PDF natif sans XML — le cas courant des fournisseurs hors UE — il n'existe
 * pas de source structurée : le texte est soumis à un modèle de langage, dont
 * la sortie est PAR NATURE non fiable.
 *
 * Ce module est la frontière entre cette sortie non fiable et le modèle
 * interne. Il ne fait pas confiance : il coerce, il vérifie, il refuse. Trois
 * garanties, dans cet ordre :
 *
 *   1. `coerceLlmInvoice` n'accepte que ce qui a la bonne forme. Un champ
 *      absent devient null, jamais une valeur inventée ; une ligne incomplète
 *      est écartée et signalée, jamais complétée d'office.
 *   2. `checkInvoiceArithmetic` recalcule les totaux depuis les lignes. C'est
 *      le seul contrôle qui détecte une ligne hallucinée ou omise : un modèle
 *      qui invente une ligne fait tomber la somme à côté du sous-total imprimé.
 *      Un document qui échoue ce contrôle ne doit pas être créé.
 *   3. `matchLineSku` ne rapproche un produit que sur une référence fournisseur
 *      et ne masque jamais une approximation : tout ce qui n'est pas une
 *      égalité stricte est rendu `needsConfirmation`, à trancher par un humain.
 *
 * Zéro dépendance : pas de réseau, pas de SILLON. L'appel au modèle appartient
 * au consommateur (edge function), la revue humaine à l'UI.
 */

import type { ParsedIncomingInvoice, ParsedIncomingLine } from './facturx-parse';

// ————————————————————————————————————————————————————————————————
// Normalisation des références
// ————————————————————————————————————————————————————————————————

/**
 * Forme canonique d'une référence fournisseur, pour comparaison seulement.
 *
 * Les références imprimées sur une facture ne respectent aucune casse ni
 * aucun séparateur stable : un même article apparaît « MRI - 131 », « MRI-131 »
 * ou « mri131 » d'un document à l'autre, et « KR 16 » porte une espace au
 * milieu du code. On compare donc des formes réduites aux seuls caractères
 * signifiants.
 *
 * La valeur rendue ne sert QU'À comparer : on ne la stocke pas et on ne la
 * réaffiche pas. La référence d'origine reste la référence.
 */
export function normalizeSku(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

// ————————————————————————————————————————————————————————————————
// Rapprochement produit
// ————————————————————————————————————————————————————————————————

export interface SupplierSkuRef {
  productId: string;
  /** product_suppliers.supplier_sku — référence de CE fournisseur. */
  supplierSku: string | null;
  /** product_suppliers.cost_price, pour signaler une dérive de prix. */
  costPrice?: number | null;
  /** Titre du produit au catalogue — sert au rapprochement par libellé. */
  title?: string | null;
  /** Artiste du produit — une facture de disquaire le porte souvent. */
  artistName?: string | null;
  /**
   * Faux pour un produit d'un AUTRE fournisseur. Le rapprochement balaie tout
   * le catalogue, mais un produit hors fournisseur ne peut jamais être retenu
   * sans confirmation : la même référence chez deux éditeurs désigne deux
   * disques différents.
   */
  sameSupplier?: boolean;
}

export type SkuMatchKind =
  /** Égalité stricte de la référence : le seul cas sûr. */
  | 'exact'
  /** Égalité après normalisation : très probable, mais à confirmer. */
  | 'normalized'
  /** Égalité une fois les zéros de tête neutralisés : MR28 ≡ MR028. */
  | 'numeric'
  /** Une référence contient l'autre : KR24ITS111 porte ITS111. */
  | 'contained'
  /** Une lettre ou un chiffre d'écart : FYR030 contre FEY030. */
  | 'approx'
  /** Rapprochement par titre et artiste, aucune référence en commun. */
  | 'label'
  /** Plusieurs produits également plausibles au même cran. */
  | 'ambiguous'
  /** Aucune correspondance. */
  | 'none';

export interface LineMatch {
  productId: string | null;
  kind: SkuMatchKind;
  /**
   * Vrai dès que le rapprochement n'est pas une égalité stricte. L'UI doit
   * alors demander un arbitrage humain : une référence approchée rattachée en
   * silence au mauvais produit fausse le stock sans laisser de trace.
   */
  needsConfirmation: boolean;
  /** Renseigné quand le prix facturé s'écarte du coût connu. */
  costPriceDelta?: number;
}

/**
 * Référence normalisée avec les zéros de tête neutralisés dans chaque groupe de
 * chiffres : « MR28 » et « MR028 » rendent la même clé.
 *
 * Les éditeurs numérotent sans règle stable — le catalogue écrit MR028, la
 * facture MR28, et c'est le même disque. Le zéro de tête ne porte aucune
 * information, il ne sert qu'à aligner des colonnes.
 */
export function numericKey(raw: string | null | undefined): string {
  const k = normalizeSku(raw);
  if (!k) return '';
  return k.replace(/\d+/g, (d) => String(Number(d)));
}

/** Distance d'édition, bornée : au-delà de `max` on s'arrête, on n'a pas besoin du reste. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Mots significatifs d'un libellé : accents et ponctuation retirés, bruit écarté. */
function labelTokens(...parts: Array<string | null | undefined>): Set<string> {
  const STOP = new Set(['THE', 'AND', 'LP', 'EP', 'ST', 'VA', 'DE', 'LA', 'LE', 'DU', 'DES', 'A']);
  const raw = parts.filter(Boolean).join(' ');
  const cleaned = raw
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ');
  return new Set(
    cleaned.split(' ').filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

/** Part des mots communs (Jaccard). 1 = mêmes mots, 0 = rien en commun. */
function labelSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Une référence doit porter un chiffre et une longueur minimale pour être discriminante. */
const isDiscriminant = (key: string) => key.length >= 5 && /\d/.test(key);

/**
 * Rapproche une ligne de facture d'un produit du catalogue.
 *
 * ÉCHELLE, du plus sûr au plus permissif. Chaque cran n'est essayé que si le
 * précédent n'a rien donné, et seul le premier se passe de confirmation :
 *
 *   exact       la référence du fournisseur, au caractère près.
 *   normalized  à la ponctuation près : « MRI - 131 » = `MRI131`.
 *   numeric     zéros de tête neutralisés : `MR28` = `MR028`.
 *   contained   une référence en contient une autre : `KR24ITS111` porte
 *               `ITS111`, deux références collées par l'extraction du PDF.
 *   approx      une lettre d'écart : `FYR030` contre `FEY030`.
 *   label       titre et artiste, quand aucune référence ne concorde.
 *
 * POURQUOI TOUT CONFIRMER SAUF LE PREMIER. Un rapprochement faux rattache une
 * ligne au mauvais produit, et c'est ce produit-là que la réception mouvemente :
 * l'erreur se paie en stock faux, et elle est mémorisée dans `product_suppliers`,
 * donc reconduite sur toutes les factures suivantes. Le coût d'un refus est un
 * clic ; celui d'un faux positif se découvre à l'inventaire.
 *
 * POURQUOI BALAYER TOUT LE CATALOGUE. Se limiter aux produits du fournisseur
 * rate les disques saisis sous un autre fournisseur, ou dont la fiche a changé
 * de main. Mais un produit hors fournisseur (`sameSupplier: false`) ne peut
 * jamais sortir en `exact` : la même référence chez deux éditeurs désigne deux
 * disques différents.
 *
 * L'AMBIGUÏTÉ EST UN RÉSULTAT. Deux candidats aussi plausibles au même cran
 * rendent `ambiguous` et aucun produit — mieux vaut faire choisir que tirer au
 * sort.
 */
export function matchLineSku(
  sku: string | null | undefined,
  refs: SupplierSkuRef[],
  unitPrice?: number,
  description?: string | null,
): LineMatch {
  const raw = (sku ?? '').trim();

  const withCost = (productId: string, kind: SkuMatchKind, needsConfirmation: boolean): LineMatch => {
    const ref = refs.find((r) => r.productId === productId);
    const out: LineMatch = { productId, kind, needsConfirmation };
    if (
      typeof unitPrice === 'number' &&
      typeof ref?.costPrice === 'number' &&
      Math.abs(unitPrice - ref.costPrice) > 0.005
    ) {
      out.costPriceDelta = Math.round((unitPrice - ref.costPrice) * 100) / 100;
    }
    return out;
  };

  const none: LineMatch = { productId: null, kind: 'none', needsConfirmation: true };
  const ambiguous: LineMatch = { productId: null, kind: 'ambiguous', needsConfirmation: true };

  /**
   * Tranche un cran : un seul candidat le remporte, plusieurs rendent ambigu.
   * Les produits DU fournisseur priment — si l'un d'eux répond, les autres ne
   * sont même pas considérés, ce qui évite qu'un homonyme d'un autre éditeur
   * rende ambigu un rapprochement qui ne l'était pas.
   */
  const decide = (hits: SupplierSkuRef[], kind: SkuMatchKind, needsConfirmation: boolean): LineMatch | null => {
    if (hits.length === 0) return null;
    const own = hits.filter((h) => h.sameSupplier !== false);
    const pool = own.length > 0 ? own : hits;
    const ids = [...new Set(pool.map((h) => h.productId))];
    if (ids.length > 1) return ambiguous;
    // Hors fournisseur : jamais sans confirmation, quel que soit le cran.
    const offSupplier = pool[0].sameSupplier === false;
    return withCost(ids[0], kind, needsConfirmation || offSupplier);
  };

  if (raw) {
    const exact = refs.filter((r) => (r.supplierSku ?? '').trim() === raw);
    const rExact = decide(exact, 'exact', false);
    if (rExact) return rExact;

    const key = normalizeSku(raw);
    if (key) {
      const rNorm = decide(refs.filter((r) => normalizeSku(r.supplierSku) === key), 'normalized', true);
      if (rNorm) return rNorm;

      const nkey = numericKey(raw);
      const rNum = decide(refs.filter((r) => numericKey(r.supplierSku) === nkey), 'numeric', true);
      if (rNum) return rNum;

      // Contenance : l'extraction du PDF colle parfois deux références
      // (« KR24ITS111 »). On exige une clé discriminante des DEUX côtés, sans
      // quoi « MR » retrouverait la moitié du catalogue.
      if (isDiscriminant(key)) {
        const rIn = decide(
          refs.filter((r) => {
            const k = normalizeSku(r.supplierSku);
            if (!isDiscriminant(k) || k === key) return false;
            return key.includes(k) || k.includes(key);
          }),
          'contained',
          true,
        );
        if (rIn) return rIn;

        // Une seule substitution, insertion ou suppression. Au-delà, on retombe
        // sur des références voisines qui ne sont pas le même disque.
        const rApprox = decide(
          refs.filter((r) => {
            const k = normalizeSku(r.supplierSku);
            return isDiscriminant(k) && k !== key && editDistance(key, k, 1) <= 1;
          }),
          'approx',
          true,
        );
        if (rApprox) return rApprox;
      }
    }
  }

  // Dernier recours : le libellé. Une facture de disquaire porte le titre et
  // souvent l'artiste, et c'est parfois la seule prise quand la référence du
  // fournisseur n'a rien à voir avec la nôtre.
  const want = labelTokens(description);
  if (want.size >= 2) {
    const scored = refs
      .map((r) => ({ ref: r, score: labelSimilarity(want, labelTokens(r.title, r.artistName)) }))
      .filter((x) => x.score >= 0.5)
      .sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      const best = scored[0];
      const runnerUp = scored.find((x) => x.ref.productId !== best.ref.productId);
      // Un écart net avec le second, sinon c'est un choix à faire, pas un
      // rapprochement : deux disques d'un même artiste se ressemblent beaucoup.
      if (!runnerUp || best.score - runnerUp.score >= 0.15) {
        return withCost(best.ref.productId, 'label', true);
      }
      return ambiguous;
    }
  }

  return none;
}

// ————————————————————————————————————————————————————————————————
// Contrôle arithmétique
// ————————————————————————————————————————————————————————————————

export interface ArithmeticIssue {
  code: 'lines_vs_subtotal' | 'subtotal_vs_total' | 'no_lines' | 'no_reference_total';
  /** Écart constaté, dans la devise du document. */
  delta?: number;
  expected?: number;
  found?: number;
}

export interface ArithmeticCheck {
  /** Faux ⇒ la facture ne doit PAS être créée en l'état. */
  ok: boolean;
  /** Somme des lignes recalculée (HT). */
  lineSum: number;
  issues: ArithmeticIssue[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Recalcule les totaux depuis les lignes et les confronte au document.
 *
 * C'est le garde-fou central de la branche non structurée, et la raison pour
 * laquelle elle est utilisable en comptabilité : une ligne hallucinée, une
 * ligne oubliée ou une quantité mal lue déplacent la somme, et l'écart se voit.
 *
 * L'absence de total de référence est traitée comme un échec, pas comme un
 * succès par défaut : sans point de comparaison, rien ne prouve que la lecture
 * est juste, et une facture non vérifiable doit être saisie à la main.
 *
 * `toleranceCents` absorbe les arrondis d'affichage du document, pas un écart
 * réel : au-delà de quelques centimes, c'est une erreur de lecture.
 */
export function checkInvoiceArithmetic(
  parsed: Pick<ParsedIncomingInvoice, 'lines' | 'subtotal' | 'taxTotal' | 'total'>,
  toleranceCents = 2,
): ArithmeticCheck {
  const tol = toleranceCents / 100;
  const issues: ArithmeticIssue[] = [];
  const lineSum = round2(parsed.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0));

  if (parsed.lines.length === 0) issues.push({ code: 'no_lines' });

  const reference = parsed.subtotal ?? parsed.total ?? null;
  if (reference === null) {
    issues.push({ code: 'no_reference_total' });
    return { ok: false, lineSum, issues };
  }

  if (parsed.subtotal !== null && Math.abs(lineSum - parsed.subtotal) > tol) {
    issues.push({
      code: 'lines_vs_subtotal',
      delta: round2(lineSum - parsed.subtotal),
      expected: parsed.subtotal,
      found: lineSum,
    });
  }

  // Le sous-total peut manquer sur un document sans TVA : les lignes servent
  // alors de base, et le total imprimé reste le juge.
  const base = parsed.subtotal ?? lineSum;
  const tax = parsed.taxTotal ?? 0;
  if (parsed.total !== null && Math.abs(base + tax - parsed.total) > tol) {
    issues.push({
      code: 'subtotal_vs_total',
      delta: round2(base + tax - parsed.total),
      expected: parsed.total,
      found: round2(base + tax),
    });
  }

  return { ok: issues.length === 0, lineSum, issues };
}

// ————————————————————————————————————————————————————————————————
// Coercition de la sortie du modèle
// ————————————————————————————————————————————————————————————————

/** Ligne telle que le modèle doit la rendre (contrat de l'edge function). */
interface RawLine {
  sku?: unknown;
  description?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
  lineTotal?: unknown;
  taxRate?: unknown;
}

export interface LlmLine extends ParsedIncomingLine {
  /** Référence fournisseur telle qu'imprimée, avant toute normalisation. */
  sku: string | null;
}

/**
 * Facture lue par inférence : même modèle que le structuré, aux lignes près,
 * qui portent en plus la référence fournisseur imprimée.
 *
 * Écrit par `Omit` plutôt qu'en intersection (`ParsedIncomingInvoice & { lines:
 * LlmLine[] }`) : l'intersection donne `ParsedIncomingLine[] & LlmLine[]`, dont
 * TypeScript tire un élément SANS `sku` à l'indexation, et le `sku` se perd
 * silencieusement au premier `.map()`.
 */
export interface LlmInvoice extends Omit<ParsedIncomingInvoice, 'lines'> {
  lines: LlmLine[];
}

export interface CoercedLlmInvoice {
  parsed: LlmInvoice;
  /**
   * Texte hors tableau conservé tel quel : ruptures, ajustements de quantité,
   * remerciements. Jamais transformé en ligne de facture — ces mentions ne sont
   * pas facturées, et une seule d'entre elles créée par erreur fausse le stock.
   */
  notes: string[];
  /** Anomalies de forme rencontrées pendant la coercition. */
  warnings: string[];
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  // « $2,800.00 » / « 2 800,00 » — on retire tout sauf chiffres, signe et
  // séparateur décimal, en tranchant le rôle de la virgule par sa position.
  const cleaned = v.replace(/[^\d,.-]/g, '');
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized: string;
  if (lastComma > lastDot) normalized = cleaned.replace(/\./g, '').replace(',', '.');
  else normalized = cleaned.replace(/,/g, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
};

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
};

const isoDate = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/**
 * Convertit la sortie brute du modèle en modèle interne.
 *
 * Ne complète jamais un manque : un champ illisible reste null et le document
 * part en revue tel quel. Une ligne sans quantité ni prix exploitables est
 * écartée et signalée — la faire passer avec des zéros la rendrait invisible
 * tout en faussant le contrôle arithmétique, qui est précisément ce qui doit
 * la détecter.
 */
export function coerceLlmInvoice(raw: unknown): CoercedLlmInvoice {
  const warnings: string[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;

  const rawLines = Array.isArray(o.lines) ? (o.lines as RawLine[]) : [];
  if (!Array.isArray(o.lines)) warnings.push('lines absent ou non tabulaire');

  const lines: LlmLine[] = [];
  rawLines.forEach((l, i) => {
    const quantity = num(l?.quantity);
    const unitPrice = num(l?.unitPrice);
    const description = str(l?.description) ?? str(l?.sku);
    if (quantity === null || unitPrice === null || !description) {
      warnings.push(`ligne ${i + 1} écartée (quantité, prix ou libellé illisible)`);
      return;
    }
    const taxRate = num(l?.taxRate) ?? 0;
    lines.push({
      sku: str(l?.sku),
      description,
      quantity,
      unitPrice,
      // Un taux rendu en pourcent (20) au lieu d'une fraction (0.20) est une
      // confusion fréquente : au-delà de 1, on ramène à la convention interne.
      taxRate: taxRate > 1 ? taxRate / 100 : taxRate,
      lineTotal: num(l?.lineTotal) ?? round2(quantity * unitPrice),
    });
  });

  const notes = (Array.isArray(o.notes) ? o.notes : [])
    .map((n) => str(n))
    .filter((n): n is string => n !== null);

  const invoiceNumber = str(o.invoiceNumber);
  if (!invoiceNumber) warnings.push('numéro de facture illisible');

  const seller = (o.seller ?? {}) as Record<string, unknown>;

  return {
    parsed: {
      typeCode: str(o.typeCode) ?? '380',
      invoiceNumber: invoiceNumber ?? '',
      issueDate: isoDate(o.issueDate),
      dueDate: isoDate(o.dueDate),
      currency: str(o.currency)?.toUpperCase() ?? null,
      seller: {
        name: str(seller.name),
        siren: str(seller.siren),
        siret: str(seller.siret),
        vatNumber: str(seller.vatNumber),
        countryCode: str(seller.countryCode)?.toUpperCase() ?? null,
      },
      buyerVatNumber: str(o.buyerVatNumber),
      subtotal: num(o.subtotal),
      taxTotal: num(o.taxTotal),
      total: num(o.total),
      originalInvoiceNumber: str(o.originalInvoiceNumber),
      lines,
    },
    notes,
    warnings,
  };
}
