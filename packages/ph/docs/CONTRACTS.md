# BEAU PH — Contracts (V0)

## A. Provider adapter contract — `beau-ph/contracts/provider.ts`

One generic contract for every rail. Not every provider implements every capability.

| Capability | Purpose | stripe | aani | bank_transfer | paynow / mpesa / ozow / payshap | beau_wallet |
|---|---|---|---|---|---|---|
| `capabilities()` | kind, confirmation, readiness, countries, currencies, secrets needed | ✔ | ✔ | ✔ | ✔ (readiness `not_configured`) | ✔ (readiness `placeholder`) |
| `runtime(env)` | deployment readiness: **presence** of secrets + mode — never values | ✔ (test key ⇒ configured; live key ⇒ refused) | ✔ (always, no credentials) | ✔ | ✔ (always `configured:false`) | ✔ (always `configured:false`) |
| `eligibility()` | adapter-side extra rule (DB matrix stays the authority) | – | ✔ (AED only) | – | – | – |
| `createPaymentRequest()` | online: embedded (client secret) or redirect · manual: instructions | ✔ embedded Checkout Session (`ui_mode=embedded`, dynamic `price_data`; hosted redirect still supported) | ✔ instructions | ✔ instructions | `unavailable` | `unavailable` |
| `getStatus()` | poll the provider | ✔ | – | – | – | – |
| `cancel()` | cancel/expire the provider-side attempt | ✔ | – | – | – | – |
| `verifyWebhook()` | signature verification — only verified events reach the core | ✔ (Stripe scheme, raw body, 300 s, live-mode refused) | – | – | `ok:false provider_not_configured` | `ok:false provider_placeholder` |
| `enrich()` (= reconcile) | add provider evidence before normalization, never mutates state | ✔ (fee, charge, balance transaction) | – | – | – | – |
| `instructionFields()` | public fields the merchant configures and the payer sees | – | ✔ | ✔ | – | – |

`capabilities()` also lists the provider's **capability specs** — `{capability, readiness, confirmation, platforms, initiatedBy, handoff}` — mirrored in `beau_ph.provider_capabilities`. The UAE Tap to Pay PSPs (`network_international`, `magnati`, `adyen`, built by `providers/_softpos.ts`) declare `softpos` (handoff, operator-attested; available for the two with a standalone app), `tap_to_pay` (placeholder, `ios_app` only, provider-event), `card_present` and `online_checkout` (not onboarded). `createPaymentRequest({capability:'softpos'})` returns handoff instructions; everything else is `unavailable`; `verifyWebhook` is refused until an API integration exists.

Rules every adapter follows: amounts/currencies come from the BEAU PH request (i.e. the host), never from the payer; `runtime()` never returns a secret value; an adapter never marks anything paid — it produces verified events for the core; an adapter never touches card/PIN data or NFC — in-person acceptance is the PSP's certified app or SDK.

## B. SQL normalizer contract (per provider, in schema `beau_ph`)

`beau_ph.normalize_<provider>_event(payload jsonb) → jsonb` maps a **verified** provider payload to:

```
{ status: created|pending|requires_action|paid|failed|expired|cancelled|refunded|evidence,
  request_id | provider_reference | payment_reference | (merchant, external_reference),   -- how to find the request
  amount, currency, provider_status, payment_reference, refund_amount, evidence: {…} }
or { ignore: "<why>" }
```

`beau_ph.ingest_provider_event(provider, provider_event_id, event_type, payload, normalized)` then: stores the evidence verbatim (idempotent on `provider_event_id`), refuses providers that cannot confirm by event (manual → `manual_provider_requires_operator`), refuses `not_configured`/`placeholder` providers, locates the request, applies the guards (rail enabled for the merchant, live/test mode, amount & currency for a paid claim, already paid, legal transition), and records the normalized event. Return value: `{ok, duplicate, outcome, request_id, payment_event_id, from, to, external_reference, public_reference, merchant}` with `outcome ∈ normalized | evidence | ignored:<why> | rejected:<why> | no_request`.

Implemented today: `normalize_stripe_event` + `ingest_stripe_event`. Manual rails have no normalizer; they are confirmed by `beau_ph.confirm_manual(request, operator, amount, currency, reference, paid_at, note, merchant_key)` — the trailing `merchant_key` (also on `cancel_request`, `expire_request`, `attach_attempt`, `mark_reconciled`, `get_request`, `request_events`) scopes the call to the host's own merchant: a foreign request is "not found" (`P0002`).

## C. Host adapter contract — `beau-ph/contracts/host.ts`

A host must provide exactly two translations and keep its own ledger authoritative:

1. **host object → BEAU PH request** — the host decides `amount`, `currency`, `external_reference` (its order), `public_reference` (payer-facing, human) and the customer country. It calls `beau_ph.create_request` (idempotent: the live request for that order + rail is reused).
2. **BEAU PH normalized event → host ledger, exactly once** — on `outcome = normalized, to = paid` the host first checks `beau_ph.owned_by(request_id, merchant_key)` (a foreign request is ignored, never paid), then writes its payment/order/earning/entitlement rows and calls `beau_ph.mark_reconciled(payment_event_id, host_reference, note, merchant_key)`. The unique receipt makes a second write impossible; `beau_ph.is_reconciled` lets the host short-circuit duplicates.

Manual rails add: the host **authenticates and authorises the operator** and passes their identity to `confirm_manual`; the core never trusts an anonymous confirmation.

### Coach Gari implementation (SQL, `public` schema)

| Host RPC | Role | Callers |
|---|---|---|
| `cg_ph_request_for_order(order, rail, runtime, use_contact_country)` | order → request (public ref = booking reference or pack `public_ref`; country from the CRM contact, ignored when recording a receipt) | internal |
| `cg_ph_request_for_pack(pack, rail, runtime)` · `cg_ph_request_for_booking(ref, token, rail, runtime)` | pack/booking → order → request | Edge `report`, `checkout` (service role) |
| `attach_checkout(order_ref, session, url, expires)` | CG-003 contract + BEAU PH attempt | Edge after Stripe |
| `process_stripe_event(event)` | Stripe evidence → normalization → ledger once (legacy path only for orders that predate BEAU PH) | Edge `stripe-webhook` |
| `payment_record_manual(pack, amount, currency, source, ref, paid_at, capability, platform)` | operator receipt → request → `confirm_manual` → ledger once; supersedes a differing pending intent. Source may be a SoftPOS PSP (`magnati` / `network_international`) with capability `softpos` — the PSP receipt reference is mandatory | admin (finance:manage) |
| `cg_ph_collect_options(pack, platform)` | what can be collected **in person** for this pack on this device (`eligible_capabilities(..., 'merchant')` filtered to in-person), plus amount due + public reference | admin (finance:manage) |
| `report_view(token, runtime)` | recap + **authoritative eligible-method list** (public instructions only) | Edge `report` |
| `payment_method_set` · `payment_methods_list` · `payment_rails` | merchant configuration and readiness matrix for the Finance screen | admin |

Boundary check: none of these BEAU PH core functions reference `session_packs`, `bookings` or `crm_contacts`; all of the above host functions do — that is the line.
