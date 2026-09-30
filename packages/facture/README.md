# FactureX

E-invoicing core, imported from SILLON `packages/einvoicing-core` on 2026-09-30
(SILLON @ d410070), unchanged. No dependency on any host: tenant, auth, storage
and UI stay with the product that uses it. Dependencies: `pdf-lib`,
`fast-xml-parser`, Web Crypto.

```
src/provider.ts            contract for an approved platform (PA) + internal status model and legal transitions
src/orchestrator.ts        outbound / inbound lifecycle: journal first, idempotence, reconciliation
src/iopole*.ts, b2brouter*.ts   two real platform adapters behind that one contract, and their status mappings
src/provider-select.ts     choosing the platform
src/facturx-xml.ts         Factur-X 1.09.2 (= ZUGFeRD 2.5.2) / CII D22B, profile EN 16931 (MINIMUM / BASIC WL never emitted)
src/facturx-pdfa.ts        embedding into PDF/A-3B (attachment, XMP, OutputIntent, document ID)
src/facturx-extract.ts     finding the structured XML in an incoming PDF or XML
src/facturx-parse.ts       reading an incoming CII invoice
src/ingest.ts              supplier matching and de-duplication verdict (inbound)
src/llm-invoice.ts         unstructured branch: coercion, arithmetic guard, SKU
```

## Tests — `npm run test:facture` (vitest), 138

The 135 tests that came with the package, plus `facturx-roundtrip.test.ts`: the
whole chain inside the package — build → embed into PDF/A-3 → extract → parse —
on a service invoice, and the rule that each generation is a new document (new
`/ID`, new hash), so idempotence rests on the stored canonical PDF.

## Imports

Relative imports have no extension (Vite / vitest resolve them). A Deno host
generates extension-ful copies — SILLON does it with
`scripts/einvoicing-core-sync.mjs`.

## Next

1. VAT franchise (art. 293 B CGI), which micro-entrepreneurs need.
2. SILLON consumes this package instead of its in-repo copy (a PR in SILLON).
3. e-reporting (B2C transactions, payment data) — design first, depends on the
   approved platform's API.

Public name to decide: "Factur-X" is the name of the standard itself.
