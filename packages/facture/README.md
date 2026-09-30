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
src/b2brouter-ereporting.ts B2Brouter e-reporting: payments → F10 reports, report states, ledgers (import directly, not via index)
src/ereporting.ts          e-reporting (flux 10.3 / 10.4): Paris days, periods by VAT regime, daily aggregates, idempotent period report, provider contract, reconciliation
```

## Tests — `npm run test:facture` (strict typecheck, then vitest), 170

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

## E-reporting — core added 2026-09-30, no platform wired yet

`ereporting.ts` knows no platform. It turns B2C sales and payments into the
reports the reform asks for:

- **flux 10.3** (B2C transactions): one line per Paris day, currency, category
  (TLB1 goods · TPS1 services · TNT1 outside French VAT · TMA1 margin) and VAT
  rate, with the number of sales;
- **flux 10.4** (B2C payments): received amounts per day and rate, services only;
- **periods** by VAT regime — transactions: réel normal mensuel by décade,
  réel normal trimestriel and réel simplifié monthly, franchise every two months;
  payments monthly;
- a **period report** refuses an operation outside its period, hashes its content
  (same content → same idempotency key, a correction → a new one);
- `EReportingProvider`: a platform takes either the aggregates or the single
  operations (it aggregates itself — B2Brouter's "Ledgers"); in the second case
  our aggregates are control totals, checked by `reconcileAggregates`.

To confirm before relying on it: payment data under the franchise (encoded as
not due — the DGFiP table lists none), the category of a franchise sale (encoded
as TPS1/TLB1 at 0 %), and every rule against the current DGFiP external specs.

### B2Brouter (OpenAPI v2026-06-26, read 2026-09-30)

B2Brouter derives the declarations from what lives on its side, so
`b2brouter-ereporting.ts` is small:

- **once per company**: Tax Report Setting `dgfip` — `vat_regime`
  (`B2B_VAT_REGIME` maps ours), `type_operation`, `enterprise_size`, `naf_code`,
  `auto_generate` / `auto_send`, `reason_vat_exempt` (default VATEX-FR-FRANCHISE);
- **transactions (10.1 / 10.3)**: generated from the invoices the account issues,
  B2C included — a B2C sale goes through the same invoice import as flux 1;
- **payments (10.2 / 10.4)**: `recordPayment` → `POST /accounts/{id}/payments` on
  the invoice; B2Brouter emits the F10 payment report. The API has no idempotency
  key there, so the host's receipt id is the payment `reference` and an existing
  one is returned instead of posting again;
- **follow-up**: `taxReportsForInvoice` (states mapped to GENERATED / SUBMITTED /
  ACCEPTED / REJECTED, `registered_with_errors` flagged), `ledger`.

Not yet exercised against the sandbox. The first run will tell: whether a B2C
invoice imported as Factur-X is accepted and turned into a flux 10 transaction,
and what the Ledger XML looks like (to plug `reconcileAggregates` on it).

## Next

1. Sandbox run of the above (needs the sandbox key as a Supabase secret of the
   host project, and the company's `dgfip` setting in the sandbox).
2. Confirm the BT-32 value in the platform sandbox (VATEX-FR-FRANCHISE is
   B2Brouter's own default exemption code).

Public name to decide: "Factur-X" is the name of the standard itself.
