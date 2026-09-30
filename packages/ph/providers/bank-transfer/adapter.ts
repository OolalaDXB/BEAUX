/* =============================================================
   BEAU PH provider — Bank transfer — manual rail

   Account holder / IBAN / BIC-SWIFT / bank name are merchant configuration
   (beau_ph.merchant_methods.instructions, admin-entered, never seeded).
   The payer transfers with the human reference; an AUTHORISED OPERATOR
   confirms receipt. Viewing or copying the details never marks anything
   paid. Any currency (international transfers); the amount is quoted in the
   request currency — never converted.
   ============================================================= */
import type { EnvReader, ProviderAdapter, ProviderCapabilities, RuntimeReadiness } from "../../contracts/provider.ts";

export const bankTransfer: ProviderAdapter = {
  key: "bank_transfer",
  capabilities(): ProviderCapabilities {
    return {
      key: "bank_transfer", displayName: "Bank transfer", kind: "manual", confirmation: "operator", readiness: "available",
      capabilities: [
        { capability: "bank_transfer", readiness: "available", confirmation: "operator", platforms: null, initiatedBy: "any", handoff: false, notes: "Account details; operator confirms receipt." },
        { capability: "manual_instructions", readiness: "available", confirmation: "operator", platforms: null, initiatedBy: "any", handoff: false },
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
      { key: "account_holder", label: "Account holder", copyable: true },
      { key: "iban", label: "IBAN", copyable: true },
      { key: "bic", label: "BIC / SWIFT", copyable: true },
      { key: "bank_name", label: "Bank", copyable: true },
      { key: "amount", label: "Amount", copyable: true },
      { key: "reference", label: "Reference", copyable: true },
    ];
  },
};
