# BEAU PH — BEAU Payment Hub

**Canonical name:** BEAU PH · **Expanded:** BEAU Payment Hub · **Identifiers:** `beau-ph` (paths/packages), `beau_ph` (database schema).

BEAU PH is a **multi-rail payment orchestration and reconciliation layer**. It answers one question for a host application:

> *Given this merchant/order, the customer's country, the currency and the providers that are actually ready — which payment methods can be offered, how is payment initiated, and how does the result get reconciled back into the host application's authoritative commerce model?*

It is **not** a bank, a PSP, a replacement for Stripe / M-PESA / Paynow / Aani, an accounting ledger, or a crypto wallet.

## Naming — three distinct things

| Name | What it is |
|---|---|
| **BEAU** | the wallet / product ecosystem |
| **BEAU PH** | this: the payment orchestration hub |
| **BEAU Wallet adapter** | one future crypto provider/rail *inside* BEAU PH (`beau_wallet`) |

The existing BEAU Wallet project is not renamed by this product.

## Status — V0 (embedded)

BEAU PH V0 lives inside the Coach Gari repository and Supabase project, behind a **clean boundary**:

- **Core** = Postgres schema `beau_ph` (`supabase/migrations/2026091[5-8]_beau_ph_*.sql`). Generic entities, provider-independent states, eligibility, evidence, idempotent normalization, reconciliation receipts. Not exposed through the API. **Knows nothing about Coach Gari** — no session packs, no bookings, no CRM, no health data, no Gari UI.
- **Provider adapters** = `beau-ph/providers/*` (TypeScript, Deno) for provider I/O + `beau_ph.normalize_<provider>_event` (SQL) for evidence → normalized state.
- **Host adapter (Coach Gari)** = `public.cg_ph_*` + the patched `attach_checkout` / `process_stripe_event` / `payment_record_manual` / `report_view` (SQL, `supabase/migrations/20260917_beau_ph_coach_gari_adapter.sql`) and the thin client in `beau-ph/host-adapters/coach-gari/adapter.ts` used by the Edge Functions.

Coach Gari remains the first consuming application and the proof environment. Its Finance screen remains the operational UI; there is deliberately **no standalone dashboard, API or service yet** (see ROADMAP).

## Rails (see docs/PROVIDERS.md for the full matrix)

| Rail | Key | Today |
|---|---|---|
| Card (Stripe) | `stripe` | working — test mode, webhook-confirmed |
| Aani (UAE instant payment) | `aani` | working — V1 static instructions, operator-confirmed |
| Bank transfer | `bank_transfer` | working — instructions, operator-confirmed |
| Paynow (Zimbabwe) | `paynow` | adapter boundary — not onboarded, cannot act |
| M-PESA (Kenya) | `mpesa` | adapter boundary — not onboarded, cannot act |
| Ozow (South Africa) | `ozow` | adapter boundary — not onboarded, cannot act |
| PayShap (South Africa) | `payshap` | adapter boundary — not onboarded, cannot act |
| BEAU Wallet | `beau_wallet` | placeholder — "coming soon", cannot act |
| Network International (N-Genius) | `network_international` | in-person **SoftPOS handoff** available (N-Genius One app, operator-attested receipt); API / native Tap to Pay reserved |
| Magnati (SwipeX) | `magnati` | in-person **SoftPOS handoff** available (SwipeX app, operator-attested receipt); API / native Tap to Pay reserved |
| Adyen | `adyen` | SDK-only: no handoff; native Tap to Pay + Checkout reserved, not onboarded |

**Capabilities, not just rails.** Every provider declares capabilities — `online_checkout · payment_link · manual_instructions · wallet · bank_transfer · mobile_money · softpos · card_present · tap_to_pay · qr · crypto` — each with its own readiness, confirmation mode, platform restriction and initiator. In-person acceptance (`softpos` / `card_present` / `tap_to_pay`) is a first-class future capability: V0 = handoff to the PSP's certified Tap to Pay on iPhone app; the native path (a BEAU PH Merchant iOS app + PSP SDK + Apple entitlement) is reserved. BEAU PH never handles card or PIN data and never reads NFC itself — see `docs/SOFTPOS.md`.

Africa is a first-class requirement: the goal is that Gari's audience in Zimbabwe, Kenya and South Africa can pay on the rail they actually use, without a separate commerce model per country. Eligibility by country and currency is a **server-side** concern of BEAU PH; no host page carries `if country == ZW`.

## Repository map

```
beau-ph/
  PRODUCT.md                      ← this file
  docs/ARCHITECTURE.md            ← diagram, domain model, event model, eligibility model, flows
  docs/CONTRACTS.md               ← provider adapter contract · SQL normalizer contract · host adapter contract
  docs/PROVIDERS.md               ← readiness matrix + owner actions per rail
  docs/SECURITY.md                ← secrets, exposure, verification, operator confirmations
  docs/TESTING.md                 ← suites, harness, what is proven
  docs/ROADMAP.md                 ← V0 → V1 → V2 → V3 and known gaps
  docs/SOFTPOS.md                 ← in-person / Tap to Pay: UAE investigation, V0 handoff, reserved native path
  contracts/provider.ts, host.ts  ← TypeScript contracts
  core/registry.ts                ← provider registry, runtime readiness map, public-output guard
  providers/{stripe,aani,bank-transfer,paynow,mpesa,ozow,payshap,beau-wallet}/adapter.ts
  host-adapters/coach-gari/adapter.ts
supabase/migrations/20260915_beau_ph_core.sql            ← core schema + functions
supabase/migrations/20260916_beau_ph_core_addendum.sql   ← cancel/expire + attach_attempt fix
supabase/migrations/20260917_beau_ph_coach_gari_adapter.sql
supabase/migrations/20260918_beau_ph_core_settle_siblings.sql
supabase/migrations/20260919_beau_ph_capabilities.sql    ← capability model, platform/initiator eligibility, UAE PSP boundaries
supabase/migrations/20260920_beau_ph_coach_gari_collect.sql ← host "Collect in person" (softpos handoff)
supabase/tests/beau_ph_contract.sql                      ← generic contract suite (+ host reconciliation, + in-person)
```

## Principles (enforced, not aspirational)

1. **The host owns the money truth.** BEAU PH emits normalized events; the host reconciles them into its ledger exactly once (`beau_ph.reconciliations` is the receipt). No second ledger.
2. **Amounts come from the host, never from the payer.** A provider event with another amount is refused; the evidence is kept.
3. **Manual rails are real provider types.** Instructions issued → pending external settlement → an authenticated, authorised operator confirms (identity, timestamp, amount, currency, provider, reference recorded). Viewing/copying instructions never marks anything paid.
4. **Evidence is never discarded.** Every provider event is stored verbatim, including the refused ones.
5. **Not-configured and placeholder rails cannot act.** Even if a merchant "enables" them, even if someone sets the env vars.
6. **No secret in the hub.** JSON columns are CHECK-guarded against secret-like keys/values; adapters report presence, never values.
7. **Public references, never UUIDs**, on anything a payer sees (`CG-1048`).
8. **No card data, ever.** In-person acceptance goes through a certified PSP app or SDK; BEAU PH sees a receipt reference or a verified provider event, never a PAN, PIN or NFC frame.
