/* =============================================================
   BEAU PH provider — Stripe (online, webhook-confirmed)

   createPaymentRequest → Checkout Session. uiMode "embedded" (default for
   the Coach Gari customer surfaces) creates an `ui_mode=embedded` session
   whose client secret the host page mounts with Stripe.js, so the payer
   stays on the host domain; `redirect_on_completion=if_required` +
   `return_url` cover the rare bank/3DS flows Stripe must redirect for.
   uiMode "hosted" keeps the classic redirect session. Either way the
   amount, currency and line item come from the BEAU PH request (i.e. the
   host's order) as dynamic `price_data` + `product_data`: the host catalogue
   stays authoritative and no Stripe Product/Price is required. Metadata
   carries reconciliation identifiers only, never personal data.
   resumePaymentRequest → re-open a still-open embedded session (same
   Checkout Session, fresh client secret fetch) instead of creating another.

   PAYMENT MODE GATE (replaces CHECK-LICENCE-001's categorical live refusal):
     PAYMENTS_MODE=test  → sk_test_ allowed, sk_live_ refused
     PAYMENTS_MODE=live  → sk_live_ allowed, sk_test_ refused
     PAYMENTS_MODE unset / unknown → refused (never guessed)
   `runtime()` reports only {configured, mode, reason}: never a key, never a
   prefix beyond the mode word. Every other call in this adapter (create,
   status, cancel, enrich) is gated on `runtime().configured`.

   verifyWebhook → Stripe's own signing scheme (signature.js), raw body,
   300 s tolerance; an event whose `livemode` does not match PAYMENTS_MODE is
   refused (mode_mismatch). The DB core independently refuses evidence whose
   livemode does not match the merchant's mode.
   enrich → adds the Stripe fee / charge / balance transaction as evidence
   before the DB normalizer (beau_ph.normalize_stripe_event) runs.
   Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET; config: PAYMENTS_MODE,
   STRIPE_PUBLISHABLE_KEY (public by design, still mode-checked: a pk_ of the
   wrong mode refuses; missing pk_ disables the embedded surface only).
   ============================================================= */
import type { CreateRequestInput, CreateRequestResult, EnvReader, ProviderAdapter, ProviderCapabilities, RuntimeReadiness, VerifiedEvent } from "../../contracts/provider.ts";
import { verifyStripeSignature } from "./signature.js";

const DEFAULT_EXPIRES_S = 30 * 60; // Stripe minimum for Checkout expiry

/** The deployment's declared payment mode, or null when unset / unknown. Safe to log. */
export function paymentsMode(env: EnvReader): "test" | "live" | null {
  const m = (env("PAYMENTS_MODE") ?? "").trim().toLowerCase();
  return m === "test" || m === "live" ? m : null;
}

function keyMode(key: string): "test" | "live" | null {
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  return null;
}
function publishableMode(key: string): "test" | "live" | null {
  if (key.startsWith("pk_test_")) return "test";
  if (key.startsWith("pk_live_")) return "live";
  return null;
}

/** Reconciliation-only metadata: identifiers, never names, contacts or notes. */
const METADATA_KEYS = ["order_reference", "public_reference", "beau_ph_request_id", "host_app", "merchant_key"] as const;
function metadata(input: CreateRequestInput): Record<string, string> {
  const m: Record<string, string> = {
    order_reference: input.externalReference, public_reference: input.publicReference, beau_ph_request_id: input.requestId,
  };
  if (input.hostApp) m.host_app = input.hostApp;
  if (input.merchantKey) m.merchant_key = input.merchantKey;
  for (const k of Object.keys(m)) if (!(METADATA_KEYS as readonly string[]).includes(k)) delete m[k];
  return m;
}

const API = "https://api.stripe.com/v1";

async function getJson(url: string, key: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** Stripe returns an expandable field as either the object or its id string. */
// deno-lint-ignore no-explicit-any
const idOf = (v: any): string | null =>
  typeof v === "string" ? v : (v && typeof v === "object" && typeof v.id === "string" ? v.id : null);

/** What we can prove about the provider's cut for one payment. Nulls mean "not known", never "zero". */
export interface FeeEvidence {
  charge_id: string | null;
  balance_transaction_id: string | null;
  /** The fee in the PAYMENT's currency — the only figure the host ledger may use. Null when not (yet) known. */
  fee_amount: number | null;
  /** The currency the balance transaction reported, i.e. the account's settlement currency. */
  fee_currency: string | null;
  /** The fee as reported, whatever the settlement currency. Evidence only. */
  fee_settlement_amount: number | null;
  net_amount: number | null;
}

/* =============================================================
   Resolving the Stripe fee.

   The fee lives on the charge's BALANCE TRANSACTION. Two things make it
   easy to miss at webhook time, and both bit the first live payment,
   which recorded a fee of zero:

     1. `latest_charge.balance_transaction` is not always returned as an
        expanded object; Stripe may hand back the id as a string, and an
        id has no `fee` on it.
     2. The balance transaction can lag the charge by a moment, so the
        very first read may have nothing to expand at all.

   So: expand, accept a bare id and fetch it, and retry a couple of times
   while it is still being created.

   The fee is denominated in the account's SETTLEMENT currency. It is
   reported as `fee_amount` only when that matches the payment currency;
   otherwise it stays evidence and the fee remains unknown, because a fee
   in another currency cannot be subtracted from the order's gross. The
   host then records `fee_known = false` rather than a wrong number, and
   its payments upsert lets a later, better reading fill it in.
   ============================================================= */
export async function feeEvidence(
  paymentIntentId: string, currency: string, key: string,
  opts: { attempts?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<FeeEvidence> {
  const attempts = opts.attempts ?? 3;
  const waitMs = opts.waitMs ?? 800;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const want = (currency || "").toLowerCase();
  const out: FeeEvidence = { charge_id: null, balance_transaction_id: null, fee_amount: null,
                             fee_currency: null, fee_settlement_amount: null, net_amount: null };

  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(waitMs);                                     // the balance transaction may still be landing
    const pi = await getJson(`${API}/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge.balance_transaction`, key);
    // deno-lint-ignore no-explicit-any
    const charge: any = pi?.latest_charge ?? null;
    out.charge_id = idOf(charge) ?? out.charge_id;
    // deno-lint-ignore no-explicit-any
    let bt: any = charge && typeof charge === "object" ? charge.balance_transaction : null;
    out.balance_transaction_id = idOf(bt) ?? out.balance_transaction_id;
    // an id without the object (the common case at webhook time): read it directly
    if (out.balance_transaction_id && typeof bt?.fee !== "number") {
      bt = await getJson(`${API}/balance_transactions/${encodeURIComponent(out.balance_transaction_id)}`, key);
    }
    if (typeof bt?.fee === "number") {
      out.fee_settlement_amount = bt.fee;
      out.fee_currency = typeof bt.currency === "string" ? bt.currency : null;
      out.net_amount = typeof bt.net === "number" ? bt.net : null;
      out.fee_amount = out.fee_currency === want ? bt.fee : null;   // never a fee in someone else's currency
      return out;
    }
  }
  return out;                                                       // charge known, fee not yet: the host keeps fee_known false
}

/* What the payer sees on their bank statement.

   Stripe puts the ACCOUNT's descriptor on every charge, and this account is registered to
   the legal entity, not to the brand the client bought from. A coaching client who reads
   an unrelated company name on their card app does not remember buying anything from it —
   that is the most common reason a genuine charge gets disputed, and a dispute costs the
   fee plus the amount whatever the outcome.

   A suffix is appended to the account's own prefix ("BEAU CAPITAL* COACH GARI"), which is
   the supported way to say who the money actually went to; a full override is restricted
   on most card accounts. Stripe rejects `< > \ ' " *` and anything over 22 characters, so
   the value is cleaned here rather than trusted: a rejected parameter would fail the whole
   checkout, and a checkout that fails over a cosmetic field is a worse bug than the one
   this fixes. Unset means unchanged — nothing breaks where it is not configured. */
export function statementSuffix(raw: string | undefined | null): string | null {
  const cleaned = String(raw ?? "").replace(/[<>\\'"*]/g, " ").replace(/\s+/g, " ").trim().slice(0, 22).trim();
  return cleaned.length >= 5 ? cleaned : null;      // under five characters it tells the payer nothing
}

/** The exact form body sent to POST /v1/checkout/sessions (exported so tests can assert it without a network). */
export function checkoutSessionParams(input: CreateRequestInput, expiresAt: number): URLSearchParams {
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("client_reference_id", input.externalReference);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", input.currency.toLowerCase());
  params.set("line_items[0][price_data][unit_amount]", String(input.amount));            // trusted: from the BEAU PH request
  params.set("line_items[0][price_data][product_data][name]", input.description);
  for (const [k, v] of Object.entries(metadata(input))) { params.set(`metadata[${k}]`, v); params.set(`payment_intent_data[metadata][${k}]`, v); }
  params.set("expires_at", String(expiresAt));
  if (input.uiMode === "embedded") {
    params.set("ui_mode", "embedded");
    params.set("redirect_on_completion", "if_required");     // stay in-page; redirect only when a bank / 3DS flow demands it
    params.set("return_url", input.returnUrls.success);
  } else {
    params.set("success_url", input.returnUrls.success);
    params.set("cancel_url", input.returnUrls.cancel);
  }
  if (input.customerEmail && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.customerEmail)) params.set("customer_email", input.customerEmail);
  const suffix = statementSuffix(input.statementSuffix ?? (typeof Deno !== "undefined" ? Deno.env.get("STRIPE_STATEMENT_SUFFIX") : undefined));
  if (suffix) params.set("payment_intent_data[statement_descriptor_suffix]", suffix);
  /* Keeping the card for next month. Stripe needs a customer to attach it to,
     and in `payment` mode it does not make one unless asked — so both of these
     go together or neither does. The consent is the payer's, given in Stripe's
     own UI on the page they are already on; nothing about the card reaches us. */
  if (input.saveInstrument) {
    params.set("payment_intent_data[setup_future_usage]", "off_session");
    params.set("customer_creation", "always");
  }
  return params;
}

export const stripe: ProviderAdapter = {
  key: "stripe",

  capabilities(): ProviderCapabilities {
    return {
      key: "stripe", displayName: "Card (Stripe)", kind: "online", confirmation: "provider_event", readiness: "available",
      capabilities: [
        { capability: "online_checkout", readiness: "available", confirmation: "provider_event", platforms: null, initiatedBy: "customer", handoff: false, notes: "Hosted Checkout, webhook-confirmed. Mode follows PAYMENTS_MODE." },
        { capability: "payment_link", readiness: "not_configured", confirmation: "provider_event", platforms: null, initiatedBy: "merchant", handoff: false, notes: "Stripe Payment Links — not implemented." },
      ],
      supports: { checkout: true, instructions: false, webhook: true, statusPoll: true, cancel: true, refundEvents: true },
      countries: null, currencies: null,
      secrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    };
  },

  runtime(env: EnvReader): RuntimeReadiness {
    const mode = paymentsMode(env);
    if (!mode) return { configured: false, reason: "payments_mode_unset" };            // never guess a mode
    const key = env("STRIPE_SECRET_KEY") ?? "";
    if (!key) return { configured: false, mode, reason: "STRIPE_SECRET_KEY missing" };
    const km = keyMode(key);
    if (!km) return { configured: false, mode, reason: "unrecognised key format" };
    if (km !== mode) return { configured: false, mode, reason: "key_mode_mismatch" };   // the key's mode ≠ PAYMENTS_MODE
    const pk = env("STRIPE_PUBLISHABLE_KEY") ?? "";
    if (pk && publishableMode(pk) !== mode) return { configured: false, mode, reason: "publishable_key_mode_mismatch" };
    return pk ? { configured: true, mode, embedded: true } : { configured: true, mode, embedded: false, reason: "STRIPE_PUBLISHABLE_KEY missing" };
  },

  async createPaymentRequest(input: CreateRequestInput, env: EnvReader): Promise<CreateRequestResult> {
    const rt = stripe.runtime(env);
    if (!rt.configured) return { kind: "unavailable", reason: rt.reason ?? "not configured" };
    const key = env("STRIPE_SECRET_KEY")!;
    const embedded = input.uiMode === "embedded";
    if (embedded && !rt.embedded) return { kind: "unavailable", reason: rt.reason ?? "embedded checkout not configured" };
    const expiresAt = Math.floor(Date.now() / 1000) + (input.expiresInSeconds ?? DEFAULT_EXPIRES_S);
    const params = checkoutSessionParams(input, expiresAt);

    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded",
                 "Idempotency-Key": `${input.externalReference}:${input.attempt}:${embedded ? "embedded" : "hosted"}` },
      body: params.toString(),
    });
    const session = await res.json().catch(() => null);
    if (!res.ok || !session?.id) return { kind: "unavailable", reason: `stripe ${res.status} ${session?.error?.type ?? ""}`.trim() };
    const expiresIso = new Date(expiresAt * 1000).toISOString();
    if (embedded) {
      if (typeof session.client_secret !== "string") return { kind: "unavailable", reason: "stripe embedded session without client_secret" };
      return { kind: "embedded", providerReference: session.id, clientSecret: session.client_secret, expiresAt: expiresIso,
               publicConfig: { publishable_key: env("STRIPE_PUBLISHABLE_KEY")! } };
    }
    if (!session.url) return { kind: "unavailable", reason: "stripe hosted session without url" };
    return { kind: "redirect", providerReference: session.id, url: session.url, expiresAt: expiresIso };
  },

  async resumePaymentRequest(providerReference: string, env: EnvReader): Promise<CreateRequestResult> {
    const rt = stripe.runtime(env);
    if (!rt.configured || !rt.embedded) return { kind: "unavailable", reason: rt.reason ?? "not configured" };
    const key = env("STRIPE_SECRET_KEY")!;
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(providerReference)}`, { headers: { Authorization: `Bearer ${key}` } });
    const s = await r.json().catch(() => null);
    if (!r.ok || !s?.id) return { kind: "unavailable", reason: `stripe ${r.status}` };
    if (s.status !== "open" || s.ui_mode !== "embedded" || typeof s.client_secret !== "string") return { kind: "unavailable", reason: `session ${s.status ?? "unknown"}` };
    const exp = typeof s.expires_at === "number" ? new Date(s.expires_at * 1000).toISOString() : new Date(Date.now() + DEFAULT_EXPIRES_S * 1000).toISOString();
    return { kind: "embedded", providerReference: s.id, clientSecret: s.client_secret, expiresAt: exp, publicConfig: { publishable_key: env("STRIPE_PUBLISHABLE_KEY")! } };
  },

  async getStatus(providerReference: string, env: EnvReader) {
    if (!stripe.runtime(env).configured) return { providerStatus: "unavailable", status: null };
    const key = env("STRIPE_SECRET_KEY")!;
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(providerReference)}`, { headers: { Authorization: `Bearer ${key}` } });
    const s = await r.json().catch(() => null);
    if (!r.ok || !s) return { providerStatus: `error ${r.status}`, status: null };
    const status = s.payment_status === "paid" ? "paid" : s.status === "expired" ? "expired" : s.status === "open" ? "requires_action" : null;
    return { providerStatus: `${s.status}/${s.payment_status}`, status, evidence: { checkout_session: s.id, payment_intent: s.payment_intent ?? null } };
  },

  async cancel(providerReference: string, env: EnvReader) {
    if (!stripe.runtime(env).configured) return { ok: false, reason: "not configured" };
    const key = env("STRIPE_SECRET_KEY")!;
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(providerReference)}/expire`, { method: "POST", headers: { Authorization: `Bearer ${key}` } });
    return r.ok ? { ok: true } : { ok: false, reason: `stripe ${r.status}` };
  },

  async verifyWebhook(req: { headers: Headers; rawBody: string }, env: EnvReader): Promise<VerifiedEvent> {
    const secret = env("STRIPE_WEBHOOK_SECRET");
    if (!secret) return { ok: false, reason: "webhook_not_configured" };
    const sig = await verifyStripeSignature(req.headers.get("stripe-signature"), req.rawBody, secret);
    if (!sig.ok) return { ok: false, reason: `bad_signature:${sig.reason}` };
    let event: Record<string, unknown>;
    try { event = JSON.parse(req.rawBody); } catch { return { ok: false, reason: "invalid_json" }; }
    if (typeof event.id !== "string" || typeof event.type !== "string") return { ok: false, reason: "malformed_event" };
    // the event's mode must match the deployment's declared mode — in both directions; an unset mode refuses everything
    const mode = paymentsMode(env);
    if (!mode) return { ok: false, reason: "payments_mode_unset" };
    if ((event.livemode === true) !== (mode === "live")) return { ok: false, reason: "mode_mismatch" };
    return { ok: true, providerEventId: event.id, eventType: event.type, payload: event };
  },

  async enrich(event: Record<string, unknown>, env: EnvReader) {
    if (event.type !== "checkout.session.completed") return event;
    if (!stripe.runtime(env).configured) return event;
    // deno-lint-ignore no-explicit-any
    const obj: any = (event as any).data?.object ?? {};
    if (typeof obj.payment_intent !== "string") return event;
    const fee = await feeEvidence(obj.payment_intent, typeof obj.currency === "string" ? obj.currency : "", env("STRIPE_SECRET_KEY")!);
    if (!fee.charge_id) return event;                               // nothing provable yet; the payment still records
    return { ...event, _enrich: { ...fee } };
  },
};
