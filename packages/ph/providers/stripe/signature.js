/* Stripe webhook signature verification — Stripe's own scheme, nothing custom.
   https://docs.stripe.com/webhooks#verify-manually

   Header  Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>...][,v0=...]
   Signed  `${t}.${rawBody}`  — the exact raw request body, byte for byte
   Scheme  HMAC-SHA256(secret = whsec_…, signed payload), hex, compared in
           constant time against every v1 candidate; v0 is ignored.
   Time    reject if |now − t| > tolerance (default 300 s) — stale or replayed
           and far-future timestamps alike.

   Plain ESM with only Web Crypto so the same file runs in Deno (the Edge
   Function) and in Node 20 (scripts/test-webhook-signature.mjs, run by CI). */

export const DEFAULT_TOLERANCE_S = 300;

export function parseHeader(header) {
  if (typeof header !== "string" || !header) return null;
  let t = null; const v1 = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(); const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1" && v) v1.push(v);
  }
  if (!t || !/^\d+$/.test(t) || !v1.length) return null;
  return { timestamp: Number(t), signatures: v1 };
}

export async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Returns { ok: true } or { ok: false, reason } — reasons: missing_header, malformed_header, timestamp_out_of_tolerance, signature_mismatch. */
export async function verifyStripeSignature(header, rawBody, secret, { toleranceS = DEFAULT_TOLERANCE_S, nowS = Math.floor(Date.now() / 1000) } = {}) {
  if (!header) return { ok: false, reason: "missing_header" };
  const parsed = parseHeader(header);
  if (!parsed) return { ok: false, reason: "malformed_header" };
  if (Math.abs(nowS - parsed.timestamp) > toleranceS) return { ok: false, reason: "timestamp_out_of_tolerance" };
  const expected = await hmacHex(secret, `${parsed.timestamp}.${rawBody}`);
  return parsed.signatures.some((s) => timingSafeEqual(s.toLowerCase(), expected)) ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}

/** Build a header the way Stripe does — for tests and the laptop probe only. */
export async function signForTest(rawBody, secret, timestampS = Math.floor(Date.now() / 1000)) {
  return `t=${timestampS},v1=${await hmacHex(secret, `${timestampS}.${rawBody}`)}`;
}
