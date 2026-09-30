/* =============================================================
   BEAU PH — Stripe: off-session collection

   Deliberately NOT part of ProviderAdapter. The adapter contract describes a
   payment the PAYER initiates: a request goes out, a human decides, money
   moves. Charging a stored card is the opposite — the merchant initiates and
   nobody is present — and pretending the two are the same interface would let
   a host call the second by accident while thinking it was doing the first.
   Recurring collection is its own module, imported explicitly by the one
   function that is allowed to do it.

   Two operations, and only two:

     mandateFromSession()  reads what a completed Checkout session left behind
                           when it was told to keep the card: which Stripe
                           customer, which payment method, and the brand and
                           last four digits so a human can recognise it. It
                           NEVER returns anything that can move money on its
                           own — a payment-method id is inert without the
                           secret key.

     chargeOffSession()    charges that stored card for one invoice. It is
                           idempotent on the BEAU PH charge id, so a retry, a
                           duplicated cron tick or a redeployment mid-flight
                           cannot charge the same month twice: Stripe returns
                           the original PaymentIntent instead of making a
                           second one.

   WHAT A FAILURE MEANS HERE. `requires_action` is reported as a failure, not
   as something to chase: it means the bank wants the cardholder present (3DS),
   and there is nobody present. The right answer is the one the caller already
   has — leave the invoice open and let the client pay it themselves, on any
   rail. Trying to drive an authentication flow from a cron job would be both
   futile and rude.

   Everything is mode-gated by the adapter's own runtime() check: a key whose
   mode differs from PAYMENTS_MODE, or an unset PAYMENTS_MODE, refuses to
   charge anything at all.
   ============================================================= */
import type { EnvReader } from "../../contracts/provider.ts";
import { stripe } from "./adapter.ts";

const API = "https://api.stripe.com/v1";

export interface Mandate {
  customerId: string;
  paymentMethodId: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

export type ChargeResult =
  | { ok: true; paymentIntentId: string; status: string }
  | { ok: false; paymentIntentId: string | null; reason: string; declineCode: string | null; retryable: boolean };

const idOf = (v: unknown): string | null =>
  typeof v === "string" ? v : (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null);

async function getJson(url: string, key: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/**
 * What a completed Checkout session left behind, when that session was created
 * with `saveInstrument`. Returns null when the session kept no card — which is
 * the normal case for every ordinary payment and must not be treated as an
 * error.
 */
export async function mandateFromSession(sessionId: string, env: EnvReader): Promise<Mandate | null> {
  const rt = stripe.runtime(env);
  if (!rt.configured) return null;
  const key = env("STRIPE_SECRET_KEY")!;

  const session = await getJson(`${API}/checkout/sessions/${encodeURIComponent(sessionId)}`, key);
  const customerId = idOf(session?.customer);
  const piId = idOf(session?.payment_intent);
  if (!customerId || !piId) return null;

  // the card actually used is on the PaymentIntent, not on the session
  const pi = await getJson(`${API}/payment_intents/${encodeURIComponent(piId)}?expand[]=payment_method`, key);
  // deno-lint-ignore no-explicit-any
  const pm: any = (pi as any)?.payment_method ?? null;
  const paymentMethodId = idOf(pm);
  if (!paymentMethodId) return null;
  // only meaningful for cards; anything else is stored without display details
  const card = pm && typeof pm === "object" ? pm.card : null;
  return {
    customerId, paymentMethodId,
    brand: typeof card?.brand === "string" ? card.brand : null,
    last4: typeof card?.last4 === "string" ? card.last4 : null,
    expMonth: typeof card?.exp_month === "number" ? card.exp_month : null,
    expYear: typeof card?.exp_year === "number" ? card.exp_year : null,
  };
}

export interface ChargeInput {
  /** BEAU PH's charge row id. Doubles as the Stripe idempotency key, so one row can only ever produce one charge. */
  chargeId: string;
  customerId: string;
  paymentMethodId: string;
  amount: number;       // minor units, from the database — never from a caller's arithmetic
  currency: string;
  description: string;
  /** The host's order reference. The webhook finds the order by it, so it is not optional in practice. */
  orderReference: string;
  customerEmail?: string | null;
}

/** Charge a stored card for one invoice. Idempotent on `chargeId`. */
export async function chargeOffSession(input: ChargeInput, env: EnvReader): Promise<ChargeResult> {
  const rt = stripe.runtime(env);
  if (!rt.configured) return { ok: false, paymentIntentId: null, reason: rt.reason ?? "not configured", declineCode: null, retryable: false };
  const key = env("STRIPE_SECRET_KEY")!;

  const params = new URLSearchParams();
  params.set("amount", String(input.amount));
  params.set("currency", input.currency.toLowerCase());
  params.set("customer", input.customerId);
  params.set("payment_method", input.paymentMethodId);
  params.set("off_session", "true");
  params.set("confirm", "true");
  params.set("description", input.description);
  /* The marker the host's reconciler requires. Without it the event is ignored
     rather than credited, which is the safe direction: a PaymentIntent from
     the ordinary Checkout flow must never be settled twice. */
  params.set("metadata[cg_source]", "subscription_auto");
  params.set("metadata[order_reference]", input.orderReference);
  params.set("metadata[charge_id]", input.chargeId);
  if (input.customerEmail && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.customerEmail)) params.set("receipt_email", input.customerEmail);

  let res: Response;
  try {
    res = await fetch(`${API}/payment_intents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded",
                 "Idempotency-Key": `cg-sub-charge:${input.chargeId}` },
      body: params.toString(),
    });
  } catch (e) {
    // the network, not the card: worth trying again
    return { ok: false, paymentIntentId: null, reason: `network: ${(e as Error).message.slice(0, 120)}`, declineCode: null, retryable: true };
  }

  // deno-lint-ignore no-explicit-any
  const body: any = await res.json().catch(() => null);
  if (!res.ok) {
    /* Stripe puts a declined charge's PaymentIntent inside the error, which is
       what lets a decline be told apart from a request we got wrong. */
    const err = body?.error ?? {};
    const pi = idOf(err.payment_intent) ?? null;
    return { ok: false, paymentIntentId: pi, reason: String(err.message ?? `stripe ${res.status}`).slice(0, 200),
             declineCode: typeof err.decline_code === "string" ? err.decline_code : (typeof err.code === "string" ? err.code : null),
             retryable: res.status >= 500 };
  }
  if (body?.status === "succeeded") return { ok: true, paymentIntentId: String(body.id), status: "succeeded" };
  if (body?.status === "requires_action") {
    // the bank wants the cardholder, and there is no cardholder here
    return { ok: false, paymentIntentId: String(body.id), reason: "the bank asked for authentication, which needs the cardholder present",
             declineCode: "authentication_required", retryable: false };
  }
  return { ok: false, paymentIntentId: body?.id ? String(body.id) : null, reason: `unexpected status ${body?.status ?? "?"}`, declineCode: null, retryable: false };
}

/** Forget a card at Stripe. Best effort: the record is already gone on our side. */
export async function detachPaymentMethod(paymentMethodId: string, env: EnvReader): Promise<boolean> {
  const rt = stripe.runtime(env);
  if (!rt.configured) return false;
  try {
    const r = await fetch(`${API}/payment_methods/${encodeURIComponent(paymentMethodId)}/detach`, {
      method: "POST", headers: { Authorization: `Bearer ${env("STRIPE_SECRET_KEY")}` },
    });
    return r.ok;
  } catch { return false; }
}
