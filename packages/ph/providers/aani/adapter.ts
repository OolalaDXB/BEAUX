/* =============================================================
   BEAU PH provider — Aani (UAE instant payment) — V1: manual rail

   Static instructions (the merchant's registered Aani mobile number, kept in
   beau_ph.merchant_methods.instructions) shown to the payer with a human
   reference; the payer pays from their own UAE bank app; an AUTHORISED
   OPERATOR confirms receipt (beau_ph.confirm_manual). Nothing here can mark
   a request paid. No Aani API, deep link, request-to-pay or auto-confirm is
   used — none is contractually available to us today. AED only; the amount
   is only quoted when the request currency is AED (no silent conversion).
   ============================================================= */
import type { EnvReader, ProviderAdapter, ProviderCapabilities, RuntimeReadiness } from "../../contracts/provider.ts";

export const aani: ProviderAdapter = {
  key: "aani",
  capabilities(): ProviderCapabilities {
    return {
      key: "aani", displayName: "Aani (UAE instant payment)", kind: "manual", confirmation: "operator", readiness: "available",
      capabilities: [{ capability: "manual_instructions", readiness: "available", confirmation: "operator", platforms: null, initiatedBy: "any", handoff: false, notes: "Static Aani instructions; operator confirms receipt." }],
      supports: { checkout: false, instructions: true, webhook: false, statusPoll: false, cancel: true, refundEvents: false },
      countries: ["AE"], currencies: ["AED"], secrets: [],
    };
  },
  runtime(_env: EnvReader): RuntimeReadiness { return { configured: true }; },   // no credentials: instructions are merchant configuration
  eligibility(input) {
    if (input.currency !== "AED") return { eligible: false, reason: "currency" };
    return { eligible: true };
  },
  createPaymentRequest(input) {
    // The authoritative instruction snapshot is built by the DB (beau_ph.create_request); this mirrors the shape.
    return Promise.resolve({ kind: "instructions", instructions: { reference: input.publicReference, amount: input.amount, currency: input.currency } });
  },
  instructionFields() {
    return [
      { key: "display_value", label: "Aani number", copyable: true },
      { key: "amount", label: "Amount", copyable: true },
      { key: "reference", label: "Reference", copyable: true },
    ];
  },
};
