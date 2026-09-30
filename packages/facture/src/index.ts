/**
 * @thestudio/einvoicing-core — cœur e-invoicing réutilisable (P1, phase 0).
 *
 * SOURCE UNIQUE du moteur : contrat provider + orchestration/cycle de vie +
 * module de format Factur-X (FR) + ingestion entrante. Zéro dépendance SILLON
 * (tenant, auth, bucket, UI restent chez le consommateur). Éprouvé par deux
 * providers réels (iopole, B2Brouter) branchés derrière le MÊME contrat sans
 * toucher ce cœur.
 *
 * Frontière conceptuelle (mandat P1) :
 *   • orchestration / cycle de vie / preuve / contrat provider = cœur générique
 *     (provider.ts, orchestrator.ts, iopole-mapping.ts, b2brouter-mapping.ts,
 *      ingest.ts) ;
 *   • Factur-X = module de format FR (facturx-xml/pdfa/extract/parse) ;
 *   • iopole / B2Brouter = adaptateurs providers OPTIONNELS (phase 2,
 *     sous-chemin providers/) ;
 *   • tenant / auth / journal / persistance métier / UI = HORS package.
 *
 * Dépendances externes uniquement : pdf-lib, fast-xml-parser, Web Crypto.
 */

// — Contrat provider + modèle de statuts interne (section G)
export * from './provider';

// — Orchestration sortante/entrante (journal-first, idempotence, réconciliation)
export * from './orchestrator';

// — Mapping PUR des référentiels providers → modèle interne
export * from './iopole-mapping';
export * from './b2brouter-mapping';

// — Ingestion entrante : rapprochement fournisseur + verdict de déduplication
export * from './ingest';

// — Module de format Factur-X (FR) : génération CII D22B + PDF/A-3 + extraction
export * from './facturx-xml';
export * from './facturx-pdfa';
export * from './facturx-extract';
export * from './facturx-parse';

// — Branche non structurée : coercition + garde-fou arithmétique + SKU
export * from './llm-invoice';
