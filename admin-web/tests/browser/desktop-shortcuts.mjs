import assert from 'node:assert/strict';
import {fixtureMember, fixtureOutgoingPayment} from './operator-read-fixture.mjs';

// Drive the window's LaunchQueue contract through the compiled application.
// Actual installation and OS shortcut delivery are separate browser checks.
export async function qualifyDesktopShortcuts({origin, open, staffPin}) {
  const viewport = {width: 1280, height: 850};
  const {page, context} = await open(viewport, 'block');
  const checks = [];
  const heading = name => page.getByRole('heading', {name, exact: true});
  const button = name => page.getByRole('button', {name, exact: true});
  const nav = page.getByRole('navigation', {name: 'Admin sections'});
  const section = name => nav.getByRole('link', {name, exact: true});
  const send = target => page.evaluate(url => window.deliverDesktopLaunch(url), target);
  const launch = path => send(origin + '/#' + path);
  const focused = control => control.evaluate(element => element === document.activeElement);
  const reads = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/admin/burimunsi/') || path.startsWith('/api/admin/operations/members') ||
        path.startsWith('/api/admin/team')) reads.push(path);
  });
  try {
    await context.addInitScript(() => {
      let consumer;
      Object.defineProperty(window, 'launchQueue', {configurable: true, value: {
        setConsumer(callback) {consumer = callback;},
      }});
      window.deliverDesktopLaunch = targetURL => consumer({targetURL});
    });
    await page.goto(origin + '/#/admin/members');
    await heading('Welcome to BuriMunsi').waitFor();
    const phone = page.getByLabel('Mobile number', {exact: true});
    const pin = page.getByLabel('Four-digit passcode', {exact: true});
    await phone.fill('0780 000 001');
    await pin.fill('0123');
    await send(origin + '/');
    await launch('/admin/payments');
    await page.waitForURL(url => url.hash === '#/admin/login?returnTo=%2Fadmin%2Fpayments');
    assert(await focused(pin));
    assert.equal(await phone.inputValue(), '0780 000 001');
    assert.equal(await pin.inputValue(), '0123');
    await launch('/admin/members');
    await page.waitForURL(url => url.hash === '#/admin/login?returnTo=%2Fadmin%2Fmembers');
    assert.deepEqual(reads, []);
    await pin.press('Enter');
    await heading('Members').waitFor();
    checks.push('cold_shortcut_and_warm_login_return_preserve_typed_form_and_session_guard');

    await section('Members').press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'main-content');
    await section('Members').focus();
    await page.keyboard.press('Tab');
    assert(await focused(section('Payments')));
    await page.keyboard.press('Enter');
    await heading('Payments').waitFor();
    assert(await focused(page.getByRole('main')));
    await page.goBack();
    await heading('Members').waitFor();
    await page.goForward();
    await heading('Payments').waitFor();
    await page.reload();
    await heading('Payments').waitFor();
    checks.push('desktop_tab_enter_moves_focus_to_workspace_and_browser_history_survives_reload');

    await launch('/admin/members');
    await heading('Members').waitFor();
    const search = page.getByRole('textbox', {name:'Search Members'});
    await search.fill('Unsubmitted fixture');
    await send(origin + '/');
    await launch('/admin/members');
    await send('https://unrelated.example/#/admin');
    await launch('/admin/security/verify-passcode');
    assert.equal(await search.inputValue(), 'Unsubmitted fixture');
    assert(await focused(search));
    assert.equal(await button('Dismiss').count(), 0);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await launch('/admin/payments');
    await launch('/admin/payments');
    assert.equal(await button('Open Payments').count(), 1);
    assert(await page.getByRole('region', {name:'Desktop shortcut'}).evaluate(notice => {
      const area = notice.getBoundingClientRect();
      return area.top >= 0 && area.bottom <= innerHeight;
    }));
    assert(await focused(search));
    await button('Dismiss').press('Enter');
    assert(await focused(search));
    assert.equal(await search.inputValue(), 'Unsubmitted fixture');
    await launch('/admin');
    await button('Open Home').press('Enter');
    await heading('Home').waitFor();
    checks.push('idle_shortcut_opens_and_pending_explicit_shortcut_preserves_draft_until_keyboard_choice');

    await page.setViewportSize({width:390,height:844});
    const menu = button('Open navigation');
    await menu.press('Enter');
    await button('Close navigation').waitFor();
    await page.keyboard.press('Escape');
    assert(await focused(menu));
    await menu.press('Enter');
    await section('Payments').press('Enter');
    await heading('Payments').waitFor();
    assert(await focused(page.getByRole('main')));
    await menu.press('Enter');
    await section('Payments').press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'main-content');
    assert.equal(await menu.getAttribute('aria-expanded'), 'false');
    checks.push('compact_keyboard_navigation_restores_trigger_on_escape_and_focuses_destination_on_enter');

    await page.setViewportSize(viewport);
    await page.getByRole('button', {name:/^Account:/}).click();
    await button('Sign out').click();
    await heading('Welcome to BuriMunsi').waitFor();
    if (staffPin) {
      await send(origin + '/admin/payments?payment=' + fixtureOutgoingPayment.id);
      await phone.fill('0780 000 003');
      await pin.fill(staffPin);
      reads.length = 0;
      await pin.press('Enter');
      await heading('Access unavailable').waitFor();
      const member = '/admin/members/' + fixtureMember.id;
      await launch(member);
      await page.getByRole('button', {name:'Open Member details',exact:true}).click();
      await page.waitForURL(url => url.hash === '#' + member);
      await heading('Access unavailable').waitFor();
      assert.deepEqual(reads, []);
      assert.equal(await section('Payments').count(), 0);
      assert.equal(await section('Members').count(), 0);
      await launch('/admin/admin-users');
      await button('Open Team').click();
      await page.waitForURL(url => url.hash === '#/admin/admin-users');
      await heading('Access unavailable').waitFor();
      assert.deepEqual(reads, []);
      checks.push('restricted_staff_cold_and_warm_shortcuts_do_not_fetch_private_records');
    }
    return checks;
  } finally {
    await context.close();
  }
}
