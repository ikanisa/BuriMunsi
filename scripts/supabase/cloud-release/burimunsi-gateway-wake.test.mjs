import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import pg from '../node_modules/pg/lib/index.js';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';

const read=name=>readFile(new URL('../../../supabase/migrations/'+name,import.meta.url),'utf8');
const [migration,unpaired,admin,member]=await Promise.all([read('20261122191500_burimunsi_gateway_realtime_wake.sql'),
 read('20261122204000_burimunsi_unpaired_sender_wake.sql'),
 read('20261122191400_burimunsi_admin_realtime.sql'),read('20261022200028_collect_private_member_realtime.sql')]);
const hash=value=>createHash('sha256').update(value).digest('hex');
const device='synthetic-sender',app='app_'+randomUUID(),group=randomUUID(),token=hash(randomBytes(32)),other=hash(randomBytes(32));
const existingAdmin='buri:ops:'+'a'.repeat(64),memberId=randomUUID(),session=randomUUID();

test('original payer work wakes a currently authorized managed sender using only a private refetch signal',async t=>{
 const cluster=await startOwnedPg17({prefix:'collect-pg-transfer-',initialUser:'fixture_bootstrap'});
 const db=new pg.Client({host:cluster.socket,port:cluster.port,user:cluster.initialUser,database:'postgres'});
 t.after(async()=>{try{await db.end();}finally{await cluster.close();}});await db.connect();
 const q=(sql,args=[])=>db.query(sql,args),one=async(sql,args=[])=>(await q(sql,args)).rows[0].v;
 const as=role=>q('SET ROLE '+role);
 await q(`CREATE ROLE postgres NOSUPERUSER NOBYPASSRLS; CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE ROLE collect_runtime;CREATE ROLE collect_sms_runtime;CREATE ROLE collect_importer;
 CREATE SCHEMA private AUTHORIZATION postgres;CREATE SCHEMA collect_sms AUTHORIZATION postgres;
 CREATE SCHEMA app AUTHORIZATION postgres;CREATE SCHEMA auth AUTHORIZATION postgres;CREATE SCHEMA realtime AUTHORIZATION postgres;
 SET ROLE postgres;
 GRANT USAGE ON SCHEMA realtime TO anon,authenticated;GRANT USAGE ON SCHEMA collect_sms TO collect_sms_runtime;
 CREATE TABLE private.collect_fence_control(singleton boolean,mode text,source_sha256 text);
 INSERT INTO private.collect_fence_control VALUES(true,'fenced',repeat('a',64));
 CREATE FUNCTION private._collect_fence_require_operator() RETURNS void LANGUAGE plpgsql AS $$BEGIN IF current_user<>'postgres' THEN RAISE insufficient_privilege;END IF;END$$;
 CREATE FUNCTION collect_sms.work_assert_write(uuid,bigint,text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
  IF current_setting('role',true)<>'collect_sms_runtime' OR current_setting('collect.sms_verified',true) IS DISTINCT FROM 'true' THEN RAISE insufficient_privilege;END IF;END$$;
 CREATE FUNCTION collect_sms.serialize_gateway_write() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 PERFORM collect_sms.work_assert_write(NULL,NULL,NULL);RETURN NULL;END$$;
 CREATE TABLE collect_sms.devices(installation_id text PRIMARY KEY,token_hash text,allowed_kinds text,ready int,revoked_at text);
 CREATE TABLE collect_sms.applications(application_id text PRIMARY KEY,token_hash text,allowed_kinds text,revoked_at text);
 CREATE TABLE collect_sms.messages(message_id text PRIMARY KEY,application_id text,idempotency_key text,state text,kind text,cancel_requested int,owner_installation_id text,text text DEFAULT 'synthetic receipt',to_number text DEFAULT '+250780000001');
 CREATE TABLE app.collections(id text PRIMARY KEY,status text NOT NULL);
 CREATE TABLE private.burimunsi_scopes(collection_id text PRIMARY KEY,enabled boolean,active_binding_id text); CREATE TABLE private.burimunsi_payment_sms_deliveries(message_id text,application_id text,idempotency_key text,collection_id text,body_sha256 text,destination_sha256 text);
 GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA collect_sms TO collect_sms_runtime;
 CREATE TABLE private.member_realtime_control(singleton boolean,enabled boolean,policy_sha256 text,source_sha256 text,attempted_total bigint);
 CREATE TABLE private.auth_principal_links(auth_user_id uuid,user_id text);CREATE TABLE app.users(id text,access_status text);
 CREATE TABLE app.auth_sessions(id text,user_id text,surface text,revoked_at bigint,expires_at bigint);CREATE TABLE auth.users(id uuid,deleted_at timestamptz,banned_until timestamptz); CREATE TABLE auth.sessions(id uuid,user_id uuid,not_after timestamptz);
 CREATE FUNCTION private.request_claims() RETURNS jsonb LANGUAGE sql AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
 CREATE TABLE realtime.messages(topic text,extension text,event text,payload jsonb,private boolean,id uuid DEFAULT gen_random_uuid());
 ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;ALTER TABLE realtime.messages FORCE ROW LEVEL SECURITY;
 GRANT SELECT,INSERT,UPDATE,DELETE ON realtime.messages TO anon,authenticated;
 CREATE POLICY fixture_operator_read ON realtime.messages FOR SELECT TO postgres USING(true);
 CREATE POLICY collect_member_no_anonymous_v1 ON realtime.messages AS RESTRICTIVE FOR ALL TO anon USING(false) WITH CHECK(false);
 CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$SELECT current_setting('realtime.topic',true)$$;
 CREATE FUNCTION realtime.send(payload jsonb,event text,topic text,private boolean) RETURNS void LANGUAGE plpgsql AS $$
 DECLARE transport uuid:=gen_random_uuid();BEGIN IF current_setting('fixture.offline',true)='1' THEN RAISE EXCEPTION 'offline';END IF;
 PERFORM set_config('realtime.topic',topic,true);INSERT INTO realtime.messages VALUES(topic,'broadcast',event,jsonb_set(payload,'{id}',to_jsonb(transport)),private,transport);END$$;
 CREATE FUNCTION private.burimunsi_admin_live_join(p_topic text) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$SELECT p_topic='buri:ops:'||repeat('a',64) AND p_topic=realtime.topic()$$;
 CREATE FUNCTION private._retention_manifest_catalog_v2() RETURNS jsonb LANGUAGE sql AS $$SELECT '{"private_classes":[]}'::jsonb$$;
 CREATE FUNCTION private.retention_capture_inventory_v2(uuid,text,bigint,text,integer) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_array('managed:storage_iceberg')$$;`);
 for(const name of ['_collect_member_realtime_metadata','_collect_member_realtime_metadata_sha','collect_member_realtime_join','collect_member_realtime_configure','collect_member_realtime_publish']){
  const definition=member.slice(member.indexOf('CREATE FUNCTION private.'+name+'('));
  const end=definition.match(/\$(?:fn|meta)\$;/);assert.ok(end);await q(definition.slice(0,end.index+end[0].length));
 }
 await q("CREATE POLICY fixture_member ON realtime.messages FOR SELECT TO authenticated USING(extension='broadcast' AND topic=realtime.topic() AND private.collect_member_realtime_join(realtime.topic()))");
 await q("INSERT INTO private.member_realtime_control VALUES(true,true,private._collect_member_realtime_metadata_sha(),repeat('a',64),0)");
 await q("SELECT set_config('burimunsi.admin_live_member_preimage',private._collect_member_realtime_metadata_sha(),false)");
 const hardened=admin.slice(admin.indexOf('ALTER POLICY collect_member_no_anonymous_v1'),admin.indexOf('END;$member_pin$;')+'END;$member_pin$;'.length);
 await q(hardened);
 await q("INSERT INTO app.collections VALUES($1,'active')",[group]);
 await q('INSERT INTO private.burimunsi_scopes VALUES($1,false,NULL)',[group]);
 await q("INSERT INTO collect_sms.devices VALUES($1,$2,'[\"receipt\"]',1,NULL)",[device,token]);
 await q("INSERT INTO collect_sms.applications VALUES($1,$2,'[\"receipt\"]',NULL)",[app,other]);
 const receipt=async key=>q("INSERT INTO private.burimunsi_payment_sms_deliveries VALUES($1,$2,$3,$4,$5,$6)",[app+':'+key,app,key,group,hash('synthetic receipt'),hash('+250780000001')]);
 for(const key of ['first','rotated','offline','revoked','ambiguous','expired','rollback','wrong-content','wrong-recipient'])await receipt(key);
 for(const relation of ['collect_sms.devices','collect_sms.applications','app.collections','private.burimunsi_scopes','private.burimunsi_payment_sms_deliveries']){
  await q('ALTER TABLE '+relation+' ENABLE ROW LEVEL SECURITY;ALTER TABLE '+relation+' FORCE ROW LEVEL SECURITY');
  if(relation.startsWith('collect_sms'))await q('CREATE POLICY gateway_runtime ON '+relation+' TO collect_sms_runtime USING(true) WITH CHECK(true)');
 }
 await q(migration);
 await q(unpaired);
 await q(`CREATE FUNCTION collect_sms.fixture_expire() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
 BEGIN PERFORM set_config('burimunsi.gateway_wake_frame','1',true);
 UPDATE private.burimunsi_gateway_wake_channels SET expires_at=clock_timestamp()-interval '1 second';END$$`);
 await q("UPDATE private.collect_fence_control SET mode='open'");
 await q('INSERT INTO private.auth_principal_links VALUES($1,$2)',[memberId,'member']);await q("INSERT INTO app.users VALUES('member','active')");
 await q("INSERT INTO app.auth_sessions VALUES($1,'member','member',NULL,9999999999)",[session]);await q('INSERT INTO auth.users VALUES($1,NULL,NULL)',[memberId]);await q('INSERT INTO auth.sessions VALUES($1,$2,NULL)',[session,memberId]);
 const memberTopic='collect:member:'+memberId+':'+session;
 const gateway=async()=>{await as('collect_sms_runtime');await q("SET collect.sms_verified='true'");};
 const issue=async(key=token,g=group,a=app)=>one('SELECT collect_sms.burimunsi_gateway_wake_channel($1,$2,$3,$4) v',[device,key,g,a]);
 const put=(key,a=app,kind='receipt')=>q("INSERT INTO collect_sms.messages VALUES($1,$2,$3,'accepted',$4,0,NULL)",[a+':'+key,a,key,kind]);
 const topic=v=>q("SELECT set_config('realtime.topic',$1,false)",[v]);
 const joined=async v=>{await as('anon');await topic(v);return one('SELECT count(*)::int v FROM realtime.messages WHERE topic=$1',[v]);};
 const read=async()=>{await as('postgres');return (await q('SELECT topic,event,payload,private FROM realtime.messages ORDER BY topic')).rows;};
 await gateway();assert.equal(await issue(other),null);assert.equal(await issue(token,'wrong'),null);assert.equal(await issue(token,group,'wrong'),null);
 const lease=await issue();assert.match(lease.topic,/^buri:gw:[0-9a-f]{64}$/);assert.deepEqual(await issue(),lease);
 assert.equal(JSON.stringify(lease).includes(device),false);assert.equal(JSON.stringify(lease).includes(token),false);
 await put('other');await put('first',app,'receipt');assert.equal(await joined(lease.topic),1);
 // An existing subscriber also loses access as soon as the group or its
 // configured bound receiver becomes ineligible.
 await q('RESET ROLE');await q("UPDATE app.collections SET status='archived'");await gateway();
 assert.equal(await issue(),null);assert.equal(await joined(lease.topic),0);
 await q('RESET ROLE');await q("UPDATE app.collections SET status='active'");
 await q("UPDATE private.burimunsi_scopes SET active_binding_id='paired',enabled=false");await gateway();
 assert.equal(await issue(),null);assert.equal(await joined(lease.topic),0);
 await q('RESET ROLE');await q("UPDATE private.burimunsi_scopes SET enabled=true");await gateway();
 assert.deepEqual(await issue(),lease);assert.equal(await joined(lease.topic),1);
 await q('RESET ROLE');await q('UPDATE private.burimunsi_scopes SET active_binding_id=NULL,enabled=false');
 await gateway();for(const [key,text,to] of [['wrong-content','incorrect','+250780000001'],['wrong-recipient','synthetic receipt','+250780000002']]){
  await q("INSERT INTO collect_sms.messages VALUES($1,$2,$3,'accepted','receipt',0,NULL,$4,$5)",[app+':'+key,app,key,text,to]);
 }assert.equal(await joined(lease.topic),1);
 await assert.rejects(q("INSERT INTO realtime.messages VALUES($1,'broadcast','gateway_sync','{}',true,gen_random_uuid())",[lease.topic]),/row-level security/);
 await assert.rejects(q('SELECT * FROM private.burimunsi_gateway_wake_channels'),/permission denied/);
 const row=(await read())[0];assert.equal(row.event,'gateway_sync');assert.equal(row.private,true);assert.deepEqual(Object.keys(row.payload).sort(),['changed','id']);assert.equal(row.payload.changed,true);
 assert.equal(await joined('buri:gw:'+'0'.repeat(64)),0);
 await gateway();await q('BEGIN');await put('rollback');await q('ROLLBACK');assert.equal((await read()).length,1);
 await gateway();await q("SET fixture.offline='1'");await put('offline');await q("SET fixture.offline='0'");
 assert.equal((await read()).length,1);await gateway();assert.equal(await one("SELECT count(*)::int v FROM collect_sms.messages WHERE idempotency_key='offline'"),1);
 await q('UPDATE collect_sms.devices SET token_hash=$1 WHERE installation_id=$2',[other,device]);
 assert.equal(await issue(),null);const rotated=await issue(other);assert.notEqual(rotated.topic,lease.topic);await put('rotated');
 assert.equal(await joined(lease.topic),0);assert.equal(await joined(rotated.topic),1);
 await gateway();await q('BEGIN');await q("UPDATE collect_sms.messages SET owner_installation_id=$1,cancel_requested=1 WHERE idempotency_key='rotated'",[device]);
 assert.equal(await one("SELECT count(*)::int v FROM collect_sms.messages WHERE idempotency_key='rotated'"),1);
 await as('postgres');assert.equal(await one("SELECT count(*)::int v FROM realtime.messages WHERE topic=$1",[rotated.topic]),2);await q('ROLLBACK');
 await gateway();await q("INSERT INTO collect_sms.devices VALUES('second',repeat('f',64),'[\"receipt\"]',1,NULL)");assert.equal(await issue(other),null);
 await put('ambiguous');assert.equal((await read()).length,2);assert.equal(await joined(rotated.topic),0);
 await gateway();await q("UPDATE collect_sms.devices SET ready=0 WHERE installation_id='second'");
 await q('SELECT collect_sms.fixture_expire()');assert.equal(await joined(rotated.topic),0);
 await gateway();await put('expired');assert.equal((await read()).length,2);
 await gateway();const renewed=await issue(other);assert.notEqual(renewed.topic,rotated.topic);
 await q("UPDATE collect_sms.devices SET revoked_at='revoked' WHERE installation_id=$1",[device]);await put('revoked');
 assert.equal(await issue(other),null);assert.equal(await joined(rotated.topic),0);assert.equal((await read()).length,2);
 await q('RESET ROLE');await q("INSERT INTO realtime.messages VALUES($1,'broadcast','operations_changed','{\"changed\":true}',true,gen_random_uuid())",[existingAdmin]);
 assert.equal(await joined(existingAdmin),1);
 await as('postgres');await q("SELECT set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'authenticated',sub:memberId,session_id:session,exp:9999999999})]);
 const memberJoin=()=>one('SELECT private.collect_member_realtime_join($1) v',[memberTopic]);
 assert.equal(await memberJoin(),true);await q("CREATE POLICY fixture_drift ON realtime.messages FOR SELECT TO postgres USING(false)");assert.equal(await memberJoin(),false);
});
