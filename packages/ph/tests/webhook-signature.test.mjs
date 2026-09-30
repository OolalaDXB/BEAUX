/* CG-003 — Stripe webhook signature verification, offline unit test (CI).
   Exercises the exact module the Edge Function imports
   (beau-ph/providers/stripe/signature.js) with a dummy secret.
   Exit code 1 on any failure. No network, no secrets. */
import { verifyStripeSignature, signForTest, hmacHex, parseHeader } from '../providers/stripe/signature.js';

const SECRET = 'whsec_unit_test_secret_do_not_use';
const OTHER = 'whsec_another_secret';
const body = JSON.stringify({ id: 'evt_test_1', type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_test_1', amount_total: 4500 } } });
const now = 1_800_000_000;
let ok = 0, fail = 0;
const t = async (name, cond) => { const r = await cond(); if (r) { ok++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name); } };

const valid = await signForTest(body, SECRET, now);
const v = (h, b = body, o = {}) => verifyStripeSignature(h, b, SECRET, { nowS: now, ...o });

await t('valid signature on the exact raw body is accepted', async () => (await v(valid)).ok);
await t('signature covers "t.body": same body, different t → rejected', async () => (await v(valid.replace(`t=${now}`, `t=${now + 1}`))).reason === 'signature_mismatch');
await t('tampered payload (amount 4500 → 1) is rejected', async () => (await v(valid, body.replace('4500', '1'))).reason === 'signature_mismatch');
await t('tampered payload: one extra whitespace byte is rejected', async () => (await v(valid, body + ' ')).reason === 'signature_mismatch');
await t('re-serialised JSON (key order) is rejected — raw bytes matter', async () => (await v(valid, JSON.stringify({ ...JSON.parse(body), zz: 1 }))).reason === 'signature_mismatch');
await t('signature made with a different secret is rejected', async () => (await v(await signForTest(body, OTHER, now))).reason === 'signature_mismatch');
await t('stale timestamp (301 s old) is rejected as replay', async () => (await v(await signForTest(body, SECRET, now - 301))).reason === 'timestamp_out_of_tolerance');
await t('timestamp 300 s old is still accepted (tolerance boundary)', async () => (await v(await signForTest(body, SECRET, now - 300))).ok);
await t('far-future timestamp (+301 s) is rejected', async () => (await v(await signForTest(body, SECRET, now + 301))).reason === 'timestamp_out_of_tolerance');
await t('replay of a valid header 10 minutes later is rejected', async () => (await v(valid, body, { nowS: now + 600 })).reason === 'timestamp_out_of_tolerance');
await t('missing header is rejected', async () => (await v(null)).reason === 'missing_header');
await t('empty header is rejected', async () => (await v('')).reason === 'missing_header');
await t('header without t= is rejected', async () => (await v(valid.replace(`t=${now},`, ''))).reason === 'malformed_header');
await t('header with v0 only (legacy scheme) is rejected', async () => (await v(valid.replace('v1=', 'v0='))).reason === 'malformed_header');
await t('non-numeric timestamp is rejected', async () => (await v(valid.replace(`t=${now}`, 't=now'))).reason === 'malformed_header');
await t('garbage header is rejected', async () => (await v('t=,v1=zz,xx')).reason === 'malformed_header');
await t('truncated signature is rejected', async () => (await v(valid.slice(0, -2))).reason === 'signature_mismatch');
await t('one flipped hex digit is rejected', async () => { const last = valid.slice(-1); return (await v(valid.slice(0, -1) + (last === 'a' ? 'b' : 'a'))).reason === 'signature_mismatch'; });
await t('multiple v1 candidates: any valid one is accepted (secret rotation)', async () => (await v(`${await signForTest(body, OTHER, now)},v1=${await hmacHex(SECRET, `${now}.${body}`)}`)).ok);
await t('multiple v1 candidates, none valid → rejected', async () => (await v(`${await signForTest(body, OTHER, now)},v1=deadbeef`)).reason === 'signature_mismatch');
await t('extra v0 alongside a valid v1 is ignored', async () => (await v(`${valid},v0=0123456789abcdef`)).ok);
await t('uppercase hex signature is accepted (case-insensitive compare)', async () => (await v(valid.replace(/v1=(.*)/, (_, s) => 'v1=' + s.toUpperCase()))).ok);
await t('known-answer: HMAC-SHA256("key","The quick brown fox jumps over the lazy dog")', async () =>
  (await hmacHex('key', 'The quick brown fox jumps over the lazy dog')) === 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
await t('parseHeader keeps every v1 and the timestamp', async () => { const p = parseHeader('t=5,v1=aa,v0=bb,v1=cc'); return p.timestamp === 5 && p.signatures.join() === 'aa,cc'; });

console.log(`\nWEBHOOK_SIGNATURE_TESTS ok=${ok} fail=${fail}`);
process.exit(fail ? 1 : 0);
