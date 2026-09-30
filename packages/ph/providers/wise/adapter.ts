/* =============================================================
   BEAU PH provider — Wise Business — manual rail

   WHY THERE IS NO CHECKOUT HERE. Wise's API is a payout and account-management
   API: it sends money and reads balances. It has no hosted checkout, no payment
   session, no "pay this merchant" surface a customer can be sent to. What Wise
   Business actually gives a merchant is LOCAL BANK DETAILS in several currencies
   (an AED account, a EUR IBAN, a GBP sort code, a USD routing number, and so
   on). A payer sends an ordinary transfer to those details.

   So this is a bank transfer that happens to land in Wise, and it is modelled
   as exactly that: instructions shown, an authorised operator confirms receipt.
   Claiming an "integration" here would be dressing up a manual rail.

   Its value over a plain bank transfer is real and worth the separate rail: the
   payer sends a LOCAL transfer in their own currency and country instead of an
   international wire, which is what makes collecting from African and European
   clients cheap and quick. The currency the merchant configures is the currency
   of the account the payer is sent to.

   BUSINESS ACCOUNT ONLY. Receiving business income into a personal Wise account
   is outside Wise's terms and risks the account being frozen with the money in
   it. The instruction fields name the account holder, and the merchant
   configures them; nothing is seeded here.

   A future reconciliation helper is possible — Wise's API can read incoming
   transactions on a balance, which would let an operator confirm against real
   statement lines instead of a screenshot. That is reconciliation, not
   acceptance, and it is not implemented.
   ============================================================= */
import type { Capability, EnvReader, ProviderAdapter, ProviderCapabilities, RuntimeReadiness } from "../../contracts/provider.ts";

export const wise: ProviderAdapter = {
  key: "wise",
  capabilities(): ProviderCapabilities {
    return {
      key: "wise",
      displayName: "Wise (local transfer)",
      kind: "manual",
      confirmation: "operator",
      readiness: "available",
      capabilities: [
        {
          capability: "bank_transfer", readiness: "available", confirmation: "operator",
          platforms: null, initiatedBy: "any", handoff: false, intents: ["service", "package", "support", "other"],
          notes: "Local account details from a Wise Business account; an authorised operator confirms receipt. No Wise API call is made.",
        },
        {
          capability: "manual_instructions", readiness: "available", confirmation: "operator",
          platforms: null, initiatedBy: "any", handoff: false, intents: ["service", "package", "support", "other"],
        },
        {
          // Wise between individuals. Same reasoning as PayPal's: a real shape,
          // non-commercial intents only, and operator-confirmed because Wise
          // reports nothing back to us either way.
          capability: "p2p_transfer", readiness: "available", confirmation: "operator",
          platforms: null, initiatedBy: "any", handoff: false, intents: ["personal"],
          notes: "Wise personal transfer between individuals. Non-commercial requests only; an authorised operator confirms receipt.",
        },
      ],
      // No checkout, no webhook: Wise cannot confirm a received payment to us.
      supports: { checkout: false, instructions: true, webhook: false, statusPoll: false, cancel: true, refundEvents: false },
      countries: null,
      currencies: null,
      secrets: [],
    };
  },

  /* A manual rail is configured by the merchant in the back-office, not by a
     deployment secret, so it is always "configured" as far as deployment goes.
     Whether the details are actually filled in is merchant configuration, which
     the database matrix answers. */
  runtime(_env: EnvReader): RuntimeReadiness {
    return { configured: true };
  },

  createPaymentRequest(input) {
    return Promise.resolve({
      kind: "instructions" as const,
      instructions: { reference: input.publicReference, amount: input.amount, currency: input.currency },
    });
  },

  instructionFields(capability?: Capability) {
    if (capability === "p2p_transfer") {
      return [
        { key: "account_holder", label: "Account name", copyable: true },
        { key: "wise_tag", label: "Wisetag or email", copyable: true },
        { key: "wise_currency", label: "Currency", copyable: true },
        { key: "notes", label: "Notes for the sender (not for a commercial payment)", copyable: false },
      ];
    }
    return [
      { key: "account_holder", label: "Account holder", copyable: true },
      { key: "wise_currency", label: "Account currency", copyable: true },
      { key: "iban", label: "IBAN / account number", copyable: true },
      { key: "swift_bic", label: "SWIFT / BIC", copyable: true },
      { key: "routing", label: "Routing / sort code", copyable: true },
      { key: "bank_name", label: "Bank name", copyable: true },
      { key: "bank_address", label: "Bank address", copyable: true },
      { key: "notes", label: "Notes for the payer", copyable: false },
    ];
  },
};
