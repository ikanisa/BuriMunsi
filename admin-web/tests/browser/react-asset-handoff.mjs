// Local browser rehearsal only, deliberately bypasses installed-worker caches
// to exercise same-origin requests which reach a changed server version.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {loadPackage, compare} from '../../../scripts/qa/r06_compare_admin_assets.mjs';
import {installLocalNetworkFence} from './local-network-fence.cjs';

const [baseDir, basePin, nextDir, nextPin, extra] = process.argv.slice(2);
assert(baseDir && basePin && nextDir && nextPin && !extra, 'Provide two pinned synthetic Admin artifacts.');
const [a, b] = await Promise.all([loadPackage(baseDir, basePin), loadPackage(nextDir, nextPin)]);
for (const root of [baseDir, nextDir]) {
  const metadata = JSON.parse(await readFile(join(root, 'version.json')));
  assert.equal(metadata.backend, 'unconfigured');
}
const skew = compare(a, b);
assert(skew.promotion.missing > 0 && skew.rollback.missing > 0, 'This adverse rehearsal needs distinct asset sets.');
function absentChunk(from, to) {
  const entry = [...from.required].find(([path]) =>
    /\/(?:BuriMunsiPayments|PaymentsWorkArea)-[^/]+\.js$/.test(path) && !to.all.has(path));
  assert(entry, 'Expected a JavaScript build chunk absent in the other version.');
  return entry;
}
const oldChunk = absentChunk(a, b), newChunk = absentChunk(b, a);
const port = Number(process.env.COLLECT_FIXTURE_PORT ?? 4175);
assert(Number.isInteger(port) && port > 1023 && port < 65536);
const origin = 'http://127.0.0.1:' + port;
const server = spawn(process.execPath, [fileURLToPath(new URL('./fixture-server.mjs', import.meta.url)),
  resolve(baseDir), resolve(nextDir)], {
  env: {COLLECT_FIXTURE_PORT: String(port), COLLECT_FIXTURE_SIGN_IN: '1'},
  stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
});
const exited = once(server, 'close');
let browser;
const deny = [];
try {
  await once(server.stdout, 'data', {signal: AbortSignal.timeout(6000)});
  const installed = chromium.executablePath();
  const executablePath = process.env.ADMIN_PWA_CHROME || (existsSync(installed) ? installed : undefined);
  browser = await chromium.launch({headless: true, args: ['--disable-background-networking'],
    proxy: {server: origin, bypass: '127.0.0.1'},
    ...(executablePath ? {executablePath} : {channel: 'chrome'})});
  const context = await browser.newContext({serviceWorkers: 'block', viewport: {width: 1440, height: 900}});
  context.setDefaultTimeout(10_000);
  const tab = await context.newPage();
  await installLocalNetworkFence(tab, origin, deny);

  async function switchTo(label) {
    const ack = once(server, 'message', {signal: AbortSignal.timeout(5000)});
    server.send(label);
    assert.equal((await ack)[0], label);
  }
  async function launchHome(page, preexistingSession) {
    assert.equal((await page.goto(origin + '/admin')).status(), 200);
    if (!preexistingSession) {
      await page.getByRole('heading', {name: 'Welcome to BuriMunsi'}).waitFor();
      await page.getByLabel('Mobile number', {exact: true}).fill('0780 000 001');
      await page.getByLabel('Four-digit passcode', {exact: true}).fill('0123');
      await page.getByRole('button', {name: 'Sign in', exact: true}).click();
    }
    await page.getByRole('heading', {name: 'Home', exact: true}).waitFor();
  }
  async function getChunk(page, [path, expected], present) {
    const result = await page.evaluate(async p => {
      const r = await fetch('/' + p, {cache: 'no-store'});
      const bytes = await r.arrayBuffer();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
        .map(v => v.toString(16).padStart(2, '0')).join('');
      return {status: r.status, mime: r.headers.get('content-type'), cache: r.headers.get('cache-control'), digest};
    }, path);
    if (present) {
      assert.equal(result.status, 200);
      assert.match(result.mime, /javascript/);
      assert.equal(result.digest, expected);
    } else {
      assert.equal(result.status, 404);
      assert.match(result.mime, /^text\/plain/);
      assert.match(result.cache, /no-store/);
    }
    await page.getByRole('heading', {name: 'Home', exact: true}).waitFor();
  }
  await launchHome(tab, false);
  assert((await context.cookies(origin)).some(c => c.name === 'collect_fixture_session' && c.httpOnly));
  await getChunk(tab, oldChunk, true);
  await switchTo('candidate');
  await getChunk(tab, oldChunk, false);
  const next = await context.newPage();
  await launchHome(next, true);
  await getChunk(next, newChunk, true);
  await switchTo('baseline');
  await getChunk(next, newChunk, false);
  await getChunk(tab, oldChunk, true);
  await next.getByRole('button', {name: /^Account:/}).click();
  await next.getByRole('button', {name: 'Sign out', exact: true}).click();
  await next.getByRole('heading', {name: 'Welcome to BuriMunsi'}).waitFor();
  await tab.reload();
  await tab.getByRole('heading', {name: 'Welcome to BuriMunsi'}).waitFor();
  assert(!(await context.cookies(origin)).some(c => c.name === 'collect_fixture_session'));
  assert.deepEqual(deny, []);
  console.log(JSON.stringify({scope:'local signed-in browser, network path only', old_tab_promotion_404:true,
    candidate_tab_rollback_404:true, same_version_exact_js:true, sign_out_both_tabs:true, hosted_acceptance:false}));
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
  await exited;
}
