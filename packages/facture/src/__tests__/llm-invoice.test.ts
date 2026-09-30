/**
 * Branche non structurée : coercition, contrôle arithmétique, rapprochement.
 *
 * La facture de référence est un document réel (Mississippi Records →
 * Outre-National, mai 2026). Elle porte les trois pièges qui ont motivé ce
 * module : du texte libre placé AVANT le tableau et qui ressemble à une ligne,
 * une mention d'ajustement de quantité, et des références à séparateurs
 * instables. Les cas négatifs ne sont pas décoratifs — un garde-fou qu'on n'a
 * jamais vu refuser ne prouve rien.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeSku,
  matchLineSku,
  checkInvoiceArithmetic,
  coerceLlmInvoice,
} from '../llm-invoice';

/** Sortie attendue du modèle pour la facture de référence. */
const MISSISSIPPI = {
  invoiceNumber: 'DC88A18C-0022',
  issueDate: '2026-05-12',
  dueDate: '2026-06-11',
  currency: 'USD',
  seller: { name: 'Mississippi Records', countryCode: 'US' },
  subtotal: 3686.0,
  taxTotal: 0,
  total: 3686.0,
  notes: [
    'thanks for your order!',
    'OUT OF STOCK: Michael Hurley Back Home',
    'Nat-Ural ordered x5 shipped x3',
  ],
  lines: [
    { sku: 'POEM002', description: 'Wesenyeleh Mebreku - Resonance Of Time', quantity: 200, unitPrice: 14.0, lineTotal: 2800.0 },
    { sku: 'MRI - 131', description: 'Aurita - Chambacu LP', quantity: 5, unitPrice: 12.0, lineTotal: 60.0 },
    { sku: 'MP03', description: 'Dragging An Ox Through Water Whole Earth Catalogued', quantity: 5, unitPrice: 14.0, lineTotal: 70.0 },
    { sku: 'SS063', description: "Les Filles de Illighadad 'At Pioneer Works' LP", quantity: 5, unitPrice: 10.0, lineTotal: 50.0 },
    { sku: 'MR28', description: 'The Rats - S/T', quantity: 10, unitPrice: 10.0, lineTotal: 100.0 },
    { sku: 'FYR030', description: 'Ruth Parker Otherwise Occupied', quantity: 10, unitPrice: 14.0, lineTotal: 140.0 },
    { sku: 'KR24ITS111', description: 'V/A - As Time Draws Near', quantity: 20, unitPrice: 12.0, lineTotal: 240.0 },
    { sku: 'OLV-013', description: 'V/A African Steel', quantity: 5, unitPrice: 13.0, lineTotal: 65.0 },
    { sku: 'KR 16', description: 'Nat-Ural', quantity: 3, unitPrice: 17.0, lineTotal: 51.0 },
    { sku: 'MOR-11', description: 'The Cosmic Tones Research Trio S/T', quantity: 10, unitPrice: 11.0, lineTotal: 110.0 },
  ],
};

describe('normalizeSku', () => {
  it('réduit les variantes de séparateur à une même forme', () => {
    expect(normalizeSku('MRI - 131')).toBe('MRI131');
    expect(normalizeSku('MRI-131')).toBe('MRI131');
    expect(normalizeSku('mri.131')).toBe('MRI131');
    expect(normalizeSku('KR 16')).toBe('KR16');
  });

  it('ne rend jamais null et absorbe le vide', () => {
    expect(normalizeSku(null)).toBe('');
    expect(normalizeSku('   ')).toBe('');
    expect(normalizeSku('---')).toBe('');
  });

  it('ne confond pas deux références distinctes', () => {
    expect(normalizeSku('KR 16')).not.toBe(normalizeSku('KR 161'));
    expect(normalizeSku('MP03')).not.toBe(normalizeSku('MP30'));
  });
});

describe('matchLineSku', () => {
  const refs = [
    { productId: 'p-poem', supplierSku: 'POEM002', costPrice: 14.0 },
    { productId: 'p-mri', supplierSku: 'MRI-131', costPrice: 11.0 },
    { productId: 'p-kr', supplierSku: 'KR16' },
  ];

  it('rapproche sans confirmation sur égalité stricte', () => {
    const m = matchLineSku('POEM002', refs);
    expect(m).toMatchObject({ productId: 'p-poem', kind: 'exact', needsConfirmation: false });
  });

  it('rapproche une variante de séparateur MAIS exige une confirmation', () => {
    const m = matchLineSku('MRI - 131', refs);
    expect(m.productId).toBe('p-mri');
    expect(m.kind).toBe('normalized');
    expect(m.needsConfirmation).toBe(true);
  });

  it('signale une dérive de prix sans bloquer le rapprochement', () => {
    expect(matchLineSku('MRI - 131', refs, 12.0).costPriceDelta).toBe(1);
    expect(matchLineSku('POEM002', refs, 14.0).costPriceDelta).toBeUndefined();
  });

  it('refuse de trancher quand deux produits portent la même référence', () => {
    const ambiguous = [
      { productId: 'a', supplierSku: 'KR 16' },
      { productId: 'b', supplierSku: 'KR-16' },
    ];
    const m = matchLineSku('KR16', ambiguous);
    expect(m.productId).toBeNull();
    expect(m.kind).toBe('ambiguous');
    expect(m.needsConfirmation).toBe(true);
  });

  it('rend none — et non un produit au hasard — sur référence inconnue ou absente', () => {
    expect(matchLineSku('INCONNU999', refs).productId).toBeNull();
    expect(matchLineSku(null, refs)).toMatchObject({ kind: 'none', needsConfirmation: true });
  });
});

describe('checkInvoiceArithmetic', () => {
  it('valide la facture de référence : 10 lignes = 3 686,00', () => {
    const { parsed } = coerceLlmInvoice(MISSISSIPPI);
    const check = checkInvoiceArithmetic(parsed);
    expect(check.lineSum).toBe(3686);
    expect(check.issues).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it('REFUSE une ligne hallucinée : le piège du texte hors tableau', () => {
    // « Michael Hurley Back Home » est une mention de rupture, pas une ligne.
    // Si le modèle la facture, la somme dépasse le sous-total imprimé.
    const { parsed } = coerceLlmInvoice({
      ...MISSISSIPPI,
      lines: [...MISSISSIPPI.lines, { sku: null, description: 'Michael Hurley Back Home', quantity: 5, unitPrice: 14.0 }],
    });
    const check = checkInvoiceArithmetic(parsed);
    expect(check.ok).toBe(false);
    expect(check.issues.map((i) => i.code)).toContain('lines_vs_subtotal');
    expect(check.issues.find((i) => i.code === 'lines_vs_subtotal')?.delta).toBe(70);
  });

  it('REFUSE une ligne omise', () => {
    const { parsed } = coerceLlmInvoice({ ...MISSISSIPPI, lines: MISSISSIPPI.lines.slice(0, -1) });
    expect(checkInvoiceArithmetic(parsed).ok).toBe(false);
  });

  it('REFUSE une quantité mal lue', () => {
    const lines = MISSISSIPPI.lines.map((l, i) => (i === 0 ? { ...l, quantity: 20 } : l));
    const { parsed } = coerceLlmInvoice({ ...MISSISSIPPI, lines });
    expect(checkInvoiceArithmetic(parsed).ok).toBe(false);
  });

  it('REFUSE un document sans total de référence plutôt que de le supposer juste', () => {
    const { parsed } = coerceLlmInvoice({ ...MISSISSIPPI, subtotal: null, total: null });
    const check = checkInvoiceArithmetic(parsed);
    expect(check.ok).toBe(false);
    expect(check.issues.map((i) => i.code)).toContain('no_reference_total');
  });

  it('tolère l’arrondi d’affichage, pas un écart réel', () => {
    const { parsed } = coerceLlmInvoice({ ...MISSISSIPPI, subtotal: 3686.01, total: 3686.01 });
    expect(checkInvoiceArithmetic(parsed).ok).toBe(true);
    const { parsed: off } = coerceLlmInvoice({ ...MISSISSIPPI, subtotal: 3686.5, total: 3686.5 });
    expect(checkInvoiceArithmetic(off).ok).toBe(false);
  });

  it('accepte une facture sans TVA : base = lignes, total imprimé juge', () => {
    const { parsed } = coerceLlmInvoice({ ...MISSISSIPPI, subtotal: null, taxTotal: null });
    expect(checkInvoiceArithmetic(parsed).ok).toBe(true);
  });
});

describe('coerceLlmInvoice', () => {
  it('conserve le texte hors tableau en notes, jamais en lignes', () => {
    const { parsed, notes } = coerceLlmInvoice(MISSISSIPPI);
    expect(parsed.lines).toHaveLength(10);
    expect(notes).toContain('Nat-Ural ordered x5 shipped x3');
    expect(parsed.lines.some((l) => l.description.includes('Michael Hurley'))).toBe(false);
  });

  it('garde la référence telle qu’imprimée', () => {
    const { parsed } = coerceLlmInvoice(MISSISSIPPI);
    expect(parsed.lines[1].sku).toBe('MRI - 131');
  });

  it('lit les montants formatés « $2,800.00 » et « 2 800,00 »', () => {
    const { parsed } = coerceLlmInvoice({
      ...MISSISSIPPI,
      subtotal: '$3,686.00',
      lines: [{ sku: 'X', description: 'X', quantity: '200', unitPrice: '$14.00' }],
    });
    expect(parsed.subtotal).toBe(3686);
    expect(parsed.lines[0].unitPrice).toBe(14);
    const { parsed: fr } = coerceLlmInvoice({ lines: [{ sku: 'X', description: 'X', quantity: '1', unitPrice: '2 800,50' }] });
    expect(fr.lines[0].unitPrice).toBe(2800.5);
  });

  it('ramène un taux rendu en pourcent à la convention interne', () => {
    const { parsed } = coerceLlmInvoice({ lines: [{ sku: 'X', description: 'X', quantity: 1, unitPrice: 10, taxRate: 20 }] });
    expect(parsed.lines[0].taxRate).toBe(0.2);
  });

  it('écarte et signale une ligne inexploitable au lieu de la combler de zéros', () => {
    const { parsed, warnings } = coerceLlmInvoice({
      lines: [
        { sku: 'OK', description: 'bon', quantity: 1, unitPrice: 10 },
        { sku: 'KO', description: 'sans prix', quantity: 2 },
      ],
    });
    expect(parsed.lines).toHaveLength(1);
    expect(warnings.join(' ')).toMatch(/ligne 2/);
  });

  it('ne fabrique rien à partir du vide', () => {
    const { parsed, warnings } = coerceLlmInvoice({});
    expect(parsed.invoiceNumber).toBe('');
    expect(parsed.total).toBeNull();
    expect(parsed.lines).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
    expect(checkInvoiceArithmetic(parsed).ok).toBe(false);
  });

  it('rejette une date non ISO plutôt que de la deviner', () => {
    const { parsed } = coerceLlmInvoice({ ...MISSISSIPPI, issueDate: 'May 12, 2026' });
    expect(parsed.issueDate).toBeNull();
  });
});
