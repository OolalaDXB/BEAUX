// operatorReadiness: the operator screen and the adapter that takes the payment agree.
// Run: node packages/ph/tests/operator-readiness.test.mjs
const { operatorReadiness, providers, providerKeys } = await import('../core/registry.ts');
let ok = 0, fail = 0;
const check = (n, c, x = '') => { if (c) ok++; else fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  → ' + x}`); };
const all = {}; for (const k of providerKeys) for (const s of providers[k].capabilities().secrets || []) all[s] = 'fictive-value';
let agree = true;
for (const k of providerKeys) for (const env of [(n) => all[n], () => undefined]) {
  const r = operatorReadiness(k, providers[k].capabilities().secrets || [], env);
  if (r.configured !== providers[k].runtime(env).configured || JSON.stringify(r).includes('fictive-value')) agree = false;
}
check('every rail: the screen says what the adapter says, and never a secret value', agree);
check('an unimplemented rail with every secret present is not configured', operatorReadiness('paynow', providers.paynow.capabilities().secrets, (n) => all[n]).configured === false);
check('an unknown rail is never configured', operatorReadiness('made_up', [], () => 'x').configured === false);
console.log(`\nOPERATOR_READINESS_TESTS ok=${ok} fail=${fail}`); process.exit(fail ? 1 : 0);
