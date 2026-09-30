/* =============================================================
   BEAU PH — provider registry + runtime readiness map (V0)

   The registry is the only place that knows every adapter. `runtimeMap()`
   produces the `p_runtime` JSON the DB core consumes for eligibility
   (beau_ph.method_matrix): presence of credentials and the mode they imply
   — never a secret value. `assertPublic()` is a last-line guard applied to
   anything that leaves the server towards a payer.
   ============================================================= */
import type { EnvReader, ProviderAdapter, ProviderKey, RuntimeMap } from "../contracts/provider.ts";
import { stripe } from "../providers/stripe/adapter.ts";
import { aani } from "../providers/aani/adapter.ts";
import { bankTransfer } from "../providers/bank-transfer/adapter.ts";
import { cash } from "../providers/cash/adapter.ts";
import { paynow } from "../providers/paynow/adapter.ts";
import { mpesa } from "../providers/mpesa/adapter.ts";
import { ozow } from "../providers/ozow/adapter.ts";
import { payshap } from "../providers/payshap/adapter.ts";
import { beauWallet } from "../providers/beau-wallet/adapter.ts";
import { networkInternational } from "../providers/network-international/adapter.ts";
import { magnati } from "../providers/magnati/adapter.ts";
import { adyen } from "../providers/adyen/adapter.ts";
import { wise } from "../providers/wise/adapter.ts";
import { paypal } from "../providers/paypal/adapter.ts";

export const providers: Record<ProviderKey, ProviderAdapter> = {
  stripe, aani, bank_transfer: bankTransfer, cash, paynow, mpesa, ozow, payshap, beau_wallet: beauWallet,
  network_international: networkInternational, magnati, adyen, wise, paypal,
};

export const providerKeys = Object.keys(providers) as ProviderKey[];

export function adapter(key: string): ProviderAdapter | null {
  return (providers as Record<string, ProviderAdapter>)[key] ?? null;
}

/** Deployment readiness of every adapter, for the DB eligibility matrix. Safe to log. */
export function runtimeMap(env: EnvReader): RuntimeMap {
  const out: RuntimeMap = {};
  for (const key of providerKeys) out[key] = providers[key].runtime(env);
  return out;
}

const SECRET_KEY_RE = /^(secret|api_?key|private_?key|password|passkey|access_?token|client_?secret|signing_?secret|webhook_?secret)$/i;
const SECRET_VALUE_RE = /(sk|rk)_(live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}/;

/** Throws if a payer-facing payload carries anything that looks like a provider secret. */
export function assertPublic(value: unknown, path = "$"): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") { if (SECRET_VALUE_RE.test(value)) throw new Error(`secret-like value at ${path}`); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => assertPublic(v, `${path}[${i}]`)); return; }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) throw new Error(`secret-like key at ${path}.${k}`);
      assertPublic(v, `${path}.${k}`);
    }
  }
}

/** Readiness matrix for documentation / operator screens (no instructions, no secrets). */
export function readinessMatrix(env: EnvReader) {
  return providerKeys.map((key) => {
    const c = providers[key].capabilities(); const r = providers[key].runtime(env);
    return { provider: key, display_name: c.displayName, kind: c.kind, confirmation: c.confirmation, readiness: c.readiness,
             capabilities: c.capabilities, countries: c.countries, currencies: c.currencies, secrets: c.secrets, runtime: r };
  });
}
