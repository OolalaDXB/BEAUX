/* BEAU PH — Stripe adapter, Embedded Checkout contract, offline unit test (CI).
   Runs the exact adapter the Edge Functions import (beau-ph/providers/stripe/adapter.ts)
   with a mocked fetch and dummy env values. Proves, without a network or a secret:
     - the amount / currency / line item come from the BEAU PH request only
     - embedded sessions carry ui_mode=embedded + return_url and NO success/cancel URL
     - the return URL stays on the canonical customer origin
     - metadata is reconciliation identifiers only (no personal or health data)
     - the mode gate fails closed (mode unset, key mismatch, publishable-key mismatch)
     - a still-open session is resumed, a closed one is not
   Exit code 1 on any failure.
     node --experimental-strip-types scripts/test-stripe-embedded.mjs                */
import { stripe, checkoutSessionParams, paymentsMode, statementSuffix } from '../providers/stripe/adapter.ts';
import { siteUrl, CANONICAL_SITE_URL } from '../host-adapters/coach-gari/adapter.ts';

let ok = 0, fail = 0;
const t = async (name, cond) => { let r = false; try { r = await cond(); } catch (e) { r = false; console.log('      ' + (e && e.message)); } if (r) { ok++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name); } };
const envOf = (o) => (k) => o[k];
const LIVE = { PAYMENTS_MODE: 'live', STRIPE_SECRET_KEY: 'sk_live_unit_test_only_0000000000', STRIPE_PUBLISHABLE_KEY: 'pk_live_unit_test_only_0000000000', STRIPE_WEBHOOK_SECRET: 'whsec_unit' };
const TEST = { PAYMENTS_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_unit_test_only_0000000000', STRIPE_PUBLISHABLE_KEY: 'pk_test_unit_test_only_0000000000' };

const input = (extra = {}) => ({
  requestId: '11111111-1111-1111-1111-111111111111', publicReference: 'CG-1048', externalReference: 'OR-8106AE',
  amount: 1000, currency: 'AED', description: 'Coach Gari coaching package (CG-1048)', customerEmail: 'client@example.com',
  returnUrls: { success: `${siteUrl(envOf({}))}/r/abc?paid=1&session_id={CHECKOUT_SESSION_ID}`, cancel: `${siteUrl(envOf({}))}/r/abc?cancelled=1` },
  attempt: 1, uiMode: 'embedded', hostApp: 'coach_gari', merchantKey: 'coach_gari', ...extra,
});

/* ---- 1. mode gate, fail closed ---- */
await t('mode unset → refused', async () => stripe.runtime(envOf({ STRIPE_SECRET_KEY: LIVE.STRIPE_SECRET_KEY })).configured === false && paymentsMode(envOf({})) === null);
await t('live mode + live keys → configured, embedded', async () => { const r = stripe.runtime(envOf(LIVE)); return r.configured && r.mode === 'live' && r.embedded === true; });
await t('test mode + test keys → configured, embedded', async () => { const r = stripe.runtime(envOf(TEST)); return r.configured && r.mode === 'test' && r.embedded === true; });
await t('live mode + test secret key → refused (key_mode_mismatch)', async () => { const r = stripe.runtime(envOf({ ...LIVE, STRIPE_SECRET_KEY: TEST.STRIPE_SECRET_KEY })); return !r.configured && r.reason === 'key_mode_mismatch'; });
await t('live mode + test publishable key → refused (publishable_key_mode_mismatch)', async () => { const r = stripe.runtime(envOf({ ...LIVE, STRIPE_PUBLISHABLE_KEY: TEST.STRIPE_PUBLISHABLE_KEY })); return !r.configured && r.reason === 'publishable_key_mode_mismatch'; });
await t('no publishable key → hosted still configured, embedded surface off', async () => { const r = stripe.runtime(envOf({ ...LIVE, STRIPE_PUBLISHABLE_KEY: undefined })); return r.configured && r.embedded === false; });
await t('unknown PAYMENTS_MODE value → refused', async () => stripe.runtime(envOf({ ...LIVE, PAYMENTS_MODE: 'prod' })).configured === false);
await t('runtime never returns a key value', async () => !JSON.stringify(stripe.runtime(envOf(LIVE))).match(/sk_|pk_|whsec_/));

/* ---- 2. session parameters ---- */
const p = checkoutSessionParams(input(), 1_900_000_000);
await t('embedded: ui_mode=embedded, redirect_on_completion=if_required', async () => p.get('ui_mode') === 'embedded' && p.get('redirect_on_completion') === 'if_required');
await t('embedded: return_url set, no success_url / cancel_url', async () => !!p.get('return_url') && !p.has('success_url') && !p.has('cancel_url'));
await t('embedded: return_url keeps the {CHECKOUT_SESSION_ID} placeholder', async () => p.get('return_url').includes('{CHECKOUT_SESSION_ID}'));
await t('return URL stays under the canonical origin by default', async () => p.get('return_url').startsWith(CANONICAL_SITE_URL + '/') && CANONICAL_SITE_URL === 'https://coachgari28.com');
await t('return URL never points at the Vercel alias by default', async () => !p.get('return_url').includes('vercel.app'));
await t('SITE_URL override is honoured (dev fallback) and trailing slash trimmed', async () => siteUrl(envOf({ SITE_URL: 'http://localhost:4173/' })) === 'http://localhost:4173');
await t('amount and currency are the request snapshot (minor units, lower-case ISO)', async () => p.get('line_items[0][price_data][unit_amount]') === '1000' && p.get('line_items[0][price_data][currency]') === 'aed' && p.get('line_items[0][quantity]') === '1');
await t('dynamic price_data + product_data: no Stripe Price / Product id is referenced', async () => ![...p.keys()].some((k) => /\[price\]$|\[product\]$/.test(k)) && p.get('line_items[0][price_data][product_data][name]') === 'Coach Gari coaching package (CG-1048)');
await t('a client-supplied amount field is not an input: only the snapshot amount is used', async () => { const q = checkoutSessionParams({ ...input(), amount: 1000, amount_total: 1, browser_amount: 1, price: 1 }, 1); return q.get('line_items[0][price_data][unit_amount]') === '1000' && ![...q.keys()].some((k) => /browser_amount|amount_total|\[price\]$/.test(k)); });
await t('hosted: success_url + cancel_url, no ui_mode', async () => { const q = checkoutSessionParams(input({ uiMode: 'hosted' }), 1); return q.has('success_url') && q.has('cancel_url') && !q.has('ui_mode') && !q.has('return_url'); });
await t('expires_at is passed through', async () => p.get('expires_at') === '1900000000');
await t('client_reference_id is the external (order) reference', async () => p.get('client_reference_id') === 'OR-8106AE');

/* ---- 3. metadata: identifiers only ---- */
const metaKeys = [...p.keys()].filter((k) => k.startsWith('metadata[')).map((k) => k.slice(9, -1)).sort();
await t('metadata keys are exactly the reconciliation identifiers', async () => JSON.stringify(metaKeys) === JSON.stringify(['beau_ph_request_id', 'host_app', 'merchant_key', 'order_reference', 'public_reference']));
await t('payment_intent metadata mirrors the same identifiers', async () => p.get('payment_intent_data[metadata][beau_ph_request_id]') === input().requestId && p.get('payment_intent_data[metadata][merchant_key]') === 'coach_gari');
await t('no personal / health / note data can reach Stripe metadata', async () => {
  const q = checkoutSessionParams({ ...input(), customerName: 'Jane Doe', notes: 'knee injury', bmi: 27, health: 'x', crm_contact_id: 'abc', consent: true }, 1);
  const s = q.toString();
  return !/Jane|knee|bmi|health|crm_contact|consent|notes/i.test(s) && [...q.keys()].filter((k) => k.startsWith('metadata[')).length === 5;
});
await t('customer_email is sent only when it looks like an email', async () => checkoutSessionParams(input({ customerEmail: '+971 50 000' }), 1).has('customer_email') === false && p.get('customer_email') === 'client@example.com');

/* ---- 4. create / resume through a mocked Stripe ---- */
let lastReq = null;
const withFetch = async (impl, fn) => { const real = globalThis.fetch; globalThis.fetch = impl; try { return await fn(); } finally { globalThis.fetch = real; } };
const jsonRes = (status, body) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });
await t('createPaymentRequest(embedded) → kind embedded with client secret + publishable key only', async () => withFetch((url, init) => { lastReq = { url, init }; return jsonRes(200, { id: 'cs_live_x', client_secret: 'cs_live_x_secret_y', ui_mode: 'embedded' }); }, async () => {
  const r = await stripe.createPaymentRequest(input(), envOf(LIVE));
  return r.kind === 'embedded' && r.providerReference === 'cs_live_x' && r.clientSecret === 'cs_live_x_secret_y' && r.publicConfig.publishable_key === LIVE.STRIPE_PUBLISHABLE_KEY && !('secret_key' in r.publicConfig)
    && lastReq.url === 'https://api.stripe.com/v1/checkout/sessions' && String(lastReq.init.body).includes('ui_mode=embedded') && lastReq.init.headers['Idempotency-Key'] === 'OR-8106AE:1:embedded';
}));
await t('createPaymentRequest(embedded) refuses when the publishable key is missing (fail closed)', async () => withFetch(() => { throw new Error('must not call Stripe'); }, async () => (await stripe.createPaymentRequest(input(), envOf({ ...LIVE, STRIPE_PUBLISHABLE_KEY: undefined }))).kind === 'unavailable'));
await t('createPaymentRequest refuses under a mode mismatch without calling Stripe', async () => withFetch(() => { throw new Error('must not call Stripe'); }, async () => (await stripe.createPaymentRequest(input(), envOf({ ...LIVE, STRIPE_SECRET_KEY: TEST.STRIPE_SECRET_KEY }))).kind === 'unavailable'));
await t('createPaymentRequest(embedded) without client_secret in the reply → unavailable', async () => withFetch(() => jsonRes(200, { id: 'cs_1', url: 'https://checkout.stripe.com/x' }), async () => (await stripe.createPaymentRequest(input(), envOf(LIVE))).kind === 'unavailable'));
await t('resumePaymentRequest re-opens an open embedded session (same reference)', async () => withFetch((url) => jsonRes(200, { id: 'cs_live_x', status: 'open', ui_mode: 'embedded', client_secret: 'cs_live_x_secret_z', expires_at: 1_900_000_000 }), async () => { const r = await stripe.resumePaymentRequest('cs_live_x', envOf(LIVE)); return r.kind === 'embedded' && r.providerReference === 'cs_live_x' && r.clientSecret === 'cs_live_x_secret_z'; }));
await t('resumePaymentRequest refuses a complete / expired session', async () => withFetch(() => jsonRes(200, { id: 'cs_live_x', status: 'complete', ui_mode: 'embedded', client_secret: 'cs_live_x_secret_z' }), async () => (await stripe.resumePaymentRequest('cs_live_x', envOf(LIVE))).kind === 'unavailable'));
await t('resumePaymentRequest refuses a hosted session for the embedded surface', async () => withFetch(() => jsonRes(200, { id: 'cs_live_x', status: 'open', ui_mode: 'hosted', url: 'https://checkout.stripe.com/x' }), async () => (await stripe.resumePaymentRequest('cs_live_x', envOf(LIVE))).kind === 'unavailable'));

/* ---- 5. the Stripe fee: never silently zero ----
   Case 2 is the exact shape that made the first live payment record a fee
   of zero: Stripe returned the balance transaction as an id string, so the
   old code found no `fee` on it and reported null. */
const { feeEvidence } = await import('../providers/stripe/adapter.ts');
const noSleep = () => Promise.resolve();
const routes = (map) => (url) => { for (const [frag, body] of map) if (String(url).includes(frag)) return jsonRes(200, typeof body === 'function' ? body() : body); return jsonRes(404, {}); };
const PI = 'pi_live_1', CH = 'ch_live_1', BT = 'txn_live_1';
const btObj = (currency = 'aed') => ({ id: BT, object: 'balance_transaction', fee: 89, net: 911, currency });

await t('fee: balance transaction already expanded → fee taken as is', async () => withFetch(routes([['/payment_intents/', { id: PI, latest_charge: { id: CH, balance_transaction: btObj() } }]]), async () => {
  const f = await feeEvidence(PI, 'AED', 'sk_live_x', { sleep: noSleep });
  return f.fee_amount === 89 && f.charge_id === CH && f.balance_transaction_id === BT && f.net_amount === 911 && f.fee_currency === 'aed';
}));
await t('fee: balance transaction returned as a bare id → fetched directly (the live bug)', async () => withFetch(routes([
  ['/payment_intents/', { id: PI, latest_charge: { id: CH, balance_transaction: BT } }],
  ['/balance_transactions/', btObj()],
]), async () => {
  const f = await feeEvidence(PI, 'AED', 'sk_live_x', { sleep: noSleep });
  return f.fee_amount === 89 && f.balance_transaction_id === BT && f.charge_id === CH;
}));
await t('fee: balance transaction lands only on a later read → retry finds it', async () => { let n = 0; return withFetch(routes([
  ['/payment_intents/', () => (++n < 3 ? { id: PI, latest_charge: { id: CH, balance_transaction: null } } : { id: PI, latest_charge: { id: CH, balance_transaction: btObj() } })],
]), async () => {
  const f = await feeEvidence(PI, 'AED', 'sk_live_x', { sleep: noSleep });
  return f.fee_amount === 89 && n === 3;
}); });
await t('fee: never available → unknown, not zero, and the charge is still reported', async () => withFetch(routes([['/payment_intents/', { id: PI, latest_charge: { id: CH, balance_transaction: null } }]]), async () => {
  const f = await feeEvidence(PI, 'AED', 'sk_live_x', { sleep: noSleep });
  return f.fee_amount === null && f.charge_id === CH && f.fee_settlement_amount === null;
}));
await t('fee: settled in another currency → kept as evidence, never used as the order fee', async () => withFetch(routes([
  ['/payment_intents/', { id: PI, latest_charge: { id: CH, balance_transaction: btObj('usd') } }],
]), async () => {
  const f = await feeEvidence(PI, 'AED', 'sk_live_x', { sleep: noSleep });
  return f.fee_amount === null && f.fee_settlement_amount === 89 && f.fee_currency === 'usd';
}));
await t('fee: charge itself returned as a bare id → charge captured, fee unknown', async () => withFetch(routes([['/payment_intents/', { id: PI, latest_charge: CH }]]), async () => {
  const f = await feeEvidence(PI, 'AED', 'sk_live_x', { sleep: noSleep });
  return f.charge_id === CH && f.fee_amount === null;
}));
await t('fee: a Stripe error never throws and never invents a figure', async () => withFetch(() => Promise.reject(new Error('network')), async () => {
  const f = await feeEvidence(PI, 'AED', 'sk_live_x', { sleep: noSleep });
  return f.fee_amount === null && f.charge_id === null;
}));
const paidEvent = { id: 'evt_1', type: 'checkout.session.completed', livemode: true, data: { object: { id: 'cs_live_1', currency: 'aed', amount_total: 1000, payment_intent: PI } } };
await t('enrich: attaches the fee to the event the host reconciles', async () => withFetch(routes([
  ['/payment_intents/', { id: PI, latest_charge: { id: CH, balance_transaction: BT } }],
  ['/balance_transactions/', btObj()],
]), async () => {
  const e = await stripe.enrich(paidEvent, envOf(LIVE));
  return e._enrich.fee_amount === 89 && e._enrich.charge_id === CH && e._enrich.balance_transaction_id === BT && e.id === 'evt_1';
}));
await t('enrich: an unknown fee is absent, so the host records fee_known = false', async () => withFetch(routes([['/payment_intents/', { id: PI, latest_charge: { id: CH, balance_transaction: null } }]]), async () => {
  const e = await stripe.enrich(paidEvent, envOf(LIVE));
  return e._enrich.fee_amount === null && e._enrich.charge_id === CH;
}));
await t('enrich: only touches checkout.session.completed', async () => withFetch(() => { throw new Error('must not call Stripe'); }, async () => {
  const e = await stripe.enrich({ ...paidEvent, type: 'refund.created' }, envOf(LIVE));
  return e._enrich === undefined;
}));

/* ---- 6. webhook mode symmetry is unchanged ---- */
await t('verifyWebhook: mode unset refuses before any signature work', async () => (await stripe.verifyWebhook({ headers: new Headers(), rawBody: '{}' }, envOf({ STRIPE_WEBHOOK_SECRET: 'whsec_x' }))).ok === false);


/* What the payer reads on their bank statement. The account's descriptor is the legal
   entity, not the brand they bought from, and an unrecognised name on a card app is the
   commonest reason a genuine charge is disputed. */
await t('a statement suffix is sent when configured', async () => {
  const q = checkoutSessionParams({ ...input(), statementSuffix: 'COACH GARI' }, 1);
  return q.get('payment_intent_data[statement_descriptor_suffix]') === 'COACH GARI';
});
await t('no suffix configured leaves the parameter out entirely', async () => {
  const q = checkoutSessionParams(input(), 1);
  return !q.has('payment_intent_data[statement_descriptor_suffix]');
});
await t('the characters Stripe rejects are cleaned, not passed through', async () =>
  statementSuffix('COACH*GARI <"x">') === 'COACH GARI x');
await t('a suffix longer than 22 characters is cut, not rejected', async () =>
  statementSuffix('COACH GARI PADEL AND FITNESS DUBAI').length <= 22);
await t('something too short to mean anything is dropped', async () =>
  statementSuffix('CG') === null && statementSuffix('   ') === null && statementSuffix(undefined) === null);

console.log(`\nSTRIPE_EMBEDDED_TESTS ok=${ok} fail=${fail}`);
process.exit(fail ? 1 : 0);
