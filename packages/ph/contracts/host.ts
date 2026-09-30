/* =============================================================
   BEAU PH — host application contract (V0)

   BEAU PH does not own the host's accounting truth. The host stays
   authoritative for its orders, payments, refunds, earnings, settlements
   and entitlements. A host adapter does two translations, and only two:

     host order                 → BEAU PH payment request  (amount/currency/references decided by the host)
     BEAU PH normalized event   → host ledger write        (exactly once; beau_ph.reconciliations is the receipt)

   In V0 the Coach Gari adapter is implemented as SQL functions in `public`
   (see supabase/migrations/20260917_beau_ph_coach_gari_adapter.sql and
   20260920_beau_ph_coach_gari_collect.sql) plus the thin TypeScript client
   in host-adapters/coach-gari/adapter.ts that the Edge Functions use. This
   file is the shape any host must satisfy.
   ============================================================= */

import type { Capability, Confirmation, Initiator, PaymentStatus, Platform, ProviderKey, Readiness, RuntimeMap } from "./provider.ts";

/** The generic request as the DB returns it (beau_ph.request_json). */
export interface PaymentRequest {
  id: string;
  merchant_id: string;
  provider: ProviderKey;
  capability: Capability | null;
  channel: "online" | "in_person";
  initiated_by: Initiator;
  platform: Platform | null;
  external_reference: string;
  public_reference: string;
  amount: number;
  currency: string;
  customer_country: string | null;
  status: PaymentStatus;
  provider_reference: string | null;
  payment_reference: string | null;
  instructions: Record<string, unknown>;
  metadata: Record<string, unknown>;
  paid_at: string | null;
  expires_at: string | null;
  created_at: string;
  attempts: number;
  attempt: { n: number; provider_reference: string | null; redirect_url: string | null; expires_at: string | null; status: string } | null;
}

/** One capability of a provider as the eligibility matrix reports it. */
export interface CapabilityEligibility {
  capability: Capability;
  readiness: Readiness;
  confirmation: Confirmation;
  handoff: boolean;
  platforms: Platform[] | null;
  initiated_by: Initiator | "any";
  in_person: boolean;
  eligible: boolean;
  reason: string | null;
}

/** A provider as beau_ph.eligible_methods returns it (instructions/settings are PUBLIC fields only). */
export interface EligibleMethod {
  provider: ProviderKey;
  display_name: string;
  kind: "online" | "manual" | "crypto";
  confirmation: Confirmation;
  /** The first eligible capability for the asking context (customer page: online_checkout / manual_instructions …). */
  capability: Capability | null;
  readiness: Readiness;
  enabled: boolean;
  eligible: boolean;
  reason: string | null;
  countries: string[] | null;
  currencies: string[] | null;
  settlement_currency: string | null;
  instructions: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
  capabilities: CapabilityEligibility[];
  reference?: string;
}

/** A flat (provider, capability) pair from beau_ph.eligible_capabilities — what a merchant "Collect payment" screen renders. */
export interface EligibleCapability {
  provider: ProviderKey;
  display_name: string;
  capability: Capability;
  confirmation: Confirmation;
  handoff: boolean;
  in_person: boolean;
  settlement_currency: string | null;
  instructions: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
}

/** Result of ingesting a verified provider event (beau_ph.ingest_provider_event). */
export interface IngestResult {
  ok: boolean;
  duplicate: boolean;
  outcome: string;                   // normalized | evidence | ignored:<why> | rejected:<why> | no_request
  provider_event_id?: string;
  request_id?: string;
  payment_event_id?: string;
  from?: PaymentStatus | null;
  to?: PaymentStatus;
  external_reference?: string;
  public_reference?: string;
  merchant?: string;
}

/**
 * What a host adapter must provide. `Client` is the host's data-access handle
 * (for Coach Gari: a service-role Supabase client used by the Edge Functions).
 */
export interface HostAdapter<Client, HostRef, HostOrder> {
  readonly merchantKey: string;
  /** Host object → BEAU PH request. The host decides amount, currency, external + public references (and the capability for in-person). */
  requestFor(client: Client, ref: HostRef, provider: ProviderKey, runtime: RuntimeMap, capability?: Capability, platform?: Platform | null): Promise<{ request: PaymentRequest; order: HostOrder }>;
  /** Record a provider attempt (e.g. a Checkout Session) against the order's request. */
  attachAttempt(client: Client, externalReference: string, providerReference: string, redirectUrl: string, expiresAt: string): Promise<void>;
  /** Verified provider event → BEAU PH evidence/normalization → host ledger, exactly once. */
  ingestEvent(client: Client, provider: ProviderKey, event: Record<string, unknown>): Promise<Record<string, unknown>>;
}
