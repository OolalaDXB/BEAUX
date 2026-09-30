/* BEAU PH provider — M-PESA (Kenya) — readiness boundary, not onboarded.
   Target integration (V1): Safaricom Daraja Lipa na M-PESA Online (STK push
   to the payer's phone), OAuth consumer key/secret, shortcode + passkey, and
   the callback URL that carries the CheckoutRequestID + MpesaReceiptNumber.
   KES only. */
import { notConfigured } from "../_boundary.ts";

export const mpesa = notConfigured({
  key: "mpesa", displayName: "M-PESA (Kenya)", countries: ["KE"], currencies: ["KES"],
  secrets: ["MPESA_CONSUMER_KEY", "MPESA_CONSUMER_SECRET", "MPESA_SHORTCODE", "MPESA_PASSKEY"], capabilities: ["mobile_money"],
  note: "needs Safaricom Daraja onboarding (go-live), STK push + callback verification",
});
