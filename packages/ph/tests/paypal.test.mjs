// PayPal — offline (no network, no account, no secrets). The adapter is driven against a fake PayPal.
// What it pins: the capture call (the second step Orders v2 leaves to the merchant), the only hosts a
// payer may be sent to, and that the adapter and the catalogue row (sql/migrations/0005) say the same thing.
// Run: node packages/ph/tests/paypal.test.mjs
import { readFileSync } from 'node:fs';
const { paypal, isPayPalApprovalUrl, PAYPAL_CURRENCIES, toPayPalAmount } = await import('../providers/paypal/adapter.ts');
const mig = readFileSync(new URL('../sql/migrations/0005_paypal_catalogue.sql', import.meta.url), 'utf8');
const src = readFileSync(new URL('../providers/paypal/adapter.ts', import.meta.url), 'utf8');

let ok = 0, fail = 0;
const check = (n, c, x = '') => { if (c) ok++; else fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  → ' + x}`); };
const ENV = (o) => (n) => o[n];
const SANDBOX = { PAYMENTS_MODE: 'test', PAYPAL_CLIENT_ID: 'id-sandbox', PAYPAL_SECRET: 'secret-sandbox', PAYPAL_WEBHOOK_ID: 'WH-ID' };
const LIVE = { ...SANDBOX, PAYMENTS_MODE: 'live' };
function fake(capture, auth = 200) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers || {}, body: init.body });
    if (String(url).endsWith('/v1/oauth2/token')) return new Response(JSON.stringify(auth === 200 ? { access_token: 'tok-1' } : {}), { status: auth });
    return new Response(JSON.stringify(capture.body ?? {}), { status: capture.status });
  };
  return { impl, calls };
}

/* ---- the capture call ---- */
{
  const f = fake({ status: 201, body: { id: 'ORDER12345', status: 'COMPLETED' } });
  const r = await paypal.capturePaymentRequest('ORDER12345', ENV(SANDBOX), f.impl);
  const cap = f.calls.find((c) => c.url.includes('/capture'));
  check('an approved order is captured', r.ok === true && r.status === 'COMPLETED' && r.already === false, JSON.stringify(r));
  check('in sandbox under PAYMENTS_MODE=test', f.calls.every((c) => c.url.startsWith('https://api-m.sandbox.paypal.com/')));
  check('on the order named, with POST', cap?.method === 'POST' && cap.url.endsWith('/v2/checkout/orders/ORDER12345/capture'));
  check('once per order: the idempotency key is the order', cap?.headers['PayPal-Request-Id'] === 'capture-ORDER12345');
  check('with the bearer token PayPal just issued, never the client secret', cap?.headers.Authorization === 'Bearer tok-1' && !JSON.stringify(cap).includes('secret-sandbox'));
  check('the answer carries no credential', !JSON.stringify(r).includes('tok-1') && !JSON.stringify(r).includes('secret'));
}
{
  const f = fake({ status: 201, body: { status: 'COMPLETED' } });
  await paypal.capturePaymentRequest('ORDER12345', ENV(LIVE), f.impl);
  check('against production under PAYMENTS_MODE=live', f.calls.length === 2 && f.calls.every((c) => c.url.startsWith('https://api-m.paypal.com/')));
}
{
  const r = await paypal.capturePaymentRequest('ORDER12345', ENV(SANDBOX), fake({ status: 422, body: { details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] } }).impl);
  check('asked twice, the second answer is still a success', r.ok === true && r.already === true, JSON.stringify(r));
}
{
  const r = await paypal.capturePaymentRequest('ORDER12345', ENV(SANDBOX), fake({ status: 422, body: { details: [{ issue: 'ORDER_NOT_APPROVED' }] } }).impl);
  check('an order the payer has not approved is not captured, and not retried', r.ok === false && r.reason === 'not_approved' && r.final === true, JSON.stringify(r));
}
{
  const r = await paypal.capturePaymentRequest('ORDER12345', ENV(SANDBOX), fake({ status: 422, body: { details: [{ issue: 'INSTRUMENT_DECLINED' }] } }).impl);
  check('a declined instrument is final', r.ok === false && r.reason === 'instrument_declined' && r.final === true);
}
{
  const down = await paypal.capturePaymentRequest('ORDER12345', ENV(SANDBOX), fake({ status: 503 }).impl);
  const busy = await paypal.capturePaymentRequest('ORDER12345', ENV(SANDBOX), fake({ status: 429 }).impl);
  check('PayPal being down or rate-limiting is transient, not final', down.ok === false && down.final === false && busy.ok === false && busy.final === false);
  const gone = await paypal.capturePaymentRequest('ORDER12345', ENV(SANDBOX), fake({ status: 404 }).impl);
  check('an order PayPal does not know is final', gone.ok === false && gone.reason === 'unknown_order' && gone.final === true);
}
{
  const f = fake({ status: 201 }, 401);
  const r = await paypal.capturePaymentRequest('ORDER12345', ENV(SANDBOX), f.impl);
  check('refused credentials: no capture is attempted', r.ok === false && r.reason === 'auth_401' && f.calls.length === 1, JSON.stringify(r));
}
{
  const f = fake({ status: 201 });
  const none = await paypal.capturePaymentRequest('ORDER12345', ENV({}), f.impl);
  const noMode = await paypal.capturePaymentRequest('ORDER12345', ENV({ ...SANDBOX, PAYMENTS_MODE: undefined }), f.impl);
  const noHook = await paypal.capturePaymentRequest('ORDER12345', ENV({ ...SANDBOX, PAYPAL_WEBHOOK_ID: '' }), f.impl);
  check('no credentials, no call', none.ok === false && none.reason === 'not_configured' && f.calls.length === 0);
  check('no declared mode, no call: the environment is never guessed', noMode.ok === false && f.calls.length === 0);
  check('no webhook id, no call: money that could not be confirmed is not taken', noHook.ok === false && f.calls.length === 0);
  const bad = await paypal.capturePaymentRequest('../../v1/payments/payouts', ENV(SANDBOX), f.impl);
  check('a reference that is not an order id never reaches PayPal', bad.ok === false && bad.reason === 'invalid_order_id' && f.calls.length === 0);
}
{
  const r = await paypal.capturePaymentRequest('ORDER12345', ENV(SANDBOX), async () => { throw new Error('network'); });
  check('a network failure is reported, never thrown', r.ok === false && r.reason === 'provider_unavailable');
}

/* ---- the only places a payer is sent ---- */
check('PayPal\'s approval pages are accepted', isPayPalApprovalUrl('https://www.paypal.com/checkoutnow?token=X') && isPayPalApprovalUrl('https://www.sandbox.paypal.com/checkoutnow?token=X'));
check('a look-alike host, another scheme or a non-string is not', !isPayPalApprovalUrl('https://www.paypal.com.evil.example/x') && !isPayPalApprovalUrl('https://paypal.com.evil.example/x')
  && !isPayPalApprovalUrl('https://evil.example/?u=https://www.paypal.com/') && !isPayPalApprovalUrl('http://www.paypal.com/x') && !isPayPalApprovalUrl(null));

/* ---- the adapter and the catalogue row say the same thing ---- */
const caps = paypal.capabilities();
const sqlSecrets = (mig.match(/secrets = '\{([A-Z_,]+)\}'/) || [])[1]?.split(',') ?? [];
const sqlCurrencies = (mig.match(/currencies = '\{([A-Z,]+)\}'/) || [])[1]?.split(',') ?? [];
const sqlFields = [...mig.matchAll(/"key":"([a-z_]+)"/g)].map((m) => m[1]);
check('same secret names in the adapter and the catalogue', JSON.stringify([...caps.secrets].sort()) === JSON.stringify([...sqlSecrets].sort()), sqlSecrets.join());
check('same currencies in the adapter and the catalogue', JSON.stringify([...caps.currencies].sort()) === JSON.stringify([...sqlCurrencies].sort()) && sqlCurrencies.length === PAYPAL_CURRENCIES.length);
check('AED is in neither', !caps.currencies.includes('AED') && !sqlCurrencies.includes('AED'));
check('no three-decimal currency is listed: the amount helper would refuse it', caps.currencies.every((c) => toPayPalAmount(100, c) !== null));
check('the catalogue\'s fields are the adapter\'s instruction fields', JSON.stringify(paypal.instructionFields().map((f) => f.key).sort()) === JSON.stringify([...sqlFields].sort()), sqlFields.join());
check('the migration records its version', /insert into beau_ph\.schema_versions \(version\) values \('0005_paypal_catalogue'\)/.test(mig));
check('no secret value is written in the migration', !/(sk|rk)_(live|test)_|whsec_|A[A-Za-z0-9_-]{60,}/.test(mig));

/* ---- a capture is a request, not a confirmation ---- */
check('the capture touches no database: it only asks PayPal', !/rpc\(|createClient|supabase/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
check('the adapter creates orders with intent CAPTURE, which is why the second step exists', /intent: "CAPTURE"/.test(src));

console.log(`\nPAYPAL_TESTS ok=${ok} fail=${fail}`); process.exit(fail ? 1 : 0);
