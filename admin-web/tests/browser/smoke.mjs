import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installLocalNetworkFence } from './local-network-fence.cjs';
import { qualifyPhoneTeam } from './phone-team.mjs';
import { fixtureInactiveMember, fixtureMember, fixtureOutgoingPayment, fixturePayment, fixtureSmsEvidenceId } from './operator-read-fixture.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const artifact = resolve(root, process.argv[2] ?? process.env.ADMIN_PWA_BUILD_DIR ?? 'build/admin-web-fixture');
const origin = process.env.ADMIN_PWA_FIXTURE_ORIGIN ?? 'http://127.0.0.1:4175';
const legacySessions = process.env.ADMIN_PWA_LEGACY_SESSIONS === '1';
const url = new URL(origin);
assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.origin === origin && url.port,
  'Use the explicit HTTP loopback origin of the fixture build.');
const { backend } = JSON.parse(await readFile(join(artifact, 'version.json'), 'utf8'));
assert.equal(backend, 'unconfigured', 'Use a synthetic artifact built in fixture mode.');
execFileSync(process.execPath, [join(root, 'admin-web/scripts/build-admin.mjs'), 'verify', artifact], {
  cwd: root, stdio: 'inherit',
});

const modulePath = process.env.PLAYWRIGHT_CORE_PATH;
const { chromium } = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : 'playwright-core');
const server = spawn(process.execPath, [fileURLToPath(new URL('./fixture-server.mjs', import.meta.url)), artifact], {
  env: { COLLECT_FIXTURE_PORT: url.port, COLLECT_FIXTURE_SIGN_IN: '1', COLLECT_FIXTURE_LEGACY_SESSIONS: legacySessions ? '1' : '0' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const exited = new Promise(resolveExit => server.once('close', resolveExit));
const denied = [];
const pageErrors = [];
const unexpectedAuth = [];
const incorrectIdentityHeaders = [];
const sessionPath = '/api/admin/auth/session';
const signInPath = '/api/admin/auth/phone-passcode';
const verifyPasscodePath = '/api/admin/auth/passcode/verify';
const allowedAuth = new Set([sessionPath, signInPath, verifyPasscodePath, '/api/admin/auth/passcode/change', '/api/admin/auth/logout']);
const sessionApi = url => url.origin === origin && url.pathname === sessionPath;
let browser;
try {
  await new Promise((ready, fail) => {
    const timer = setTimeout(() => fail(new Error('Admin fixture did not bind its loopback port.')), 5000);
    server.once('exit', code => {
      clearTimeout(timer);
      fail(new Error(`Admin fixture exited with status ${code}.`));
    });
    server.once('error', error => {
      clearTimeout(timer);
      fail(error);
    });
    server.stdout.on('data', output => {
      if (output.toString().includes(origin)) {
        clearTimeout(timer);
        ready();
      }
    });
  });

  const installed = chromium.executablePath();
  const executablePath = process.env.ADMIN_PWA_CHROME || (existsSync(installed) ? installed : undefined);
  browser = await chromium.launch({
    headless: true, args: ['--disable-background-networking'],
    // The fixture serves its own origin and refuses proxy requests. Bound the
    // network here too so the service-worker context can use normal navigation.
    proxy: { server: origin, bypass: '127.0.0.1' },
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
  });
  async function open(viewport, serviceWorkers) {
    const context = await browser.newContext({ viewport, serviceWorkers });
    context.setDefaultTimeout(10_000);
    const page = await context.newPage();
    context.on('request', request => {
      const {pathname} = new URL(request.url());
      if (pathname.startsWith('/api/admin/auth/') && !allowedAuth.has(pathname)) unexpectedAuth.push(pathname);
      if (pathname.startsWith('/api/admin/')) {
        const sessionRead = request.method() === 'GET' && pathname === sessionPath;
        const passcodeExchange = request.method() === 'POST' && [signInPath, verifyPasscodePath].includes(pathname);
        const identityVersion = request.headers()['x-collect-owner-identity-version'];
        if (identityVersion !== (sessionRead || passcodeExchange ? '1' : undefined)) incorrectIdentityHeaders.push([request.method(), pathname]);
      }
    });
    page.on('pageerror', error => pageErrors.push(error.message));
    if (serviceWorkers === 'block') await installLocalNetworkFence(page, origin, denied);
    else context.on('request', request => {
      const target = new URL(request.url());
      if (target.origin !== origin) denied.push({ origin: target.origin, resourceType: request.resourceType() });
    });
    return { context, page };
  }

  const starterNotice = 'If this page does not finish opening, reopen it while online.';
  const startup = await open({ width: 390, height: 844 }, 'block');
  const entryPath = /^\/_build\/[0-9a-f]{64}\/assets\/admin-entry\.js$/;
  await startup.page.route(url => url.origin === origin && entryPath.test(url.pathname), route =>
    route.fulfill({ status: 404, contentType: 'text/plain', headers: { 'Cache-Control': 'no-store' },
      body: 'Synthetic missing Admin entry' }));
  const failedEntry = startup.page.waitForResponse(response => entryPath.test(new URL(response.url()).pathname));
  const shell = await startup.page.goto(origin + '/');
  assert.equal(shell.status(), 200);
  assert.equal((await failedEntry).status(), 404);
  await startup.page.getByRole('main').getByRole('heading', { name: 'BuriMunsi Admin', exact: true }).waitFor();
  await startup.page.getByRole('main').getByText(starterNotice, { exact: true }).waitFor();
  assert.equal(await startup.page.getByRole('heading', { name: 'Welcome to BuriMunsi' }).count(), 0);
  assert.equal((await startup.context.cookies()).length, 0);
  await startup.context.close();

  const desktop = await open({ width: 1440, height: 900 }, 'block');
  const { page } = desktop;
  await page.goto(origin + '/admin/forgot-password');
  await page.getByRole('heading', { name: 'Welcome to BuriMunsi' }).waitFor();
  assert.equal(new URL(page.url()).hash, '#/admin/login');
  assert.equal(await page.getByText(starterNotice, { exact: true }).count(), 0);
  await page.goto(origin + '/admin');
  await page.getByRole('heading', { name: 'Welcome to BuriMunsi' }).waitFor();
  assert.equal(await page.getByLabel('Email', { exact: true }).count(), 0);
  await page.getByLabel('Mobile number', { exact: true }).fill('0780 000 001');
  await page.getByLabel('Four-digit passcode', { exact: true }).fill('0123');
  const loginRequests = [];
  const recordLogin = request => {
    const {pathname} = new URL(request.url());
    if (pathname.startsWith('/api/admin/auth/')) loginRequests.push(pathname);
  };
  page.on('request', recordLogin);
  const firstOverview = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/burimunsi/home' && response.ok());
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const overview = page.getByRole('heading', { name: 'Home' });
  await overview.waitFor();
  await firstOverview;
  await page.getByText('Inbox status unknown', {exact: true}).waitFor();
  assert.equal(await page.getByRole('link', {name: 'M-Money SMS', exact: true}).getAttribute('href'), '#/admin/payments?view=sms');
  page.off('request', recordLogin);
  assert.deepEqual(loginRequests, legacySessions ? [signInPath, sessionPath] : [signInPath]);
  const cookies = await desktop.context.cookies(origin);
  assert(cookies.some(cookie => cookie.name === 'collect_fixture_session' && cookie.httpOnly));
  assert(!String(await page.evaluate(() => document.cookie)).includes('collect_fixture_session'));
  await page.reload();
  await overview.waitFor();
  await page.goto(origin + '/admin/security/verify-passcode?returnTo=%2Fadmin');
  await overview.waitFor();
  assert.equal(new URL(page.url()).hash, '#/admin');

  // Modern phone accounts bypass the old verification screen. Exercise it
  // with the preceding Core contract and the same authenticated fixture cookie.
  const stepUp = await open({ width: 1440, height: 900 }, 'block');
  const verificationRequests = [];
  try {
    await stepUp.context.addCookies(cookies);
    const ownerEmail = 'local-owner@example.test';
    const ownerIdentity = {schemaVersion: 1, adminId: 'synthetic-admin', principalId: 'synthetic-principal', email: ownerEmail};
    const user = {id: ownerIdentity.adminId, principalId: ownerIdentity.principalId, email: ownerEmail,
      role: 'owner', sessionId: 'synthetic-legacy-session', authMethod: 'phone_passcode', phone: '+250780000001',
      permissions: ['overview.read'], financialModel: 'canonical_evidence_ledger', passcodeVerifiedAt: new Date(Date.now() - 310_000).toISOString()};
    const state = {user, ownerEmail, ownerIdentity, expiresAt: new Date(Date.now() + 600_000).toISOString(), csrfToken: 'b'.repeat(64)};
    await stepUp.context.route(sessionApi, route => route.fulfill({json: state}));
    await stepUp.context.route(url => url.origin === origin && url.pathname === verifyPasscodePath, route => {
      const request = route.request();
      assert.equal(request.method(), 'POST');
      assert.deepEqual(request.postDataJSON(), {pin: '0123'});
      assert.equal(request.headers()['x-collect-csrf'], state.csrfToken);
      user.passcodeVerifiedAt = new Date().toISOString();
      const proof = {contractVersion: 1, sessionId: user.sessionId, passcodeVerifiedAt: user.passcodeVerifiedAt};
      const direct = !legacySessions && request.headers()['x-collect-owner-identity-version'] === '1';
      return route.fulfill({json: {...proof, ...(direct ? {session: {...state, sessionContract: 2}} : {})}});
    });
    await stepUp.page.goto(origin + '/admin/security/verify-passcode?returnTo=%2Fadmin');
    await stepUp.page.getByRole('heading', {name: 'Verify your passcode'}).waitFor();
    stepUp.page.on('request', request => {
      const {pathname} = new URL(request.url());
      if (allowedAuth.has(pathname)) verificationRequests.push(pathname);
    });
    await stepUp.page.getByLabel('Four-digit passcode', {exact: true}).fill('0123');
    await stepUp.page.getByRole('button', {name: 'Verify passcode', exact: true}).click();
    await stepUp.page.getByRole('heading', {name: 'Home'}).waitFor();
    assert.deepEqual(verificationRequests, legacySessions ? [verifyPasscodePath, sessionPath] : [verifyPasscodePath]);
  } finally {
    await stepUp.context.close();
  }

  // The canonical financial table remains available while its scoped M-Money inbox is open.
  const nav = page.getByRole('navigation', {name: 'Admin sections'});
  assert.deepEqual(await nav.getByRole('link').allTextContents(), ['Home', 'Members', 'Payments']);
  assert.equal(await page.getByRole('searchbox', {name: 'Search admin sections'}).count(), 0);
  const payments = nav.getByRole('link', {name: 'Payments', exact: true});
  assert.equal(await payments.getAttribute('href'), '#/admin/payments');
  const paymentListResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === origin && url.pathname === '/api/admin/burimunsi/payments' &&
      url.searchParams.get('limit') === '100' && url.searchParams.get('offset') === '0';
  });
  await payments.click();
  assert.equal((await paymentListResponse).status(), 200);
  await page.getByRole('heading', {name: 'Payments', level: 1, exact: true}).waitFor();
  assert.equal(new URL(page.url()).hash, '#/admin/payments');
  assert.equal(await page.getByRole('navigation', {name: 'Payment views'}).count(), 0);
  const paymentTable = page.getByRole('table', {name: 'Payments', exact: true});
  const paymentRow = payment => paymentTable.getByRole('row').filter({has: page.getByRole('button', {name: payment.ftId, exact: true})});
  await paymentRow(fixturePayment).getByRole('cell', {name: 'Incoming', exact: true}).waitFor();
  await paymentRow(fixtureOutgoingPayment).getByRole('cell', {name: 'Outgoing', exact: true}).waitFor();
  await paymentTable.getByRole('button', {name: 'Filter Direction', exact: true}).click();
  const directionFilter = page.getByRole('dialog', {name: 'Filter Direction', exact: true});
  await directionFilter.getByRole('checkbox', {name: 'Outgoing', exact: true}).check();
  await directionFilter.getByRole('button', {name: 'Apply filter', exact: true}).click();
  await paymentRow(fixturePayment).waitFor({state: 'hidden'});
  await paymentRow(fixtureOutgoingPayment).waitFor();
  await page.getByRole('button', {name: 'Clear all filters', exact: true}).click();
  await paymentRow(fixturePayment).waitFor();
  const receiptInbox = page.getByRole('region', {name: 'M-Money SMS inbox', exact: true});
  const inboxToggle = receiptInbox.getByRole('button', {name: 'M-Money SMS', exact: true});
  assert.equal(await inboxToggle.getAttribute('aria-expanded'), 'false');
  await inboxToggle.click();
  await page.waitForURL(url => url.hash === '#/admin/payments?view=sms');
  const observationTable = receiptInbox.getByRole('region', {name: 'Android receiver observations', exact: true}).getByRole('table');
  await observationTable.waitFor();
  assert.equal(await inboxToggle.getAttribute('aria-expanded'), 'true');
  await paymentRow(fixturePayment).waitFor();
  await page.setViewportSize({width: 390, height: 844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const tableScroll = page.getByRole('region', {name: 'Payments table scroll area', exact: true});
  assert.equal(await tableScroll.evaluate(region => region.scrollWidth > region.clientWidth), true);
  await inboxToggle.click();
  await page.waitForURL(url => url.hash === '#/admin/payments');
  await observationTable.waitFor({state: 'hidden'});
  assert.equal(await inboxToggle.getAttribute('aria-expanded'), 'false');
  await paymentRow(fixtureOutgoingPayment).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({width: 1440, height: 900});
  await nav.getByRole('link', {name: 'Home', exact: true}).click();
  await overview.waitFor();

  // The demo reads are synthetic and confined to this authenticated fixture.
  await nav.getByRole('link', {name: 'Members', exact: true}).click();
  const memberSearch = page.getByLabel('Search Members', {exact: true});
  await memberSearch.waitFor();
  assert.equal(await page.getByRole('navigation', {name: 'Member directory views'}).count(), 0);
  const memberStatus = page.getByRole('combobox', {name: 'Status', exact: true});
  assert.deepEqual(await memberStatus.locator('option').allTextContents(), ['All statuses', 'Active', 'Inactive']);
  const inactiveRoster = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === origin && url.pathname === '/api/admin/core/members' &&
      url.searchParams.get('directory') === 'roster' && url.searchParams.get('status') === 'inactive' && response.ok();
  });
  await memberStatus.selectOption('inactive');
  await inactiveRoster;
  const inactiveRow = page.getByRole('row').filter({hasText: fixtureInactiveMember.display_name});
  await inactiveRow.getByRole('cell', {name: 'Inactive', exact:true}).waitFor();
  const memberRecords = page.getByRole('region', {name: 'Members records', exact: true});
  await memberRecords.getByRole('columnheader', {name: 'Mobile number', exact: true}).waitFor();
  const memberHeadings = await memberRecords.getByRole('columnheader').allTextContents();
  assert.deepEqual(memberHeadings.filter(name => /number|phone|WhatsApp/i.test(name)), ['Mobile number']);
  const scopedDetail = member => page.waitForResponse(response => response.url() === origin + '/api/admin/operations/members/' + member.id && response.ok());
  await Promise.all([scopedDetail(fixtureInactiveMember), inactiveRow.getByRole('button', {name:'View ' + fixtureInactiveMember.public_id}).click()]);
  await page.getByRole('heading', {name: 'Record details',exact:true}).waitFor();
  await page.getByText('Mobile number', {exact: true}).locator('+ dd').waitFor();
  const contactLabels = await page.locator('main dl dt').allTextContents();
  assert.deepEqual(contactLabels.filter(name => /number|phone|WhatsApp/i.test(name)), ['Mobile number']);
  assert.equal(await page.getByText('Status', {exact:true}).locator('+ dd').textContent(), 'Inactive');
  await page.getByRole('button', {name:'Back to members',exact:true}).click();
  assert.equal(await memberStatus.inputValue(), 'inactive');
  await memberStatus.selectOption('active');
  await page.getByRole('row').filter({hasText: fixtureMember.display_name}).waitFor();
  await memberSearch.fill('No synthetic member matches');
  await page.getByRole('button', {name: 'Search', exact: true}).click();
  await page.getByText('No records found', {exact: true}).waitFor();
  await memberSearch.fill(fixtureMember.display_name);
  await page.getByRole('button', {name: 'Search', exact: true}).click();
  const memberRow = page.getByRole('row').filter({hasText: fixtureMember.display_name});
  await Promise.all([scopedDetail(fixtureMember), memberRow.getByRole('button', {name: `View ${fixtureMember.public_id}`, exact: true}).click()]);
  await page.getByRole('heading', {name: 'Record details', exact: true}).waitFor();
  await page.getByText(fixtureMember.display_name, {exact: true}).waitFor();
  await page.getByRole('row').filter({hasText: 'Synthetic group'}).waitFor();
  await page.getByRole('button', {name: 'Back to members', exact: true}).click();
  assert.equal(await memberSearch.inputValue(), fixtureMember.display_name);
  const personBookmark = new URLSearchParams({search: fixtureMember.display_name, status:'active', sort: 'public_id_asc'});
  await page.goto(origin + '/#/admin/users?' + personBookmark);
  await page.waitForURL(url => url.hash === '#/admin/members?' + personBookmark);
  await page.getByRole('row').filter({hasText: fixtureMember.display_name}).waitFor();
  assert.equal(await memberSearch.inputValue(), fixtureMember.display_name);

  await nav.getByRole('link', {name: 'Payments', exact: true}).click();
  await page.getByRole('button', {name: 'Filter FT reference', exact: true}).click();
  const paymentFilter = page.getByRole('dialog', {name: 'Filter FT reference', exact: true});
  await paymentFilter.getByRole('searchbox', {name:'Contains', exact:true}).fill(fixturePayment.ftId);
  await paymentFilter.getByRole('button', {name:'Apply filter', exact:true}).click();
  assert.equal(await page.getByRole('button', {name: fixtureOutgoingPayment.ftId, exact:true}).count(), 0);
  await paymentRow(fixturePayment).getByRole('button', {name: 'Review linked SMS', exact: true}).click();
  const paymentDetail = page.getByRole('region', {name: 'Payment details', exact: true});
  await paymentDetail.getByText(fixturePayment.ftId, {exact: true}).waitFor();
  await paymentDetail.getByRole('region', {name:'Linked SMS', exact:true}).getByText('Parsed', {exact:true}).waitFor();
  await paymentDetail.getByText('Unallocated', {exact: true}).waitFor();
  await paymentDetail.getByRole('button', {name: 'Close', exact: true}).click();
  await paymentDetail.waitFor({state: 'hidden'});
  await page.getByRole('button', {name: 'Clear all filters', exact: true}).click();
  await paymentRow(fixtureOutgoingPayment).getByRole('button', {name: fixtureOutgoingPayment.ftId, exact: true}).click();
  await paymentDetail.getByText(fixtureOutgoingPayment.ftId, {exact: true}).waitFor();
  await paymentDetail.getByText('RWF 5,000', {exact: true}).waitFor();
  assert.equal(await paymentDetail.getByRole('region', {name:'Linked SMS', exact:true}).count(), 0);
  assert.equal(await paymentDetail.getByText(fixtureSmsEvidenceId, {exact: true}).count(), 0);
  await page.setViewportSize({width: 320, height: 640});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await paymentDetail.getByRole('button', {name: 'Close', exact: true}).click();
  await page.setViewportSize({width: 1440, height: 900});
  await nav.getByRole('link', {name: 'Home', exact: true}).click();
  await overview.waitFor();

  const receipts = requestUrl => requestUrl.origin === origin && requestUrl.pathname === '/api/admin/momo/observations' &&
    requestUrl.searchParams.get('limit') === '25';
  await desktop.context.route(receipts, route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'service_unavailable' } }),
  }), { times: 1 });
  assert.equal(await nav.getByRole('link', {name: 'SMS receipts', exact: true}).count(), 0);
  const failedReceipts = page.waitForResponse(response => receipts(new URL(response.url())) && response.status() === 503);
  await page.goto(origin + '/#/admin/sms-receipts');
  await page.waitForURL(url => url.hash === '#/admin/payments?view=sms');
  await page.getByRole('heading', { name: 'Payments', level: 1, exact: true }).waitFor();
  await failedReceipts;
  const retriedReceipts = page.waitForResponse(response => {
    const url = new URL(response.url());
    return receipts(url) && url.searchParams.get('collectionId') === fixturePayment.groupId &&
      url.searchParams.get('includeProcessing') === '1' && response.ok();
  });
  await receiptInbox.getByRole('button', {name: 'Try again', exact: true}).click();
  await retriedReceipts;
  const receiptRow = observationTable.getByRole('row').nth(1);
  await receiptRow.waitFor();
  const receiptCells = receiptRow.getByRole('cell');
  assert.match(await receiptCells.nth(1).innerText(), /\bParsed\b/);
  assert.equal(await observationTable.getByRole('columnheader', {name: 'Payment reference', exact: true}).count(), 0);
  await observationTable.getByRole('columnheader', {name: 'Payer SMS', exact: true}).waitFor();
  const receiptHeadings = await observationTable.getByRole('columnheader').allTextContents();
  const payerSmsCell = receiptCells.nth(receiptHeadings.indexOf('Payer SMS'));
  await payerSmsCell.filter({hasText: 'No receipt recorded'}).waitFor();
  await desktop.context.route(receipts, async route => {
    const response = await route.fetch();
    const pageData = await response.json();
    const [first, ...rest] = pageData.items;
    await route.fulfill({response, json: {...pageData, items: [{...first, payerStatus: 'delivered'}, ...rest]}});
  }, {times: 1});
  await receiptInbox.getByRole('button', {name: 'Refresh receiver', exact: true}).click();
  await payerSmsCell.filter({hasText: 'Reported delivered'}).waitFor();
  await page.setViewportSize({width: 320, height: 768});
  assert.equal(await receiptRow.evaluate((row) => getComputedStyle(row).display), 'grid');
  assert.match(await payerSmsCell.innerText(), /Payer SMS\s+Reported delivered/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({width: 1440, height: 900});
  await page.goBack();
  await overview.waitFor();

  const phoneTeamChecks = await qualifyPhoneTeam({admin: page, origin, open, legacySessions});

  const recovery = await open({ width: 1440, height: 900 }, 'block');
  await recovery.context.addCookies(cookies);
  const sessionPage = recovery.page;
  let nextSession = 'default';
  await recovery.context.route(sessionApi, async route => {
    const mode = nextSession;
    nextSession = 'default';
    if (mode === 'default') return route.fallback();
    if (mode === 'unavailable') return route.fulfill({ status: 503, json: { error: { code: 'service_unavailable' } } });
    // The role and grants alone cannot establish the current Admin's scope.
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ response, json: { ...body, adminIdentity: null } });
  });
  const protectedReads = [];
  sessionPage.on('request', request => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/admin/burimunsi/') || ['/api/admin/momo/native-setup', '/api/admin/core/groups'].includes(pathname)) protectedReads.push(pathname);
  });

  await sessionPage.goto(origin + '/admin/security/authenticator?' + new URLSearchParams({ returnTo: '/admin/burimunsi?draft=private' }));
  await sessionPage.getByRole('heading', { name: 'BuriMunsi access' }).waitFor();
  const loadAccess = sessionPage.getByRole('button', { name: 'Load BuriMunsi access', exact: true });
  await loadAccess.waitFor();
  assert.equal(new URL(sessionPage.url()).hash, '#/admin/burimunsi');

  nextSession = 'unattested';
  await sessionPage.reload();
  await sessionPage.getByRole('heading', { name: 'Access unavailable' }).waitFor();
  assert.equal(await loadAccess.count(), 0);

  nextSession = 'unavailable';
  await sessionPage.reload();
  await sessionPage.getByRole('heading', { name: 'Workspace unavailable' }).waitFor();
  assert.equal(await sessionPage.getByRole('heading', { name: 'BuriMunsi access' }).count(), 0);
  await sessionPage.getByRole('button', { name: 'Try again' }).click();
  await loadAccess.waitFor();

  const sessionRead = sessionPage.waitForResponse(response => sessionApi(new URL(response.url())));
  await sessionPage.goto(origin + '/admin/licenses');
  const { expiresAt } = await (await sessionRead).json();
  await sessionPage.getByRole('heading', { name: 'Open-source licenses' }).waitFor();
  // Advance only wall time, as on tab resume before the browser runs due timers.
  await sessionPage.clock.setSystemTime(new Date(Date.parse(expiresAt) + 1));
  await sessionPage.getByRole('button', {name: /^Account:/}).click();
  await sessionPage.getByRole('link', {name: 'Workspace', exact: true}).click();
  await sessionPage.getByRole('heading', { name: 'Welcome to BuriMunsi' }).waitFor();
  assert.equal(new URL(sessionPage.url()).hash, '#/admin/login?returnTo=%2Fadmin%2Fgroups');
  await sessionPage.goBack();
  await sessionPage.waitForURL(url => url.hash === '#/admin/login?returnTo=%2Fadmin%2Flicenses');
  assert.equal(await sessionPage.getByRole('heading', { name: 'Open-source licenses' }).count(), 0);
  assert.deepEqual(protectedReads, []);
  await recovery.context.close();

  const mobile = await open({ width: 390, height: 844 }, 'block');
  await mobile.page.goto(origin + '/admin/sms-receipts');
  await mobile.page.getByRole('heading', { name: 'Welcome to BuriMunsi' }).waitFor();
  assert(!decodeURIComponent(mobile.page.url()).includes('780000001'));
  assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await mobile.page.getByRole('heading', { name: 'Payments' }).count(), 0);

  await mobile.context.addCookies(cookies);
  await mobile.page.goto(origin + '/admin/sms-receipts');
  await mobile.page.getByRole('heading', { name: 'M-Money SMS', level: 2, exact: true }).waitFor();
  const openNavigation = mobile.page.getByRole('button', { name: 'Open navigation' });
  const closeNavigation = mobile.page.getByRole('button', { name: 'Close navigation' });
  await openNavigation.click();
  await closeNavigation.waitFor();
  assert.equal(await closeNavigation.evaluate(button => document.activeElement === button), true);
  assert.equal(await mobile.page.locator('.admin-main-column').evaluate(column => column.inert), true,
    'Background controls should be inert while the drawer is open.');
  await mobile.page.keyboard.press('Control+k');
  assert.equal(await closeNavigation.evaluate(button => document.activeElement === button), true);
  await mobile.page.keyboard.press('Escape');
  await openNavigation.waitFor();
  assert.equal(await openNavigation.evaluate(button => document.activeElement === button), true);
  await openNavigation.click();
  await mobile.page.setViewportSize({ width: 1024, height: 844 });
  await mobile.page.waitForFunction(() => !document.querySelector('.admin-main-column').inert);
  await mobile.page.getByRole('main').waitFor();
  await mobile.context.close();

  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('heading', { name: 'Welcome to BuriMunsi' }).waitFor();
  assert(!(await desktop.context.cookies(origin)).some(cookie => cookie.name === 'collect_fixture_session'));

  // Exercise an actual install with a separate browser context.
  const pwa = await open({ width: 1280, height: 800 }, 'allow');
  await pwa.page.goto(origin + '/');
  await pwa.page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated');
  // A first install waits for an existing tab to close. Reopen the app under
  // the installed scope, then require the worker to serve a bookmarked URL
  // with the browser offline.
  await pwa.page.close();
  const reopened = await pwa.context.newPage();
  reopened.on('pageerror', error => pageErrors.push(error.message));
  await reopened.goto(origin + '/?reopen=online');
  await reopened.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  // The first reopened document can begin loading while activation propagates.
  // A regular navigation from that document must enter the installed scope.
  if (!await reopened.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
    const controlledNavigation = reopened.waitForNavigation();
    await reopened.evaluate(next => location.assign(next), origin + '/?resume=fixture');
    await controlledNavigation;
  }
  await reopened.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  await pwa.context.setOffline(true);
  const offline = await reopened.goto(origin + '/admin?reopen=fixture');
  assert(offline?.fromServiceWorker() && offline.status() === 200, 'The installed worker must serve the offline bookmark.');
  await reopened.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  const cachedPaths = await reopened.evaluate(async () => {
    const names = await caches.keys();
    const requests = (await Promise.all(names.map(async name => (await caches.open(name)).keys()))).flat();
    return requests.map(request => new URL(request.url).pathname);
  });
  assert(cachedPaths.some(path => /^\/_build\/[0-9a-f]{64}\/assets\/admin-entry\.js$/.test(path)));
  assert(cachedPaths.every(path => path.startsWith('/_build/') || ['/', '/manifest.json', '/version.json'].includes(path)));
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(denied, []);
  assert.deepEqual(unexpectedAuth, []);
  assert.deepEqual(incorrectIdentityHeaders, []);
  const checks = ['missing_react_entry_retains_readable_static_notice', 'healthy_react_mount_replaces_static_notice', 'obsolete_password_route_returns_to_phone_sign_in', 'phone_passcode_sign_in_and_httponly_cookie', 'sign_in_with_expected_session_request_count', 'verification_with_expected_session_request_count', 'reload_restores_session', 'admin_home_reports_scoped_sms_health', 'retired_passcode_bookmark_returns_to_overview', 'three_daily_links_and_no_redundant_sidebar_search', 'canonical_payment_direction_filter_and_clear', 'inline_inbox_preserves_financial_table_and_390px_scroll', 'protected_sms_deep_link', 'filtered_member_detail_and_return', 'single_mobile_number_in_member_roster_and_detail', 'payment_details_link_to_authorized_sms_evidence', 'payment_without_source_and_320px_reflow', 'sms_read_failure_retry',
      'payer_sms_empty_and_reported_delivered', 'compact_receipt_cards', 'browser_back_restores_overview', 'fresh_mobile_deep_link_requires_sign_in',
      'retired_authenticator_bookmark_preserves_safe_destination', 'missing_scoped_admin_identity_removes_controls', 'session_failure_and_recovery_require_server_authority', 'expired_request_and_history_return_require_sign_in',
      'mobile_drawer_traps_and_restores_focus_and_reflows', 'sign_out_clears_fixture_cookie', 'installed_worker_caches_static_files_only', ...phoneTeamChecks, 'no_unexpected_auth_request', 'identity_version_only_on_session_exchanges'];
  console.log(JSON.stringify({status: 'pass', environment: 'synthetic_loopback', origin, count: checks.length, checks,
    sessionExchange: {mode: legacySessions ? 'legacy' : 'negotiated', signInRequests: loginRequests.length, verificationRequests: verificationRequests.length}}, null, 2));
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
  await exited;
}
