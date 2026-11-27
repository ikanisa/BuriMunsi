// The caller starts an isolated PG17 process with TCP disabled and grants Deno
// access only to its temporary UNIX socket. Exercise the shipping driver types.
import assert from 'node:assert/strict';
import postgres from 'npm:postgres@3.4.7';
import {PostgresRecordsStore} from '../../functions/_shared/domain/burimunsi/postgres-records-store.js';
import {RecordsService} from '../../functions/_shared/domain/burimunsi/records-service.js';
import {ScopedCursor} from '../../functions/_shared/domain/burimunsi/cursor.js';

const [socket,port,memberId]=Deno.args;
assert.match(socket,/^\/(?:private\/)?tmp\/collect-pg-transfer-[a-zA-Z0-9]+\/s$/);
assert.match(port,/^5\d{4}$|^60\d{3}$/);
const db=postgres({host:socket,port:Number(port),database:'postgres',user:'collect_fixture',ssl:false,max:1,prepare:false,onnotice(){}});
const group='native-large-fixture',unused=()=>{throw Error('unexpected adapter call');};
const actor={id:'reader',sessionId:'session',groupId:group,role:'staff',capabilities:['records.read'],
  active:true,revoked:false,expiresAt:Date.now()+600000};
const authority={groupId:group,session:async()=>actor,read:fn=>db.begin('read only isolation level repeatable read',async sql=>{
  await sql.unsafe("SET LOCAL ROLE collect_runtime; SET LOCAL collect.edge_verified='true'");
  await sql.unsafe("SELECT set_config('burimunsi.collection_id',$1,true)",[group]);return fn(sql);
})};
const store=new PostgresRecordsStore({authority,paymentsOnly:true,sourceReader:{detail:unused,revision:unused,page:unused}});
const records=new RecordsService({groupId:group,store,paymentsOnly:true,cursor:new ScopedCursor(crypto.getRandomValues(new Uint8Array(32)))});
const page=query=>records.page(actor,'payments',query);
try{
  const [identity]=await db.unsafe("SELECT current_setting('cluster_name') AS cluster,current_setting('listen_addresses') AS listen,inet_server_addr() IS NULL AS local,current_setting('server_version_num')::int/10000 AS major");
  assert.deepEqual({...identity},{cluster:'collect_synthetic_fixture',listen:'',local:true,major:17});
  const empty=await page({memberId:'missing-member',limit:2});
  assert.deepEqual(empty.items,[]);assert.match(empty.revision,/^[a-f0-9]{64}$/);
  const [sample]=await db.unsafe("SELECT occurred_at FROM burimunsi.payments WHERE collection_id=$1 LIMIT 1",[group]);
  assert.ok(sample.occurred_at instanceof Date);
  for(const query of [{limit:2},{limit:2,sort:'newest'}]){
    const first=await page(query);
    assert.equal(first.totalCount,100001);assert.equal(first.items.length,2);assert.ok(first.nextCursor);
    const next=await page({...query,cursor:first.nextCursor});
    assert.equal(next.revision,first.revision);assert.equal(new Set([...first.items,...next.items].map(row=>row.id)).size,4);
    assert.ok([...first.items,...next.items].every(row=>row.groupId===group&&row.sourceId===null));
    const member=await page({...query,memberId});
    assert.equal(member.totalCount,2);assert.ok(member.items.every(row=>row.memberId===memberId));
  }
  const descending=await page({sort:'amount_desc',direction:'outgoing',minRwf:9,maxRwf:10,limit:2});
  assert.deepEqual(descending.items.map(row=>row.amountRwf),[10,10]);
  const reference=await page({q:'N100001',limit:2});assert.deepEqual(reference.items.map(row=>row.id),['native-100001']);
  const before=await page({sort:'oldest',limit:2,memberId});
  await db.unsafe("UPDATE burimunsi.payments SET provider_reference='REVISED' WHERE id='native-1' AND collection_id=$1",[group]);
  // A member-scoped first page with one item has an actual continuation.
  const prior=await page({sort:'oldest',limit:1,memberId});
  await db.unsafe("UPDATE burimunsi.payments SET provider_reference='REVISED-AGAIN' WHERE id='native-1' AND collection_id=$1",[group]);
  await assert.rejects(page({sort:'oldest',limit:1,memberId,cursor:prior.nextCursor}),{code:'cursor_scope_changed'});
  assert.notEqual(prior.revision,before.revision);
  console.log('PASS postgres.js 3.4.7 typed revisions, simple/advanced and member-scoped pages above 100,000 items, narrow search, and stale cursor.');
}finally{await db.end({timeout:4});}
