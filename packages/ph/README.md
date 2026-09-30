# BEAU PH

Payment hub. Product brief: [PRODUCT.md](PRODUCT.md) · design notes: [docs/](docs).

```
contracts/       the provider and host contracts (types)
core/registry.ts the provider registry, runtime readiness, public-output guard
providers/       one adapter per rail (Stripe, PayPal, Wise, Aani, bank, cash, SoftPOS, …)
host-adapters/   reference host: Coach Gari (the first product running on BEAU PH)
sql/migrations/  the beau_ph schema — 0001_baseline = production on 2026-09-30
sql/tests/       core_contract.sql (no host) + the Supabase harness it runs on
tests/           TypeScript tests (Node 22+, types stripped, no network)
```

Extracted on 30 September 2026 from the Coach Gari repository, where it was built
(Coach Gari decisions CG-012 onwards). The docs were written there and still speak
of Coach Gari as the host; that is accurate — it is the first one.

## Tests

| Suite | What it proves |
|---|---|
| `sql/tests/core_contract.sql` — 98 checks | eligibility, authoritative amounts, event normalisation, manual rails never self-confirm, secrets never public, placeholder rails cannot pay, SoftPOS eligibility, rail configuration bounds, BEAU FX, cash — on a database with **no host at all** |
| `tests/imports.test.mjs` | every module loads on its own |
| `tests/webhook-signature.test.mjs` | Stripe signature verification (timing-safe, tolerance, rotation) |
| `tests/stripe-embedded.test.mjs` | Checkout session parameters, payment mode, fee evidence |

The host half of the contract (a host reconciles once, idempotently; multi-rail
races; multi-tenant isolation against a real host; test/live never cross;
cancellation at the provider) runs in the host's own repository — for Coach Gari,
`supabase/tests/beau_ph_contract.sql`.
