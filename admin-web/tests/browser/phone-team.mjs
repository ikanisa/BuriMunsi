import assert from 'node:assert/strict';
import { fixtureInitialPasscode } from './phone-account-fixture.mjs';

// Exercise the compiled application and its HTTP contract through isolated browser sessions.
export async function qualifyPhoneTeam({admin, origin, open, legacySessions}) {
  const checks = [];
  const number = '0780 000 003', phone = '+250780000003', name = 'Fixture phone teammate', changedPin = '7391';
  const endpoint = path => origin + '/api/admin/' + path;
  const teamUrl = origin + '/admin/admin-users';
  const heading = (page, title) => page.getByRole('heading', {name: title, exact: true});
  const button = (page, title) => page.getByRole('button', {name: title, exact: true});
  const targetRow = admin.getByRole('row').filter({hasText: name});
  async function submit(page, title, path, status = 200) {
    const [response] = await Promise.all([
      page.waitForResponse(response => response.url() === endpoint(path) && response.request().method() === 'POST'),
      button(page, title).click(),
    ]);
    assert.equal(response.status(), status, path);
    return response;
  }
  async function signIn(page, pin, status = 200) {
    await page.getByLabel('Mobile number', {exact: true}).fill(number);
    await page.getByLabel('Four-digit passcode', {exact: true}).fill(pin);
    const response = await submit(page, 'Sign in', 'auth/phone-passcode', status);
    assert.deepEqual(response.request().postDataJSON(), {phone, pin});
    assert.equal(await response.request().headerValue('x-collect-owner-identity-version'), '1');
    if (status === 200) {
      assert.equal((await response.json()).sessionContract, legacySessions ? undefined : 2);
    } else {
      await page.getByText('Check your mobile number and passcode.', {exact: true}).waitFor();
    }
  }
  async function accountReceipt(title, path, expectedBody, version) {
    const response = await submit(admin, title, path);
    const body = response.request().postDataJSON(), requestId = body.requestId;
    assert.match(requestId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(body, {...expectedBody, requestId});
    assert.equal(await response.request().headerValue('idempotency-key'), requestId);
    assert.match(await response.request().headerValue('x-collect-csrf'), /^[a-f0-9]{64}$/);
    const receipt = await response.json();
    assert.deepEqual(receipt, {applied: true, id: receipt.id, version});
    assert.match(receipt.id, /^[0-9a-f-]{36}$/);
    return receipt.id;
  }
  await admin.goto(teamUrl);
  await heading(admin, 'Team access').waitFor();
  const permissions = heading(admin, 'Role permissions');
  await permissions.waitFor();
  const matrix = permissions.locator('..');
  assert.deepEqual(await matrix.getByRole('heading', {level: 3}).allTextContents(), ['Admin', 'Staff']);
  assert.equal(await admin.getByRole('button', {name: /invite|verif/i}).count(), 0);
  const adminRow = admin.getByRole('row').filter({has: admin.getByRole('cell', {name: 'Admin', exact: true})});
  assert.equal(await adminRow.count(), 1);
  assert.equal(await adminRow.getByRole('button', {name: /^Manage /}).count(), 0);
  checks.push('team_displays_admin_without_access_controls');

  await button(admin, 'Create account').click();
  await admin.getByLabel('Name', {exact: true}).fill(name);
  await admin.getByLabel('Mobile number').fill(number);
  assert.equal(await admin.getByLabel('Role', {exact: true}).count(), 0);
  await admin.getByText('Role: Staff', {exact: true}).waitFor();
  assert.equal(await admin.getByLabel(/passcode|email|whatsapp/i).count(), 0);
  await button(admin, 'Review account').click();
  const id = await accountReceipt('Confirm account creation', 'team/accounts', {displayName: name, phone, role: 'staff'}, 1);
  await targetRow.getByRole('cell', {name: 'Staff', exact: true}).waitFor();
  await targetRow.getByRole('cell', {name: 'Active', exact: true}).waitFor();
  checks.push('admin_creates_staff_with_configured_initial_passcode');

  const staff = await open({width: 1280, height: 800}, 'block');
  const staffPage = staff.page;
  try {
    await staffPage.goto(origin + '/admin');
    await signIn(staffPage, fixtureInitialPasscode);
    await heading(staffPage, 'Home').waitFor();
    assert.equal(await staffPage.getByRole('region', {name: 'SMS processing status'}).count(), 0);
    await staffPage.goto(teamUrl);
    await heading(staffPage, 'Access unavailable').waitFor();
    assert.equal(await button(staffPage, 'Create account').count(), 0);
    checks.push('staff_signs_in_directly_and_cannot_manage_team');
    const withheld = await staffPage.evaluate(async () => {
      const requests = ['/api/admin/core/members?directory=roster&limit=25&offset=0',
        '/api/admin/burimunsi/payments?limit=100&offset=0', '/api/admin/momo/observations?collectionId=fixture-group&limit=25&includeProcessing=1'];
      return Promise.all(requests.map(async path => (await fetch(path)).status));
    });
    assert.deepEqual(withheld, [403, 403, 403]);
    await staffPage.goto(origin + '/admin/payments?view=sms');
    await heading(staffPage, 'Access unavailable').waitFor();
    assert.equal(await staffPage.getByRole('table').count(), 0);
    checks.push('staff_without_grants_cannot_read_scoped_members_payments_or_sms');

    await staffPage.goto(origin + '/admin/security/verify-email?returnTo=%2Fadmin%2Fsecurity');
    await heading(staffPage, 'Account security').waitFor();
    assert.equal(new URL(staffPage.url()).hash, '#/admin/security');
    await staffPage.getByLabel('Current passcode', {exact: true}).fill(fixtureInitialPasscode);
    await staffPage.getByLabel('New passcode', {exact: true}).fill(changedPin);
    await staffPage.getByLabel('Confirm new passcode', {exact: true}).fill(changedPin);
    const changed = await submit(staffPage, 'Change passcode', 'auth/passcode/change');
    assert.deepEqual(changed.request().postDataJSON(), {current: fixtureInitialPasscode, newPin: changedPin, confirm: changedPin});
    await heading(staffPage, 'Welcome to BuriMunsi').waitFor();
    assert(!(await staff.context.cookies(origin)).some(cookie => cookie.name === 'collect_fixture_session'));
    await signIn(staffPage, fixtureInitialPasscode, 401);
    await signIn(staffPage, changedPin);
    await staffPage.getByRole('button', {name: /^Account:/}).waitFor();
    checks.push('optional_personal_passcode_change_rejects_old_and_accepts_new');

    const accessPath = `team/accounts/${id}/access`;
    await targetRow.getByRole('button', {name: `Manage ${name}`}).click();
    assert.equal(await admin.getByLabel('Role', {exact: true}).count(), 0);
    await admin.getByText('Role: Staff', {exact: true}).waitFor();
    assert.equal(await admin.getByRole('option', {name: 'Admin', exact: true}).count(), 0);
    await button(admin, 'Review account').click();
    await admin.getByRole('status').filter({hasText: 'Choose a different access status.'}).waitFor();
    assert.equal(await button(admin, 'Confirm access change').count(), 0);
    checks.push('staff_access_cannot_promote_or_change_role');

    await admin.getByLabel('Access', {exact: true}).selectOption('disabled');
    await button(admin, 'Review account').click();
    assert.equal(await accountReceipt('Confirm access change', accessPath, {expectedVersion: 1, role: 'staff', active: false}, 2), id);
    await targetRow.getByRole('cell', {name: 'Disabled', exact: true}).waitFor();
    await staffPage.reload();
    await heading(staffPage, 'Welcome to BuriMunsi').waitFor();
    await signIn(staffPage, changedPin, 401);
    assert.equal(await button(staffPage, 'Create account').count(), 0);
    checks.push('disabled_account_loses_session_and_cannot_sign_in');

    await targetRow.getByRole('button', {name: `Manage ${name}`}).click();
    await admin.getByLabel('Access', {exact: true}).selectOption('active');
    await button(admin, 'Review account').click();
    assert.equal(await accountReceipt('Confirm access change', accessPath, {expectedVersion: 2, role: 'staff', active: true}, 3), id);
    await targetRow.getByRole('cell', {name: 'Staff', exact: true}).waitFor();
    await targetRow.getByRole('cell', {name: 'Active', exact: true}).waitFor();
    await signIn(staffPage, changedPin);
    await heading(staffPage, 'Home').waitFor();
    checks.push('reenabled_staff_can_sign_in_without_promotion');
  } finally {
    await staff.context.close();
  }
  await admin.goto(origin + '/admin');
  await heading(admin, 'Home').waitFor();
  return checks;
}
