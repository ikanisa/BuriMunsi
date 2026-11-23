// An unrouted PG17 Unix socket exercises real RLS, cached-subscriber revocation,
// transaction visibility, rollback, failed delivery, and expiry.
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import pg from '../node_modules/pg/lib/index.js';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';
import {handleAdmin} from '../../../supabase/functions/_shared/domain/admin_bridge.js';
import {compileSql} from '../../../supabase/functions/_shared/postgres-compatibility-sql.js';

const release=await readFile(new URL('../../../supabase/migrations/20261122191400_burimunsi_admin_realtime.sql',import.meta.url),'utf8');
const predecessor=await readFile(new URL('../../../supabase/migrations/20261022200028_collect_private_member_realtime.sql',import.meta.url),'utf8');
const phoneAccounts=await readFile(new URL('../../../supabase/migrations/20261122190000_burimunsi_phone_operator_accounts.sql',import.meta.url),'utf8');
function privateFunction(name,source){
 const start=source.indexOf('CREATE FUNCTION private.'+name+'(');
 assert.ok(start>=0);const tail=source.slice(start),end=tail.match(/\$(?:fn|meta)\$;/);
 assert.ok(end);return tail.slice(0,end.index+end[0].length);
}
const sid=randomUUID(),pub=randomUUID(),native=randomUUID(),auth=randomUUID();
const group='synthetic-group',principal='scope-principal',admin='scope-admin',pHash='f'.repeat(64);
const origin='https://burimunsi-admin.ikanisa.com',cookieToken=randomBytes(32).toString('hex');
const hash=value=>createHash('sha256').update(value).digest('hex'),cookie=hash(cookieToken);
const ownerAuthority={kind:'shared_approval',adminId:admin};

// Handle the real same-origin standalone Admin route with the production SQL
// compiler. Only the connection/admission and predecessor account fixture are local.
function adminHttpFixture(client){
 const execute=(statement,values)=>{const {text,values:bound}=compileSql(statement,values);return client.query(text,bound);};
 const db={setBrowserPasscodeAccount(account){assert.equal(account.principal_id,principal);},
  prepare(statement){return {bind(...values){return {statement,values,first:async()=>(await execute(statement,values)).rows[0]};}};},
  async batch(statements){
   await client.query('BEGIN');
   try{
    const answers=[];for(const {statement,values} of statements)answers.push({results:(await execute(statement,values)).rows});
    await client.query('COMMIT');return answers;
   }catch(error){await client.query('ROLLBACK');throw error;}
  }};
 return async({body={},method='POST',path='/api/admin/sync/live',from=origin,csrf=hash('collect-admin-csrf:'+cookieToken),token=cookieToken}={})=>{
  const headers={'Content-Type':'application/json','X-Collect-Requested-With':'collect-admin',Origin:from};
  if(csrf)headers['X-Collect-CSRF']=csrf;if(token)headers.Cookie='__Host-collect_admin='+token;
  const request=new Request(origin+path,{method,headers,body:method==='GET'?undefined:JSON.stringify(body)});
  const response=await handleAdmin(request,{DB:db,BURIMUNSI_PRODUCT_MODE:'standalone',BURIMUNSI_COLLECTION_ID:group,ADMIN_ORIGINS:origin});
  return {status:response.status,body:await response.json(),cache:response.headers.get('Cache-Control')};
 };
}
test('private Realtime authorizes just the current group and session and never depends on delivery to commit credit',async t=>{
 const cluster=await startOwnedPg17({prefix:'collect-pg-transfer-',initialUser:'fixture_bootstrap'}),client=new pg.Client({host:cluster.socket,port:cluster.port,user:cluster.initialUser,database:'postgres'});
 t.after(async()=>{try{await client.end();}finally{await cluster.close();}});await client.connect();
 const q=(sql,args)=>client.query(sql,args),one=async(sql,args)=>(await q(sql,args)).rows[0]?.value;
 await q(`
 CREATE ROLE postgres NOSUPERUSER NOBYPASSRLS;CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE ROLE collect_runtime;CREATE ROLE collect_importer;
 CREATE SCHEMA private AUTHORIZATION postgres;CREATE SCHEMA app AUTHORIZATION postgres;CREATE SCHEMA realtime AUTHORIZATION postgres;CREATE SCHEMA auth AUTHORIZATION postgres;
 CREATE SCHEMA collect_ops AUTHORIZATION postgres;
 SET ROLE postgres;
 GRANT USAGE ON SCHEMA private,app TO collect_runtime;
 CREATE TABLE private.collect_fence_control(singleton boolean,mode text,source_sha256 text);INSERT INTO private.collect_fence_control VALUES(true,'fenced',repeat('a',64));
 CREATE FUNCTION private._collect_fence_require_operator() RETURNS void LANGUAGE plpgsql AS $$BEGIN IF current_user<>'postgres' THEN RAISE insufficient_privilege;END IF;END$$;
 CREATE FUNCTION private._collect_fence_require_runtime() RETURNS void LANGUAGE plpgsql AS $$BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'collect_runtime' OR current_setting('collect.edge_verified',true) IS DISTINCT FROM 'true'
   OR current_setting('fixture.work_kind',true) IS DISTINCT FROM 'http_admin' THEN RAISE insufficient_privilege;END IF;END$$;
 CREATE FUNCTION private._collect_fence_statement() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
  IF current_setting('role',true)='postgres' AND current_setting('fixture.work_kind',true)='maintenance' THEN RETURN NULL;END IF;
  IF current_setting('role',true) IS DISTINCT FROM 'collect_runtime' OR current_setting('collect.edge_verified',true) IS DISTINCT FROM 'true' THEN RAISE insufficient_privilege;END IF;RETURN NULL;END$$;
 CREATE TABLE app.collections(id text PRIMARY KEY,status text);CREATE TABLE app.users(id text PRIMARY KEY,access_status text);
 CREATE TABLE app.memberships(collection_id text,user_id text,active bigint,role text);
 CREATE TABLE app.admin_principal_links(user_id text,admin_user_id text);CREATE TABLE app.admin_users(id text PRIMARY KEY,status text,role text,email text,auth_version bigint);
 CREATE TABLE app.admin_grants(user_id text,permission text);CREATE TABLE app.admin_account_role_capabilities(role text,permission text);
 CREATE TABLE app.auth_sessions(id text PRIMARY KEY,user_id text,surface text,revoked_at bigint,expires_at bigint,created_at bigint,auth_at bigint,assurance_level bigint,mfa_at bigint,mfa_factor_id text);
 CREATE TABLE app.admin_sessions(token_hash text PRIMARY KEY,public_id text,user_id text,auth_session_id text,auth_version bigint,origin text,created_at bigint,expires_at bigint,
  issued_assurance_level bigint,issued_mfa_at bigint,issued_mfa_factor_id text);
 CREATE TABLE app.privacy_retention_barriers(subject_id text);CREATE TABLE private.collect_deployment_identity(singleton boolean,profile_sha256 text);
 CREATE TABLE private.burimunsi_browser_pin_sessions(session_id text,collection_id text,principal_id text,admin_id text,public_id uuid,cookie_hash text,origin text,profile_sha256 text,
   issued_at bigint,expires_at bigint,account_id uuid,account_version bigint,credential_version bigint,authority jsonb);
 CREATE TABLE private.burimunsi_operator_approvals(collection_id text,principal_user_id text,admin_user_id text,active boolean,role text,capabilities text[],phone text);
 CREATE TABLE private.bff_sessions(token_hash text,auth_user_id uuid,auth_session_id uuid,refresh_lease text);CREATE TABLE private.auth_principal_links(auth_user_id uuid,user_id text);
 CREATE TABLE auth.sessions(id uuid,user_id uuid,not_after timestamptz,aal text,factor_id uuid);
 CREATE TABLE auth.users(id uuid,deleted_at timestamptz,is_anonymous boolean,email text,email_confirmed_at timestamptz,banned_until timestamptz);
 CREATE TABLE private.managed_mfa_proofs(session_id uuid,user_id uuid,factor_id uuid,verified_at_epoch bigint);
 CREATE TABLE auth.mfa_factors(id uuid,user_id uuid,status text);
 CREATE TABLE private.fixture_actor(value jsonb);
 CREATE TABLE private.collect_owner_identity(singleton boolean,principal_user_id text,admin_user_id text,owner_email text);
 CREATE TABLE private.burimunsi_accounts(id uuid,collection_id text,principal_user_id text,phone text,role text,capabilities text[],
   version bigint,credential_version bigint,active boolean,removed boolean);
 CREATE TABLE private.burimunsi_scopes(collection_id text);
 CREATE TABLE private.member_realtime_control(singleton boolean,enabled boolean,policy_sha256 text,source_sha256 text,attempted_total bigint);
 CREATE FUNCTION private.request_claims() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('fixture.claims',true),''),'{}')::jsonb$$;
 CREATE TABLE app.admin_account_guards(id text PRIMARY KEY,passed bigint NOT NULL CHECK(passed=1));
 CREATE TABLE app.auth_mfa_factors(id text,user_id text,status text);CREATE FUNCTION app.unixepoch() RETURNS bigint LANGUAGE sql AS $$SELECT extract(epoch FROM now())::bigint$$;
 ALTER TABLE app.admin_users ADD COLUMN burimunsi_phone_only boolean NOT NULL DEFAULT false;
 ALTER TABLE private.burimunsi_operator_approvals ADD COLUMN identity_source text NOT NULL DEFAULT 'phone';
 ALTER TABLE private.burimunsi_accounts ADD COLUMN name text, ADD COLUMN pin_hash jsonb;
 CREATE FUNCTION private.collect_owner_is(web_id text,principal text,email text) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS(SELECT 1 FROM private.collect_owner_identity WHERE singleton AND admin_user_id=web_id AND principal_user_id=principal AND owner_email=email)$$;
 CREATE FUNCTION private.burimunsi_browser_pin_is_fresh(bigint) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
 CREATE FUNCTION private.burimunsi_browser_pin_session(p_group text,p_cookie text,p_origin text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$
  SELECT f.value||jsonb_build_object('permissions',ARRAY(SELECT permission FROM app.admin_grants WHERE user_id=b.principal_id),
    'authVersion',c.auth_version,'proofId',b.public_id,'verifiedAt',b.issued_at,'phone','+250780000001','name','Synthetic','email',u.email,
    'operatorRole','admin','storageRole',u.role,'accountId',b.account_id)
   FROM private.fixture_actor f JOIN private.burimunsi_browser_pin_sessions b ON b.session_id=f.value->>'sessionId'
   JOIN app.auth_sessions s ON s.id=b.session_id AND s.revoked_at IS NULL
   JOIN app.admin_sessions c ON c.token_hash=b.cookie_hash JOIN app.admin_users u ON u.id=c.user_id
   WHERE b.collection_id=p_group AND b.cookie_hash=p_cookie AND b.origin=p_origin AND b.expires_at>extract(epoch FROM now())$$;
 CREATE FUNCTION private.burimunsi_browser_pin_set_context(g text,h text,o text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
  BEGIN IF private.burimunsi_browser_pin_session(g,h,o) IS NULL THEN RAISE insufficient_privilege;END IF;
  PERFORM set_config('burimunsi.browser_pin_cookie',h,true);RETURN true;END$$;
 CREATE FUNCTION private.burimunsi_browser_pin_context() RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$SELECT value FROM private.fixture_actor$$;
 CREATE FUNCTION private.burimunsi_observation_admin_collections() RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$
  SELECT jsonb_agg(jsonb_build_object('collectionId',value->>'collectionId')) FROM private.fixture_actor$$;
 CREATE FUNCTION private.burimunsi_observation_admin_scope(p_group text,boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
 DECLARE actor jsonb:=private.burimunsi_browser_pin_context();BEGIN
  PERFORM private._collect_fence_require_runtime();
  IF actor->>'collectionId' IS DISTINCT FROM p_group THEN RAISE insufficient_privilege;END IF;RETURN actor;END$$;
 CREATE FUNCTION private.assert_actor(text,text,text,bigint,bigint) RETURNS text LANGUAGE sql SECURITY DEFINER AS $$SELECT value->>'principalId' FROM private.fixture_actor$$;
 CREATE FUNCTION private.burimunsi_managed_admin_snapshot() RETURNS TABLE(principal_session_id text,principal_user_id text,public_session_id text,expires_at bigint)
 LANGUAGE sql SECURITY DEFINER AS $$SELECT value->>'sessionId',value->>'principalId',value->>'publicId',(value->>'expiresAt')::bigint FROM private.fixture_actor$$;
 CREATE FUNCTION private.burimunsi_pin_root_snapshot(g text,p text,ph text,ro text,caps text[]) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$
  SELECT jsonb_build_object('kind','shared_approval','adminId',o.admin_user_id) FROM private.burimunsi_operator_approvals o
  WHERE o.collection_id=g AND o.principal_user_id=p AND o.phone=ph AND o.role=ro AND o.active AND caps<@o.capabilities$$;
 CREATE FUNCTION private.burimunsi_pin_authority_snapshot(g text,p text,ph text,ro text,caps text[]) RETURNS jsonb LANGUAGE sql AS $$
  SELECT private.burimunsi_pin_root_snapshot(g,p,ph,ro,caps)$$;
 CREATE TABLE private.burimunsi_unresolved_observations(collection_id text);
 CREATE TABLE private.burimunsi_sms_source_scopes(collection_id text);CREATE TABLE private.burimunsi_transaction_scopes(collection_id text);
 CREATE TABLE private.burimunsi_auto_sms_jobs(collection_id text,state text);
 CREATE TABLE app.payments(id text PRIMARY KEY,collection_id text);CREATE TABLE app.contribution_posting_snapshots(payment_id text);
 CREATE TABLE private.burimunsi_payment_sms_deliveries(collection_id text,state text,provider_state text);
 CREATE TABLE private.burimunsi_inbox_checks(collection_id text,state text);CREATE TABLE collect_ops.jobs_dispatches(id uuid PRIMARY KEY);
 CREATE FUNCTION private._retention_manifest_catalog_v2() RETURNS jsonb LANGUAGE sql AS $$SELECT '{"private_classes":[]}'::jsonb;$$;
 CREATE FUNCTION private.retention_capture_inventory_v2(uuid,text,bigint,text,integer) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_array('managed:storage_iceberg')$$;
 CREATE TABLE realtime.messages(topic text,extension text,event text,payload jsonb,private boolean,id uuid DEFAULT gen_random_uuid());
 ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;ALTER TABLE realtime.messages FORCE ROW LEVEL SECURITY;
 CREATE POLICY fixture_server_read ON realtime.messages FOR SELECT TO postgres USING(true);
 CREATE POLICY fixture_server_delete ON realtime.messages FOR DELETE TO postgres USING(true);
 CREATE POLICY fixture_member_server ON realtime.messages FOR INSERT TO postgres WITH CHECK (topic LIKE 'collect:member:%');
 CREATE POLICY collect_member_no_anonymous_v1 ON realtime.messages AS RESTRICTIVE FOR ALL TO anon USING(false) WITH CHECK(false);
 GRANT USAGE ON SCHEMA realtime TO authenticated,anon;GRANT SELECT,INSERT,UPDATE,DELETE ON realtime.messages TO authenticated,anon;
 CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$SELECT current_setting('realtime.topic',true)$$;
 CREATE FUNCTION realtime.send(payload jsonb,event text,topic text,private boolean) RETURNS void LANGUAGE plpgsql AS $$
 DECLARE transport_id uuid:=gen_random_uuid();BEGIN
 IF current_setting('fixture.transport',true)='broken' THEN RAISE EXCEPTION 'fixture outage';END IF;
 PERFORM set_config('realtime.topic',topic,true);
 INSERT INTO realtime.messages VALUES(topic,'broadcast',event,jsonb_set(payload,'{id}',to_jsonb(transport_id)),private,transport_id);END$$;
 GRANT INSERT ON private.burimunsi_unresolved_observations,private.burimunsi_sms_source_scopes,
   app.contribution_posting_snapshots TO collect_runtime;
 GRANT SELECT ON app.admin_sessions,app.admin_users,app.admin_principal_links,app.users,app.auth_sessions,app.auth_mfa_factors,
   app.admin_grants,app.admin_account_role_capabilities,app.admin_account_guards TO collect_runtime;
 GRANT INSERT,DELETE ON app.admin_account_guards TO collect_runtime;
 `);
 for(const name of ['_collect_member_realtime_metadata','_collect_member_realtime_metadata_sha','collect_member_realtime_join',
  'collect_member_realtime_configure','collect_member_realtime_publish'])await q(privateFunction(name,predecessor));
 await q(privateFunction('burimunsi_browser_operator',phoneAccounts));
 await q("CREATE POLICY fixture_member ON realtime.messages FOR SELECT TO authenticated USING (topic=(SELECT realtime.topic()) AND extension='broadcast' AND private.collect_member_realtime_join((SELECT realtime.topic())))");
 const memberPin=await one('SELECT private._collect_member_realtime_metadata_sha() value');
 await q("INSERT INTO private.member_realtime_control VALUES(true,true,$1,repeat('a',64),0)",[memberPin]);
 await q(release);
 assert.equal(await one('SELECT policy_sha256 value FROM private.member_realtime_control'),memberPin);
 assert.notEqual(await one('SELECT private._collect_member_realtime_metadata_sha() value'),memberPin);
 await q("UPDATE private.collect_fence_control SET mode='open'");
 const now=Math.floor(Date.now()/1000)-2,expires=now+1800;
 const actor={collectionId:group,principalId:principal,sessionId:sid,publicId:pub,adminId:admin,expiresAt:expires};
 await q("INSERT INTO app.collections VALUES($1,'active')",[group]);await q("INSERT INTO app.users VALUES($1,'active')",[principal]);
 await q("INSERT INTO app.memberships VALUES($1,$2,1,'owner')",[group,principal]);
 await q('INSERT INTO app.admin_principal_links VALUES($1,$2)',[principal,admin]);
 await q("INSERT INTO app.admin_users VALUES($1,'active','owner','owner@example.invalid',5)",[admin]);
 await q("INSERT INTO app.admin_grants VALUES($1,'sms.read')",[principal]);await q("INSERT INTO app.admin_account_role_capabilities VALUES('owner','sms.read')");
 await q("INSERT INTO app.auth_sessions VALUES($1,$2,'admin',NULL,$3,$4,$4,1,NULL,NULL)",[sid,principal,expires,now]);
 await q("INSERT INTO app.admin_sessions VALUES($1,$2,$3,$4,5,'https://burimunsi-admin.ikanisa.com',$5,$6,1,NULL,NULL)",[cookie,pub,admin,sid,now,expires]);
 await q("INSERT INTO private.collect_deployment_identity VALUES(true,$1)",[pHash]);
 await q("INSERT INTO private.burimunsi_browser_pin_sessions VALUES($1,$2,$3,$4,$5,$6,'https://burimunsi-admin.ikanisa.com',$7,$8,$9,$10,1,2,$11)",
  [sid,group,principal,admin,pub,cookie,pHash,now,expires,native,ownerAuthority]);
 await q("INSERT INTO private.burimunsi_operator_approvals VALUES($1,$2,$3,true,'admin',ARRAY['records.read','sms.read'],'+250780000001')",[group,principal,admin]);
 await q("INSERT INTO private.burimunsi_accounts VALUES($1,$2,$3,'+250780000001','admin',ARRAY['records.read','sms.read'],1,2,true,false)",[native,group,principal]);
 await q('INSERT INTO private.burimunsi_scopes VALUES($1)',[group]);
 await q("INSERT INTO private.collect_owner_identity VALUES(true,$1,$2,'owner@example.invalid')",[principal,admin]);
 for(const table of ['burimunsi_accounts','burimunsi_scopes','burimunsi_operator_approvals']){
  await q(`ALTER TABLE private.${table} ENABLE ROW LEVEL SECURITY;ALTER TABLE private.${table} FORCE ROW LEVEL SECURITY;
   CREATE POLICY burimunsi_scoped_owner ON private.${table} TO postgres USING(collection_id=current_setting('burimunsi.collection_id',true))`);
 }
 await q('INSERT INTO private.fixture_actor VALUES($1::jsonb)',[actor]);
 await q('INSERT INTO app.payments VALUES($1,$2)',['payment',group]);
 const runtime=async kind=>{await q("SET ROLE collect_runtime;SET collect.edge_verified='true'");await q("SELECT set_config('fixture.work_kind',$1,false)",[kind]);};
 const operator=()=>q('SET ROLE postgres'),publicAnon=()=>q('SET ROLE anon');
 const issue=g=>one('SELECT private.burimunsi_admin_live_issue($1::text) AS value',[g]);
 const select=()=>q('SELECT topic,event,payload,private FROM realtime.messages');
 const topic=x=>q("SELECT set_config('realtime.topic',$1,false)",[x]);
 const insert=()=>q('INSERT INTO private.burimunsi_unresolved_observations VALUES($1)',[group]);
 const count=async()=>{await operator();return one('SELECT count(*)::int AS value FROM realtime.messages');};
 await runtime('http_admin');await q("SET burimunsi.browser_pin_cookie='verified_fixture'");
 await assert.rejects(()=>issue('other-group'),{code:'42501'});const cap=await issue(null);
 assert.match(cap.topic,/^buri:ops:[a-f0-9]{64}$/);assert.ok(Date.parse(cap.expiresAt)>Date.now()+240000&&Date.parse(cap.expiresAt)<=Date.now()+300000);
 assert.equal((await issue(group)).topic,cap.topic);
 await t.test('same-origin cookie and CSRF issue a scoped private channel through the normal HTTP handler',async()=>{
  await q('SET search_path=app,pg_catalog');const call=adminHttpFixture(client);
  for(const body of [{},{collectionId:group}]){
   const response=await call({body});assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.cache,'no-store');assert.deepEqual(response.body,cap);
  }
  for(const [input,status] of [[{body:{collectionId:'other-group'}},403],[{body:{unexpected:1}},400],[{body:{collectionId:null}},400],
   [{method:'GET'},405],[{path:'/api/admin/sync/live?collectionId=other'},400],[{csrf:''},403],[{from:'https://other.example.invalid'},403],[{token:''},401]]){
   const response=await call(input);assert.equal(response.status,status,JSON.stringify(response.body));assert.equal(response.body.topic,undefined);
  }
  await operator();await q("DELETE FROM app.admin_grants WHERE permission='sms.read'");
  await runtime('http_admin');assert.equal((await call()).status,403);
  await operator();await q("INSERT INTO app.admin_grants VALUES($1,'sms.read')",[principal]);await runtime('http_admin');
  await q('RESET search_path');
 });
 await publicAnon();await assert.rejects(()=>issue(group),{code:'42501'});await assert.rejects(()=>q('SELECT * FROM private.burimunsi_admin_live_channels'),{code:'42501'});
 await topic('buri:ops:'+'0'.repeat(64));assert.equal((await select()).rowCount,0);
 await runtime('jobs');await q('BEGIN');await insert();await q('INSERT INTO app.contribution_posting_snapshots VALUES($1)',['payment']);await q('COMMIT');
 assert.equal(await count(),1);await publicAnon();await topic(cap.topic);
 const [broadcast]=(await select()).rows;assert.match(broadcast.payload.id,/^[0-9a-f-]{36}$/);
 assert.deepEqual(broadcast,{topic:cap.topic,event:'operations_changed',payload:{changed:true,id:broadcast.payload.id},private:true});
 await t.test('an authorized phone Admin can subscribe and a demotion closes cached read access',async()=>{
  await operator();await q("UPDATE app.admin_users SET role='admin',burimunsi_phone_only=true");
  await runtime('http_admin');assert.equal((await issue(group)).topic,cap.topic);
  await publicAnon();await topic(cap.topic);assert.equal((await select()).rowCount,1);
  await operator();await q("SELECT set_config('burimunsi.collection_id',$1,false)",[group]);
  assert.equal((await q("UPDATE private.burimunsi_accounts SET role='staff'")).rowCount,1);
  await publicAnon();await topic(cap.topic);assert.equal((await select()).rowCount,0);
  await operator();await q("UPDATE private.burimunsi_accounts SET role='admin'");await q("UPDATE app.admin_users SET role='owner',burimunsi_phone_only=false");
  await publicAnon();await topic(cap.topic);
 });
 await assert.rejects(()=>q("INSERT INTO realtime.messages VALUES($1,'broadcast','operations_changed','{}',true)",[cap.topic]),{code:'42501'});
 await assert.rejects(()=>q("SELECT realtime.send('{}','operations_changed',$1,true)",[cap.topic]),{code:'42501'});
 assert.equal((await q('UPDATE realtime.messages SET payload=payload WHERE topic=$1',[cap.topic])).rowCount,0);
 assert.equal((await q('DELETE FROM realtime.messages WHERE topic=$1',[cap.topic])).rowCount,0);
 await topic('existing-member');assert.equal((await select()).rowCount,0);
 const memberId=randomUUID(),memberAuth=randomUUID(),memberSid=randomUUID(),memberTopic='collect:member:'+memberAuth+':'+memberSid;
 await operator();await q("INSERT INTO app.users VALUES($1,'active')",[memberId]);
 await q("INSERT INTO app.auth_sessions VALUES($1,$2,'member',NULL,$3,$4,$4,1,NULL,NULL)",[memberSid,memberId,expires,now]);
 await q('INSERT INTO private.auth_principal_links VALUES($1,$2)',[memberAuth,memberId]);await q('INSERT INTO auth.sessions VALUES($1,$2,NULL,NULL,NULL)',[memberSid,memberAuth]);
 await q("INSERT INTO auth.users VALUES($1,NULL,false,'member@example.invalid',now(),NULL)",[memberAuth]);await q("INSERT INTO realtime.messages VALUES($1,'broadcast','existing','{}',true)",[memberTopic]);
 await q('SET ROLE authenticated');await topic(memberTopic);
 await q("SELECT set_config('fixture.claims',$1,false)",[JSON.stringify({sub:memberAuth,session_id:memberSid,role:'authenticated',exp:expires})]);
 assert.deepEqual((await select()).rows.map(row=>row.topic),[memberTopic]);
 await operator();await q("CREATE POLICY fixture_future_drift ON realtime.messages FOR SELECT TO postgres USING(false)");
 await q('SET ROLE authenticated');assert.equal((await select()).rowCount,0);
 await operator();await q('DROP POLICY fixture_future_drift ON realtime.messages');await q('DELETE FROM realtime.messages WHERE topic=$1',[memberTopic]);
 await runtime('jobs');await q('BEGIN');await insert();await q('ROLLBACK');assert.equal(await count(),1);
 await q("DELETE FROM app.admin_grants WHERE permission='sms.read'");await runtime('jobs');await insert();assert.equal(await count(),1);
 await publicAnon();await topic(cap.topic);assert.equal((await select()).rowCount,0);
 await operator();await q("INSERT INTO app.admin_grants VALUES($1,'sms.read')",[principal]);await q("SELECT set_config('burimunsi.collection_id',$1,false)",[group]);
 await q("UPDATE private.burimunsi_accounts SET credential_version=3");
 await runtime('jobs');await insert();assert.equal(await count(),1);await operator();await q("UPDATE private.burimunsi_accounts SET credential_version=2");
 await runtime('jobs');await q("SET fixture.transport='broken'");await q('INSERT INTO app.contribution_posting_snapshots VALUES($1)',['payment']);
 assert.equal(await count(),1);assert.equal(await one('SELECT count(*)::int value FROM app.contribution_posting_snapshots'),2);await q("SET fixture.transport='ok'");
 await q('UPDATE app.auth_sessions SET revoked_at=$1',[now]);await runtime('jobs');await insert();assert.equal(await count(),1);
 await publicAnon();await topic(cap.topic);assert.equal((await select()).rowCount,0);await operator();await q('UPDATE app.auth_sessions SET revoked_at=NULL');
 // A managed BFF session uses existing GoTrue identity, fixed cookie and group approval.
 await q('INSERT INTO private.auth_principal_links VALUES($1,$2)',[auth,principal]);await q('INSERT INTO private.bff_sessions VALUES($1,$2,$3,NULL)',[cookie,auth,sid]);
 await q("INSERT INTO auth.users VALUES($1,NULL,false,'owner@example.invalid',now(),NULL)",[auth]);await q('INSERT INTO auth.sessions VALUES($1,$2,NULL,NULL,NULL)',[sid,auth]);
 await runtime('http_admin');await q("SET burimunsi.browser_pin_cookie=''");const managed=await issue(group);assert.notEqual(managed.topic,cap.topic);
 await runtime('jobs');await insert();assert.equal(await count(),2);await publicAnon();await topic(managed.topic);assert.equal((await select()).rowCount,1);
 await operator();await q('UPDATE private.burimunsi_operator_approvals SET active=false');
 await runtime('jobs');await insert();assert.equal(await count(),2);await publicAnon();await topic(managed.topic);assert.equal((await select()).rowCount,0);
 await operator();await q('UPDATE private.burimunsi_operator_approvals SET active=true');
 await operator();await q('DELETE FROM auth.sessions');await runtime('jobs');await insert();assert.equal(await count(),2);
 await publicAnon();await topic(managed.topic);assert.equal((await select()).rowCount,0);
 // Advance only the test-held lifespan; runtime clients have no permission to do so.
 await operator();await q("SET fixture.work_kind='maintenance';SET burimunsi.admin_live_frame='1'");
 await q("UPDATE private.burimunsi_admin_live_channels SET expires_at=clock_timestamp()-interval '1 second'");
 await q('DELETE FROM collect_ops.jobs_dispatches WHERE false');
 assert.equal(await one('SELECT count(*)::int value FROM private.burimunsi_admin_live_channels'),0);
});
