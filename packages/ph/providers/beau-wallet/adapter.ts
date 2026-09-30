/* =============================================================
   BEAU PH provider — BEAU Wallet (crypto) — PLACEHOLDER

   BEAU (the wallet / product ecosystem) is distinct from BEAU PH (this hub).
   Inside BEAU PH the wallet is one future provider/rail. Today it is visible
   as "coming soon" and can do nothing: no request, no confirmation, no
   static wallet address shown to payers, no client-submitted transaction
   hash accepted as proof. beau_ph.providers.readiness = 'placeholder' makes
   the DB refuse create_request / ingest_provider_event for it as well.

   FUTURE CONTRACT (server-authorised crypto payment request), to implement
   only after separate approval:

     host order
       → BEAU PH payment request            (amount, fiat reference currency)
       → approved asset / network           (stablecoin-capable: e.g. USDC on an approved network)
       → BEAU Wallet deep link / QR         (bound to ONE unique request reference)
       → wallet transaction
       → verifiable confirmation            (on-chain / wallet-service attestation verified server-side)
       → normalized BEAU PH event           (beau_ph.ingest_provider_event 'beau_wallet')
       → host ledger reconciliation
   ============================================================= */
import type { EnvReader, ProviderAdapter, ProviderCapabilities, RuntimeReadiness } from "../../contracts/provider.ts";

/** What a future BEAU Wallet request MUST bind (all fields required; none client-supplied). */
export interface BeauWalletRequestSpec {
  externalReference: string;        // host order reference
  uniqueRequestReference: string;   // one-time reference for this request
  amount: number;                   // fiat amount, minor units (authoritative)
  fiatReferenceCurrency: string;    // e.g. "AED", "USD"
  asset: string;                    // approved crypto asset, e.g. "USDC"
  network: string;                  // approved network identifier
  receivingAccount: string;         // merchant receiving address/account for THIS request (server-issued)
  cryptoAmount: string;             // exact asset amount derived server-side at issuance
  expiresAt: string;                // ISO timestamp
}

export const beauWallet: ProviderAdapter = {
  key: "beau_wallet",
  capabilities(): ProviderCapabilities {
    return {
      key: "beau_wallet", displayName: "BEAU Wallet", kind: "crypto", confirmation: "unavailable", readiness: "placeholder",
      capabilities: [
        { capability: "crypto", readiness: "placeholder", confirmation: "unavailable", platforms: null, initiatedBy: "customer", handoff: false },
        { capability: "wallet", readiness: "placeholder", confirmation: "unavailable", platforms: null, initiatedBy: "customer", handoff: false },
        { capability: "qr", readiness: "placeholder", confirmation: "unavailable", platforms: null, initiatedBy: "customer", handoff: false },
      ],
      supports: { checkout: false, instructions: false, webhook: false, statusPoll: false, cancel: false, refundEvents: false },
      countries: null, currencies: null, secrets: [],
    };
  },
  runtime(_env: EnvReader): RuntimeReadiness { return { configured: false, reason: "placeholder — coming soon" }; },
  createPaymentRequest() { return Promise.resolve({ kind: "unavailable", reason: "BEAU Wallet is not available yet" }); },
  verifyWebhook() { return Promise.resolve({ ok: false, reason: "provider_placeholder" }); },
};
