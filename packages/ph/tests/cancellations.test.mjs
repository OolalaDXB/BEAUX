/* BEAU PH — provider cancellation: Stripe cancel() and the queue drainer, offline (CI).
   The exact adapter and drainer a host imports, with a mocked fetch and a mocked
   service-role RPC. Proves, without a network or a secret:
     - a refused expire is read back: expired = done, paid = final, unknown = final
     - a 429 / 5xx is transient and never read back
     - the drainer never calls a provider with the other mode's key, nor an
       unconfigured one, and leaves those rows untouched
     - a rail without cancel() leaves the queue as skipped; a throw is a retry
     - nothing secret, and no provider reference, reaches the summary
   Run: node packages/ph/tests/cancellations.test.mjs                                    */
import { stripe } from '../providers/stripe/adapter.ts';
import { drainCancellations } from '../core/cancellations.ts';

let ok = 0, fail = 0;
const t = async (name, cond) => { let r = false; try { r = await cond(); } catch (e) { console.log('      ' + (e && e.message)); } if (r) { ok++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name); } };
const envOf = (o) => (k) => o[k];
const KEY = 'sk_test_unit_test_only_0000000000';
const TEST = { PAYMENTS_MODE: 'test', STRIPE_SECRET_KEY: KEY, STRIPE_PUBLISHABLE_KEY: 'pk_test_unit_test_only_0000000000' };
const LIVE = { PAYMENTS_MODE: 'live', STRIPE_SECRET_KEY: 'sk_live_unit_test_only_0000000000', STRIPE_PUBLISHABLE_KEY: 'pk_live_unit_test_only_0000000000' };

/* fetch double: routes by method + path; records every call */
let calls = [];
const stub = (routes) => { calls = []; globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET'; const path = new URL(url).pathname; calls.push({ method, path, auth: init.headers?.Authorization });
  const h = routes[`${method} ${path}`]; if (!h) return new Response('{"error":{"message":"no route"}}', { status: 599 });
  const [status, body] = typeof h === 'function' ? h() : h; return new Response(JSON.stringify(body), { status });
}; };
const S = '/v1/checkout/sessions/cs_test_abc';

/* ---- 1. Stripe cancel() ---- */
stub({ [`POST ${S}/expire`]: [200, { id: 'cs_test_abc', status: 'expired' }] });
await t('expire accepted → ok', async () => { const r = await stripe.cancel('cs_test_abc', envOf(TEST)); return r.ok && !r.already && calls.length === 1 && calls[0].auth === `Bearer ${KEY}`; });

stub({ [`POST ${S}/expire`]: [400, { error: { message: 'not open' } }], [`GET ${S}`]: [200, { id: 'cs_test_abc', status: 'expired' }] });
await t('refused, session already expired → ok (already)', async () => { const r = await stripe.cancel('cs_test_abc', envOf(TEST)); return r.ok && r.already === true && calls.length === 2; });

stub({ [`POST ${S}/expire`]: [400, { error: { message: 'not open' } }], [`GET ${S}`]: [200, { id: 'cs_test_abc', status: 'complete', payment_status: 'paid' }] });
await t('refused, session paid → final paid_at_provider, never "done"', async () => { const r = await stripe.cancel('cs_test_abc', envOf(TEST)); return !r.ok && r.final === true && r.reason === 'paid_at_provider:paid'; });

stub({ [`POST ${S}/expire`]: [404, { error: { message: 'No such checkout.session' } }], [`GET ${S}`]: [404, { error: {} }] });
await t('unknown to this account → final', async () => { const r = await stripe.cancel('cs_test_abc', envOf(TEST)); return !r.ok && r.final === true && r.reason === 'unknown_at_provider'; });

stub({ [`POST ${S}/expire`]: [500, { error: {} }] });
await t('5xx → transient, not read back', async () => { const r = await stripe.cancel('cs_test_abc', envOf(TEST)); return !r.ok && !r.final && r.reason === 'stripe 500' && calls.length === 1; });

stub({ [`POST ${S}/expire`]: [429, { error: {} }] });
await t('429 → transient, not read back', async () => { const r = await stripe.cancel('cs_test_abc', envOf(TEST)); return !r.ok && !r.final && calls.length === 1; });

stub({ [`POST ${S}/expire`]: [400, { error: {} }], [`GET ${S}`]: [200, { id: 'cs_test_abc', status: 'open' }] });
await t('refused while still open → transient, retried', async () => { const r = await stripe.cancel('cs_test_abc', envOf(TEST)); return !r.ok && !r.final; });

stub({});
await t('not a Checkout Session reference → final, no call', async () => { const r = await stripe.cancel('pi_123/../x', envOf(TEST)); return !r.ok && r.final === true && calls.length === 0; });
await t('not configured → refused, no call', async () => { const r = await stripe.cancel('cs_test_abc', envOf({ STRIPE_SECRET_KEY: KEY })); return !r.ok && r.reason === 'not_configured' && calls.length === 0; });

/* ---- 2. drainer ---- */
const rpcDouble = (due, { markError = null, dueError = null } = {}) => {
  const marks = []; const asked = [];
  return { marks, asked, rpc: async (fn, args) => {
    asked.push({ fn, args });
    if (fn === 'cancellations_due') return dueError ? { data: null, error: { message: dueError } } : { data: due, error: null };
    if (fn === 'cancellation_mark') { marks.push(args); return markError && args.p_id === markError ? { data: null, error: { message: 'deadlock' } } : { data: {}, error: null }; }
    return { data: null, error: { message: 'unexpected rpc ' + fn } };
  } };
};
const row = (id, provider, ref, mode = 'test') => ({ id, merchant: 'm', provider, provider_reference: ref, attempts: 0, mode });

const throwing = { key: 'stripe', capabilities: stripe.capabilities, runtime: stripe.runtime, cancel: async () => { throw new Error(`boom with ${KEY}`); } };
const due = [
  row('r-ok', 'stripe', 'cs_test_abc'),
  row('r-aani', 'aani', 'AANI-1'),
  row('r-live', 'stripe', 'cs_live_zzz', 'live'),
  row('r-gone', 'made_up_rail', 'x'),
];
stub({ [`POST ${S}/expire`]: [200, { id: 'cs_test_abc', status: 'expired' }] });
let db = rpcDouble(due);
let sum = await drainCancellations(db, envOf(TEST), { limit: 7 });
const byId = (s, id) => s.items.find((i) => i.id === id);
await t('the limit reaches the queue', async () => db.asked[0].fn === 'cancellations_due' && db.asked[0].args.p_limit === 7);
await t('a cancelled session is marked done', async () => byId(sum, 'r-ok').outcome === 'done' && db.marks.some((m) => m.p_id === 'r-ok' && m.p_ok === true && m.p_skip === false));
await t('a rail without cancel() leaves as skipped', async () => byId(sum, 'r-aani').outcome === 'skipped' && db.marks.some((m) => m.p_id === 'r-aani' && m.p_skip === true));
await t('an unknown rail leaves as skipped', async () => byId(sum, 'r-gone').outcome === 'skipped');
await t('a live row is never cancelled with a test key, and stays pending', async () => byId(sum, 'r-live').outcome === 'deferred'
  && byId(sum, 'r-live').reason === 'mode_mismatch:test≠live' && !db.marks.some((m) => m.p_id === 'r-live') && !calls.some((c) => c.path.includes('cs_live_zzz')));
await t('one provider call for one cancellable row', async () => calls.length === 1);
await t('counts add up', async () => sum.due === 4 && sum.done === 1 && sum.skipped === 2 && sum.deferred === 1 && sum.retry === 0 && sum.errors === 0);

stub({});
db = rpcDouble([row('r-t', 'stripe', 'cs_test_abc')]);
sum = await drainCancellations(db, envOf({ STRIPE_SECRET_KEY: KEY }));
await t('an unconfigured deployment cancels nothing and marks nothing', async () => sum.deferred === 1 && db.marks.length === 0 && calls.length === 0 && /^not_configured/.test(byId(sum, 'r-t').reason));

db = rpcDouble([row('r-k', 'stripe', 'cs_test_abc')]);
sum = await drainCancellations(db, envOf({ ...TEST, STRIPE_SECRET_KEY: LIVE.STRIPE_SECRET_KEY }));
await t('a test deployment holding a live key (same declared mode) cancels nothing and burns no attempt', async () =>
  byId(sum, 'r-k').reason === 'not_configured:key_mode_mismatch' && db.marks.length === 0 && calls.length === 0);

db = rpcDouble([row('r-t', 'stripe', 'cs_test_abc')]);
sum = await drainCancellations(db, envOf(TEST), { adapter: () => throwing });
await t('a thrown cancel is a retry, the key redacted from the reason', async () => byId(sum, 'r-t').outcome === 'retry'
  && db.marks[0].p_ok === false && db.marks[0].p_skip === false && !db.marks[0].p_error.includes(KEY) && db.marks[0].p_error.includes('[redacted]'));

stub({ [`POST ${S}/expire`]: [400, {}], [`GET ${S}`]: [200, { id: 'cs_test_abc', status: 'complete', payment_status: 'paid' }] });
db = rpcDouble([row('r-p', 'stripe', 'cs_test_abc')]);
sum = await drainCancellations(db, envOf(TEST));
await t('paid at the provider leaves the queue as skipped, with the reason, not done', async () => byId(sum, 'r-p').outcome === 'skipped'
  && db.marks[0].p_skip === true && db.marks[0].p_ok === false && db.marks[0].p_error === 'paid_at_provider:paid');

stub({ [`POST ${S}/expire`]: [200, {}] });
db = rpcDouble([row('r-a', 'stripe', 'cs_test_abc'), row('r-b', 'stripe', 'cs_test_abc')], { markError: 'r-a' });
sum = await drainCancellations(db, envOf(TEST));
await t('a failed mark is reported and the batch goes on', async () => sum.errors === 1 && byId(sum, 'r-a').outcome === 'mark_failed' && byId(sum, 'r-b').outcome === 'done');

await t('an unreadable queue throws (nothing cancelled blind)', async () => {
  stub({}); try { await drainCancellations(rpcDouble([], { dueError: 'permission denied' }), envOf(TEST)); return false; } catch (e) { return /cancellations_due/.test(e.message) && calls.length === 0; } });

stub({ [`POST ${S}/expire`]: [200, {}] });
sum = await drainCancellations(rpcDouble(due), envOf(LIVE));
await t('the summary never carries a key or a provider reference', async () => { const s = JSON.stringify(sum); return !/sk_|pk_|whsec_|cs_test|cs_live|AANI-1/.test(s); });

console.log(`\nCANCELLATION_TESTS ok=${ok} fail=${fail}`); process.exit(fail ? 1 : 0);
