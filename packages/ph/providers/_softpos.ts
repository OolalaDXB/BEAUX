/* =============================================================
   BEAU PH — SoftPOS / Tap to Pay PSP adapter factory (UAE, V0 = handoff)

   Card-present acceptance on a phone has two honest shapes:

   1. PROVIDER-APP HANDOFF (V0, fastest compliant path). The merchant opens
      the PSP's own certified Tap to Pay on iPhone app (N-Genius One,
      SwipeX), the customer taps, the PSP processes the transaction and
      shows a receipt; an authorised operator then attests that receipt /
      transaction reference in BEAU PH. Nothing card-related touches our
      code — capability `softpos`, confirmation `operator`, `handoff: true`.

   2. NATIVE INTEGRATION (future, reserved). A BEAU PH Merchant iOS app
      integrates Apple's Tap to Pay on iPhone through a supported PSP SDK:
      organisation Apple Developer account + the
      `com.apple.developer.proximity-reader.payment.acceptance` entitlement,
      PSP-certified terminal configuration, provider webhook/API
      verification, then the normal BEAU PH normalized reconciliation —
      capability `tap_to_pay`, confirmation `provider_event`, ios_app only.
      Never attempted from the PWA. Never proprietary NFC.

   This factory implements shape 1 as instructions and reserves shape 2 as
   a placeholder. It never reports `configured` (no API integration exists)
   and never verifies a webhook.
   ============================================================= */
import type { Capability, CapabilitySpec, EnvReader, InstructionField, ProviderAdapter, ProviderCapabilities, ProviderKey, Readiness } from "../contracts/provider.ts";

export interface SoftposSpec {
  key: ProviderKey;
  displayName: string;
  /** The PSP's certified merchant app the operator hands off to (null when the PSP is SDK-only). */
  handoffApp: string | null;
  /** Readiness of the handoff capability: 'available' when a standalone certified app exists for small merchants. */
  handoffReadiness: Readiness;
  countries: string[] | null;
  currencies: string[] | null;
  /** Secrets a future API / SDK integration would need — names only. */
  secrets: string[];
  note: string;
}

export function softposProvider(spec: SoftposSpec): ProviderAdapter {
  const caps: CapabilitySpec[] = [
    { capability: "softpos", readiness: spec.handoffReadiness, confirmation: "operator", platforms: null, initiatedBy: "merchant", handoff: true,
      notes: spec.handoffApp ? `V0 handoff to the ${spec.handoffApp} app; operator attests the receipt.` : "SDK-only PSP: no standalone handoff app." },
    { capability: "tap_to_pay", readiness: "placeholder", confirmation: "provider_event", platforms: ["ios_app"], initiatedBy: "merchant", handoff: false,
      notes: "Native Tap to Pay on iPhone via the PSP SDK in a future BEAU PH Merchant iOS app." },
    { capability: "card_present", readiness: "not_configured", confirmation: "provider_event", platforms: null, initiatedBy: "merchant", handoff: false,
      notes: "Physical terminal / API-reconciled acceptance — not onboarded." },
    { capability: "online_checkout", readiness: "not_configured", confirmation: "provider_event", platforms: null, initiatedBy: "customer", handoff: false,
      notes: "Online gateway — not onboarded." },
  ];
  return {
    key: spec.key,
    capabilities(): ProviderCapabilities {
      return {
        key: spec.key, displayName: spec.displayName, kind: "online", confirmation: "provider_event", readiness: "not_configured",
        capabilities: caps,
        supports: { checkout: false, instructions: true, webhook: false, statusPoll: false, cancel: false, refundEvents: false },
        countries: spec.countries, currencies: spec.currencies, secrets: spec.secrets,
      };
    },
    runtime(_env: EnvReader) {
      // A handoff needs no credentials in BEAU PH; the API/SDK path is not onboarded regardless of env presence.
      return { configured: false, reason: `API/SDK not onboarded (${spec.note}); SoftPOS handoff needs no credentials` };
    },
    createPaymentRequest(input) {
      if (input.capability === "softpos" && spec.handoffReadiness === "available") {
        return Promise.resolve({ kind: "instructions", instructions: {
          handoff: true, handoff_app: spec.handoffApp, reference: input.publicReference, amount: input.amount, currency: input.currency,
          steps: [`Open ${spec.handoffApp}`, "Choose Tap to Pay and enter the amount", "Let the customer tap their card or wallet", "Enter the app's receipt / transaction reference in BEAU PH"],
        } });
      }
      return Promise.resolve({ kind: "unavailable", reason: `${spec.displayName}: ${input.capability ?? "online_checkout"} is not available (${spec.note})` });
    },
    verifyWebhook() { return Promise.resolve({ ok: false, reason: "provider_not_configured" }); },
    instructionFields(capability?: Capability): InstructionField[] {
      if (capability === "softpos") {
        return [
          { key: "amount", label: "Amount", copyable: true },
          { key: "reference", label: "Reference", copyable: true },
          { key: "handoff_app", label: "App", copyable: false },
          { key: "receipt_reference", label: "Receipt / transaction reference (from the app)", copyable: false, input: true },
        ];
      }
      return [];
    },
  };
}
