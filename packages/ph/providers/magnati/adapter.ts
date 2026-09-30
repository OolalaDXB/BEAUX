/* BEAU PH provider — Magnati (UAE acquirer, FAB group). Apple Tap to Pay on iPhone launch
   partner in the UAE (Dec 2024) through the SwipeX app (digital onboarding, iPhone XS+).
   V0: SoftPOS handoff to SwipeX, operator-attested receipt. Future: native via the Magnati
   SDK (tap_to_pay, ios_app), Magnati online gateway (online_checkout) — not onboarded. */
import { softposProvider } from "../_softpos.ts";

export const magnati = softposProvider({
  key: "magnati", displayName: "Magnati (SwipeX)",
  handoffApp: "SwipeX", handoffReadiness: "available",
  countries: ["AE"], currencies: ["AED"],
  secrets: ["MAGNATI_MERCHANT_KEY", "MAGNATI_API_SECRET"],
  note: "needs a Magnati merchant account (SwipeX onboarding); Magnati API for the verified path",
});
