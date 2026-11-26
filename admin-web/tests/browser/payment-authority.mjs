import assert from 'node:assert/strict';
import {fixtureMember, fixturePayment} from './operator-read-fixture.mjs';

export async function qualifyPaymentAuthority({origin, open, staffPin, installed = false}) {
  const {page: initialPage, context} = await open({width:1280,height:800}, installed ? 'allow' : 'block');
  let page = initialPage;
  const api = '/api/admin/burimunsi/payments';
  const detail = api + '/' + fixturePayment.id;
  const heading = name => page.getByRole('heading', {name,exact:true});
  const button = name => page.getByRole('button', {name,exact:true});
  const isPath = path => url => url.origin === origin && url.pathname === path;
  const originalMarker = 'OLD-SYNTHETIC-RESPONSE';
  let requestKey;
  const receipts = [];
  const late = Promise.withResolvers(), delivered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const seenAfterSwitch = [];
  let holdNext = false, switched = false;
  try {
    if (installed) {
      await page.goto(origin + '/');
      await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated');
      await page.close();
      page = await context.newPage();
      await page.goto(origin + '/?f07=installed');
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
        const navigation = page.waitForNavigation();
        await page.evaluate(next => location.assign(next), origin + '/?f07=controlled');
        await navigation;
      }
      await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    }
    const oldRecord = page.getByRole('button', {name:fixturePayment.ftId, exact:true});
    await context.route(isPath(detail), route => route.fulfill({json:{...fixturePayment,canAllocate:true}}));
    await context.route(isPath(api + '/members'), route => route.fulfill({json:{items:[{id:fixtureMember.id,name:fixtureMember.display_name}],total:1}}));
    await context.route(isPath(detail + '/allocate'), route => {
      requestKey = route.request().headers()['idempotency-key'];
      return route.fulfill({status:503,json:{error:{code:'proxy_outcome_unknown'}}});
    });
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/allocation-receipt')) receipts.push(url.pathname);
      if (switched && (url.pathname.startsWith(api) || (requestKey && request.headers()['idempotency-key'] === requestKey))) seenAfterSwitch.push(url.pathname);
    });
    await context.route(isPath(api + '/analysis'), async route => {
      const shouldHold = holdNext;
      holdNext = false;
      const beforeSwitch = await route.fetch();
      const payload = await beforeSwitch.json();
      assert.equal(beforeSwitch.status(),200,'Expected the signed-in Admin’s Payments response.');
      const items = payload.items.map(row => row.id === fixturePayment.id ? {...row,canAllocate:true} : row);
      if (!shouldHold) return route.fulfill({response:beforeSwitch,json:{...payload,items}});
      late.resolve();
      await release.promise;
      // An aborted old request may already have lost its browser recipient.
      try {await route.fulfill({response:beforeSwitch,json:{...payload,items:items.map(row=>({...row,ftId:originalMarker}))}});}
      catch {assert.equal(route.request().method(),'POST');}
      finally {delivered.resolve();}
    });
    const signIn = async (number, pin) => {
      await heading('Welcome to BuriMunsi').waitFor();
      await page.getByLabel('Mobile number',{exact:true}).fill(number);
      await page.getByLabel('Four-digit passcode',{exact:true}).fill(pin);
      await button('Sign in').click();
    };
    if (!installed) await page.goto(origin + '/admin');
    await signIn('0780 000 001','0123');
    await heading('Home').waitFor();
    await page.getByRole('link',{name:'Payments',exact:true}).click();
    await oldRecord.click();
    await page.getByRole('link',{name:'Unallocated – allocate payment ' + fixturePayment.ftId,exact:true}).click();
    const dialog = page.getByRole('dialog',{name:'Allocate payment',exact:true});
    const paymentLink = page.url();
    assert.equal(new URLSearchParams(new URL(paymentLink).hash.split('?')[1]).get('payment'),fixturePayment.id);
    assert.equal(new URLSearchParams(new URL(paymentLink).hash.split('?')[1]).get('allocate'),fixturePayment.id);
    await dialog.getByRole('button',{name:'Select suggested member ' + fixtureMember.display_name,exact:true}).click();
    assert.equal(await dialog.getByRole('combobox',{name:'Member',exact:true}).inputValue(),fixtureMember.id);
    await dialog.getByRole('button',{name:'Review allocation',exact:true}).click();
    await dialog.getByRole('button',{name:'Confirm allocation',exact:true}).click();
    await heading('Original allocation request').waitFor();
    assert.match(requestKey,/^[0-9a-f-]{36}$/);
    await page.getByText(requestKey,{exact:true}).waitFor();
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
    await dialog.waitFor({state:'hidden'});
    holdNext = true;
    await button('Refresh').click();
    await Promise.race([late.promise, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('No held Admin Payments read')), 10000);
      timer.unref();
    })]);
    await page.getByRole('button',{name:/^Account:/}).click();
    await button('Sign out').click();
    await heading('Welcome to BuriMunsi').waitFor();
    assert(!(await context.cookies(origin)).some(cookie=>cookie.name==='collect_fixture_session'));
    switched = true;
    await signIn('0780 000 003',staffPin);
    await page.getByRole('button',{name:/^Account:/}).waitFor();
    release.resolve();
    await delivered.promise;
    const noExposure = async () => {
      assert.equal(await page.getByText(originalMarker,{exact:true}).count(),0);
      assert.equal(await oldRecord.count(),0);
      assert.equal(await page.getByText(requestKey,{exact:true}).count(),0);
      assert.equal(await heading('Original allocation request').count(),0);
      assert(!page.url().includes(requestKey));
    };
    await noExposure();
    await page.evaluate(link => {location.hash = new URL(link).hash;},paymentLink);
    await heading('Access unavailable').waitFor();
    await noExposure();
    await page.goBack();
    await page.getByRole('button',{name:/^Account:/}).waitFor();
    await noExposure();
    await page.goForward();
    await heading('Access unavailable').waitFor();
    await noExposure();
    assert.deepEqual(seenAfterSwitch,[]);
    assert.deepEqual(receipts,[]);
    const reopened = await context.newPage();
    const reopenedReads = [];
    reopened.on('request', request => {
      const target = new URL(request.url());
      if (target.pathname.startsWith(api) || request.headers()['idempotency-key'] === requestKey) reopenedReads.push(target.pathname);
    });
    await reopened.goto(paymentLink);
    await reopened.getByRole('heading',{name:'Access unavailable',exact:true}).waitFor();
    assert.equal(await reopened.getByText(requestKey,{exact:true}).count(),0);
    assert.equal(await reopened.getByText(originalMarker,{exact:true}).count(),0);
    assert.equal(await reopened.getByRole('button',{name:fixturePayment.ftId,exact:true}).count(),0);
    assert.deepEqual(reopenedReads,[]);
    if (installed) {
      assert(await reopened.evaluate(()=>navigator.serviceWorker.controller !== null));
    }
    await reopened.close();
    if (installed) {
      const cachePaths = await page.evaluate(async () => {
        const keys = await caches.keys();
        return (await Promise.all(keys.map(async key => (await caches.open(key)).keys())))
          .flat().map(request => new URL(request.url).pathname);
      });
      assert(cachePaths.length > 0);
      assert(cachePaths.every(path => !path.startsWith('/api/')));
    }
  } finally {
    release.resolve();
    await context.close();
  }
  return ['late_payments_read_and_original_request_not_visible_to_next_identity_or_history' + (installed ? '_with_installed_worker' : '')];
}
