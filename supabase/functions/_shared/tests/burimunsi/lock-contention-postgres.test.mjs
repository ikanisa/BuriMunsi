import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {loadBuriPostgresFixture} from './postgres-fixture.mjs';

const pg=loadBuriPostgresFixture();
const probe=readFileSync(new URL('../../../../../scripts/supabase/testing/buri-isolated-pg/advisory-contention.sql',import.meta.url),'utf8');
const title='redacted advisory snapshot pairs an actual waiter with its holder';
function snapshot(){
 const r=pg.run('postgres',['-Atq','-F','|'],probe);
 assert.equal(r.status,0,'owned snapshot failed');
 return r.stdout.trim().split('\n').map(line=>line.split('|'));
}
test(title,{skip:!pg,timeout:15000},async()=>{
 const start=sql=>{
  const child=pg.start('postgres',['-Atq']);
  child.stdin.on('error',()=>{});child.stdout.resume();child.stderr.resume();
  const done=new Promise(resolve=>child.once('close',resolve));
  child.stdin.write(sql);
  return {child,done};
 };
 const quiet=snapshot();
 assert.equal(quiet.length,3);
 assert.ok(quiet.every(row=>row[2]==='0'&&row[3]==='0'&&row[11]==='f'));
 const holder=start("BEGIN; SELECT pg_advisory_xact_lock(734636924058501::bigint); SELECT pg_advisory_xact_lock(7346371,99); SELECT 'synthetic-private-marker';\n");
 let waiter;
 try{
  let hasHolder=false;
  for(let i=0;i<30&&!hasHolder;i++){
   hasHolder=snapshot().some(row=>row[1]==='buri-authority'&&row[2]==='1'&&row[3]==='0');
   if(!hasHolder)await delay(50);
  }
  assert.ok(hasHolder);
  waiter=start("BEGIN; SET LOCAL lock_timeout='8s'; SELECT pg_advisory_xact_lock_shared(734636924058501::bigint);\n");
  let matching;
  for(let i=0;i<30&&!matching;i++){
   const rows=snapshot();
   assert.ok(rows.every(r=>r.length===12&&r.every(v=>!v.includes('synthetic-private-marker'))));
   matching=rows.find(r=>r[1]==='buri-authority'&&r[3]==='1'&&r[6]);
   if(!matching)await delay(50);
  }
  assert.ok(matching,'no matching active lock pair');
  assert.equal(matching[2],'1');assert.notEqual(matching[4],matching[6]);
  assert.ok(matching[5]&&matching[7]&&matching[8]);
  assert.equal(matching[9],'idle in transaction');
  assert.equal(matching[10],'1');assert.equal(matching[11],'f');
 }finally{
  holder.child.stdin.end('ROLLBACK;\n');await holder.done;
  if(waiter){waiter.child.stdin.end('ROLLBACK;\n');await waiter.done;}
 }
 assert.ok(snapshot().every(row=>row[2]==='0'&&row[3]==='0'));
});
