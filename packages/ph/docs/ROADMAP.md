# BEAU PH — Roadmap and extraction path

## V0 — embedded core inside Coach Gari (this step) ✔
- Generic core in schema `beau_ph`; provider adapters in `beau-ph/providers`; Coach Gari host adapter in `public` + `beau-ph/host-adapters/coach-gari`.
- Real proof on Stripe (test), Aani (manual) and bank transfer (manual), with the existing CG-003/CG-012 behaviour preserved and tested.
- Readiness boundary for Paynow, M-PESA, Ozow, PayShap; placeholder for BEAU Wallet.
- Operational UI stays Coach Gari's Finance screen (methods + rails matrix).

## V1 — first real African rail + a second host
- Onboard one rail for real (Paynow for Zimbabwe is the natural first: Gari's audience, USD-capable): implement `providers/paynow/adapter.ts` (initiate + hash-verified result) and `beau_ph.normalize_paynow_event`; flip `providers.readiness` to `available` by forward migration; add its contract tests; the Coach Gari page needs **no change** — the server-side list simply starts including it for ZW clients.
- Consume BEAU PH from a second host (a Studio/Oolala product) through its own host adapter, proving the boundary. Candidates: Maisons, SILLON commercial flows. Not integrated now.
- Close the V0 gaps listed below.

## In-person acceptance track (parallel to the rail roadmap — see SOFTPOS.md)
- **V0 (done):** capability model (`softpos · card_present · tap_to_pay` reserved), UAE PSP boundaries, provider-app handoff with operator-attested receipt from Coach Gari's "Collect in person" (session or package).
- **V0.1 (owner):** onboard one PSP for real (Magnati / SwipeX or Network International / N-Genius One), enable it in Finance, run a first tap on a test package.
- **V1:** PSP API integration where available (N-Genius / Magnati / Adyen APIs): `verifyWebhook` + `normalize_<psp>_event`, so a handoff receipt can be provider-verified after the fact and `card_present` (terminal) reconciles automatically.
- **Native (separate approval):** a BEAU PH Merchant iOS app integrating Tap to Pay on iPhone through a supported PSP SDK — organisation Apple Developer account + `proximity-reader.payment.acceptance` entitlement, PSP-certified configuration, provider webhook/API verification, BEAU PH normalized reconciliation. Flips `tap_to_pay` from placeholder to available by forward migration; never from the PWA.

## V2 — extract as a standalone reusable service/package
- Move schema `beau_ph` + adapters into their own deployable (own Postgres schema/database + a small service exposing the host contract), publish the TypeScript contracts as a package, replace the in-process definer calls with an authenticated API; hosts keep their adapters.

## V3 — only if justified
- Public API + SDK + MCP surface; merchant configuration UI; reconciliation/evidence dashboard; hosted payment-method discovery; outbound webhooks to hosts.

**V2/V3 are not built now** — a standalone dashboard, API or service requires separate approval.

## Recurring collection (host-scheduled, provider-charged) ✔
- The SCHEDULE belongs to the host, not to the provider: Coach Gari's `subscriptions` / `subscription_cycles` decide when a period is due, and every rail collects it the ordinary way. Stripe Subscriptions were deliberately not used — a provider-owned calendar would be a second source of truth about when a period is due, and every disagreement between the two would surface as a client charged twice or not at all.
- BEAU PH's contribution is one optional flag on a request (`saveInstrument`) and one module outside the adapter contract (`providers/stripe/recurring.ts`). The flag asks a provider to keep the payer's instrument for later off-session use, with the consent given in the provider's own UI at payment time; a provider that cannot do this ignores it.
- `recurring.ts` is deliberately NOT part of `ProviderAdapter`. The adapter contract describes a payment the PAYER initiates. Charging a stored instrument is the opposite — the merchant initiates and nobody is present — and putting the two behind one interface would let a host call the second while believing it was doing the first.
- An off-session charge returns through the ordinary verified webhook and is reconciled by a host function of its own (`process_stripe_charge_event`), the same separation the PayPal rail has. It is admitted only by a marker the charge itself sets, so a PaymentIntent from the ordinary Checkout flow can never be settled twice.
- Generalising this to other rails is a V1+ question and is not pretended to be solved: only Stripe has both the mandate and the off-session charge today.

## Known gaps carried from V0 (honest list)
1. **Provider-side cancel on supersede** — when a request is cancelled (paid on another rail, or superseded by a manual receipt of another amount) the core marks it cancelled but does not call the adapter's `cancel()` to expire an open Stripe Checkout Session; a late card payment would then be refused by BEAU PH (ledger untouched, evidence kept) and would need a manual refund. V1: the Edge/host calls `adapter.cancel(provider_reference)` on cancellation events.
2. **Legacy `no_request` path** — orders created before BEAU PH (or through `create_order_for_pack` without going through the request flow) are still validated by the host's original amount check when their webhook arrives. Remove once no pre-BEAU order can be in flight.
3. **`cash` / `manual` / `external` sources** remain host-only ledger sources (not approved BEAU PH provider keys). Decide: promote `cash` to a manual provider or drop it.
4. **Deployment readiness is reported by the Edge**, not stored — correct (secrets never touch the DB) but means the Finance rails matrix cannot show "configured"; it shows product readiness + merchant enablement.
5. **Customer country for bookings** is unknown (the booking flow captures no country) → merchant country applies. Packs use the CRM contact's country through a small text→ISO mapping (`public.cg_country_code`), which is host knowledge.
6. **BEAU Wallet** remains a placeholder by decision; its future request contract is documented in the adapter file.
7. **Edge bundles** are deployed from the repo sources through the Management API; a CLI deploy (`supabase functions deploy`) from the repo produces the same graph.
8. **SoftPOS V0 is operator-attested, not provider-verified.** The PSP receipt reference is mandatory and auditable against the PSP statement, but BEAU PH cannot confirm it with the PSP until an API integration exists (V1). A fake reference would be caught at settlement reconciliation, not at confirmation time.
9. **Runtime E2E is owner-run.** The database suites prove every flow in rollback; the deployed Edge Functions + Vercel page are exercised with `scripts/e2e-runtime.mjs` / `scripts/test-webhook.mjs` from a laptop (the build sandbox cannot reach `*.supabase.co` / `*.vercel.app`). At the V0 gate the live project held **zero** orders, payments or BEAU PH requests — no real Stripe TEST round trip had been made yet.
10. **Tenant scope is host-cooperative in V0** (closed at the gate by `20260921_beau_ph_tenant_scope.sql`): the core enforces the merchant key a host passes; a host that omits it acts unscoped, which is acceptable only because the core is reachable solely by definer functions and `service_role`. V2 (standalone service) must derive the merchant from the caller's credential, never from a parameter.
