import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {build, version} from 'esbuild';
import {STATIC_RECOVERY_SCRIPT} from '../src/static-recovery.js';
import {recoveryDom} from './fixtures/static-handoff-harness.mjs';

// Mirror the actual Wrangler 4.151.0 deployment transform that exposed the
// Function.toString closure defect. A source-only import cannot detect it.
assert.equal(version, '0.28.2', 'Use the exact locked hosting compiler');
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
  bundle: true, format: 'esm', target: 'es2024', keepNames: true,
  supported: {'import-source': true, using: true},
  loader: {'.js': 'jsx', '.mjs': 'jsx', '.cjs': 'jsx'},
  conditions: ['workerd', 'worker', 'browser'],
  sourcemap: 'inline', minify: false, write: false, logLevel: 'silent',
});


const code = compiled.outputFiles[0].text;
const {default: worker} = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
// Use the reviewed managed deployment profile without duplicating its host.
const profile = JSON.parse(await readFile(new URL('../wrangler.burimunsi.jsonc', import.meta.url))).vars;
const origin = profile.ADMIN_ORIGIN;
const bundleSha = createHash('sha256').update(code).digest('hex');
test('actual kept-name Admin bundle excludes the retired BuriMunsi challenge controller', async t => {
  t.diagnostic(`esbuild ${version}; keepNames=true; format=esm; target=es2024; bundle_sha256=${bundleSha}`);
  let staticDispatches = 0;
  const env = {...profile,
    ASSETS: {fetch() { staticDispatches++; throw Error('Parent must not fall back to assets'); }}};
  const retired = await worker.fetch(new Request(origin + '/admin/auth/local-challenge'), env);
  assert.equal(retired.status, 404);
  assert.equal((await retired.json()).error.code, 'not_found');
  assert.doesNotMatch(code, /collect\.admin\.human_challenge\.pairing\.v1/);
  assert.doesNotMatch(code, /\/v1\/privacy\/email\/challenge/);
  assert.equal(staticDispatches, 0);
});

// Exercise the same kept-name bundle used above, not only the unbundled worker.
test('actual kept-name Admin bundle serves manual predecessor recovery instead of SPA HTML', async () => {
  const path = '/_build/7f23b213325ba63698284d8d31dcb67e3487cf6b4d279e5ff50506950b206198/main.dart.js';
  let calls = 0;
  const env = {...profile,
    ASSETS: {async fetch() { calls++; return new Response('<html>old fallback</html>', {headers: {
      'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=31536000, immutable'}}); }}};
  const response = await worker.fetch(new Request(origin + path), env);
  assert.equal(calls, 1); assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /^text\/javascript/);
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  assert.equal(response.headers.get('X-Collect-Static-Recovery'), '1');
  const body = await response.text(); assert.equal(body, STATIC_RECOVERY_SCRIPT);
  const dom = recoveryDom(); dom.run(body);
  assert.equal(dom.panel().children[2].textContent, 'Reopen BuriMunsi');
  assert.equal(dom.reloads, 0); assert.equal(dom.forbiddenEffects, 0);
  dom.panel().children[2].listeners.click();
  assert.equal(dom.reloads, 1); assert.equal(dom.forbiddenEffects, 0);
});
