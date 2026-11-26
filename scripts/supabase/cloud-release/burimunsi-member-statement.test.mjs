import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import pg from '../node_modules/pg/lib/index.js';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';
import {createAdminWorker} from '../../../deploy/platform-admin/src/index.js';
import {BURIMUNSI_ADMIN_COOKIE} from '../../../deploy/platform-admin/src/admin-session-realm.js';
import {adminBuriMunsiPayments} from '../../../supabase/functions/_shared/domain/admin_burimunsi_payments.js';

const {vars} = JSON.parse(await readFile(new URL('../../../deploy/platform-admin/wrangler.burimunsi.jsonc', import.meta.url)));
const origin = vars.ADMIN_ORIGIN;
const group = 'statement-fixture', member = randomUUID(), membership = randomUUID(), outside = randomUUID();
const prefix = '/api/admin/burimunsi/payments?statement=1&memberId=';
const amount = BigInt(Number.MAX_SAFE_INTEGER);
const token = randomUUID().replaceAll('-', '').repeat(2);
const cookieHash = createHash('sha256').update(token).digest('hex');

test('the Worker and PostgreSQL serve a scoped statement and reject a same-count change between pages', async t => {
  const fixture = await startOwnedPg17({prefix:'collect-pg-transfer-', initialUser:'fixture_bootstrap'});
  const connections = [];
  const connect = async () => {
    const db = new pg.Client({host: fixture.socket, port: fixture.port, database: 'postgres', user: fixture.initialUser});
    connections.push(db);
    await db.connect();
    return db;
  };
  t.after(async () => {
    try { await Promise.all(connections.map(connection => connection.end())); }
    finally { await fixture.close(); }
  });
  const [reader, writer] = await Promise.all([connect(), connect()]);
  await writer.query(`CREATE SCHEMA private;
    CREATE SCHEMA app;
    CREATE SCHEMA burimunsi;
    CREATE TABLE private.test_sessions(token_hash text PRIMARY KEY, actor jsonb NOT NULL);
    CREATE FUNCTION private.burimunsi_browser_pin_session(text,text,text) RETURNS jsonb LANGUAGE sql STABLE AS $$
      SELECT actor FROM private.test_sessions WHERE token_hash=$2 AND actor->>'collectionId'=$1 $$;
    CREATE FUNCTION private.assert_actor(text,text,text,bigint,bigint) RETURNS text LANGUAGE sql STABLE AS $$
      SELECT 'fixture-principal'::text $$;
    CREATE TABLE private.burimunsi_accounts(id uuid PRIMARY KEY, collection_id text,
      principal_user_id text, role text, active boolean, removed boolean, capabilities text[]);
    CREATE TABLE app.collections(id text PRIMARY KEY, status text NOT NULL);
    CREATE TABLE app.users(id text PRIMARY KEY, member_type text NOT NULL);
    CREATE TABLE app.memberships(id text PRIMARY KEY, collection_id text, user_id text, UNIQUE(collection_id,user_id));
    CREATE TABLE burimunsi.payments(collection_id text, member_id text, id text PRIMARY KEY, direction text,
      amount_rwf bigint, provider_reference text, source_time text, occurred_at timestamptz, created_at timestamptz,
      sms_source_id text, counterparty_identifier text);
    CREATE INDEX statement_member ON burimunsi.payments(collection_id,member_id);
    ALTER TABLE burimunsi.payments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE burimunsi.payments FORCE ROW LEVEL SECURITY;
    CREATE POLICY fixture_collection ON burimunsi.payments FOR SELECT
      USING (collection_id=current_setting('burimunsi.collection_id', true));
    CREATE ROLE statement_runtime NOLOGIN;
    GRANT USAGE ON SCHEMA private,app,burimunsi TO statement_runtime;
    GRANT SELECT ON ALL TABLES IN SCHEMA private,app,burimunsi TO statement_runtime;
    GRANT UPDATE (id) ON private.burimunsi_accounts TO statement_runtime;`);
  const account = randomUUID(), session = randomUUID(), now = Math.floor(Date.now()/1000);
  const actor = {collectionId:group, accountId:account, principalId:'fixture-principal', adminId:'fixture-admin',
    sessionId:session, publicId:session, proofId:session, authVersion:1, accountVersion:1, credentialVersion:1,
    operatorRole:'admin', storageRole:'owner', phone:'+250780000001', name:'Fixture',
    permissions:['collections.read','users.read','payments.read','sms.read'], expiresAt:now+600, verifiedAt:now-1};
  await writer.query('INSERT INTO private.test_sessions VALUES ($1,$2::jsonb)', [cookieHash, JSON.stringify(actor)]);
  await writer.query("INSERT INTO private.burimunsi_accounts VALUES ($1,$2,'fixture-principal','admin',true,false,ARRAY['records.read','sms.read'])", [account, group]);
  await writer.query("INSERT INTO app.collections VALUES ($1,'active'),('elsewhere','active')", [group]);
  await writer.query("INSERT INTO app.users VALUES ($1,'app'),($2,'direct')", [member, outside]);
  await writer.query("INSERT INTO app.memberships VALUES ($1,$2,$3),('external','elsewhere',$3),('outside','elsewhere',$4)", [membership, group, member, outside]);
  await writer.query(`INSERT INTO burimunsi.payments
    SELECT $1,$2,'p-'||lpad(n::text,2,'0'),CASE WHEN n=26 THEN 'outgoing' ELSE 'incoming' END,
      $3::bigint,'REF-'||n,'',NULL::timestamptz,'2026-11-26 10:00:00Z'::timestamptz,'restricted-source','restricted-identifier'
    FROM generate_series(1,26) n
    UNION ALL SELECT 'elsewhere',$2,'other','incoming',1,'WRONG','',NULL,'2026-11-26 10:00:00Z'::timestamptz,NULL,NULL`,
  [group, member, String(amount)]);

  const db = {
    applicationWork: {assert: async () => {}}, setBrowserPasscodeAccount() {}, context() {}, readContext() {},
    transaction() { throw new Error('The statement must never take a write transaction'); },
    prepare(sql) {
      return {bind: (...args) => ({first: async () => {
        let index = 0;
        const result = await reader.query(sql.replace(/\?/g, () => '$' + ++index), args);
        return result.rows[0];
      }})};
    },
    async withLockedReadSnapshot(fn) {
      await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      try {
        await reader.query('SET LOCAL ROLE statement_runtime');
        return await fn({unsafe: async (sql, args) => (await reader.query(sql, args)).rows});
      }
      finally { await reader.query('ROLLBACK'); }
    },
  };
  const worker = createAdminWorker({fetchImpl: async request => {
    const target = new URL(request.url);
    assert.equal(target.pathname, '/functions/v1/admin-api/api/admin/burimunsi/payments');
    try {
      return await adminBuriMunsiPayments(new Request(origin + target.pathname.replace('/functions/v1/admin-api','') + target.search,request),
        {DB:db, BURIMUNSI_PRODUCT_MODE:'standalone', BURIMUNSI_COLLECTION_ID:group, ADMIN_ORIGINS:origin});
    } catch (error) {
      return Response.json({error:{code:error.code}}, {status:error.status ?? 500,headers:{'Cache-Control':'private, no-store'}});
    }
  }});
  const request = async (path, {signedIn = true} = {}) => {
    const response = await worker.fetch(new Request(origin + path, signedIn ? {headers:{cookie:BURIMUNSI_ADMIN_COOKIE + '=' + token}} : {}),
      {...vars,ASSETS:{fetch:()=>assert.fail('The statement must remain an API response')}});
    assert.match(response.headers.get('Cache-Control'), /no-store/);
    return [response.status, await response.json()];
  };

  const [ok, first] = await request(prefix + member);
  assert.equal(ok, 200);
  assert.deepEqual({groupId:first.groupId, memberId:first.memberId, membershipId:first.membershipId,
    totalCount:first.totalCount, offset:first.offset, closingRwf:first.closingRwf},
  {groupId:group, memberId:member, membershipId:membership,totalCount:26,offset:0,closingRwf:String(24n * amount)});
  assert.equal(first.items.length, 25);
  assert.equal(first.items[0].id, 'p-01');
  assert.equal(first.items.at(-1).balanceRwf, String(25n * amount));
  assert.deepEqual(Object.keys(first.items[0]).sort(), ['amountRwf','atRaw','balanceRwf','direction','ftId','id']);
  assert.match(first.revision, /^[0-9a-f]{64}$/);
  const later = prefix + member + '&offset=25&revision=' + first.revision;
  const [accepted, last] = await request(later);
  assert.equal(accepted, 200);
  assert.deepEqual(last.items.map(item => [item.id,item.direction,item.balanceRwf]), [['p-26','outgoing',String(24n * amount)]]);

  // Same number of rows and same closing sum, but altered page contents and
  // intermediate running balances. Neither count nor closing alone pins them.
  await writer.query("UPDATE burimunsi.payments SET amount_rwf=amount_rwf-1 WHERE id IN ('p-01','p-26')");
  assert.deepEqual(await request(later), [409,{error:{code:'member_statement_changed'}}]);
  const [refreshed, fresh] = await request(prefix + member);
  assert.equal(refreshed, 200);
  assert.notEqual(fresh.revision, first.revision);
  assert.equal(fresh.closingRwf, first.closingRwf);
  assert.equal(fresh.items[0].balanceRwf, String(amount - 1n));
  assert.equal((await request(prefix + member + '&offset=25'))[0], 400);
  assert.equal((await request(prefix + outside))[0], 404);
  assert.equal((await request(prefix + member + '&groupId=elsewhere'))[0], 400);
  assert.equal((await request(prefix + member,{signedIn:false}))[0], 401);
  await writer.query("UPDATE private.test_sessions SET actor=actor || '{\"permissions\":[\"payments.read\",\"users.read\"]}'::jsonb");
  assert.equal((await request(prefix + member))[0], 403);
});
