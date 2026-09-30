/* =============================================================
   BEAU PH provider — PayPal (online, webhook-confirmed) + manual fallback

   Unlike Wise, PayPal has a real acceptance API. This adapter implements it:
   Orders v2 with intent CAPTURE, the payer approves on PayPal, and the payment
   is confirmed ONLY by a signature-verified webhook — never by the browser
   coming back to the return URL. That is the same rule the Stripe adapter
   follows, for the same reason: a return URL is a navigation, not a receipt.

   BUSINESS ACCOUNT, AND NEVER FRIENDS AND FAMILY. A commercial payment sent as
   "Friends and Family" breaches PayPal's terms, removes protection for both
   sides, and is the usual reason a receiving account gets limited. This adapter
   creates a proper commercial order; the manual instruction fields say to pay
   the business account with the reference, and deliberately offer no
   friends-and-family wording.

   PAYMENT MODE GATE, symmetric like Stripe:
     PAYMENTS_MODE=test → api-m.sandbox.paypal.com, sandbox credentials
     PAYMENTS_MODE=live → api-m.paypal.com, live credentials
     unset / unknown    → refused, never guessed
   PayPal puts no livemode flag in its events, so the mode cannot be read from
   the payload. It does not need to be: verification runs against the same
   environment the credentials belong to, so a sandbox event cannot verify with
   live credentials. verifyWebhook therefore stamps the deployment mode into the
   verified event, and the database keeps refusing anything whose mode does not
   match the merchant's.

   Secrets: PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_WEBHOOK_ID. Config:
   PAYMENTS_MODE. runtime() reports {configured, mode, reason} only — never a
   value, never a prefix.
   ============================================================= */
import type {
  Capability, CreateRequestInput, CreateRequestResult, EnvReader, ProviderAdapter, ProviderCapabilities,
  RuntimeReadiness, StatusResult, VerifiedEvent,
} from "../../contracts/provider.ts";

const LIVE = "https://api-m.paypal.com";
const SANDBOX = "https://api-m.sandbox.paypal.com";
const DEFAULT_EXPIRES_S = 3 * 60 * 60;   // PayPal keeps an approved order usable for hours; we quote three.

export function paymentsMode(env: EnvReader): "test" | "live" | null {
  const m = (env("PAYMENTS_MODE") ?? "").trim().toLowerCase();
  return m === "test" || m === "live" ? m : null;
}
const apiBase = (mode: "test" | "live") => (mode === "live" ? LIVE : SANDBOX);

/* Currencies PayPal settles without decimals. Everything else it quotes with
   two. PayPal does not support three-decimal currencies, so a request in one
   cannot be created rather than being silently rounded. */
const ZERO_DECIMAL = new Set(["HUF", "JPY", "TWD"]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

/** Minor units → the decimal string PayPal expects. */
export function toPayPalAmount(minor: number, currency: string): string | null {
  const c = currency.toUpperCase();
  if (THREE_DECIMAL.has(c)) return null;                       // unsupported: refuse rather than round
  if (ZERO_DECIMAL.has(c)) return String(Math.round(minor));   // already whole units in PayPal's terms
  return (minor / 100).toFixed(2);
}
/** PayPal's decimal string → minor units, for comparing against the request. */
export function fromPayPalAmount(value: string, currency: string): number | null {
  const c = currency.toUpperCase();
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (THREE_DECIMAL.has(c)) return null;
  return ZERO_DECIMAL.has(c) ? Math.round(n) : Math.round(n * 100);
}

function readiness(env: EnvReader): RuntimeReadiness {
  const mode = paymentsMode(env);
  if (!mode) return { configured: false, reason: "payments_mode_unset" };
  const id = (env("PAYPAL_CLIENT_ID") ?? "").trim();
  const secret = (env("PAYPAL_SECRET") ?? "").trim();
  if (!id || !secret) return { configured: false, mode, reason: "credentials_missing" };
  if (!(env("PAYPAL_WEBHOOK_ID") ?? "").trim()) {
    // Without the webhook id no event can be verified, so nothing could ever be
    // confirmed. Refusing here is better than taking a payment we cannot record.
    return { configured: false, mode, reason: "webhook_id_missing" };
  }
  return { configured: true, mode, embedded: false };
}

/** OAuth2 client-credentials token. Held for the one call, never logged, never returned. */
async function accessToken(env: EnvReader, mode: "test" | "live", fetchImpl: typeof fetch): Promise<string> {
  const id = (env("PAYPAL_CLIENT_ID") ?? "").trim();
  const secret = (env("PAYPAL_SECRET") ?? "").trim();
  const r = await fetchImpl(`${apiBase(mode)}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${id}:${secret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`paypal_auth_${r.status}`);
  const j = await r.json() as { access_token?: string };
  if (!j.access_token) throw new Error("paypal_auth_no_token");
  return j.access_token;
}

export const paypal: ProviderAdapter = {
  key: "paypal",
  capabilities(): ProviderCapabilities {
    return {
      key: "paypal",
      displayName: "PayPal",
      kind: "online",
      confirmation: "provider_event",
      readiness: "available",
      capabilities: [
        {
          capability: "online_checkout", readiness: "available", confirmation: "provider_event",
          platforms: null, initiatedBy: "customer", handoff: false, intents: ["service", "package", "support", "other"],
          notes: "Orders v2, intent CAPTURE. Confirmed only by a signature-verified webhook. Commercial order — never friends and family.",
        },
        {
          capability: "wallet", readiness: "available", confirmation: "provider_event",
          platforms: null, initiatedBy: "customer", handoff: false, intents: ["service", "package", "support", "other"],
          notes: "The payer may settle from their PayPal balance or a card on their PayPal account; it is the same order either way.",
        },
        {
          capability: "manual_instructions", readiness: "available", confirmation: "operator",
          platforms: null, initiatedBy: "any", handoff: false, intents: ["service", "package", "support", "other"],
          notes: "Fallback when the API is not configured: pay the business account with the reference; an operator confirms receipt.",
        },
        {
          // A personal transfer is a real payment shape the hub must be able to
          // express — splitting a cost, reimbursing an expense, a gift. It is
          // restricted to a non-commercial intent because using it for a sale
          // breaches PayPal's terms and removes protection for both sides, and
          // it is operator-confirmed because no Orders v2 order and no webhook
          // exist for it: there is nothing that could confirm it for us.
          capability: "p2p_transfer", readiness: "available", confirmation: "operator",
          platforms: null, initiatedBy: "any", handoff: false, intents: ["personal"],
          notes: "PayPal personal transfer (friends and family). Non-commercial requests only; the merchant opts in twice. An authorised operator confirms receipt.",
        },
      ],
      supports: { checkout: true, instructions: true, webhook: true, statusPoll: true, cancel: false, refundEvents: true },
      countries: null,
      // PayPal cannot quote a three-decimal currency; the amount helpers refuse one rather than round it.
      currencies: null,
      secrets: ["PAYPAL_CLIENT_ID", "PAYPAL_SECRET", "PAYPAL_WEBHOOK_ID"],
    };
  },

  runtime(env: EnvReader): RuntimeReadiness { return readiness(env); },

  async createPaymentRequest(input: CreateRequestInput, env: EnvReader, fetchImpl: typeof fetch = fetch): Promise<CreateRequestResult> {
    const rt = readiness(env);
    // Not configured is not an error: the rail falls back to its instructions.
    if (!rt.configured || !rt.mode) {
      return { kind: "instructions", instructions: { reference: input.publicReference, amount: input.amount, currency: input.currency } };
    }
    const value = toPayPalAmount(input.amount, input.currency);
    if (value === null) return { kind: "unavailable", reason: "currency_not_supported" };

    let token: string;
    try { token = await accessToken(env, rt.mode, fetchImpl); }
    catch { return { kind: "unavailable", reason: "provider_unavailable" }; }

    const body = {
      intent: "CAPTURE",
      purchase_units: [{
        // Reconciliation identifiers only. No name, no contact, no note.
        reference_id: input.requestId,
        custom_id: input.requestId,
        invoice_id: `${input.externalReference}-${input.attempt}`,
        description: input.description.slice(0, 127),
        amount: { currency_code: input.currency.toUpperCase(), value },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
            return_url: input.returnUrls.success,
            cancel_url: input.returnUrls.cancel,
          },
        },
      },
    };
    const r = await fetchImpl(`${apiBase(rt.mode)}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // One order per (order reference, attempt): a retried call re-reads the same order.
        "PayPal-Request-Id": `${input.externalReference}-${input.attempt}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { kind: "unavailable", reason: `provider_error_${r.status}` };
    const j = await r.json() as { id?: string; links?: { rel?: string; href?: string }[] };
    const approve = (j.links ?? []).find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
    if (!j.id || !approve) return { kind: "unavailable", reason: "no_approval_link" };

    return {
      kind: "redirect",
      providerReference: j.id,
      url: approve,
      expiresAt: new Date(Date.now() + (input.expiresInSeconds ?? DEFAULT_EXPIRES_S) * 1000).toISOString(),
    };
  },

  async getStatus(providerReference: string, env: EnvReader, fetchImpl: typeof fetch = fetch): Promise<StatusResult> {
    const rt = readiness(env);
    if (!rt.configured || !rt.mode) return { providerStatus: "unconfigured", status: null };
    const token = await accessToken(env, rt.mode, fetchImpl);
    const r = await fetchImpl(`${apiBase(rt.mode)}/v2/checkout/orders/${encodeURIComponent(providerReference)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return { providerStatus: `error_${r.status}`, status: null };
    const j = await r.json() as { status?: string };
    const ps = String(j.status ?? "UNKNOWN");
    const map: Record<string, StatusResult["status"]> = {
      CREATED: "created", SAVED: "pending", APPROVED: "requires_action",
      PAYER_ACTION_REQUIRED: "requires_action", COMPLETED: "paid", VOIDED: "cancelled",
    };
    return { providerStatus: ps, status: map[ps] ?? null };
  },

  /* PayPal verifies its own signatures: the transmission headers plus the raw
     body are posted back to PayPal with the configured webhook id, and PayPal
     answers SUCCESS or FAILURE. Doing it this way rather than checking the
     certificate chain ourselves means there is no local trust store to keep
     current, and a rotated PayPal signing certificate cannot silently start
     failing closed on us. */
  async verifyWebhook(req: { headers: Headers; rawBody: string }, env: EnvReader, fetchImpl: typeof fetch = fetch): Promise<VerifiedEvent> {
    const rt = readiness(env);
    if (!rt.configured || !rt.mode) return { ok: false, reason: "not_configured" };

    const h = (n: string) => req.headers.get(n) ?? "";
    const transmissionId = h("paypal-transmission-id");
    const transmissionTime = h("paypal-transmission-time");
    const transmissionSig = h("paypal-transmission-sig");
    const certUrl = h("paypal-cert-url");
    const authAlgo = h("paypal-auth-algo");
    if (!transmissionId || !transmissionSig || !certUrl) return { ok: false, reason: "missing_signature_headers" };
    // The certificate must be PayPal's own host, or the verification call would
    // be asked to trust a URL an attacker chose.
    try {
      const host = new URL(certUrl).hostname;
      if (!/(^|\.)paypal\.com$/.test(host)) return { ok: false, reason: "bad_cert_host" };
    } catch { return { ok: false, reason: "bad_cert_url" }; }

    let event: Record<string, unknown>;
    try { event = JSON.parse(req.rawBody) as Record<string, unknown>; }
    catch { return { ok: false, reason: "invalid_json" }; }

    let token: string;
    try { token = await accessToken(env, rt.mode, fetchImpl); }
    catch { return { ok: false, reason: "auth_failed" }; }

    const r = await fetchImpl(`${apiBase(rt.mode)}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        transmission_id: transmissionId,
        transmission_time: transmissionTime,
        cert_url: certUrl,
        auth_algo: authAlgo,
        transmission_sig: transmissionSig,
        webhook_id: (env("PAYPAL_WEBHOOK_ID") ?? "").trim(),
        webhook_event: event,
      }),
    });
    if (!r.ok) return { ok: false, reason: `verify_http_${r.status}` };
    const v = await r.json() as { verification_status?: string };
    if (v.verification_status !== "SUCCESS") return { ok: false, reason: "signature_invalid" };

    const id = String((event as { id?: unknown }).id ?? "");
    const type = String((event as { event_type?: unknown }).event_type ?? "");
    if (!id || !type) return { ok: false, reason: "malformed_event" };

    // PayPal carries no livemode flag. The mode is the one the credentials that
    // just verified this event belong to, which is why it is stamped here.
    return { ok: true, providerEventId: id, eventType: type, payload: { ...event, beau_ph_livemode: rt.mode === "live" } };
  },

  /* The two shapes need different fields, and deliberately different words: the
     commercial one names a BUSINESS account, the personal one names a person and
     says in its own label that it is not for paying an invoice. Nothing here
     offers "friends and family" as wording for a commercial payment. */
  instructionFields(capability?: Capability) {
    if (capability === "p2p_transfer") {
      return [
        { key: "paypal_personal_account", label: "PayPal account (personal transfer)", copyable: true },
        { key: "account_holder", label: "Account name", copyable: true },
        { key: "notes", label: "Notes for the sender (not for a commercial payment)", copyable: false },
      ];
    }
    return [
      { key: "paypal_business_email", label: "PayPal business account", copyable: true },
      { key: "account_holder", label: "Account name", copyable: true },
      { key: "notes", label: "Notes for the payer", copyable: false },
    ];
  },
};
