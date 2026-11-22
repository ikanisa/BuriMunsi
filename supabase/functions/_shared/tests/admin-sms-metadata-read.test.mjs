import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {accountDatabase} from '../domain/admin_accounts.js';
import {adminSmsMetadataRead} from '../domain/admin_sms_receipts.js';

const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

test('Incoming SMS metadata uses one authorized projection and preserves counts, order and source visibility', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const account = {
    id: uuid(1), principal_id: uuid(2), auth_user_id: uuid(3), auth_session_id: uuid(4),
    token_hash: 'a'.repeat(64), public_id: uuid(5), origin: 'https://fixture.invalid',
    auth_version: 1, role: 'staff', issued_assurance_level: 1, issued_mfa_at: null,
    issued_mfa_factor_id: null, permissions: ['sms.read'],
  };
  const reads = [];
  let allowed = true;
  const db = {
    prepare(sql) { return {sql, bind: (...args) => ({sql, args})}; },
    batch() { assert.fail('Receipt metadata entered a mutation transaction'); },
    async adminReadBatch(context, authority, statements) {
      assert.match(context.sql, /set_admin_email_context/);
      assert.match(authority.sql, /admin_sessions/);
      assert.ok(authority.args.includes('sms.read'));
      assert.equal(statements.length, 1);
      if (!allowed) throw Error('admin_account_authority');
      const [{sql, args}] = statements;
      reads.push(sql);
      return [{results: sqlite.prepare(sql).all(...args)}];
    },
  };
  const env = accountDatabase({DB: db}, account);
  const actor = {permissions: new Set(['sms.read'])};
  async function get(path, query = '') {
    const request = new Request(account.origin + '/api/admin/sms/' + path + query);
    return adminSmsMetadataRead(request, env, account, actor, path.split('/'), new URL(request.url));
  }
  try {
    sqlite.exec(`
      CREATE TABLE users(id TEXT PRIMARY KEY, public_id TEXT, full_name TEXT);
      CREATE TABLE sms_receipts(id TEXT PRIMARY KEY, owner_user_id TEXT, body_sha256 TEXT, status TEXT,
        evidence_level TEXT, received_at_device TEXT, created_at TEXT, originating_session_id TEXT);
    `);
    sqlite.prepare('INSERT INTO users VALUES (?,?,?)').run(account.principal_id, '123456', 'Test Operator');
    const insert = sqlite.prepare("INSERT INTO sms_receipts VALUES (?,?,?,'received','client_received',NULL,?,?)");
    for (const [n, date, session] of [[3, '01', 'managed'], [1, '02', 'managed'], [2, '02', 'managed'], [4, '03', null]]) {
      insert.run(uuid(n), account.principal_id, 'b'.repeat(64), '2026-11-' + date + 'T00:00:00.000Z', session);
    }
    const first = await get('receipts', '?limit=2&search=operator');
    assert.deepEqual(first.rows.map(row => row.id), [uuid(1), uuid(2)]);
    assert.equal(first.total, 3);
    assert.equal(first.next_offset, 2);
    const next = await get('receipts', '?limit=2&offset=2');
    assert.deepEqual(next.rows.map(row => row.id), [uuid(3)]);
    assert.equal(next.next_offset, null);
    const past = await get('receipts', '?offset=20');
    assert.equal(past.total, 3);
    assert.deepEqual(past.rows, []);
    const noMatches = await get('receipts', '?source_kind=receiver');
    assert.equal(noMatches.total, 0);
    assert.deepEqual(noMatches.rows, []);
    const detail = await get('receipts/capture/' + uuid(2));
    assert.deepEqual(detail.resource, first.rows[1]);
    await assert.rejects(get('receipts/capture/' + uuid(4)), {status: 404});
    assert.equal(reads.length, 6);
    allowed = false;
    await assert.rejects(get('receipts'), {status: 403});
    await assert.rejects(get('receipts/capture/' + uuid(1) + '/content'), {status: 403});
    assert.equal(reads.length, 6);
  } finally {
    sqlite.close();
  }
});
