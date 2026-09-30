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

## Tests — `npm run test:facture` (strict typecheck, then vitest), 146

The 135 tests that came with the package, plus `facturx-roundtrip.test.ts`: the
whole chain inside the package — build → embed into PDF/A-3 → extract → parse —
on a service invoice, and the rule that each generation is a new document (new
`/ID`, new hash), so idempotence rests on the stored canonical PDF; and
`franchise-293b.test.ts` (below).

Checked against SILLON too: its 82 app-level e-invoicing tests (PDF/A-3, inbound,
supplier matching, invoice mapping) pass with this version of the package.

## VAT franchise (art. 293 B CGI) — added 2026-09-30

`regime.regimeCode = '293 B'` (exported as `FRANCHISE_REGIME_CODE`): category
**E**, 0 %, exemption code **VATEX-FR-FRANCHISE**, the mention
« TVA non applicable, art. 293 B du CGI » (`FRANCHISE_LEGAL_MENTION`, used when
the invoice gives none) in BG-1 and as the exemption reason. The seller's VAT
number becomes optional; without one, `seller.taxRegistrationId` (BT-32, scheme
`FC`) is required, which is what BR-E-02 asks for. An invoice that charges VAT
under the franchise is refused; a rate typed by mistake on a line does not create
a second breakdown (true for every non-S category now).

**To confirm before the first real emission:** the exemption code and the BT-32
value against the approved platform's schematron, in its sandbox.

## Imports

Relative imports have no extension (Vite / vitest resolve them). A Deno host
generates extension-ful copies — SILLON does it with
`scripts/einvoicing-core-sync.mjs`.

## Hosts

- **SILLON** — `packages/einvoicing-core/src` is a copy of this `src/`, pinned by
  `UPSTREAM.json` (BEAUX commit + SHA-256 per file) and guarded by a blocking CI
  check (`npm run einvoicing:upstream:check`). To ship a change: commit it here,
  then in SILLON `node scripts/einvoicing-core-upstream.mjs --from <BEAUX checkout>`
  and `npm run sync:einvoicing` (Deno copies). Adopted in SILLON #229 (2026-09-30).

## Next

1. e-reporting (B2C transactions, payment data) — design first, depends on the
   approved platform's API.
2. Confirm VATEX-FR-FRANCHISE and the BT-32 value in the platform sandbox.

Public name to decide: "Factur-X" is the name of the standard itself.
