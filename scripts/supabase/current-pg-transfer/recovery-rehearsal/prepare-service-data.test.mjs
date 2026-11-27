import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import pg from '../../node_modules/pg/lib/index.js';
import {startOwnedPg17} from '../test-support/owned-pg17.mjs';

const sql = await readFile(new URL('prepare-service-data.sql', import.meta.url), 'utf8');

async function openFixture(t, clusterName) {
  const cluster = await startOwnedPg17({
    prefix: 'collect-pg-transfer-',
    initialUser: 'collect_fixture',
    clusterName,
  });
  const db = new pg.Client({
    host: cluster.socket,
    port: cluster.port,
    database: 'postgres',
    user: cluster.initialUser,
  });
  t.after(async () => {
    try {
      await db.end();
    } finally {
      await cluster.close();
    }
  });
  await db.connect();
  return db;
}

test('prepare a typed Payments and Auth service restore', async t => {
  const db = await openFixture(t, 'burimunsi_isolated_recovery');
  await db.query(`
    CREATE SCHEMA burimunsi;
    CREATE SCHEMA auth;
    CREATE TABLE burimunsi.payments (id text, member_id text);
    CREATE TABLE auth.refresh_tokens (id bigserial PRIMARY KEY);
    INSERT INTO burimunsi.payments VALUES ('first', NULL), ('second', 'member');
    INSERT INTO auth.refresh_tokens (id) VALUES (1), (7);
  `);

  async function insertRefreshToken() {
    const result = await db.query('INSERT INTO auth.refresh_tokens DEFAULT VALUES RETURNING id');
    return result.rows[0].id;
  }

  await t.test('derive allocation from retained members and advance past copied identities', async () => {
    await db.query(sql);
    await db.query(sql);
    const payments = await db.query('SELECT allocation_state FROM burimunsi.payments ORDER BY id');
    assert.deepEqual(payments.rows.map(row => row.allocation_state), ['unallocated', 'allocated']);

    const changed = await db.query(`
      UPDATE burimunsi.payments SET member_id = 'member'
      WHERE id = 'first' RETURNING allocation_state
    `);
    assert.equal(changed.rows[0].allocation_state, 'allocated');
    assert.equal(await insertRefreshToken(), '8');
  });

  await t.test('preserve higher sequence positions for both called and uncalled values', async () => {
    await db.query("SELECT setval(pg_get_serial_sequence('auth.refresh_tokens', 'id'), 101, true)");
    await db.query(sql);
    assert.equal(await insertRefreshToken(), '102');

    await db.query("SELECT setval(pg_get_serial_sequence('auth.refresh_tokens', 'id'), 205, false)");
    await db.query(sql);
    assert.equal(await insertRefreshToken(), '205');
  });

  await t.test('refuse a previously exhausted sequence even when the largest imported ID is lower', async () => {
    await db.query("SELECT setval(pg_get_serial_sequence('auth.refresh_tokens', 'id'), 9223372036854775807, true)");
    await assert.rejects(db.query(sql), /recovered_refresh_token_sequence_exhausted/);
    await db.query('ROLLBACK');
  });

  await t.test('keep the first identity available on an empty restored table', async () => {
    await db.query('TRUNCATE auth.refresh_tokens RESTART IDENTITY');
    await db.query(sql);
    await db.query(sql);
    const position = await db.query('SELECT last_value, is_called FROM auth.refresh_tokens_id_seq');
    assert.deepEqual(position.rows[0], {last_value: '1', is_called: false});
    assert.equal(await insertRefreshToken(), '1');
  });

  await t.test('refuse an incompatible generated expression or an ordinary allocation column', async () => {
    await db.query(`
      ALTER TABLE burimunsi.payments DROP COLUMN allocation_state;
      ALTER TABLE burimunsi.payments ADD COLUMN allocation_state text
        GENERATED ALWAYS AS ('allocated'::text) STORED;
    `);
    await assert.rejects(db.query(sql), /recovered_allocation_expression_changed/);
    await db.query('ROLLBACK');

    await db.query(`
      ALTER TABLE burimunsi.payments DROP COLUMN allocation_state;
      ALTER TABLE burimunsi.payments ADD COLUMN allocation_state text;
    `);
    await assert.rejects(db.query(sql), /recovered_allocation_expression_changed/);
    await db.query('ROLLBACK');
  });

  await t.test('roll back the allocation repair if Auth lacks an owned sequence', async () => {
    await db.query(`
      ALTER TABLE burimunsi.payments DROP COLUMN allocation_state;
      DROP TABLE auth.refresh_tokens;
      CREATE TABLE auth.refresh_tokens (id bigint PRIMARY KEY);
    `);
    await assert.rejects(db.query(sql), {code: 'P0002'});
    await db.query('ROLLBACK');
    const fields = await db.query(`
      SELECT count(*)::int AS total FROM pg_attribute
      WHERE attrelid = 'burimunsi.payments'::regclass
        AND attname = 'allocation_state' AND NOT attisdropped
    `);
    assert.equal(fields.rows[0].total, 0);
  });
});

test('refuse a different cluster before touching any relation', async t => {
  const db = await openFixture(t, 'collect_synthetic_fixture');
  await assert.rejects(db.query(sql), /isolated_service_restore_required/);
  await db.query('ROLLBACK');
});
