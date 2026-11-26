// Local synthetic browser rehearsal for both direct network and installed-worker paths.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {loadPackage, compare} from '../../../scripts/qa/r06_compare_admin_assets.mjs';
import {fixtureMember, fixturePayment} from './operator-read-fixture.mjs';
import {installLocalNetworkFence} from './local-network-fence.cjs';

const [baseDir, basePin, nextDir, nextPin, mode, extra] = process.argv.slice(2);
assert(baseDir && basePin && nextDir && nextPin && (!mode || ['--installed','--allocation-recovery'].includes(mode)) && !extra,
  'Provide two pinned synthetic Admin artifacts and optionally --installed or --allocation-recovery.');
const installedMode = mode === '--installed' || mode === '--allocation-recovery';
const allocationRecovery = mode === '--allocation-recovery';
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
  resolve(baseDir), resolve(nextDir), ...(allocationRecovery ? [mode] : [])], {
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
  const context = await browser.newContext({serviceWorkers: installedMode ? 'allow' : 'block', viewport: {width: 1440, height: 900}});
  context.setDefaultTimeout(10_000);
  context.setDefaultNavigationTimeout(25_000);
  const tab = await context.newPage();
  await installLocalNetworkFence(tab, origin, deny);

  async function switchTo(label) {
    const ack = once(server, 'message', {signal: AbortSignal.timeout(5000)});
    server.send(label);
    assert.equal((await ack)[0], label);
  }
  async function launchHome(page, preexistingSession) {
    assert.equal((await page.goto(origin + '/admin', {waitUntil:'domcontentloaded'})).status(), 200);
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
  // A Playwright function predicate must be synchronous. Poll the asynchronous
  // registration explicitly rather than treating its Promise as a ready state.
  async function waitForRegistration(page, slot, state) {
    await page.evaluate(async ({slot, state}) => {
      const deadline = performance.now() + 28_000;
      while (performance.now() < deadline) {
        if ((await navigator.serviceWorker.getRegistration())?.[slot]?.state === state) return;
        await new Promise(r => setTimeout(r, 40));
      }
      throw new Error('Expected service worker ' + slot + ' in state ' + state);
    }, {slot, state});
  }
  async function installedVersion(page, expected, old) {
    await waitForRegistration(page, 'active', 'activated');
    if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    const result = await page.evaluate(async ({current, previous}) => {
      const names = (await caches.keys()).filter(n => n.startsWith('collect-admin-'));
      const entries = await Promise.all(names.map(async n => (await (await caches.open(n)).keys())
        .map(k => new URL(k.url).pathname)));
      return {count: names.length, current: entries.flat().some(p => p.startsWith('/_build/' + current + '/')),
        previous: !!previous && entries.flat().some(p => p.startsWith('/_build/' + previous + '/')),
        api: entries.flat().some(p => p.startsWith('/api/'))};
    }, {current: expected, previous: old});
    assert.deepEqual(result, {count:1, current:true, previous:false, api:false});
  }
  async function transition(label, from, to, fromChunk, toChunk, tab, other) {
    for (const page of [tab, other]) {
      await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    }
    await switchTo(label);
    await tab.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      if (!r?.waiting && !r?.installing) await r.update();
    });
    await waitForRegistration(tab, 'waiting', 'installed');
    await getChunk(other, fromChunk, true);
    await tab.goto('about:blank', {waitUntil:'domcontentloaded'});
    assert(await other.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state === 'installed'));
    await other.goto('about:blank', {waitUntil:'domcontentloaded'});
    await launchHome(tab, true);
    await installedVersion(tab, to.version, from.version);
    await launchHome(other, true);
    await getChunk(tab, toChunk, true);
    await getChunk(other, fromChunk, false);
  }
  async function allocationEvidence() {
    const reply = once(server, 'message', {signal:AbortSignal.timeout(5000)});
    server.send('allocation-evidence');
    return (await reply)[0];
  }
  async function openAllocation(page) {
    await page.getByRole('link', {name:'Payments',exact:true}).click();
    await page.getByRole('button', {name:fixturePayment.ftId,exact:true}).click();
    const wizardEntry = page.getByRole('link',{name:'Allocate to member',exact:true});
    const inlineEntry = page.getByRole('combobox',{name:'Member',exact:true});
    await wizardEntry.or(inlineEntry).first().waitFor();
    if (await wizardEntry.count()) {
      await wizardEntry.click();
      return page.getByRole('dialog',{name:'Allocate payment',exact:true});
    }
    return null;
  }
  async function submitInterruptedAllocation(page) {
    const wizard = await openAllocation(page);
    const detailUrl = page.url();
    const body = wizard ?? page.getByRole('region', {name:'Original allocation request'});
    await (wizard ?? page).getByRole('combobox', {name:'Member',exact:true}).selectOption(fixtureMember.id);
    if (wizard) {
      await wizard.getByRole('button',{name:'Review allocation',exact:true}).click();
      await wizard.getByRole('button',{name:'Confirm allocation',exact:true}).click();
    } else await page.getByRole('button', {name:'Allocate',exact:true}).click();
    await body.getByText('Allocation was not confirmed. Check the original request before trying again.',{exact:true}).waitFor();
    const code = (await body.locator('code').textContent())?.trim();
    assert.match(code,/^[0-9a-f-]{36}$/);
    const result = await allocationEvidence();
    assert.deepEqual({writes:result.writes,effects:result.effects,lookupMatches:result.lookupMatches},
      {writes:1,effects:1,lookupMatches:[]});
    if (wizard) await wizard.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.getByRole('link', {name:'Home',exact:true}).click();
    await page.getByRole('heading', {name:'Home',exact:true}).waitFor();
    return {detailUrl, code};
  }
  async function checkInterruptedAllocation(page,{detailUrl,code}) {
    assert.equal(new URL(detailUrl).origin,origin);
    await page.goto(detailUrl,{waitUntil:'domcontentloaded'});
    const wizard = page.getByRole('dialog',{name:'Allocate payment',exact:true});
    const inline = page.getByRole('region',{name:'Original allocation request'});
    const openRecovery = page.getByRole('link',{name:'Review allocation request',exact:true});
    await wizard.or(inline).or(openRecovery).first().waitFor();
    if ((!await wizard.count()) && (!await inline.count())) await openRecovery.click();
    const body = wizard.or(inline).first();
    const original = body.getByText(code,{exact:true});
    await original.waitFor();
    const check = body.getByRole('button',{name:'Check request',exact:true});
    await check.click();
    await body.getByText('The original request could not be checked. Keep its reference and check again.',{exact:true}).waitFor();
    assert(await original.isVisible());
    assert.equal(await body.getByRole('button',{name:'Retry allocation',exact:true}).count(),0);
    await check.click();
    await body.waitFor({state:'hidden'});
    await page.getByRole('region',{name:'Payment details'}).getByText('Allocated',{exact:true}).waitFor();
    await page.reload({waitUntil:'domcontentloaded'});
    await page.getByRole('heading',{name:'Payment details',exact:true}).waitFor();
    await page.getByRole('region',{name:'Payment details'}).getByText('Allocated',{exact:true}).waitFor();
    assert.equal(await body.count(),0);
    assert.equal(await page.getByRole('button',{name:'Allocate',exact:true}).count(),0);
    if (await openRecovery.count()) {
      await openRecovery.click();
      await wizard.getByText('This payment is already allocated to ' + fixtureMember.display_name + '.',{exact:true}).waitFor();
      assert.equal(await wizard.getByRole('button',{name:'Check request',exact:true}).count(),0);
      assert.equal(await wizard.getByText(code,{exact:true}).count(),0);
      await wizard.getByRole('button',{name:'Close',exact:true}).click();
    }
    const result = await allocationEvidence();
    assert.deepEqual({writes:result.writes,effects:result.effects,lookupMatches:result.lookupMatches},
      {writes:1,effects:1,lookupMatches:[true,true]});
    await page.getByRole('link',{name:'Home',exact:true}).click();
    await page.getByRole('heading',{name:'Home',exact:true}).waitFor();
  }
  if (installedMode) {
    await launchHome(tab, false);
    await installedVersion(tab, a.version);
    const other = await context.newPage();
    await launchHome(other, true);
    await installedVersion(other, a.version);
    const initialSession = (await context.cookies(origin)).find(c=>c.name==='collect_fixture_session');
    const pending = allocationRecovery ? await submitInterruptedAllocation(tab) : null;
    await transition('candidate', a, b, oldChunk, newChunk, tab, other);
    if (pending) {
      assert(initialSession?.httpOnly);
      assert((await context.cookies(origin)).find(c=>c.name==='collect_fixture_session')?.value === initialSession.value,
        'The original authenticated session must survive the handoff');
      await checkInterruptedAllocation(tab,pending);
    }
    await transition('baseline', b, a, newChunk, oldChunk, tab, other);
    const apiOnline = await tab.evaluate(async () => {
      try {
        const r = await fetch('/api/admin/auth/session', {cache:'no-store'});
        return r.redirected || r.ok;
      } catch {return false;}
    });
    assert.equal(apiOnline, true, 'Synthetic authenticated API baseline must respond online');
    await context.setOffline(true);
    assert(await tab.evaluate(async () => {
      try {await fetch('/api/admin/auth/session', {cache:'no-store'}); return false;}
      catch {return true;}
    }), 'Offline authentication must not be served from cache');
    await context.setOffline(false);
    await other.getByRole('button', {name:/^Account:/}).click();
    await other.getByRole('button', {name:'Sign out', exact:true}).click();
    await other.getByRole('heading', {name:'Welcome to BuriMunsi'}).waitFor();
    await tab.reload();
    await tab.getByRole('heading', {name:'Welcome to BuriMunsi'}).waitFor();
    assert(!(await context.cookies(origin)).some(c => c.name === 'collect_fixture_session'));
    assert.deepEqual(deny, []);
    if (pending) {
      const final = await allocationEvidence();
      assert.deepEqual({writes:final.writes,effects:final.effects,lookupMatches:final.lookupMatches},
        {writes:1,effects:1,lookupMatches:[true,true]});
    }
    console.log(JSON.stringify({scope:allocationRecovery ? 'loopback installed workers with one in-memory synthetic allocation' : 'loopback installed workers, no financial writes',
      ...(allocationRecovery ? {allocation_posts:1,synthetic_effects:1,original_request_reads:2,financial_ledger_verified:false} : {}),
      tested:['promotion waits for both tabs','rollback waits for both tabs','cache replacement both ways',
        'correct and retired chunk behavior','offline auth refused','cross-tab sign-out'], hosted_acceptance:false}));
  } else {
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
  }
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
  await exited;
}
