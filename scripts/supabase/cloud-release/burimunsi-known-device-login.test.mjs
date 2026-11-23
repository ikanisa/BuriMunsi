import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from '../node_modules/pg/lib/index.js';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const direct = hash('collect.native.supabase-direct.global-budget.v1|https://rrlduytparvsjfmegalh.supabase.co');
const migration = file => readFile(new URL('../../../supabase/migrations/'+file,import.meta.url),'utf8');

test('returning verified handsets can sign in through a shift-start burst while new devices retain the public admission limit',async t=>{
  const cluster=await startOwnedPg17({prefix:'collect-pg-transfer-',initialUser:'fixture_bootstrap'});
  const db=new pg.Client({host:cluster.socket,port:cluster.port,user:cluster.initialUser,database:'postgres'});
  t.after(async()=>{try{await db.end();}finally{assert.equal((await cluster.close()).removed,true);}});
  await db.connect();
  await db.query(`CREATE ROLE postgres NOSUPERUSER; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE ROLE collect_runtime; CREATE ROLE collect_importer; CREATE SCHEMA private AUTHORIZATION postgres;
    CREATE SCHEMA app AUTHORIZATION postgres; SET ROLE postgres;
    CREATE TABLE private.collect_fence_control(singleton boolean,mode text);
    INSERT INTO private.collect_fence_control VALUES(true,'fenced');
    CREATE FUNCTION private._collect_fence_require_operator() RETURNS void LANGUAGE sql AS 'SELECT';
    CREATE FUNCTION private.burimunsi_setup_fence() RETURNS void LANGUAGE sql AS 'SELECT';
    CREATE TABLE private.burimunsi_accounts(id uuid,collection_id text,principal_user_id text,phone text,name text,role text,
      capabilities text[],active boolean,removed boolean,pin_hash jsonb,credential_version bigint,version bigint);
    CREATE TABLE private.burimunsi_device_grants(id uuid primary key,collection_id text,installation_id uuid,token_hash text,profile text,active boolean);
    CREATE TABLE private.burimunsi_device_accounts(grant_id uuid,collection_id text,account_id uuid);
    CREATE TABLE private.burimunsi_scopes(collection_id text);
    CREATE TABLE app.collections(id text,status text);
    INSERT INTO private.burimunsi_scopes VALUES('scope');
    INSERT INTO app.collections VALUES('scope','active');
    CREATE FUNCTION private.burimunsi_pin_authority_snapshot(text,text,text,text,text[]) RETURNS jsonb LANGUAGE sql AS 'SELECT jsonb_build_object()';
    CREATE TABLE private.burimunsi_pin_login_limits(bucket text,window_start bigint,attempts bigint,PRIMARY KEY(bucket,window_start));`);
  const previous=await migration('20261110143000_burimunsi_native_phone_pin.sql');
  const from=previous.indexOf('CREATE FUNCTION private.burimunsi_pin_login_budget(');
  const until=previous.indexOf('CREATE FUNCTION private.burimunsi_pin_create_session(',from);
  assert.ok(from>0 && until>from);
  await db.query(previous.slice(from,until));
  await db.query("CREATE FUNCTION private.burimunsi_observation_storage_commit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$; GRANT USAGE,CREATE ON SCHEMA private TO postgres;");
  await db.query(await migration('20261122191200_burimunsi_known_device_login_budget.sql'));
  await db.query("SET ROLE postgres; CREATE FUNCTION private.synthetic_new_operator_rpc() RETURNS int LANGUAGE sql AS 'SELECT 1'; RESET ROLE");
  const privileges=(await db.query("SELECT has_function_privilege('anon','private.synthetic_new_operator_rpc()','execute') AS future_public,has_function_privilege('authenticated','private.burimunsi_observation_storage_commit()','execute') AS trigger_public")).rows[0];
  assert.deepEqual(privileges,{future_public:false,trigger_public:false});
  const call=async(phone,device,key,network=direct,profile='internal_receiver')=>(await db.query(
    'SELECT private.burimunsi_pin_login_account($1,$2,$3::uuid,$4,floor(extract(epoch from clock_timestamp())*1000)::bigint,$5,$6) result',
    [phone,hash(phone),device,network,key,profile])).rows[0].result;
  const phones=Array.from({length:60},(_,i)=>'+25078'+String(1000000+i));
  const handsets=[];
  for(const phone of phones){
    const installation=randomUUID(), id=randomUUID(), grant=randomUUID(), key=hash(randomUUID());
    await db.query("INSERT INTO private.burimunsi_accounts VALUES ($1,'scope','operator',$2,'Test operator','admin',array[]::text[],true,false,'{}',1,1)",[id,phone]);
    await db.query("INSERT INTO private.burimunsi_device_grants VALUES ($1,'scope',$2,$3,'internal_receiver',true)",[grant,installation,key]);
    await db.query("INSERT INTO private.burimunsi_device_accounts VALUES($1,'scope',$2)",[grant,id]);
    handsets.push({phone,installation,key});
  }
  const shift=await Promise.all(handsets.map(({phone,installation,key})=>call(phone,installation,key)));
  assert.ok(shift.every(result=>result.allowed && result.account.phone));
  const unexpected=Array.from({length:51},(_,i)=>[ '+25079'+String(2000000+i),randomUUID(),hash(randomUUID()) ]);
  const fresh=await Promise.all(unexpected.map(args=>call(...args)));
  assert.equal(fresh.filter(x=>x.allowed).length,50);
  const one=handsets[0];
  assert.equal((await call(one.phone,one.installation,hash('wrong-device'))).allowed,false);
  assert.equal((await call(one.phone,one.installation,one.key,direct,'staff')).allowed,false);
  assert.equal((await call(one.phone,one.installation,one.key)).allowed,true);
  for(let attempt=0;attempt<3;attempt++) await call(one.phone,one.installation,one.key);
  assert.equal((await call(one.phone,one.installation,one.key)).allowed,false);
  const access=await db.query("SELECT has_function_privilege('anon','private.burimunsi_pin_login_account(text,text,uuid,text,bigint,text,text)','EXECUTE') AS anonymous,has_function_privilege('collect_runtime','private.burimunsi_pin_login_account(text,text,uuid,text,bigint,text,text)','EXECUTE') AS runtime");
  assert.deepEqual(access.rows[0],{anonymous:false,runtime:true});
});
