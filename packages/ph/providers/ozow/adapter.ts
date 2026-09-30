/* BEAU PH provider — Ozow (South Africa, instant EFT) — readiness boundary, not onboarded.
   Target integration (V1): Ozow hosted payment page (site code, private key
   for the SHA-512 hash check, API key), success/error/notify URLs, and the
   notification hash verification before any state change. ZAR only. */
import { notConfigured } from "../_boundary.ts";

export const ozow = notConfigured({
  key: "ozow", displayName: "Ozow (South Africa)", countries: ["ZA"], currencies: ["ZAR"],
  secrets: ["OZOW_SITE_CODE", "OZOW_PRIVATE_KEY", "OZOW_API_KEY"], capabilities: ["online_checkout"],
  note: "needs Ozow merchant onboarding and the hash-verified notification handler",
});
