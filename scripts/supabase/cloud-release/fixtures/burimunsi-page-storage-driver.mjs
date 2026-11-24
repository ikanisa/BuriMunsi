// Real pinned Edge driver and owned PG17 socket. Every HTTP reply is synthetic.
import assert from 'node:assert/strict';
import postgres from 'npm:postgres@3.4.7';
import {SupabaseObjectBucket} from '../../../../supabase/functions/_shared/storage/bucket.js';
import {storageApplicationPool} from '../../../../supabase/functions/_shared/storage/application-pool.js';
import {PostgresStorageJournal} from '../../../../supabase/functions/_shared/storage/postgres-journal.js';
import {ProtectedStorageProtocol} from '../../../../supabase/functions/_shared/storage/protocol.js';
import {SupabaseNativeTransport} from '../../../../supabase/functions/_shared/storage/supabase-transport.js';

const [socket, portText] = Deno.args;
assert.match(socket, /^\/(?:private\/)?tmp\/collect-pg-transfer-[a-zA-Z0-9]+\/s$/);
const port = Number(portText);
assert.ok(Number.isInteger(port) && port >= 51000 && port <= 60999);
const sql = postgres({host:socket,port,database:'postgres',user:'collect_fixture',max:3,ssl:false,prepare:false,onnotice(){}});
try {
  const [identity] = await sql.unsafe("SELECT inet_server_addr() IS NULL AS local,current_setting('cluster_name') AS name,current_setting('server_version_num')::int/10000 AS major");
  assert.deepEqual({...identity},{local:true,name:'collect_synthetic_fixture',major:17});
  const keys = Array.from({length:10},(_,i)=>'sms/item-'+(i+1)).reverse();
  const namespace = {origin:'https://fixture.invalid',bucket:'private-evidence'};
  let leaseChecks=0,transactions=0,inTransaction=false,checkAllLocks=false,afterLocks=null,alive=true;
  const checked = {async assert(){assert.ok(alive,'lost work');leaseChecks++;},waitUntil:p=>p,abandon:()=>{}};
  const db = {sql,applicationWork:checked,context:raw=>raw.unsafe('SET LOCAL ROLE collect_runtime')};
  const pool = storageApplicationPool(db);
  const journal = new PostgresStorageJournal({async connectJournal(){
    const c=await pool.connectJournal();
    return {release:()=>c.release(),async query(text,values){
      const result=await c.query(text,values);
      if(text==='BEGIN'){assert.equal(inTransaction,false);inTransaction=true;transactions++;}
      if(text==='COMMIT'||text==='ROLLBACK')inTransaction=false;
      if(checkAllLocks && text.includes('row_to_json(p)')){
        const locks=await sql.unsafe(`SELECT bool_or(pg_try_advisory_xact_lock(hashtextextended(k,7346369))) AS acquired
          FROM jsonb_array_elements_text($1::text::jsonb) AS x(k)`,[JSON.stringify(keys)]);
        assert.equal(locks[0].acquired,false);
      }
      if(text.includes('WITH ORDINALITY') && text.includes('pg_advisory_xact_lock')) afterLocks?.();
      return result;
    }};
  }},{namespace});
  let calls=[],mode='valid',checkRenewalLock=false;
  const transport = new SupabaseNativeTransport({url:namespace.origin,bucket:namespace.bucket,secretKey:'sb_secret_synthetic_fixture',
    fetchImpl:async(url,init)=>{
      assert.equal(inTransaction,false,'provider requests must start after releasing journal locks');
      if(checkRenewalLock){
        const [row]=await sql.unsafe('SELECT pg_try_advisory_xact_lock(734636924058501::bigint) AS available');
        assert.equal(row.available,true,'a session renewal can take the exclusive lock while Storage is reading');
      }
      const path=new URL(url).pathname;
      if(path.endsWith('/bucket/'+namespace.bucket)){
        calls.push('bucket');return Response.json({id:namespace.bucket,name:namespace.bucket,public:mode==='public'});
      }
      const match=/\/sms\/item-(\d+)$/.exec(path);assert.ok(match);
      const value='envelope-'+match[1];calls.push(init.method);
      if(mode==='gone')return new Response(init.method==='HEAD'?null:JSON.stringify({code:'NoSuchKey'}),{status:404,headers:{'Content-Type':'application/json'}});
      return new Response(init.method==='HEAD'?null:mode==='corrupt'?value.toUpperCase():value,
        {status:200,headers:{'Content-Length':String(value.length)}});
    }});
  const bucket=Object.assign(Object.create(SupabaseObjectBucket.prototype),{journal,transport,protocol:new ProtectedStorageProtocol({journal,transport})});
  const consume=async(read,targets=keys)=>{
    for(const key of targets)assert.equal(await (await read(key)).text(),'envelope-'+key.split('-')[1]);
  };
  await consume(key=>bucket.get(key));
  const result={original:{transactions,leaseChecks,objects:calls.filter(x=>x==='GET').length}};
  assert.deepEqual(calls,keys.flatMap(()=>['bucket','HEAD','GET']));
  transactions=0;leaseChecks=0;calls=[];checkAllLocks=true;
  let expired;
  checkRenewalLock=true;
  await bucket.withRetainedSmsReads(keys,async read=>{
    expired=read;await assert.rejects(read('sms/unrequested'));await consume(read);
  });
  checkRenewalLock=false;
  await assert.rejects(expired(keys[0]));checkAllLocks=false;
  result.page={transactions,leaseChecks,objects:calls.filter(x=>x==='GET').length};
  assert.deepEqual(calls,keys.flatMap(()=>['bucket','HEAD','GET']));
  // Separate request connections may see the same page in either order.
  const concurrentJournal=new PostgresStorageJournal(pool,{namespace});
  const reversed=[...keys].reverse();
  const [forward,backward]=await Promise.all([
    concurrentJournal.getReceiptReadBindings(keys),concurrentJournal.getReceiptReadBindings(reversed),
  ]);
  assert.deepEqual([...forward.keys()],keys);
  assert.deepEqual([...backward.keys()],reversed);
  for(const key of keys)assert.deepEqual(forward.get(key),backward.get(key));
  for(const bad of [[],[keys[0]],[keys[0],keys[0]],[keys[0],'other/x'],Array.from({length:21},(_,i)=>'sms/'+i)]){
    await assert.rejects(journal.getReceiptReadBindings(bad));
  }
  for(mode of ['public','gone','corrupt']){
    await assert.rejects(bucket.withRetainedSmsReads(keys,read=>read(keys[0])));
  }
  mode='valid';
  const writer=await sql.reserve();let reading;
  try {
    // Wait on the last of the ordered keys. A deletion committed before lock
    // acquisition must be visible to the next, read-committed journal query.
    const last=[...keys].sort().at(-1);
    await writer.unsafe('BEGIN');
    const [{pid}]=await writer.unsafe('SELECT pg_backend_pid() AS pid,pg_advisory_xact_lock(hashtextextended($1,7346369))',[last]);
    await writer.unsafe('DELETE FROM private.storage_objects WHERE object_key=$1',[last]);
    let passedLocks=false;afterLocks=()=>{passedLocks=true;};
    reading=journal.getReceiptReadBindings(keys);
    const until=Date.now()+5000;
    while(!(await sql.unsafe('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting',[pid]))[0].waiting){
      assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,5));
    }
    assert.equal(passedLocks,false);await writer.unsafe('COMMIT');
    const read=await reading;assert.equal(read.get(last).meta,null);assert.equal(read.get(last).intent.state,'committed');
    assert.equal(passedLocks,true);
  } finally {
    await writer.unsafe('ROLLBACK');if(reading)await reading;writer.release();
  }
  alive=false;await assert.rejects(bucket.withRetainedSmsReads(keys,read=>read(keys[0])));
  console.log(JSON.stringify(result));
} finally {
  await sql.end();
}
