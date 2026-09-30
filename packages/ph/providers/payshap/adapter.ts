/* BEAU PH provider — PayShap (South Africa, real-time rapid payments) — readiness boundary, not onboarded.
   PayShap is bank-led: a merchant reaches it through a sponsoring bank / PSP
   that exposes PayShap request-to-pay (RPP) or a ShapID-based collection.
   Target integration (V1): the sponsor's API credentials, RPP initiation with
   the human reference, and the sponsor's signed status callback. ZAR only. */
import { notConfigured } from "../_boundary.ts";

export const payshap = notConfigured({
  key: "payshap", displayName: "PayShap (South Africa)", countries: ["ZA"], currencies: ["ZAR"],
  secrets: ["PAYSHAP_SPONSOR_CLIENT_ID", "PAYSHAP_SPONSOR_CLIENT_SECRET"], capabilities: ["qr", "bank_transfer"],
  note: "needs a sponsoring bank/PSP that exposes PayShap request-to-pay",
});
