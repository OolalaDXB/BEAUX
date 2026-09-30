/* =============================================================
   BEAU PH provider — Cash — manual, in-person rail

   Cash is handed over at the session. There is no provider, no API and no
   event: an AUTHORISED OPERATOR records the receipt (amount, currency,
   date, optional note) and that operator confirmation is the only thing
   that can mark a cash request paid. The client's option shows the amount
   in the request currency and the human reference — never converted.
   An optional instruction text is merchant configuration.
   ============================================================= */
import type { EnvReader, ProviderAdapter, ProviderCapabilities, RuntimeReadiness } from "../../contracts/provider.ts";

export const cash: ProviderAdapter = {
  key: "cash",
  capabilities(): ProviderCapabilities {
    return {
      key: "cash", displayName: "Cash", kind: "manual", confirmation: "operator", readiness: "available",
      capabilities: [
        { capability: "cash", readiness: "available", confirmation: "operator", platforms: null, initiatedBy: "any", handoff: false, notes: "Cash in person; an authorised operator records the receipt." },
      ],
      supports: { checkout: false, instructions: true, webhook: false, statusPoll: false, cancel: true, refundEvents: false },
      countries: null, currencies: null, secrets: [],
    };
  },
  runtime(_env: EnvReader): RuntimeReadiness { return { configured: true }; },
  createPaymentRequest(input) {
    return Promise.resolve({ kind: "instructions", instructions: { reference: input.publicReference, amount: input.amount, currency: input.currency } });
  },
  instructionFields() {
    return [
      { key: "amount", label: "Amount", copyable: true },
      { key: "reference", label: "Reference", copyable: true },
    ];
  },
};
