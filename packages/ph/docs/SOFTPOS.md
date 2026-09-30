# BEAU PH — In-person / SoftPOS acceptance (`softpos` · `card_present` · `tap_to_pay`)

## Target flow

```
host application → merchant selects an order / payment request → "Collect in person"
→ customer taps a contactless card or wallet on the merchant's phone
→ a CERTIFIED PSP processes the transaction → verified provider result
→ BEAU PH normalized payment event → host ledger reconciliation
```

Three keys are reserved in the capability vocabulary and mean different things:

| Capability | Meaning | Confirmation | V0 status |
|---|---|---|---|
| `softpos` | phone-as-terminal through the **PSP's own certified app** (handoff) | operator attests the app receipt | **available** for Network International (N-Genius One) and Magnati (SwipeX); not for Adyen (SDK-only) |
| `tap_to_pay` | **native** Apple Tap to Pay on iPhone through a supported PSP SDK inside a BEAU PH Merchant iOS app | verified provider webhook/API event | **placeholder** — `ios_app` platform only |
| `card_present` | physical terminal / API-reconciled acceptance | verified provider event | not onboarded |

BEAU PH **never** handles raw card or PIN data, never implements proprietary NFC card reading, and never attempts Tap to Pay from the existing PWA.

## Investigation — UAE (verified 7 Sep 2026)

- Apple launched **Tap to Pay on iPhone in the UAE on 10 December 2024**. The first payment platforms offering it are **Adyen, Magnati and Network International**; it works with contactless Amex, Mastercard and Visa cards, Apple Pay and other digital wallets, on **iPhone XS or later** with a recent iOS, no extra hardware. ([Apple Newsroom AE](https://www.apple.com/ae/newsroom/2024/12/apple-launches-tap-to-pay-on-iphone-in-the-uae/), [9to5Mac](https://9to5mac.com/2024/12/10/tap-to-pay-iphone-united-arab-emirates/), [AppleInsider](https://appleinsider.com/articles/24/12/10/tap-to-pay-on-iphone-comes-to-the-united-arab-emirates))
- **Network International**: Tap to Pay on iPhone for UAE merchants through the **N-Genius One iOS app** (iPhone XS+); also a Tap to Pay on Android offer. ([network.ae press release](https://www.network.ae/en/about-us/press-and-media/news/network-international-launches-tap-to-pay-on-iphone-for-uae-merchants), [product page](https://www.network.ae/en/merchant-solutions/in-person-payments/tap-to-pay-on-iphone))
- **Magnati** (FAB group): Tap to Pay on iPhone through the **SwipeX app** from the App Store, with a brief digital onboarding; existing merchants enable it via their account manager. Magnati also has a Visa "Tap to Phone" (Android) offer since 2022. ([magnati.com](https://www.magnati.com/en/magnati-simplifies-contactless-payments-with-the-launch-of-tap-to-pay-on-iphone/), [Khaleej Times](https://www.khaleejtimes.com/supplements/magnati-simplifies-contactless-payments-with-the-launch-of-tap-to-pay-on-iphone))
- **Adyen**: Tap to Pay on iPhone for UAE businesses through the Adyen POS Mobile SDK / Terminal API — an SDK you integrate in your own app; there is no standalone small-merchant app to hand off to. ([Adyen AE](https://www.adyen.com/en_AE/press-and-media/adyen-brings-tap-to-pay-on-iphone-to-uae-businesses), [The Paypers](https://thepaypers.com/payments/news/adyen-introduces-tap-to-pay-on-iphone-in-the-uae))
- **Developer requirements for a native integration**: an organisation-level Apple Developer account (Account Holder) requests the Tap to Pay on iPhone entitlement — the managed capability grants `com.apple.developer.proximity-reader.payment.acceptance`; the app integrates the ProximityReader API and/or the PSP's SDK; **the PSP is responsible for the certifications and security considerations** that let merchants accept payments; iOS 16+ (PIN entry 16.4+). ([Apple developer docs](https://developer.apple.com/documentation/ProximityReader/setting-up-the-entitlement-for-tap-to-pay-on-iPhone), [Apple regions](https://developer.apple.com/tap-to-pay/regions/), [Apple developer forum on PSP certification](https://developer.apple.com/forums/thread/774939))
- Stripe Terminal also offers Tap to Pay, but Stripe is not a UAE launch platform for it and Tap to Pay on iPhone is a separate Terminal product from the online Checkout Coach Gari uses — not a UAE V0 candidate. ([Stripe docs](https://docs.stripe.com/terminal/payments/setup-reader/tap-to-pay))

**Recommendation (owner decision):** for V0 pick **Magnati / SwipeX** (self-serve digital onboarding, standalone app) or **Network International / N-Genius One** (if Gari already banks with an N-Genius-connected acquirer). Both are modelled as handoff-capable; enabling one is a Finance setting, not code. Adyen is reserved for the native path.

## V0 — provider-app handoff (implemented)

```
Session / package → "Collect in person"
→ cg_ph_collect_options(pack, platform)       what BEAU PH allows: merchant × AED × device × readiness × merchant-initiated
→ amount + public reference (CG-####) shown; "Open SwipeX" (app link if configured)
→ the customer taps in the PSP app; the app shows a receipt / RRN
→ operator enters the receipt reference → payment_record_manual(pack, amount, 'AED', 'magnati', 'RRN-…', capability 'softpos', platform)
→ beau_ph.create_request(capability softpos, channel in_person, initiated_by merchant)   [pending, instructions snapshot incl. handoff_app]
→ beau_ph.confirm_manual(operator, amount, currency, receipt reference)                     [paid; evidence.verification = operator_attested_provider_receipt]
→ public.payments (provider magnati, capability softpos) → session_packs.payment_source = card_present → reconciled once
```

Rules: the receipt reference is **mandatory** (core and host); the amount/currency must equal the request's; a "provider event" for a handoff PSP is stored as evidence and refused (`rejected:provider_not_configured`) because no verified API path exists yet; money collected by the PSP settles to Gari's PSP merchant account → **no Oolala earning**; only the app name and an optional app link are stored (no merchant id, key or credential); the client-facing report page never lists an in-person capability (initiator gate).

Trust level, stated plainly: V0 is **operator-attested**, not provider-verified. The receipt reference makes it auditable against the PSP's statement; provider-verified status arrives with the API/native path.

## Future — native integration (reserved, not built)

A **BEAU PH Merchant iOS app** integrates Tap to Pay on iPhone through a supported PSP SDK. Prerequisites, all mandatory:

1. a supported PSP/acquirer with a UAE merchant account (Network International, Magnati or Adyen);
2. the Apple Tap to Pay on iPhone entitlement on an organisation developer account;
3. PSP-certified terminal configuration (the PSP owns certification; BEAU PH never touches card data);
4. provider webhook/API verification in the PSP adapter (`verifyWebhook` / `normalize_<psp>_event`);
5. the normal BEAU PH normalized reconciliation into the host ledger.

Modelled today as capability `tap_to_pay` — `placeholder`, `provider_event`, platforms `{ios_app}`, merchant-initiated. The contract test proves the platform gate: even if the capability were live, it is offered on `ios_app` only, never on `web`/`ios_pwa`, and still requires deployed PSP credentials.

## Generic capability model (all hosts)

`beau_ph.provider_capabilities(provider, capability, readiness, confirmation, platforms, initiated_by, handoff)`. Eligibility (`method_matrix` / `eligible_methods` / `eligible_capabilities`) considers **merchant** configuration, **country**, **currency**, **device/platform** (`web · ios_pwa · android_pwa · ios_app · android_app`), **who initiates** (customer vs merchant) and **provider onboarding/readiness** (product readiness per capability, API readiness per provider, deployment readiness from the adapters). Host UX for any BEAU PH host: *order → Collect payment → capability → amount → customer taps → paid → host ledger updated* — Coach Gari's "Session → Collect payment → Tap to Pay → AED 850 → Paid → pack updated" is one instance of it.
