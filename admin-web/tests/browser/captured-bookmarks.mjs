import assert from 'node:assert/strict';
import {fixtureMember, fixtureOutgoingPayment} from './operator-read-fixture.mjs';

// Each launch is delivered by Chromium to the same real installed app window.
export async function verifyCapturedBookmarks({app, origin, launchURL}) {
  const button = name => app.getByRole('button', {name, exact:true});
  const route = path => app.waitForURL(url => url.hash === '#' + path);
  const title = name => app.waitForFunction(expected => document.title === expected, name + ' · BuriMunsi Admin');
  const accepted = async (url, label) => {
    await launchURL(url);
    const notice = app.getByRole('region', {name:'Desktop shortcut'});
    await notice.getByRole('button', {name:'Open ' + label, exact:true}).waitFor();
    const copy = await notice.innerText();
    assert(!copy.includes(fixtureMember.id) && !copy.includes(fixtureOutgoingPayment.id) && !copy.includes('Unsubmitted'));
    await button('Open ' + label).click();
  };

  const list = '/admin/members?search=Synthetic%20member&status=active';
  const member = '/admin/members/' + fixtureMember.id;
  const nested = '?' + new URLSearchParams({returnTo:list});
  await launchURL(origin + list);
  await route(list);
  const search = app.getByLabel('Search Members', {exact:true});
  await search.waitFor();
  assert.equal(await search.inputValue(), 'Synthetic member');
  await title('Members');
  await accepted(origin + '/#' + member + nested, 'Member details');
  await route(member + nested);
  await app.getByRole('heading', {name:'Record details',exact:true}).waitFor();
  await title('Members');
  await accepted(origin + member + '/statement' + nested, 'Member statement');
  await route(member + '/statement' + nested);
  await app.getByRole('heading', {name:'Member statement',exact:true}).waitFor();
  await title('Members');

  await app.getByRole('navigation', {name:'Admin sections'}).getByRole('link', {name:'Members',exact:true}).click();
  await search.fill('Unsubmitted document fixture');
  for (const [path, label] of [['/privacy','Privacy and data use'], ['/privacy/account-deletion','Account deletion']]) {
    await launchURL(origin + path);
    const action = app.getByRole('link', {name:'Open ' + label + ' (opens in a new tab)'});
    await action.waitFor();
    assert.equal(await search.inputValue(), 'Unsubmitted document fixture');
    const [document] = await Promise.all([app.waitForEvent('popup'), action.click()]);
    try {
      await document.getByRole('heading', {name:label,exact:true,level:1}).waitFor();
      assert.equal(document.url(), origin + path);
    } finally {await document.close();}
    assert.equal(await search.inputValue(), 'Unsubmitted document fixture');
    await title('Members');
  }

  const canonical = '/admin/payments?payment=' + fixtureOutgoingPayment.id;
  await accepted(origin + '/admin/transactions/' + fixtureOutgoingPayment.id, 'Payment details');
  await route(canonical);
  await app.getByRole('region', {name:'Payment details'}).waitFor();
  await title('Payments');
  const filtered = '/admin/payments?direction=outgoing&status=unallocated';
  await accepted(origin + '/#' + filtered, 'Payments');
  await route(filtered);
  await accepted(origin + canonical, 'Payment details');
  await route(canonical);
  await app.getByRole('region', {name:'Payment details'}).waitFor();
  await title('Payments');
  for (const [path, label, heading] of [
    ['/admin/security','Account security','Account security'], ['/admin/admin-users','Team','Team access'],
    ['/admin/licenses','Open-source notices','Open-source licenses'],
  ]) {
    await accepted(origin + path, label);
    await route(path);
    await app.getByRole('heading', {name:heading,exact:true}).waitFor();
  }
  await app.getByRole('navigation',{name:'Admin sections'}).getByRole('link',{name:'Payments',exact:true}).click();
  await app.getByRole('heading',{name:'Payments',level:1,exact:true}).waitFor();
}
