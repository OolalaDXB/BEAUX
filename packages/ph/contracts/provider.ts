/* =============================================================
   BEAU PH — BEAU Payment Hub
   Provider adapter contract (V0 + capability model)

   A provider carries CAPABILITIES (online_checkout, manual_instructions,
   softpos, tap_to_pay, …), each with its own readiness, confirmation mode,
   platform restriction, initiator and an explicit "handoff" flag. Not every
   provider implements every capability, and a capability may be reserved
   (placeholder) long before it can act.

   The DATABASE core (schema beau_ph) is the authority for state, eligibility
   (merchant × country × currency × platform × initiator × readiness),
   evidence, idempotency and reconciliation. An adapter is provider I/O only:
   it talks to the provider, verifies what comes back, and reports
   deployment readiness — never a secret value.

   In-person acceptance: BEAU PH never handles raw card / PIN data and never
   reads NFC itself. V0 = handoff to the PSP's certified app (operator
   attests the receipt); future = Apple Tap to Pay on iPhone through a
   supported PSP SDK inside a BEAU PH Merchant iOS app (ios_app only).
   ============================================================= */

export type ProviderKey =
  | "stripe" | "aani" | "bank_transfer" | "cash" | "paynow" | "mpesa" | "ozow" | "payshap" | "beau_wallet"
  | "network_international" | "magnati" | "adyen" | "wise" | "paypal";
export type ProviderKind = "online" | "manual" | "crypto";
export type Confirmation = "provider_event" | "operator" | "unavailable";
export type Readiness = "available" | "not_configured" | "placeholder";
export type Mode = "test" | "live";

/** Generic capability vocabulary (mirrors beau_ph.is_capability). */
export type Capability =
  | "online_checkout" | "payment_link" | "manual_instructions" | "wallet" | "bank_transfer" | "mobile_money"
  | "softpos" | "card_present" | "tap_to_pay" | "qr" | "crypto" | "cash" | "p2p_transfer";
export const IN_PERSON_CAPABILITIES: ReadonlySet<Capability> = new Set(["softpos", "card_present", "tap_to_pay", "cash"]);

/** Device / platform the request is initiated from (mirrors beau_ph.is_platform). `ios_app` = a future BEAU PH Merchant iOS app. */
export type Platform = "web" | "ios_pwa" | "android_pwa" | "ios_app" | "android_app";
export type Initiator = "customer" | "merchant";

/** Provider-independent request states (mirrors beau_ph.payment_requests.status). */
export type PaymentStatus = "created" | "pending" | "requires_action" | "paid" | "failed" | "expired" | "cancelled" | "refunded";

/** Reads a deployment secret by name. Adapters never log, return or store the value. */
export type EnvReader = (name: string) => string | undefined;

/** What a request is for. `personal` is a transfer that is not a sale; a tip to a business is still commercial (`support`). */
export type Intent = "service" | "package" | "support" | "other" | "personal";

export interface CapabilitySpec {
  capability: Capability;
  readiness: Readiness;
  confirmation: Confirmation;
  /** Which intents this capability may serve. Null / omitted = any. Keeps a peer-to-peer rail off a commercial request. */
  intents?: Intent[] | null;
  /** null = any platform. */
  platforms: Platform[] | null;
  initiatedBy: Initiator | "any";
  /** The acceptance happens in the provider's own certified app; an authorised operator attests the provider receipt. */
  handoff: boolean;
  notes?: string;
}

export interface ProviderCapabilities {
  key: ProviderKey;
  displayName: string;
  kind: ProviderKind;
  /** Provider-level confirmation for its API/event path. */
  confirmation: Confirmation;
  /** Provider-level (API / online integration) readiness. Capabilities carry their own. */
  readiness: Readiness;
  capabilities: CapabilitySpec[];
  supports: { checkout: boolean; instructions: boolean; webhook: boolean; statusPoll: boolean; cancel: boolean; refundEvents: boolean };
  /** null = any */
  countries: string[] | null;
  currencies: string[] | null;
  /** Names of the secrets the adapter needs (documentation + presence checks only). */
  secrets: string[];
}

/** What the adapter reports about THIS deployment. Presence only — never a value. */
export interface RuntimeReadiness {
  configured: boolean;
  mode?: Mode;
  reason?: string;
  /** Online providers with an in-page (embedded) checkout: true when the public client configuration is present and mode-consistent. */
  embedded?: boolean;
}
export type RuntimeMap = Partial<Record<ProviderKey, RuntimeReadiness>>;

export interface EligibilityInput { country: string | null; currency: string; mode: Mode; platform?: Platform | null; initiatedBy?: Initiator; capability?: Capability }
export interface EligibilityResult { eligible: boolean; reason?: string }

export interface CreateRequestInput {
  /** BEAU PH request id — opaque to the provider, useful as metadata. */
  requestId: string;
  /** Human reference the payer sees (e.g. CG-1048). Never a UUID. */
  publicReference: string;
  /** The host's order reference — used as the provider's client reference. */
  externalReference: string;
  /** Minor units. Comes from the host/DB. A payer-supplied amount is never accepted. */
  amount: number;
  currency: string;
  description: string;
  customerEmail?: string | null;
  returnUrls: { success: string; cancel: string };
  /** 1-based attempt number (idempotency keys). */
  attempt: number;
  expiresInSeconds?: number;
  /** What the payer should read on their bank statement, beside the account's own name
      (e.g. "COACH GARI"). The account descriptor is the legal entity; this says which
      brand the money went to, which is what stops a genuine charge being disputed.
      A provider that cannot carry one ignores it. */
  statementSuffix?: string | null;
  /** Which capability of the provider this request uses (default: the provider's primary online/manual one). */
  capability?: Capability;
  platform?: Platform | null;
  initiatedBy?: Initiator;
  /** "embedded" keeps the payer inside the host page (provider surface mounted in-page); "hosted" redirects to the provider. Default hosted. */
  uiMode?: "hosted" | "embedded";
  /** Reconciliation identifiers only (no personal data): the host application and merchant key, copied into provider metadata. */
  hostApp?: string;
  merchantKey?: string;
  /** Ask the provider to keep the instrument for later off-session use (recurring collection). The
      consent happens in the provider's own UI at payment time; BEAU PH never sees the instrument.
      Providers that cannot do this ignore it — it is a request, never a promise. */
  saveInstrument?: boolean;
}

export type CreateRequestResult =
  | { kind: "redirect"; providerReference: string; url: string; expiresAt: string }
  /** In-page checkout: the browser mounts the provider surface with `clientSecret` (scoped to this one provider session) + `publicConfig` (publishable, non-secret values only). */
  | { kind: "embedded"; providerReference: string; clientSecret: string; expiresAt: string; publicConfig: Record<string, string> }
  | { kind: "instructions"; instructions: Record<string, unknown> }
  | { kind: "unavailable"; reason: string };

export interface StatusResult { providerStatus: string; status: PaymentStatus | null; evidence?: Record<string, unknown> }

export type VerifiedEvent =
  | { ok: true; providerEventId: string; eventType: string; payload: Record<string, unknown> }
  | { ok: false; reason: string };

/** A public instruction field (manual / handoff rails): how the operator- or payer-facing page shows, copies or collects it. */
export interface InstructionField { key: string; label: string; copyable: boolean; input?: boolean }

export interface ProviderAdapter {
  readonly key: ProviderKey;
  capabilities(): ProviderCapabilities;
  /** Deployment readiness of this adapter (secret presence + mode). Feeds beau_ph.method_matrix(p_runtime). */
  runtime(env: EnvReader): RuntimeReadiness;
  /** Adapter-side extra rules (rare). The DB matrix remains the authority. */
  eligibility?(input: EligibilityInput, runtime: RuntimeReadiness): EligibilityResult;
  /** Online rails: create the provider-side payment (redirect). Manual / handoff rails: describe instructions. */
  createPaymentRequest?(input: CreateRequestInput, env: EnvReader): Promise<CreateRequestResult>;
  /** Embedded rails: re-open a still-valid provider session (same reference) instead of creating a second one. `unavailable` when it is no longer open. */
  resumePaymentRequest?(providerReference: string, env: EnvReader): Promise<CreateRequestResult>;
  getStatus?(providerReference: string, env: EnvReader): Promise<StatusResult>;
  cancel?(providerReference: string, env: EnvReader): Promise<{ ok: boolean; reason?: string }>;
  /** Verify a provider callback. Only a verified event may reach beau_ph.ingest_provider_event. */
  verifyWebhook?(req: { headers: Headers; rawBody: string }, env: EnvReader): Promise<VerifiedEvent>;
  /** reconcile(): add provider evidence (fees, balance transactions) BEFORE the DB normalizer runs. Never mutates state. */
  enrich?(event: Record<string, unknown>, env: EnvReader): Promise<Record<string, unknown>>;
  /** Manual / handoff rails: the public fields the merchant configures and the payer/operator sees. */
  instructionFields?(capability?: Capability): InstructionField[];
}
