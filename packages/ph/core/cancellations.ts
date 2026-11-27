/* =============================================================
   BEAU PH — provider cancellation queue drainer

   The database queues, for every request that closes (cancelled | expired)
   and every attempt a newer one supersedes, the provider-side attempt to
   expire (`beau_ph.provider_cancellations`, migrations 0001 + 0004). Without
   this drainer the queue only grew: an open Stripe Checkout Session stayed
   payable, a late payment was refused by the core and had to be refunded by
   hand (ROADMAP, V0 gap 1).

   drainCancellations() is host-agnostic: a host calls it from whatever runs
   on a schedule or after a cancellation (an Edge Function, a cron job), with
   its service-role database handle and its deployment secrets. It never
   decides anything the database has not queued, and it never retries what
   cannot succeed:

     due row → adapter.cancel()                 → cancellation_mark
       no adapter / no cancel()                 → skipped  (rail has no cancel)
       adapter not configured here              → left pending, untouched
       deployment mode ≠ merchant mode          → left pending, untouched
                                                  (a live key never touches a test
                                                  session, nor the reverse)
       ok                                       → done
       ok:false, final (paid, unknown ref)      → skipped with the reason
       ok:false / thrown                        → failure, retried (5 attempts)

   Nothing secret leaves it: the summary carries ids, providers, outcomes and
   reasons — never a key, never a provider reference.
   ============================================================= */
import type { CancelResult, EnvReader, Mode, ProviderAdapter } from "../contracts/provider.ts";
import { adapter as registryAdapter } from "./registry.ts";

/** The only thing the drainer needs from the host: a service-role RPC on the beau_ph schema. */
export type BeauPhRpc = {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
};

export interface DueCancellation { id: string; merchant: string; provider: string; provider_reference: string; attempts: number; mode: Mode }

export type DrainOutcome = "done" | "already" | "skipped" | "retry" | "deferred" | "mark_failed";

export interface DrainItem { id: string; provider: string; outcome: DrainOutcome; reason?: string }

export interface DrainSummary {
  due: number;
  done: number;
  skipped: number;
  retry: number;
  deferred: number;
  errors: number;
  items: DrainItem[];
}

export interface DrainOptions {
  /** At most this many queue rows per call (the database caps it at 100). Default 20. */
  limit?: number;
  /** Adapter lookup — the registry by default; a test passes its own. */
  adapter?: (key: string) => ProviderAdapter | null;
}

const MAX_REASON = 300;
const clean = (s: string) => s.replace(/(sk|rk)_(live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+|Bearer\s+\S+/g, "[redacted]").slice(0, MAX_REASON);

function isDue(x: unknown): x is DueCancellation {
  const r = x as Record<string, unknown>;
  return !!r && typeof r.id === "string" && typeof r.provider === "string" && typeof r.provider_reference === "string"
    && (r.mode === "test" || r.mode === "live");
}

async function mark(db: BeauPhRpc, id: string, ok: boolean, error: string | null, skip: boolean) {
  const { error: e } = await db.rpc("cancellation_mark", { p_id: id, p_ok: ok, p_error: error, p_skip: skip });
  return e ? clean(e.message ?? e.code ?? "cancellation_mark failed") : null;
}

/** Drain one batch of the provider cancellation queue. Never throws for a row; throws only if the queue cannot be read. */
export async function drainCancellations(db: BeauPhRpc, env: EnvReader, opts: DrainOptions = {}): Promise<DrainSummary> {
  const lookup = opts.adapter ?? registryAdapter;
  const { data, error } = await db.rpc("cancellations_due", { p_limit: opts.limit ?? 20 });
  if (error) throw new Error(`cancellations_due: ${clean(error.message ?? error.code ?? "error")}`);
  const rows = (Array.isArray(data) ? data : []).filter(isDue);

  const summary: DrainSummary = { due: rows.length, done: 0, skipped: 0, retry: 0, deferred: 0, errors: 0, items: [] };
  const record = async (row: DueCancellation, outcome: DrainOutcome, reason: string | undefined, write?: { ok: boolean; skip: boolean }) => {
    if (write) {
      const failed = await mark(db, row.id, write.ok, write.ok ? null : (reason ?? null), write.skip);
      if (failed) { summary.errors++; summary.items.push({ id: row.id, provider: row.provider, outcome: "mark_failed", reason: failed }); return; }
    }
    summary[outcome === "already" ? "done" : (outcome as "done" | "skipped" | "retry" | "deferred")]++;
    summary.items.push({ id: row.id, provider: row.provider, outcome, ...(reason ? { reason } : {}) });
  };

  for (const row of rows) {
    const a = lookup(row.provider);
    if (!a || typeof a.cancel !== "function") { await record(row, "skipped", "rail has no cancel", { ok: false, skip: true }); continue; }

    const rt = a.runtime(env);
    // both are checked: an unconfigured adapter can still declare the row's mode (a live key in a test deployment)
    if (!rt.configured || rt.mode !== row.mode) {
      await record(row, "deferred", rt.configured ? `mode_mismatch:${rt.mode ?? "unset"}≠${row.mode}` : `not_configured${rt.reason ? ":" + rt.reason : ""}`);
      continue;
    }

    let res: CancelResult;
    try { res = await a.cancel(row.provider_reference, env); }
    catch (e) { res = { ok: false, reason: `thrown:${e instanceof Error ? e.message : String(e)}` }; }

    if (res.ok) await record(row, res.already ? "already" : "done", res.already ? "already closed at the provider" : undefined, { ok: true, skip: false });
    else if (res.final) await record(row, "skipped", clean(res.reason), { ok: false, skip: true });
    else await record(row, "retry", clean(res.reason), { ok: false, skip: false });
  }
  return summary;
}
