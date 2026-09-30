# BEAUX

The BEAU building blocks, shared by Oolala's products. Private.

| Package | What it is | First host |
|---|---|---|
| [`packages/ph`](packages/ph) | **BEAU PH** — the payment hub: one contract for every payment rail (Stripe, PayPal, Wise, Aani, bank transfer, cash, SoftPOS handoff, M-PESA / Paynow / Ozow / PayShap boundaries), BEAU FX, and the `beau_ph` Postgres schema that holds requests, attempts, events and reconciliation. | Coach Gari |
| [`packages/facture`](packages/facture) | **FactureX** — e-invoicing core: Factur-X (EN 16931) generation, PDF/A-3, provider contract for approved platforms (iopole, B2Brouter), inbound ingestion. *Arriving from SILLON — phase B.* | SILLON |

The two packages do not depend on each other. Linking a payment to an invoice is
a host's job, written in the product that uses both.

## How a product uses a package

- **Code** — TypeScript that runs unchanged in Deno (Supabase Edge Functions),
  Node 22+ and the browser. A host imports it; nothing is compiled here.
- **Database** — BEAU PH is a *module installed into each host's database*, not a
  central service: its migrations live in `packages/ph/sql/migrations` and keep
  their own version ledger (`beau_ph.schema_versions`), apart from the host's.
  See [`packages/ph/sql/README.md`](packages/ph/sql/README.md).

## Rules

1. A host goes through a package's public surface (its contracts, its SQL
   functions), never into its tables or internals.
2. Nothing secret is ever committed: keys live in the host's deployment secrets.
3. Every change keeps both suites green: `npm test` (TypeScript) and
   `npm run test:ph:db` (schema rebuilt from migrations + contract suite).

## Running the tests

```bash
npm test                                                     # TypeScript, no network
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm run test:ph:db   # a THROWAWAY Postgres
```
