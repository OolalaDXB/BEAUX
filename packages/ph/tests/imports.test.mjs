/* Every module of the package loads on its own: a broken import, a syntax error or a
   module that reaches for something at load time fails here, not in a deployed function.
   Node strips the TypeScript types itself (22.18+), so nothing is compiled.
   Run: node packages/ph/tests/imports.test.mjs */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { if (!['tests', 'sql', 'docs', 'node_modules'].includes(n)) walk(p); }
    else if (/\.(ts|js)$/.test(n) && !/\.d\.ts$/.test(n)) files.push(p);
  }
})(ROOT);

let ok = 0, fail = 0;
for (const f of files.sort()) {
  try { await import(pathToFileURL(f).href); ok++; console.log(`PASS  ${relative(ROOT, f)}`); }
  catch (e) { fail++; console.log(`FAIL  ${relative(ROOT, f)} — ${e.message.split('\n')[0]}`); }
}
console.log(`\nPH_IMPORT_TESTS ok=${ok} fail=${fail}`);
if (fail || !ok) process.exit(1);
