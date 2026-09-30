# FactureX

E-invoicing core — **phase B**, not imported yet.

Source: SILLON `packages/einvoicing-core` (Factur-X EN 16931 XML, PDF/A-3 embedding,
extraction/parsing, provider contract + orchestration, iopole and B2Brouter
adapters, inbound ingestion, LLM invoice coercion with arithmetic guard).

Planned, in order:
1. import with its tests, unchanged;
2. VAT franchise (art. 293 B CGI — category E; exemption code to confirm against the current EN 16931 VATEX list), which
   micro-entrepreneurs need;
3. SILLON consumes the package instead of its in-repo copy (a PR in SILLON);
4. e-reporting (B2C transactions, payment data) — design first, depends on the
   approved platform's API.

Public name to decide: "Factur-X" is the name of the standard itself.
