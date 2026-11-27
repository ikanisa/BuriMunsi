import assert from 'node:assert/strict';
import test from 'node:test';
import pg from '../node_modules/pg/lib/index.js';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';
import {compileSql} from '../../../supabase/functions/_shared/postgres-compatibility-sql.js';
import {readMemberRosterWindow} from '../../../supabase/functions/_shared/domain/admin_member_roster.js';
import {readAllocationMemberPage} from '../../../supabase/functions/_shared/domain/admin_burimunsi_allocation_members.js';

test('large group directory pages, searches and exports stay scoped to a stable revision and immutable allocation member numbers',async t=>{
  const cluster=await startOwnedPg17({prefix:'collect-pg-transfer-',initialUser:'collect_fixture'});
  const db=new pg.Client({host:cluster.socket,port:cluster.port,user:cluster.initialUser,database:'postgres'});
  t.after(async()=>{try{await db.end();}finally{await cluster.close();}});
  await db.connect();
  await db.query(`CREATE SCHEMA app;SET search_path TO app,public;
    CREATE TABLE collections(id text PRIMARY KEY,status text);
    CREATE TABLE users(id text PRIMARY KEY,public_id text,full_name text,member_type text,access_status text,phone text,momo_number text,created_at text);
    CREATE TABLE memberships(collection_id text,user_id text,active int,membership_record_number text,PRIMARY KEY(collection_id,user_id));
    INSERT INTO collections VALUES('one','active'),('two','active');
    INSERT INTO users SELECT md5(i::text)::uuid::text,lpad(i::text,6,'0'),
      CASE WHEN i=10000 THEN 'Élodie Jean-Claude' WHEN i<=45 THEN 'Identical operator choice' ELSE 'Member '||i::text END,
      'direct','active',CASE WHEN i=10000 THEN '+256700123456' END,
      CASE WHEN i=10000 THEN '0788000512' WHEN i=9999 THEN '0788000456' END,'2026-11-27T00:00:00.000Z'
      FROM generate_series(1,10001)i;
    INSERT INTO memberships SELECT CASE WHEN i=10001 THEN 'two' ELSE 'one' END,md5(i::text)::uuid::text,
      CASE WHEN i=46 THEN 0 ELSE 1 END,(100000000000::bigint+i)::text FROM generate_series(1,10001)i;
    ANALYZE`);
  const env={DB:{prepare:sql=>({bind:(...args)=>compileSql(sql,args)}),batch:async statements=>Promise.all(statements.map(async statement=>({results:(await db.query(statement)).rows})))}};
  const sql={unsafe:async(text,args)=>(await db.query(text,args)).rows};
  const page=async({group='one',limit=25,offset=0,sort='public_id_asc',search='',columns,revision}={})=>{
    const url=new URL('https://fixture.invalid/?directory=roster&window=1');
    if(columns) url.searchParams.set('columns',JSON.stringify(columns));
    if(revision)url.searchParams.set('revision',revision);
    return readMemberRosterWindow(env,group,url,{limit,offset,sort,search});
  };
  const started=performance.now();
  const first=await page();
  t.diagnostic('First 25 records from 10,000 in-group members: '+Math.round(performance.now()-started)+' ms on this local PostgreSQL 17 fixture.');
  assert.equal(first.items.length,25);assert.equal(first.total,10000);assert.equal(first.matching,10000);
  const revision=first.revision;assert.match(revision,/^[a-f0-9]{64}$/);
  assert.equal((await page({offset:9975,revision})).items.at(-1).publicId,'010000');
  assert.equal((await page({revision,search:'type:direct status:active claud élo'})).items[0].publicId,'010000');
  assert.equal((await page({search:'+256 (700) 123 456',revision})).matching,1);
  assert.equal((await page({search:'0788 000 512',revision})).matching,0);
  assert.equal((await page({search:'0788 000 456',revision})).matching,1);
  assert.equal((await page({search:'010001',revision})).matching,0);
  assert.equal((await page({columns:[['phone','present',''],['full_name','any','elo claud'],['status','any',['active']]],revision})).matching,1);
  assert.equal((await page({columns:[['phone','blank','']],revision})).matching,9998);
  assert.equal((await page({group:'two'})).total,1);
  const seen=new Set();for(let offset=0;offset<10000;offset+=100){
    const batch=await page({offset,limit:100,revision});
    for(const member of batch.items){assert(!seen.has(member.id));seen.add(member.id);}
  }
  assert.equal(seen.size,10000);
  const choices=await readAllocationMemberPage(sql,'one',{q:'Identical operator choice',limit:25});
  assert.equal(choices.items.length,25);assert.equal(choices.nextCursor,choices.items.at(-1).id);
  const next=await readAllocationMemberPage(sql,'one',{q:'Identical operator choice',limit:25,after:choices.nextCursor});
  assert.equal(next.items.length,20);assert.equal(next.nextCursor,null);
  assert.equal(new Set([...choices.items,...next.items].map(m=>m.id)).size,45);
  const last=next.items.at(-1);
  for(const q of [last.publicId,last.memberNumber]){
    const byNumber=await readAllocationMemberPage(sql,'one',{q,limit:25});
    assert.deepEqual(byNumber.items,[last]);assert.equal(byNumber.nextCursor,null);
  }
  for(const q of ['000046','010001'])assert.equal((await readAllocationMemberPage(sql,'one',{q,limit:25})).items.length,0);
  await db.query("UPDATE users SET full_name='Changed outside the group' WHERE public_id='010001'");
  assert.equal((await page({revision})).revision,revision);
  await db.query("UPDATE users SET full_name='Equal-count in-group edit' WHERE public_id='000002'");
  await assert.rejects(page({revision,offset:25}),error=>error.code==='member_roster_changed');
  assert.notEqual((await page()).revision,revision);
});
