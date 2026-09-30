/* BEAU PH provider — Network International (UAE acquirer). Apple Tap to Pay on iPhone
   launch partner in the UAE (Dec 2024) through the N-Genius One iOS app (iPhone XS+).
   V0: SoftPOS handoff to N-Genius One, operator-attested receipt. Future: native via the
   PSP SDK (tap_to_pay, ios_app), N-Genius Online (online_checkout) — not onboarded. */
import { softposProvider } from "../_softpos.ts";

export const networkInternational = softposProvider({
  key: "network_international", displayName: "Network International (N-Genius)",
  handoffApp: "N-Genius One", handoffReadiness: "available",
  countries: ["AE"], currencies: ["AED"],
  secrets: ["NGENIUS_API_KEY", "NGENIUS_OUTLET_ID"],
  note: "needs a Network International merchant account; N-Genius API for the verified path",
});
