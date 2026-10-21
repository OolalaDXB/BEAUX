/* =============================================================
   BEAU PH provider — Wero (EPI instant payment, euro area) — manual rail

   Wero is the European Payments Initiative's account-to-account wallet: the
   payer sends euros from their own bank app to a phone number or email, and
   the money arrives in seconds (SEPA Instant underneath). Available today in
   Belgium, France, Germany and Luxembourg, the Netherlands following.

   WHY MANUAL. Wero's merchant acceptance (e-commerce checkout, request-to-pay)
   is rolling out through acquiring banks and PSPs, not as an API we can call
   directly. What a merchant can use now is the person-to-person shape: the
   payer sends to the merchant's registered Wero phone or email with the human
   reference, and an AUTHORISED OPERATOR confirms receipt — exactly like Aani
   in the UAE. Nothing here can mark a request paid.

   EUR only; the amount is only quoted when the request currency is EUR (no
   silent conversion). The Wero phone or email is merchant configuration
   (beau_ph.merchant_methods.instructions), never seeded.
   ============================================================= */
import type { EnvReader, ProviderAdapter, ProviderCapabilities, RuntimeReadiness } from "../../contracts/provider.ts";

export const WERO_COUNTRIES = ["BE", "DE", "FR", "LU", "NL"];

export const wero: ProviderAdapter = {
  key: "wero",
  capabilities(): ProviderCapabilities {
    return {
      key: "wero", displayName: "Wero (instant payment, EU)", kind: "manual", confirmation: "operator", readiness: "available",
      capabilities: [{ capability: "manual_instructions", readiness: "available", confirmation: "operator", platforms: null, initiatedBy: "any", handoff: false,
                       notes: "Pay to the merchant's Wero phone or email from the payer's bank app; operator confirms receipt." }],
      supports: { checkout: false, instructions: true, webhook: false, statusPoll: false, cancel: true, refundEvents: false },
      countries: WERO_COUNTRIES, currencies: ["EUR"], secrets: [],
    };
  },
  runtime(_env: EnvReader): RuntimeReadiness { return { configured: true }; },   // no credentials: instructions are merchant configuration
  eligibility(input) {
    if (input.currency !== "EUR") return { eligible: false, reason: "currency" };
    return { eligible: true };
  },
  createPaymentRequest(input) {
    return Promise.resolve({ kind: "instructions", instructions: { reference: input.publicReference, amount: input.amount, currency: input.currency } });
  },
  instructionFields() {
    return [
      { key: "display_value", label: "Wero phone or email", copyable: true },
      { key: "account_holder", label: "Name shown in Wero", copyable: false },
      { key: "amount", label: "Amount", copyable: true },
      { key: "reference", label: "Reference", copyable: true },
    ];
  },
};
