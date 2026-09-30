# BEAU FX — currency rates and quotes (V0)

BEAU FX is the server-side currency subsystem of BEAU PH. It is modelled on the
Maisons FX subsystem (daily rates, EUR base, rate-on-or-before, sources,
freshness, anomaly rejection, refresh and backfill, observability) and adds
what a payment hub needs: immutable, expiring quotes and a clean separation
between the pricing currency and the currency actually collected. Everything
lives in the database (`supabase/migrations/20260927_beau_ph_fx.sql`); no
rate, quote or conversion is ever computed in a browser or an Edge Function.

## Rates

| Object | Table | Notes |
|---|---|---|
| Source | `beau_ph.fx_sources` | `frankfurter` (ECB reference rates, EUR base), `usd_peg` (derived), `nbg` (National Bank of Georgia, **disabled** until a merchant needs GEL). Enabled flag, sort, URL. |
| Currency | `beau_ph.fx_currencies` | ISO code, enabled, `source_key`, optional `peg_currency` + `peg_rate`. Seeded: USD, GBP, ZAR, AED (peg 3.6725) enabled; CHF, SAR, QAR, GEL, RUB defined and disabled. EUR is the base and needs no row. |
| Daily rate | `beau_ph.fx_rates` | one row per (currency, rate_date), `rate` = units per EUR, `source`, `fetched_at`. Never overwritten by a worse value. |
| Refresh run | `beau_ph.fx_refresh_runs` | requested_by (`cron` or the operator), status, rate_date, currencies updated / skipped, per-source errors, details. |

**Lookup** is rate-on-or-before: `fx_rate_on(currency, date)` returns the most
recent rate dated on or before the day asked for, with its date and source, so
a weekend or a missed run falls back to the last business day — and the age of
that fallback is what freshness measures.

**Freshness** (`fx_freshness(age_hours)`): ≤ 36 h `fresh` · 36–72 h
`acceptable` · > 72 h `stale` · no rate `missing`. The merchant's
`max_age_hours` (default 72) is the ceiling for quoting.

**Validation** (`fx_validate_rate`): a rate must be positive and finite, and a
day-on-day variation above ±20 % against the previous stored rate is rejected
and recorded in the run as `variation_<pct>` — the previous rate stays in force
rather than a suspicious one entering the ledger.

**Source isolation**: `fx_refresh_start()` issues one `pg_net` request per
enabled source; `fx_refresh_collect()` reads each response independently, so a
source that fails, times out or returns garbage is logged under its own key
and the other sources' rates are still ingested. Pegs are derived from the
peg currency's rate **of the same day** (`peg_base_missing` otherwise) — never
from a stale one.

**Schedule**: `beau-ph-fx-refresh` at 06:05 UTC daily (after the ECB
publication), `beau-ph-fx-collect` every minute (closes open runs; a run older
than ten minutes without a response is failed, not left pending). The
workspace can start a refresh (`beau_ph_fx_refresh`, `finance:manage`) and
poll the collector (`beau_ph_fx_collect`).

## Quotes

`fx_quote(merchant, amount, from, to, preview)` converts a pricing amount into
a payment amount through EUR (`from → EUR → to`) using the rate on or before
today for both legs, and refuses when:

- the merchant has FX disabled (`merchant_fx.enabled`, **false by default**);
- either currency is not enabled, or has no rate;
- the older of the two rates is beyond `max_age_hours` (stale means **no
  quote**, never a guess).

A non-preview quote is stored in `beau_ph.fx_quotes` as an **immutable
snapshot**: pricing amount and currency, payment amount and currency, both
rate dates and sources, `reference_rate`, `provider_rate` (V0: null — a
provider's own conversion rate when one applies), `merchant_adjustment_bps`,
`customer_rate` (the rate the payer actually gets), freshness, age and
`expires_at` (`quote_ttl_minutes`, default 15). A trigger refuses any change
except the lifecycle fields (`status`, `consumed_at`, `request_id`). Rounding
is to the payment currency's minor unit, always in the payer's favour.

A quote is **consumed** exactly once, by `create_request` when the request that
carries it is created (`fx_quote_consume`): an expired, already consumed or
foreign-merchant quote is refused. The request records `pricing_amount`,
`pricing_currency`, `amount` / `currency` (payment) and `fx_quote_id`; the
provider event must match the **payment** amount and currency exactly.

## The four currencies of one payment

| Currency | Where it lives | Meaning |
|---|---|---|
| Pricing | `orders.gross_amount` / `orders.currency`, `payment_requests.pricing_*` | what the service or package costs |
| Payment | `payment_requests.amount` / `currency`, `payments.amount` / `currency` | what the payer is charged, in the currency chosen |
| Settlement | `merchant_methods.currency`, provider fee evidence | what the provider pays out in (fees may be denominated here) |
| Reporting | `merchant_fx.reporting_currency` (informational in V0) | the merchant's view |

The host ledger (`partner_earnings`) is stamped in the **payment** currency
(`recompute_earning`), so a package priced in USD and paid in AED shows an AED
earning; nothing is converted back silently.

## Client disclosure

`report_view(token, runtime, currency)` returns a `payment` block:
`pricing_amount`, `pricing_currency`, the selected `currency` and `amount`, the
`fx` snapshot when they differ (rate, freshness, quote TTL), and `options[]` —
the pricing currency first, then every enabled currency FX can quote right now.
The page renders those options verbatim and sends back only the currency code;
an unknown or unavailable code falls back to the pricing currency. The
indicative rate is disclosed on the page; the definitive quote is locked when
the Checkout Session is created and lives at most `quote_ttl_minutes`.

## Support intent

A `support` request goes through the same framework: intent-scoped
eligibility, pricing / payment currencies, quotes, ledger in the collected
currency. Only the vocabulary exists in V0; the public flow is not built.

## Operator workspace (BEAU PH › FX)

`beau_ph_fx()` (`finance:view`) returns settings, health (last refresh,
per-freshness counts, rejected rates, source errors), one row per currency
with its rate, date, source, age and freshness, the sources, the last eight
runs and the quote counters. Writes (`beau_ph_fx_set`, `beau_ph_fx_currency_set`,
`beau_ph_fx_refresh`) need `finance:manage` and are audited in
`beau_ph.config_audit` (field level) and `public.admin_audit`.
`beau_ph_fx_preview` is a calculator: a preview quote, never stored.

## Tests

`supabase/tests/beau_ph_contract.sql` §23 (source and freshness, stale means
no quote, immutability, expiry and single consumption, server-side amount, a
browser cannot override, per-source isolation, anomaly rejection) and §24
(a USD package paid in AED through the host: request, Checkout attach,
webhook in AED, ledger in AED, the quote consumed, the Finance list shows
`fx = true`). `cg012` proves the report page falls back to the pricing
currency when FX is off.
