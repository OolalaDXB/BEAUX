# BEAU PH — Architecture (V0)

## 1. The boundary, as a diagram

```
                         PAYER (client page /r/<token>, booking page)
                                        │  renders exactly the list it is given
                                        ▼
┌──────────────────────────── Supabase Edge Functions (Deno) ────────────────────────────┐
│  report · checkout · stripe-webhook                                                    │
│     │ uses                                                                             │
│     ▼                                                                                  │
│  beau-ph/host-adapters/coach-gari/adapter.ts   ← names the host RPCs, nothing else     │
│  beau-ph/core/registry.ts                       ← provider registry, runtimeMap(env)   │
│  beau-ph/providers/<rail>/adapter.ts            ← provider I/O: create redirect,       │
│        stripe · aani · bank-transfer ·             verify webhook, enrich evidence,    │
│        paynow · mpesa · ozow · payshap ·           report deployment readiness         │
│        beau-wallet                                 (presence of secrets, never values) │
└──────────────┬──────────────────────────────────────────────────────┬──────────────────┘
               │ RPC (service role)                                   │ HTTPS
               ▼                                                      ▼
┌───────────── Postgres: schema public (HOST = Coach Gari) ─────┐   Stripe (test) …
│  orders · payments · refunds · chargebacks · partner ledger   │   future: Paynow, M-PESA,
│  bookings · session_packs · crm_contacts (health: never here) │   Ozow, PayShap, BEAU Wallet
│                                                               │
│  HOST ADAPTER (SQL):                                          │
│   cg_ph_request_for_order / _for_pack / _for_booking          │
│   attach_checkout · process_stripe_event ·                    │
│   payment_record_manual · report_view · payment_method_set    │
│   finance_transactions · payment_methods_summary ·            │
│   beau_ph_rails · beau_ph_fx · cg_country_code                │
└───────────────┬───────────────────────────────────────────────┘
                │ owner-only calls (definer functions) — no API exposure
                ▼
┌───────────── Postgres: schema beau_ph (BEAU PH CORE) ─────────────────────────────────┐
│  merchants · providers · provider_capabilities · merchant_methods                     │
│  settlement_destinations · method_settlements · config_audit                          │
│  payment_requests · payment_attempts · provider_events · payment_events               │
│  reconciliations · fx_sources · fx_currencies · fx_rates · merchant_fx · fx_quotes    │
│  method_matrix / eligible_methods · create_request · attach_attempt ·                 │
│  ingest_provider_event (+ normalize_stripe_event) · confirm_manual ·                  │
│  cancel_request / expire_request · mark_reconciled / is_reconciled · request_events   │
│  ── knows: merchant, provider, external_reference, public_reference, amount,          │
│     currency, country, status, evidence.  ── never: packs, bookings, CRM, health.     │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

Two translations, and only two, cross the boundary (both in the host adapter):

```
host order (booking | session pack)  ──▶  beau_ph.create_request(merchant, rail, external_ref, public_ref, amount, currency, country, runtime)
beau_ph normalized "paid" event      ──▶  public.payments (+ orders, earnings, pack projection) once  ──▶  beau_ph.mark_reconciled(event, payments.id)
```

## 2. Generic domain model (schema `beau_ph`)

| Entity | Table | Key fields |
|---|---|---|
| Merchant / tenant | `merchants` | `key` (e.g. `coach_gari`), `country`, `default_currency`, `mode` (test/live) |
| Payment provider | `providers` | `key`, `kind` (online/manual/crypto), `confirmation` (provider_event/operator/unavailable), `countries[]`, `currencies[]`, `readiness` (available/not_configured/placeholder) |
| Payment method (merchant × provider) | `merchant_methods` | `enabled`, `listed`, `currency` (settlement), `countries[]`, `currencies[]`, `intents[]`, `limits` (per currency, minor units), `capabilities[]`, `instructions` (public), `settings` (non-secret). `null` countries / currencies = **needs configuration**, never "any"; eligibility is the intersection with the provider's coverage |
| Settlement destination | `settlement_destinations`, `method_settlements` | where a rail pays out (label, currency, non-secret details), mapped per method; distinct from the method itself |
| Configuration audit | `config_audit` | field-level: merchant, area, entity, actor, field, old, new — CHECKed free of secrets |
| FX | `fx_sources`, `fx_currencies`, `fx_rates`, `fx_refresh_runs`, `merchant_fx`, `fx_quotes` | EUR-base daily rates, freshness, immutable expiring quotes — see `FX.md` |
| Payment request | `payment_requests` | `external_reference` (host order ref), `public_reference` (payer-facing, never a UUID), `amount`, `currency`, `customer_country`, `status`, `provider_reference`, `payment_reference`, `instructions`/redirect payload, `metadata`, `expires_at`, `paid_at` |
| Payment attempt | `payment_attempts` | `n`, `provider_reference` (e.g. Checkout Session), `redirect_url`, `expires_at`, `status` |
| Provider event (raw evidence) | `provider_events` | `provider_key`, `provider_event_id` (unique per provider), `event_type`, `payload` (verbatim), `outcome` |
| Normalized payment event | `payment_events` | `from_status → to_status`, `amount`, `currency`, `provider_status` (native, kept), `provider_reference`, `actor` (provider/operator/system), `actor_id`, `evidence` |
| Reconciliation | `reconciliations` | `payment_event_id` (unique — once), `host_reference` (the host's ledger id) |

| Provider capability | `provider_capabilities` | `(provider, capability)`, `readiness`, `confirmation` (provider_event / operator / unavailable), `platforms[]` (null = any), `initiated_by` (customer / merchant / any), `handoff` |

A request also records `capability`, `channel` (online / in_person), `initiated_by`, `platform`, the **intent** (`service · package · support · other`), and — when paid in another currency than it was priced in — `pricing_amount`, `pricing_currency` and the `fx_quote_id` it consumed (`amount` / `currency` are always the payment side).

Providers carry, besides readiness, `channel_label`, `intents[]`, the **names** of the deployment secrets they need, a `config_schema` (the fields the operator may fill: store `instructions` or `settings`, type, options, mask, public) and `onboarding` notes; the rail editor is rendered from this schema.

Invariants (indexes/CHECKs): one **live** request per (merchant, order, provider); one **paid** request per (merchant, order); `public_reference` is not a UUID; no secret-like key/value in any JSON column; `amount > 0`; ISO currency/country; capability ∈ the vocabulary `online_checkout · payment_link · manual_instructions · wallet · bank_transfer · mobile_money · softpos · card_present · tap_to_pay · qr · crypto`; platform ∈ `web · ios_pwa · android_pwa · ios_app · android_app`.

## 3. Event model — states and transitions

Normalized, provider-independent states: `created · pending · requires_action · paid · failed · expired · cancelled · refunded`.

```
created ──▶ pending | requires_action | paid | failed | expired | cancelled
pending ──▶ requires_action | paid | failed | expired | cancelled
requires_action ──▶ pending | paid | failed | expired | cancelled
paid ──▶ refunded
(same → same is an idempotent no-op; everything else is an illegal transition and is refused — evidence kept)
```

Every change goes through one internal path (`beau_ph.record_event`), which writes the `payment_events` row, updates the request, closes open attempts, and — when a request becomes **paid** — cancels the sibling live requests of the same order on other rails (`settled via <rail>`).

`provider_status` and the raw `provider_events.payload` keep the provider-native truth alongside the normalized state; a partial refund or a dispute is an **evidence-only** event (no state change), a full refund transitions to `refunded`.

## 4. Eligibility model (server-side, the only authority)

`beau_ph.method_matrix(merchant, country, currency, runtime, platform, initiated_by)` evaluates every **(provider, capability)** pair and returns `eligible` + `reason` per capability (and per provider = any capability eligible):

| Check (in order) | Reason when it fails |
|---|---|
| capability readiness = placeholder | `coming_soon` |
| capability readiness = not_configured | `not_configured` |
| merchant method missing, disabled or unlisted | `disabled` |
| merchant countries or currencies not configured (`null`) | `needs_configuration` |
| country ∉ provider countries, or ∉ merchant countries | `country` |
| currency ∉ provider currencies, or ∉ merchant currencies | `currency` |
| intent asked and ∉ provider intents or ∉ merchant intents | `intent` |
| merchant narrowed its capabilities and this one is excluded | `disabled` |
| capability initiator ≠ who is asking (customer page vs merchant "Collect") | `initiator` |
| capability restricted to platforms and the device is unknown or not among them | `platform` |
| provider-event capability (non-handoff) whose provider API readiness ≠ available | `provider_not_configured` / `provider_placeholder` |
| provider-event capability and adapter not configured in this deployment | `runtime_not_configured` |
| provider-event capability whose runtime mode ≠ merchant mode | `mode_mismatch` |

Inputs: merchant configuration, customer country (host-derived; unknown → merchant country; in person = merchant country), request currency, **device/platform** (`web · ios_pwa · android_pwa · ios_app · android_app`), **who initiates** (customer vs merchant), provider onboarding/readiness (per capability for the product, per provider for the API path), and `runtime` — the deployment readiness map the Edge adapters compute from **secret presence and mode**, never values. Three projections: `eligible_methods` (providers, customer-initiated by default — what a payer page renders verbatim), `eligible_capabilities` (flat provider × capability pairs — what a merchant "Collect payment" screen renders), `method_matrix` (everything, with reasons — the Finance rails view). `create_request` re-checks the (provider, capability) eligibility, so neither a client nor a page can force a rail or a capability.

## 5. Flows

**Card (online, provider-confirmed)**
`host order → create_request(stripe) [created] → adapter.createPaymentRequest → attach_attempt [requires_action] → payer pays → adapter.verifyWebhook + enrich → ingest_provider_event: evidence, guards (rail enabled, mode, amount/currency, already paid, transition) → payment_event [paid] → host reconciles once → mark_reconciled`.

**Manual (Aani / bank transfer, operator-confirmed)**
`instructions shown from eligible_methods (read-only) → payer pays outside → operator (authenticated, finance:manage) records receipt → host creates/reuses order → create_request(rail) [pending, instructions snapshot] → confirm_manual(operator, amount, currency, reference) → operator.confirmed evidence + payment_event [paid] → host ledger once → mark_reconciled`. A receipt whose amount differs from a pending card intent **supersedes** that intent explicitly (order cancelled, request cancelled); nothing is converted or guessed.

**In person — SoftPOS handoff (V0, merchant-initiated)**
`host order → Collect in person → eligible_capabilities(merchant, currency, platform, 'merchant') → operator opens the PSP's certified Tap to Pay app (N-Genius One / SwipeX) → customer taps → PSP receipt → operator records the receipt reference → create_request(capability softpos, channel in_person) [pending, instructions incl. handoff_app] → confirm_manual (receipt reference mandatory; evidence.verification = operator_attested_provider_receipt) → host ledger once → mark_reconciled`. The native path (`tap_to_pay`: PSP SDK inside a BEAU PH Merchant iOS app, provider-event-confirmed, `ios_app` only) is reserved as a placeholder; see `SOFTPOS.md`.

**Another payment currency (BEAU FX)**
`report_view(token, runtime, currency)` lists the pricing currency and every currency FX can quote → the payer picks a code → `cg_ph_request_for_pack(pack, rail, runtime, currency)` takes a stored quote (`fx_quote`, immutable, 15 min) and creates the request in the payment currency carrying the pricing origin and the quote id; one live request per rail and order, in the currency last chosen → `attach_checkout` attaches the Checkout Session to that live request → the webhook must match the **payment** amount → the host ledger and earning are stamped in the payment currency. FX off (the default) = the pricing currency only. See `FX.md`.

## 5b. Operator workspace (host-embedded, V0)

Finance › **Transactions** (`finance_transactions`, `finance_transaction_detail`) and **Payment methods** (`payment_methods_summary`, `payment_method_get/set/add/remove`); BEAU PH › **Rails** (`beau_ph_rails`, `beau_ph_rail_events`, `beau_ph_config_audit`, settlement destinations) and **FX** (`beau_ph_fx*`). Every one of these is a thin `public` wrapper: permission gate, merchant key `coach_gari`, then `beau_ph.*`. The Edge helper `ph-admin` adds deployment readiness (secret presence per catalogue name, Stripe mode verdict). The page (`admin/finance.js`) loads each surface lazily, caches reads for a minute and invalidates on write.

## 6. Extraction seams (what makes V2 possible)

- The core schema has no foreign key to any host table; the host references BEAU PH by plain `uuid` columns (`payments.ph_request_id`, `ph_event_id`).
- The host adapter is the only code that names both sides; the Edge Functions only ever call host RPCs and provider adapters.
- The TypeScript layer has no runtime dependency (Deno-native, Web Crypto only).
- Provider knowledge is split into an I/O adapter (TS) and a normalizer (SQL) — both per provider, both replaceable.
