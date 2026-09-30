/* BEAU PH provider — Adyen (global PSP). Apple Tap to Pay on iPhone launch partner in the
   UAE (Dec 2024) through the Adyen POS Mobile SDK / Terminal API. SDK-based: there is no
   standalone merchant handoff app, so the V0 handoff is NOT available; the native path
   (tap_to_pay in a BEAU PH Merchant iOS app) and Adyen Checkout stay reserved / not onboarded. */
import { softposProvider } from "../_softpos.ts";

export const adyen = softposProvider({
  key: "adyen", displayName: "Adyen",
  handoffApp: null, handoffReadiness: "not_configured",
  countries: null, currencies: null,
  secrets: ["ADYEN_API_KEY", "ADYEN_MERCHANT_ACCOUNT", "ADYEN_HMAC_KEY"],
  note: "needs an Adyen merchant account and an Adyen-built app or SDK integration",
});
