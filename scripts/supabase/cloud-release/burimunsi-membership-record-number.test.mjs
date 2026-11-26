import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import pg from '../node_modules/pg/lib/index.js';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';
import {membershipSql, scopedMembershipRow} from '../../../supabase/functions/_shared/domain/admin_record_sources.js';

const migration = name => readFile(new URL('../../../supabase/migrations/' + name, import.meta.url), 'utf8');
const [baseline, sql] = await Promise.all([
  migration('20261020134444_collect_curated_platform_baseline.sql'),
  migration('20261124130000_burimunsi_membership_record_number.sql'),
]);
const originalColumns = ['id', 'collection_id', 'user_id', 'role', 'active', 'joined_at', 'revision'];
const catalog = {application:{memberships:{columns:originalColumns, subject:'user_id = subject_id'},
  unrelated:{columns:['id'], subject:'collection_id = subject_id'}}, private_classes:[], copy_classes:[]};
const insert = `INSERT INTO app.memberships(id,collection_id,user_id,role,active,joined_at,revision)
  VALUES ($1,$2,$3,'member',1,'2026-11-26T00:00:00.000Z',1) RETURNING membership_record_number`;

test('membership numbers preserve old writers and scope while rejecting reassignment and forged identities', async t => {
  const fixture = await startOwnedPg17({prefix:'collect-pg-transfer-', initialUser:'fixture_bootstrap'});
  const clients = [];
  const connect = async () => {
    const db = new pg.Client({host:fixture.socket, port:fixture.port, database:'postgres', user:fixture.initialUser});
    clients.push(db); await db.connect(); return db;
  };
  t.after(async () => {
    try { await Promise.all(clients.map(db => db.end())); }
    finally { assert.equal((await fixture.close()).removed, true); }
  });
  const owner = await connect();
  const table = baseline.split('\n').find(line => line.startsWith('CREATE TABLE memberships '));
  assert.ok(table);
  await owner.query(`
    CREATE ROLE postgres; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE ROLE collect_importer; CREATE ROLE collect_runtime;
    CREATE SCHEMA app AUTHORIZATION postgres; CREATE SCHEMA private AUTHORIZATION postgres;
    SET ROLE postgres; SET search_path=app,pg_catalog;
    ${table}
    GRANT USAGE ON SCHEMA app TO collect_runtime;
    GRANT SELECT,INSERT,UPDATE ON app.memberships TO collect_runtime;
    CREATE TABLE private.collect_fence_control(singleton boolean,mode text);
    INSERT INTO private.collect_fence_control VALUES(true,'open');
    CREATE FUNCTION private._collect_fence_require_operator() RETURNS void LANGUAGE plpgsql AS $$
      BEGIN IF current_user<>'postgres' THEN RAISE insufficient_privilege; END IF; END$$;
    CREATE FUNCTION private._retention_manifest_catalog_v2() RETURNS jsonb
      LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $catalog$
      SELECT '${JSON.stringify(catalog)}'::jsonb $catalog$;
    REVOKE ALL ON FUNCTION private._retention_manifest_catalog_v2() FROM PUBLIC;
    INSERT INTO memberships VALUES('before-a','group-a','member-a','member',1,'2026-11-26T00:00:00.000Z',1),
      ('before-b','group-b','member-a','member',1,'2026-11-26T00:00:00.000Z',1);
  `);
  const rejectMigration = async expected => {
    await assert.rejects(owner.query(sql), expected);
    await owner.query('ROLLBACK');
  };
  await rejectMigration({code:'55000', message:'membership_record_number_fence_required'});
  await owner.query("UPDATE private.collect_fence_control SET mode='fenced'");
  await owner.query('REVOKE UPDATE ON app.memberships FROM collect_runtime');
  await rejectMigration({code:'55000', message:'membership_record_number_predecessor_changed'});
  await owner.query('GRANT UPDATE ON app.memberships TO collect_runtime');
  await owner.query(sql);

  const numbers = async () => (await owner.query('SELECT id,membership_record_number FROM app.memberships ORDER BY id')).rows;
  const issued = await numbers();
  assert.equal(issued.length, 2);
  assert.equal(new Set(issued.map(row => row.membership_record_number)).size, 2);
  assert.ok(issued.every(row => /^[1-9]\d{11}$/.test(row.membership_record_number)));
  const expected = structuredClone(catalog);
  expected.application.memberships.columns.push('membership_record_number');
  assert.deepEqual((await owner.query('SELECT private._retention_manifest_catalog_v2() AS value')).rows[0].value, expected);

  const runtime = await connect(), parallel = await connect();
  for (const db of [runtime, parallel]) await db.query('SET ROLE collect_runtime');
  await runtime.query("UPDATE app.memberships SET role='admin',active=0,revision=revision+1 WHERE id='before-a'");
  assert.deepEqual(await numbers(), issued);
  await assert.rejects(runtime.query("UPDATE app.memberships SET membership_record_number=DEFAULT WHERE id='before-a'"), {code:'42501'});
  await assert.rejects(runtime.query(`INSERT INTO app.memberships(id,collection_id,user_id,joined_at,membership_record_number)
    OVERRIDING SYSTEM VALUE VALUES('forged','group-a','forged','2026-11-26T00:00:00.000Z',900000000000)`), {code:'42501'});
  const sequence = (await owner.query("SELECT pg_get_serial_sequence('app.memberships','membership_record_number') AS value")).rows[0].value;
  await assert.rejects(runtime.query('SELECT setval($1::regclass,900000000000)', [sequence]), {code:'42501'});
  await assert.rejects(owner.query("UPDATE app.memberships SET membership_record_number=900000000000 WHERE id='before-a'"),
    {code:'428C9'});
  await assert.rejects(owner.query("UPDATE app.memberships SET membership_record_number=DEFAULT WHERE id='before-a'"),
    {code:'42501', message:'membership_record_number_immutable'});
  await Promise.all([
    runtime.query(insert, ['after-a','group-a','member-c']),
    parallel.query(insert, ['after-b','group-b','member-c']),
  ]);
  const all = await numbers();
  assert.equal(all.length, 4);
  assert.equal(new Set(all.map(row => row.membership_record_number)).size, 4);
  await runtime.query(`INSERT INTO app.memberships(id,collection_id,user_id,role,active,joined_at,revision)
    VALUES('unused','group-a','member-c','member',1,'2026-11-26T00:00:00.000Z',1)
    ON CONFLICT(collection_id,user_id) DO UPDATE SET active=1,revision=memberships.revision+1`);
  assert.deepEqual(await numbers(), all);

  // The actual Admin projection returns the database-issued identity as text,
  // still restricted to the selected member and group.
  await owner.query(`CREATE TABLE app.collections(id text,title text);
    CREATE TABLE app.users(id text,public_id text,full_name text,member_type text,phone text,
      momo_provider text,momo_number text,momo_pay_code text,access_status text);
    INSERT INTO app.collections VALUES('group-a','Fixture A'),('group-b','Fixture B');
    INSERT INTO app.users VALUES('member-a','123456','Fixture member','app',NULL,NULL,NULL,NULL,'active');`);
  const row = (await owner.query(membershipSql({recordNumber:true}) + ' WHERE m.user_id=$1 AND m.collection_id=$2',
    ['member-a','group-a'])).rows;
  assert.equal(row.length, 1);
  assert.equal(scopedMembershipRow({...row[0], active:Number(row[0].active), revision:Number(row[0].revision)}).membership_record_number,
    issued[0].membership_record_number);
  await rejectMigration({code:'55000', message:'membership_record_number_predecessor_changed'});
});
