import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import pg from '../node_modules/pg/lib/index.js';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';
import {createAdminWorker} from '../../../deploy/platform-admin/src/index.js';
import {BURIMUNSI_ADMIN_COOKIE} from '../../../deploy/platform-admin/src/admin-session-realm.js';
import {handleAdmin} from '../../../supabase/functions/_shared/domain/admin_bridge.js';
import {PostgresTransactions} from '../../../supabase/functions/_shared/postgres-transactions.js';
import {openApplicationWork} from '../../../supabase/functions/_shared/application-fence.js';

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
    const types={getTypeParser:(oid,format)=>[20,1700].includes(oid)?value=>{
      const n=Number(value);if(!Number.isSafeInteger(n))throw Error('fixture_database_integer');return n;
    }:pg.types.getTypeParser(oid,format)};
    const db = new pg.Client({host: fixture.socket, port: fixture.port, database: 'postgres', user: fixture.initialUser,types});
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
    CREATE TABLE app.collections(id text PRIMARY KEY, status text NOT NULL,title text DEFAULT 'Group');
    CREATE TABLE app.users(id text PRIMARY KEY, member_type text NOT NULL,public_id text DEFAULT '100001',
      phone text,email text,full_name text DEFAULT 'Verified member',momo_provider text,momo_number text,momo_pay_code text,
      access_status text DEFAULT 'active',revision int DEFAULT 1,created_at text DEFAULT '2026-11-25T10:00:00.000Z',
      updated_at text DEFAULT '2026-11-25T10:00:00.000Z');
    CREATE TABLE app.admin_principal_links(user_id text,admin_user_id text);
    CREATE TABLE app.admin_users(id text PRIMARY KEY,role text,status text);
    CREATE TABLE app.ledger_entries(member_id text,collection_id text,amount_minor int);
    CREATE TABLE app.memberships(id text PRIMARY KEY, collection_id text, user_id text,role text DEFAULT 'member',
      active int DEFAULT 1,revision int DEFAULT 1,joined_at text DEFAULT '2026-11-25T10:00:00.000Z',
      membership_record_number text DEFAULT '123456789012',UNIQUE(collection_id,user_id));
    CREATE TABLE burimunsi.payments(collection_id text, member_id text, id text PRIMARY KEY, direction text,
      amount_rwf bigint, provider_reference text, source_time text, occurred_at timestamptz, created_at timestamptz,
      sms_source_id text, counterparty_identifier text);
    CREATE INDEX burimunsi_payments_member ON burimunsi.payments(collection_id,member_id);
    ALTER TABLE burimunsi.payments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE burimunsi.payments FORCE ROW LEVEL SECURITY;
    CREATE POLICY fixture_collection ON burimunsi.payments FOR SELECT
      USING (collection_id=current_setting('burimunsi.collection_id', true));
    CREATE ROLE statement_runtime NOLOGIN;
    CREATE ROLE collect_runtime NOLOGIN IN ROLE statement_runtime;
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
  await writer.query("INSERT INTO app.collections(id,status) VALUES ($1,'active'),('elsewhere','active')", [group]);
  await writer.query("INSERT INTO app.users(id,member_type) VALUES ($1,'app'),($2,'direct')", [member, outside]);
  await writer.query("INSERT INTO app.memberships(id,collection_id,user_id) VALUES ($1,$2,$3),('external','elsewhere',$3),('outside','elsewhere',$4)", [membership, group, member, outside]);
  await writer.query(`INSERT INTO burimunsi.payments
    SELECT $1,$2,'p-'||lpad(n::text,2,'0'),CASE WHEN n=26 THEN 'outgoing' ELSE 'incoming' END,
      $3::bigint,'REF-'||n,'',NULL::timestamptz,'2026-11-26 10:00:00Z'::timestamptz,'restricted-source','restricted-identifier'
    FROM generate_series(1,26) n
    UNION ALL SELECT 'elsewhere',$2,'other','incoming',1,'WRONG','',NULL,'2026-11-26 10:00:00Z'::timestamptz,NULL,NULL`,
  [group, member, String(amount)]);
  await writer.query(`INSERT INTO burimunsi.payments
    SELECT 'elsewhere',$1,'extra-'||n,'incoming',1,NULL,'',NULL,clock_timestamp(),NULL,NULL
    FROM generate_series(1,5000) n`,[outside]);
  await writer.query('ANALYZE burimunsi.payments');

  let afterProfile,slowBalance=false,paymentReads=0,snapshots=0,profilePlans=false;
  const plans=[];
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
      snapshots++;
      await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      try {
        await reader.query('SET LOCAL ROLE statement_runtime; SET LOCAL search_path=app,public,pg_catalog');
        return await fn({unsafe: async (sql, args) => {
          if(sql.includes('FROM burimunsi.payments'))paymentReads++;
          if(slowBalance&&sql.includes('SELECT membership.id AS membership_id,totals.*'))await reader.query('SELECT pg_sleep(0.7)');
          if(profilePlans&&(sql.includes('FROM burimunsi.payments')||sql.includes('AS member_membership'))){
            const p=await reader.query('EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) '+sql,args);
            plans.push(p.rows[0]['QUERY PLAN'][0]);
          }
          const rows=(await reader.query(sql,args)).rows;
          if(afterProfile&&sql.includes('AS member_membership'))await afterProfile();
          return rows;
        }});
      }
      finally { await reader.query('ROLLBACK'); }
    },
  };
  const worker = createAdminWorker({fetchImpl: async request => {
    const target = new URL(request.url);
    assert.match(target.pathname,/^\/functions\/v1\/admin-api\/api\/admin\/(?:burimunsi\/payments|operations\/members\/[^/]+)$/);
    return handleAdmin(new Request(origin + target.pathname.replace('/functions/v1/admin-api','') + target.search,request),
      {DB:db, BURIMUNSI_PRODUCT_MODE:'standalone', BURIMUNSI_COLLECTION_ID:group, ADMIN_ORIGINS:origin});
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
  const detail=id=>'/api/admin/operations/members/'+id;
  const before=snapshots;
  profilePlans=true;
  const [balanceOk,balance]=await request(detail(member)+'?include=balance');
  profilePlans=false;
  assert.equal(balanceOk,200,JSON.stringify(balance));assert.equal(snapshots-before,1);
  assert.equal(balance.resource.id,member);
  assert.equal(balance.related.memberships[0].id,membership);
  assert.deepEqual(balance.member_balance,{groupId:group,memberId:member,membershipId:membership,closingRwf:first.closingRwf});
  assert.equal(Object.hasOwn(balance,'member_statement'),false);
  assert.equal(plans.length,2);
  assert.ok(JSON.stringify(plans[1]).includes('burimunsi_payments_member'));
  t.diagnostic(`Member detail plus closing balance with 26 scoped and 5,001 foreign movements. One locked snapshot; PG executor ${plans.map(p=>p['Execution Time'].toFixed(3)).join(' + ')} ms, balance uses collection/member index.`);
  const [boundOk,bound]=await request(detail(member)+'?include=statement');
  assert.equal(boundOk,200,JSON.stringify(bound));assert.deepEqual(bound.member_statement,first);
  const previousReads=paymentReads;
  assert.equal((await request(detail(outside)+'?include=balance'))[0],404);
  assert.equal((await request(detail(member)+'?include=statement&groupId=elsewhere'))[0],400);
  assert.equal((await request(detail(member)+'?include=balance&include=balance'))[0],400);
  assert.equal((await request(detail(member)+'?include=balance',{signedIn:false}))[0],401);
  assert.equal(paymentReads,previousReads);
  slowBalance=true;
  const [degraded,profile]=await request(detail(member)+'?include=balance');
  assert.equal(degraded,200);assert.equal(profile.resource.id,member);assert.equal(profile.member_balance,null);
  slowBalance=false;
  const later = prefix + member + '&offset=25&revision=' + first.revision;
  const [accepted, last] = await request(later);
  assert.equal(accepted, 200);
  assert.deepEqual(last.items.map(item => [item.id,item.direction,item.balanceRwf]), [['p-26','outgoing',String(24n * amount)]]);

  // Same number of rows and same closing sum, but altered page contents and
  // intermediate running balances. Neither count nor closing alone pins them.
  afterProfile=async()=>writer.query("UPDATE burimunsi.payments SET amount_rwf=amount_rwf-1 WHERE id IN ('p-01','p-26')");
  const [racingOk,racing]=await request(detail(member)+'?include=statement');
  afterProfile=undefined;
  assert.equal(racingOk,200);assert.deepEqual(racing.member_statement,first);
  const [changed,change]=await request(later);
  assert.equal(changed,409);assert.equal(change.error.code,'member_statement_changed');
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
  assert.equal((await request(detail(member)+'?include=statement'))[0],403);

  await t.test('Admin transaction mode and role setup is one SQL exchange with the exact admission tuple',async()=>{
    const id=randomUUID(),epoch=13,source='a'.repeat(64),kind='http_admin';
    const proof={contractVersion:1,admissionId:id,epoch,sourceSha256:source,state:'active',mode:'open',kind};
    const work=await openApplicationWork({id,sourceSha256:source,kind,backend:{
      register:async()=>proof,lease:async()=>({row:proof,assert:async()=>proof,release:async()=>{}}),status:async()=>proof,
      close:async()=>({...proof,state:'settled',reason:'completed',externalDispatches:0,uncertainDispatches:0}),
    }});
    let released=0;const sent=[];
    const sql={async unsafe(text,args){sent.push(text);return (await reader.query(text,args)).rows;},release(){released++;}};
    const db=new PostgresTransactions({reserve:async()=>sql},{},work);
    const context=tx=>tx.unsafe(`SELECT current_user AS role,current_setting('transaction_isolation') AS isolation,
      current_setting('collect.fence_admission_id') AS id,current_setting('collect.fence_epoch') AS epoch,
      current_setting('collect.fence_source_sha256') AS source,current_setting('collect.edge_verified') AS verified`);
    for(const [read,isolation] of [['withAdminSessionRead','read committed'],['withLockedReadSnapshot','repeatable read']]){
      const before=sent.length;
      assert.deepEqual(await db[read](context),[{role:'collect_runtime',isolation,id,epoch:String(epoch),source,verified:'true'}]);
      assert.equal(sent.length-before,4,'BEGIN, scoped setup, read and ROLLBACK');
      assert.equal(sent.at(-1),'ROLLBACK');
      assert.match(sent[before+1],/AS runtime_role/);
      assert.equal((await reader.query('SELECT current_user AS role')).rows[0].role,fixture.initialUser);
    }
    assert.equal(released,2);
    await work.finish();
  });
});
