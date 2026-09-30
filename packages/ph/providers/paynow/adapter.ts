/* BEAU PH provider — Paynow (Zimbabwe) — readiness boundary, not onboarded.
   Target integration (V1): Paynow "Initiate Transaction" (hosted redirect / Express
   checkout for EcoCash + OneMoney), result + status polling URLs, HMAC-SHA512
   hash verification with the integration key. USD and ZWG. */
import { notConfigured } from "../_boundary.ts";

export const paynow = notConfigured({
  key: "paynow", displayName: "Paynow (Zimbabwe)", countries: ["ZW"], currencies: ["USD", "ZWG"],
  secrets: ["PAYNOW_INTEGRATION_ID", "PAYNOW_INTEGRATION_KEY"], capabilities: ["online_checkout", "mobile_money"],
  note: "needs Paynow merchant onboarding (integration id + key) and the hash-verified result handler",
});
