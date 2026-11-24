import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {list,operatingDetail} from '../domain/admin_records.js';
import {operatingRead} from '../domain/admin_bridge.js';
import {coreSorts} from '../domain/admin_search.js';
import {createAdminReadDatabase} from '../domain/admin_read_database.js';

const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const date = '2026-11-11T00:00:00.000Z';

test('Admin directory counts active groups and filters member eligibility before pagination', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE users(id TEXT PRIMARY KEY, public_id TEXT, phone TEXT, email TEXT, full_name TEXT,
        member_type TEXT, momo_provider TEXT, momo_number TEXT, momo_pay_code TEXT, access_status TEXT,
        revision INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE admin_principal_links(user_id TEXT,admin_user_id TEXT);
      CREATE TABLE admin_users(id TEXT,role TEXT,status TEXT);
      CREATE TABLE collections(id TEXT PRIMARY KEY,status TEXT);
      CREATE TABLE memberships(user_id TEXT,collection_id TEXT,active INTEGER);
      CREATE TABLE ledger_entries(member_id TEXT,amount_minor INTEGER,collection_id TEXT);
    `);
    const people = db.prepare(`INSERT INTO users VALUES (?, ?, NULL, NULL, ?, ?, NULL, NULL,
      NULL, ?, 1, ?, ?)`);
    for (const [n, name, type, status] of [
      [1, 'Nadine', 'app', 'active'],
      [2, 'Noel', 'direct', 'active'],
      [3, 'Jeanne', 'app', 'active'],
      [4, 'Paul', 'operator', 'active'],
      [5, 'Marie', 'app', 'suspended'],
    ]) {
      people.run(uuid(n), String(n).padStart(6, '0'), name, type, status, date, date);
    }
    const groups = db.prepare('INSERT INTO collections VALUES (?, ?)');
    groups.run(uuid(11), 'active');
    groups.run(uuid(12), 'active');
    groups.run(uuid(13), 'archived');
    const memberships = db.prepare('INSERT INTO memberships VALUES (?, ?, ?)');
    for (const [person, group, active] of [[1, 11, 1], [1, 12, 1], [2, 13, 1], [3, 11, 0], [4, 11, 1], [5, 11, 1]]) {
      memberships.run(uuid(person), uuid(group), active);
    }
    const ledger = db.prepare('INSERT INTO ledger_entries VALUES (?, ?, ?)');
    ledger.run(uuid(1), 750, uuid(11));
    ledger.run(uuid(1), -250, uuid(11));

    const env = {DB: {
      prepare(sql) { return {bind(...args) { return {sql, args}; }}; },
      async batch(statements) {
        return statements.map(({sql, args}) => ({results:db.prepare(sql).all(...args)}));
      },
    }};
    const url = new URL('https://fixture.invalid/api/admin/core/members?sort=active_groups_desc&limit=1');
    const first = await list(env, 'members', url);
    assert.equal(first.total, 2);
    assert.deepEqual(first.rows.map(row => [row.id, row.active_groups, row.total_contributed_rwf]), [[uuid(1), 2, 500]]);

    url.searchParams.set('offset', '1');
    assert.deepEqual((await list(env, 'members', url)).rows.map(row => row.id), [uuid(5)]);
    url.searchParams.delete('offset');
    assert.equal((await list(env, 'members', url, {groupId:uuid(13)})).total, 0);
    assert.equal((await list(env, 'members', url, {groupId:uuid(11),activeOnly:true})).total, 1);
    url.searchParams.set('search', 'Marie with groups');
    assert.deepEqual((await list(env, 'members', url, {groupId:uuid(11)})).rows.map(row => row.id), [uuid(5)]);
    url.searchParams.set('search', 'without groups');
    assert.equal((await list(env, 'members', url)).total, 0);

    // Compare projected rows, including nullable keys, aggregates and the ID tie-breaker.
    for (const field of Object.keys(coreSorts.members)) {
      for (const direction of ['asc', 'desc']) {
        const params = new URLSearchParams({sort:field + '_' + direction,limit:'2',search:'with groups'});
        url.search = params.toString();
        const all = await list(env, 'members', url, {groupId:uuid(11)});
        assert.equal(all.total, 2);
        for (const offset of [1, 2, 2147483647]) {
          url.searchParams.set('offset', String(offset));
          url.searchParams.set('limit', '1');
          const page = await list(env, 'members', url, {groupId:uuid(11)});
          assert.equal(page.total, all.total);
          assert.deepEqual(page.rows, all.rows.slice(offset, offset + 1), field + '_' + direction);
        }
      }
    }
    // The phone-session roster includes inactive memberships and scopes money to the selected collection.
    ledger.run(uuid(1), 1000, uuid(12));
    const roster = query => list(env, 'members', new URL('https://fixture.invalid/?directory=roster' + query),
      {rosterGroupId:uuid(11)});
    const result = await roster('&sort=public_id_asc');
    assert.deepEqual(result.rows.map(row => [row.id, row.membership_status, row.account_status, row.active_groups, row.total_contributed_rwf]), [
      [uuid(1), 'active', 'active', 1, 500],
      [uuid(3), 'inactive', 'active', 0, 0],
      [uuid(5), 'active', 'suspended', 1, 0],
    ]);
    assert.equal(result.total, 3);
    const filtered = await roster('&status=active&sort=public_id_asc&limit=1&offset=1');
    assert.equal(filtered.total, 2);
    assert.equal(filtered.rows[0].id, uuid(5));
    assert.deepEqual((await roster('&search=status:inactive&sort=status_desc')).rows.map(row=>row.id), [uuid(3)]);
    assert.equal((await roster('&search=Noel')).total, 0);
    const actor={id:uuid(50),role:'staff',permissions:['users.read']};
    const detail=(id,scope)=>operatingDetail(env,actor,'members',uuid(id),new URL('https://fixture.invalid/'),{rosterGroupId:uuid(scope)});
    const inactive=await detail(3,11);
    assert.equal(inactive.resource.membership_status,'inactive');
    assert.equal(inactive.resource.status,'active');
    assert.deepEqual(inactive.related,{});
    assert.equal((await detail(1,11)).resource.total_contributed_rwf,500);
    assert.equal((await detail(1,12)).resource.total_contributed_rwf,1000);
    await assert.rejects(detail(3,12),{status:404,code:'not_found'});
    await assert.rejects(roster('&status=suspended'), {status:400,code:'invalid_filter'});
    await assert.rejects(roster('&directory=all'), {status:400,code:'invalid_filter'});
    await assert.rejects(roster('&group_id='+uuid(12)), {status:400,code:'invalid_filter'});
  } finally {
    db.close();
  }
});


test('Admin read projections execute only under their originating guard', async () => {
  const guarded = [];
  const database = {
    prepare(text) {
      return {text, bind: (...values) => ({text, values})};
    },
    async adminReadBatch(context, authority, statements) {
      guarded.push({context, authority, statements});
      return [{results: [{total: 1}]}];
    },
  };
  const fail = error => {throw error;};
  const first = createAdminReadDatabase(database, 'first session', 'users.read', fail);
  const other = createAdminReadDatabase(database, 'other session', 'users.read', fail);
  const page = first.prepare('SELECT id FROM fixture_directory WHERE status = ?').bind('active');

  assert.equal(page.all, undefined);
  assert.equal(page.first, undefined);
  await assert.rejects(other.batch([page]), /prepared in this Admin read scope/);
  assert.equal(guarded.length, 0);
  assert.deepEqual(await first.batch([page]), [{results: [{total: 1}]}]);
  assert.deepEqual(guarded, [{
    context: 'first session',
    authority: 'users.read',
    statements: [{text: 'SELECT id FROM fixture_directory WHERE status = ?', values: ['active']}],
  }]);
});

test('Admin lookups use the live read scope and filter only the applicable directory', async () => {
  const account = {
    id: uuid(1), principal_id: uuid(2), auth_user_id: uuid(3), auth_session_id: uuid(4),
    token_hash: 'a'.repeat(64), public_id: uuid(5), origin: 'https://fixture.invalid',
    auth_version: 1, role: 'staff', issued_assurance_level: 1, issued_mfa_at: null,
    issued_mfa_factor_id: null, permissions: ['collections.read', 'users.read', 'receivers.read'],
  };
  const reads = [];
  const env = {DB: {
    prepare(sql) {
      return {sql, bind: (...args) => ({sql, args})};
    },
    async adminReadBatch(context, authority, statements) {
      reads.push({context, authority, statements});
      return [{results: [{page_total: 0, id: null}]}];
    },
  }};
  const groupId = uuid(6);
  for (const [kind, group, permission, testWhere] of [
    ['groups', null, 'collections.read', sql => !sql.includes('member_type')],
    ['users', null, 'users.read', sql => sql.includes("member_type!='operator'")],
    ['members', groupId, 'users.read', sql => sql.includes('WHERE collection_id=? AND active=1')],
    ['payees', groupId, 'receivers.read', sql => sql.includes('group_id=?') && !sql.includes('member_type')],
  ]) {
    const url = new URL('/api/admin/operations/lookups', account.origin);
    url.searchParams.set('kind', kind);
    if (group) url.searchParams.set('group_id', group);
    const result = await operatingRead(new Request(url), env, account, ['lookups'], url);
    assert.deepEqual([result.kind, result.group_id, result.total, result.rows], [kind, group, 0, []]);
    const {context, authority, statements} = reads.at(-1);
    assert.equal(statements.length, 1);
    assert.deepEqual(context.args, [account.id, account.token_hash, account.origin, account.public_id]);
    assert.deepEqual(authority.args.slice(11, 13), [permission, permission]);
    assert.match(authority.sql, /FOR SHARE OF g,c/);
    assert.ok(statements.every(({sql}) => sql.includes("status='active'") && testWhere(sql)), kind);
    if (group) assert.ok(statements.every(({args}) => args.includes(groupId)), kind);
  }
  const request = suffix => new Request(new URL('/api/admin/operations/lookups?' + suffix, account.origin));
  let input = request('kind=members');
  await assert.rejects(operatingRead(input, env, account, ['lookups'], new URL(input.url)),
    {status: 400, code: 'invalid_filter'});
  input = request('kind=payees&group_id=' + groupId);
  await assert.rejects(operatingRead(input, env, {...account, permissions: []}, ['lookups'], new URL(input.url)),
    {status: 403, code: 'permission_required'});
  assert.equal(reads.length, 4);
});
