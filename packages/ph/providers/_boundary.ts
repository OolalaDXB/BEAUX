/* =============================================================
   BEAU PH — "readiness boundary" adapter factory

   For rails we intend to activate (Paynow, M-PESA, Ozow, PayShap) but have
   NOT onboarded: the adapter exists, declares its contract, capabilities,
   countries, currencies and the secrets it will need, and refuses to act.
   It never fakes a redirect, never verifies a webhook, never reports
   `configured` — even if someone sets the environment variables — until
   the real integration is implemented and approved. The DB registry
   mirrors this (beau_ph.providers.readiness = 'not_configured'), so
   eligibility, create_request and ingest_provider_event all refuse as well.
   ============================================================= */
import type { Capability, CapabilitySpec, EnvReader, ProviderAdapter, ProviderCapabilities, ProviderKey } from "../contracts/provider.ts";

export function notConfigured(spec: { key: ProviderKey; displayName: string; countries: string[]; currencies: string[]; secrets: string[]; note: string; capabilities?: Capability[] }): ProviderAdapter {
  const reason = `${spec.displayName} adapter is a readiness boundary (V1): ${spec.note}`;
  const caps: CapabilitySpec[] = (spec.capabilities ?? ["online_checkout"]).map((capability) => ({
    capability, readiness: "not_configured", confirmation: "provider_event", platforms: null, initiatedBy: "customer", handoff: false, notes: spec.note,
  }));
  return {
    key: spec.key,
    capabilities(): ProviderCapabilities {
      return {
        key: spec.key, displayName: spec.displayName, kind: "online", confirmation: "provider_event", readiness: "not_configured",
        capabilities: caps,
        supports: { checkout: true, instructions: false, webhook: true, statusPoll: true, cancel: false, refundEvents: false },
        countries: spec.countries, currencies: spec.currencies, secrets: spec.secrets,
      };
    },
    runtime(env: EnvReader) {
      const missing = spec.secrets.filter((s) => !env(s));
      // Presence of secrets alone does not make an unimplemented adapter ready.
      return { configured: false, reason: missing.length ? `not onboarded — missing ${missing.join(", ")}` : "adapter not implemented (V1)" };
    },
    createPaymentRequest() { return Promise.resolve({ kind: "unavailable", reason }); },
    verifyWebhook() { return Promise.resolve({ ok: false, reason: "provider_not_configured" }); },
  };
}
