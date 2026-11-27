import assert from 'node:assert/strict';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';
import {BURIMUNSI_ADMIN_ORIGIN} from '../../../supabase/functions/_shared/burimunsi-standalone.js';
import {standalonePrivacySupport} from '../../../supabase/functions/_shared/burimunsi-privacy-support.js';
import {burimunsiSupport} from '../../../supabase/functions/_shared/burimunsi-support.js';

const args = process.argv.slice(2);
assert(args.length === 0 || args.length === 1 && args[0] === '--hosted', 'Use --hosted to verify the public release.');
const hosted = args.includes('--hosted');
const path = '/privacy/account-deletion';
let server, browser;
const cases = [];
try {
  let origin = BURIMUNSI_ADMIN_ORIGIN;
  if (!hosted) {
    server = createServer(async (req, res) => {
      const url = new URL(req.url, BURIMUNSI_ADMIN_ORIGIN);
      const response = standalonePrivacySupport(new Request(url, {method: req.method})) ?? new Response(null, {status: 404});
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  const executablePath = process.env.ADMIN_PWA_CHROME || chromium.executablePath();
  browser = await chromium.launch(existsSync(executablePath) ? {executablePath} : {channel: 'chrome'});
  for (const width of [320, 1280]) {
    const context = await browser.newContext({viewport: {width, height: 800}, serviceWorkers: 'block'});
    const page = await context.newPage();
    let handoffs = 0;
    const unexpected = [];
    await context.route('**/*', async route => {
      const req = route.request();
      if (req.url() === burimunsiSupport.url && req.isNavigationRequest() && req.method() === 'GET') {
        assert.equal(await req.headerValue('referer'), null);
        handoffs++;
        return route.fulfill({contentType: 'text/plain', body: 'Synthetic support hand-off'});
      }
      const url = new URL(req.url());
      if (url.origin === origin && req.method() === 'GET' && ['/privacy', path, path + '/assets/style.css', '/favicon.ico'].includes(url.pathname)) {
        return route.continue();
      }
      unexpected.push({method: req.method(), type: req.resourceType()});
      return route.abort();
    });
    const response = await page.goto(origin + path);
    assert.equal(response.status(), 200);
    assert.match(response.headers()['cache-control'], /no-store/);
    const main = page.getByRole('main');
    await main.getByRole('heading', {name: 'Account deletion', level: 1}).waitFor();
    const content = await main.innerText();
    assert.match(content, /account stays accessible/i);
    assert.match(content, /financial records must be retained/i);
    assert.match(content, /passcode and identity documents private/i);
    assert.equal(await main.locator('form, input, script').count(), 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    const notice = main.getByRole('link', {name: 'How BuriMunsi uses your data'});
    let dataUse = '';
    if (await notice.count()) {
      const [response] = await Promise.all([page.waitForResponse(origin + '/privacy'), notice.click()]);
      assert.equal(response.headers()['x-collect-document'], 'burimunsi.privacy.notice.v1');
      await main.getByRole('heading', {name: 'Privacy and data use', level: 1}).waitFor();
      dataUse = await main.innerText();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await main.getByRole('link', {name: 'request account deletion'}).click();
      await main.getByRole('heading', {name: 'Account deletion', level: 1}).waitFor();
    }
    const disclosure = {
      eligibleSmsAndStorage: /eligible M-Money messages to Supabase/.test(dataUse),
      staffAndAuditedAdmin: /records the reason for that access\. Staff cannot read original messages/.test(dataUse),
      photoProcessorAndReview: /image to OpenAI to extract names and mobile numbers/.test(dataUse) && /before saving/.test(dataUse),
      explicitSend: /Send a message asking for account deletion/.test(content),
    };
    const link = main.getByRole('link', {name: /Contact support on WhatsApp/});
    assert.equal(await link.getAttribute('href'), burimunsiSupport.url);
    await link.focus();
    await Promise.all([page.waitForURL(burimunsiSupport.url), page.keyboard.press('Enter')]);
    assert.equal(handoffs, 1);
    assert.deepEqual(unexpected, []);
    cases.push({width, handoffIntercepted: true, sentRequestsToSupport: 0, disclosure});
    await context.close();
  }
  console.log(JSON.stringify({target: hosted ? 'published' : 'candidate', cases}));
  assert(cases.every(entry => Object.values(entry.disclosure).every(Boolean)), 'The page is missing a disclosure listed in the receipt.');
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
