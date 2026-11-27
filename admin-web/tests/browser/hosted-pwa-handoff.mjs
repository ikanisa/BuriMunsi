import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {BURIMUNSI_ADMIN_ORIGIN} from '../../../supabase/functions/_shared/burimunsi-standalone.js';

// The caller owns its isolated HTTPS deployment. The browser never submits a sign-in.
export async function qualifyHostedPwaHandoff({browser, origin, baseline, candidate, switchRelease}) {
  const url = new URL(origin);
  assert(url.protocol === 'https:' && url.origin === origin && origin !== BURIMUNSI_ADMIN_ORIGIN);
  assert([baseline, candidate].every(id => /^[a-f0-9]{64}$/.test(id)) && baseline !== candidate);
  const context = await browser.newContext({serviceWorkers: 'allow'});
  const results = [];
  try {
    const pages = await Promise.all([context.newPage(), context.newPage()]);
    async function installed(page, expected) {
      await page.evaluate(async () => {
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          if ((await navigator.serviceWorker.getRegistration())?.active?.state === 'activated') return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('The service worker did not activate.');
      });
      if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
      await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
      const cache = await page.evaluate(async () => {
        const names = (await caches.keys()).filter(n => n.startsWith('collect-admin-'));
        const lists = await Promise.all(names.map(async n => (await (await caches.open(n)).keys()).map(e => new URL(e.url).pathname)));
        const paths = lists.flat();
        return {count: names.length, versions: [...new Set(paths.filter(p => p.startsWith('/_build/')).map(p => p.split('/')[2]))],
          privateCount: paths.filter(p => p.startsWith('/api/') || p.startsWith('/functions/')).length};
      });
      assert.deepEqual(cache, {count: 1, versions: [expected], privateCount: 0});
    }
    async function login(page, expected) {
      const response = await page.goto(origin + '/admin/login');
      assert.equal(response.status(), 200);
      await page.getByLabel('Mobile number', {exact: true}).waitFor();
      assert(await page.getByRole('button', {name: 'Sign in', exact: true}).isDisabled());
      assert(await page.locator(`script[src="/_build/${expected}/assets/admin-entry.js"]`).count());
      await installed(page, expected);
    }
    async function waitForPublicVersion(expected) {
      for (let attempt = 0; attempt < 45; attempt++) {
        const response = await context.request.get(origin + '/version.json', {headers: {'Cache-Control': 'no-cache'}});
        if (response.ok() && (await response.json()).asset_manifest_sha256 === expected) return;
        await delay(750);
      }
      throw new Error('The scoped host did not serve the requested release.');
    }
    async function waiting(page) {
      return page.evaluate(async () => {
        const r = await navigator.serviceWorker.getRegistration();
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          if (r.waiting?.state === 'installed') return true;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return false;
      });
    }
    await waitForPublicVersion(baseline);
    await login(pages[0], baseline);
    await login(pages[1], baseline);
    for (const [phase, from, to] of [['candidate', baseline, candidate], ['rollback', candidate, baseline]]) {
      const field = pages[1].getByLabel('Mobile number', {exact: true});
      const draft = '0780 000 003';
      await field.fill(draft);
      await switchRelease(phase);
      await waitForPublicVersion(to);
      await pages[0].evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
      assert(await waiting(pages[0]));
      assert.equal(await field.inputValue(), draft);
      // Check both immutable entries on the host, independently of the browser's cache.
      for (const id of [from, to]) {
        const result = await context.request.get(`${origin}/_build/${id}/assets/admin-entry.js`);
        assert.equal(result.status(), 200);
        assert.match(result.headers()['content-type'], /javascript/);
      }
      await pages[0].goto('about:blank');
      assert(await waiting(pages[1]));
      assert.equal(await field.inputValue(), draft);
      await pages[1].goto('about:blank');
      for (const page of pages) await login(page, to);
      results.push({phase, openTabs: 2, heldInputPreserved: true, bothAssetSetsReturned: true,
        activatedAfterBothLeft: true, cachedPrivateRoutes: 0, activeManifest: to});
    }
    const session = await context.request.get(origin + '/api/admin/auth/session');
    assert.equal(session.status(), 200);
    assert.equal((await session.json()).user, null);
    await context.setOffline(true);
    assert(await pages[0].evaluate(async () => {
      try { await fetch('/api/admin/auth/session', {cache: 'no-store'}); return false; }
      catch { return true; }
    }));
    return {transitions: results, offlineSessionUnavailable: true, signInSubmissions: 0};
  } finally { await context.close(); }
}
