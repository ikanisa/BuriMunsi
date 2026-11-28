import assert from 'node:assert/strict';
import {verifyCapturedBookmarks} from './captured-bookmarks.mjs';

// Chrome installs desktop apps in a regular profile. Keep this profile and all
// account requests on the disposable local fixture.
export async function verifyDesktopInstallation(chromium, executablePath, origin) {
  const root = new URL('/', origin);
  assert.equal(root.hostname, '127.0.0.1');
  const profile = await chromium.launchPersistentContext('', {
    headless: true, viewport: null, args: ['--disable-background-networking', '--test-type'],
    proxy: {server: origin, bypass: '127.0.0.1'},
    ...(executablePath ? {executablePath} : {channel: 'chrome'}),
  });
  const protocol = await profile.browser().newBrowserCDPSession();
  const identity = {manifestId: root.href};
  const launch = path => protocol.send('PWA.launch', path ? {...identity, url: root.href + '#' + path} : identity);
  let installed = false;
  try {
    const tab = profile.pages()[0];
    await tab.goto(root.href);
    await tab.getByRole('button', {name: /install BuriMunsi Admin/i}).waitFor();
    const inspector = await profile.newCDPSession(tab);
    assert.deepEqual((await inspector.send('Page.getInstallabilityErrors')).installabilityErrors, []);
    await protocol.send('PWA.install', {...identity, installUrlOrBundleUrl: root.href});
    installed = true;
    await protocol.send('PWA.changeAppUserSettings', {...identity, displayMode: 'standalone', linkCapturing: true});
    await protocol.send('PWA.getOsAppState', identity);

    const [app, first] = await Promise.all([profile.waitForEvent('page'), launch('/admin/payments')]);
    await app.waitForFunction(() => matchMedia('(display-mode: standalone)').matches);
    await app.waitForURL(/returnTo=%2Fadmin%2Fpayments$/);
    assert.equal(await app.getByRole('button', {name: /install BuriMunsi Admin/i}).count(), 0);
    const phone = app.getByLabel('Mobile number', {exact: true});
    await phone.fill('0780 000 001');
    assert.equal((await launch()).targetId, first.targetId);
    assert.equal((await launch('/admin/members')).targetId, first.targetId);
    await app.waitForURL(/returnTo=%2Fadmin%2Fmembers$/);
    assert.equal(await phone.inputValue(), '0780 000 001');
    await app.getByLabel('Four-digit passcode', {exact: true}).fill('0123');
    await app.getByRole('button', {name: 'Sign in', exact: true}).click();
    const search = app.getByLabel('Search Members', {exact: true});
    await search.fill('Fixture search');
    await app.waitForFunction(() => document.title === 'Members · BuriMunsi Admin');
    assert.equal((await launch('/admin/payments')).targetId, first.targetId);
    await app.getByRole('button', {name: 'Open Payments', exact: true}).waitFor();
    assert.equal(await search.inputValue(), 'Fixture search');
    await app.getByRole('button', {name: 'Open Payments', exact: true}).click();
    await app.getByRole('heading', {name: 'Payments', exact: true, level: 1}).waitFor();
    await app.waitForFunction(() => document.title === 'Payments · BuriMunsi Admin');
    await verifyCapturedBookmarks({app, origin, launchURL: async url => {
      const result = await protocol.send('PWA.launch', {...identity, url});
      assert.equal(result.targetId, first.targetId);
    }});
    await app.getByRole('button', {name: /^Account:/}).click();
    assert.equal(await app.getByRole('button', {name: /install BuriMunsi Admin/i}).count(), 0);
    await app.getByRole('button', {name: 'Sign out', exact: true}).click();
    await app.getByRole('heading', {name: 'Welcome to BuriMunsi'}).waitFor();
    assert.equal(await app.title(), 'BuriMunsi Admin');
  } finally {
    try {
      if (installed) await protocol.send('PWA.uninstall', identity);
    } finally {await profile.close();}
  }
}
