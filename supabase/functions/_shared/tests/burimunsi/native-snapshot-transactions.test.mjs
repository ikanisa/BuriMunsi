import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import '../helpers/node-postgres-import.mjs';
import {ownFixtureWork, syntheticFenceBackend, SYNTHETIC_FENCE_SOURCE, finishFixtureWork} from '../helpers/fenced-unit.js';
import {openApplicationWork} from '../../application-fence.js';
const {PostgresDatabase}=await import('../../postgres.js');

afterEach(finishFixtureWork);
const begin='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const claims={sub:'fixture_user'};

async function database({readOnly='on',isolation='repeatable read',role='collect_runtime',failed='',rollbackFails=false}={}) {
  const calls=[], releases=[];
  function execute(text,values=[]) {
    calls.push({text,values});
    if(text===failed || (rollbackFails && text==='ROLLBACK')) throw Error('simulated query failure');
    if(text.includes("set_config('role','collect_runtime',true)")) {
      return readOnly==='on' && isolation==='repeatable read' ? [{runtime_role:role}] : [];
    }
    return [];
  }
  const tx=(parts,...values)=>execute(parts.join('?'),values);
  tx.unsafe=execute;
  tx.release=()=>releases.push(calls.at(-1).text);
  const work=ownFixtureWork(await openApplicationWork({backend:syntheticFenceBackend(),sourceSha256:SYNTHETIC_FENCE_SOURCE,kind:'http_collect'}));
  const db=new PostgresDatabase({reserve:async()=>tx},claims,work);
  return {calls,db,releases};
}

test('native read starts in the required mode and installs its role and bound claims in one exchange',async()=>{
  const {db,calls,releases}=await database();
  await db.withNativeReadSnapshot(async tx=>{
    assert.equal(await db.withNativeReadSnapshot(inner=>inner===tx),true);
    assert.throws(()=>db.transaction(()=>{}),/read_snapshot_cannot_write/);
    await tx.unsafe('SELECT 1');
  });
  assert.equal(calls.length,4);
  assert.equal(calls[0].text,begin);
  assert.match(calls[1].text,/WHERE pg_catalog\.current_setting\('transaction_read_only'\) = 'on'\s+AND pg_catalog\.current_setting\('transaction_isolation'\) = 'repeatable read'/);
  for(const field of ['role','statement_timeout','lock_timeout','search_path','request.jwt.claims','collect.edge_verified']) {
    assert.ok(calls[1].text.includes("set_config('"+field+"'"),field);
  }
  assert.deepEqual(calls[1].values,[JSON.stringify(claims)]);
  assert.deepEqual(calls.slice(-2).map(call=>call.text),['SELECT 1','COMMIT']);
  assert.deepEqual(releases,['COMMIT']);
});

test('unexpected read mode or runtime role rolls back before dispatch',async()=>{
  for(const options of [{readOnly:'off'},{isolation:'read committed'},{role:'postgres'}]) {
    const {db,calls,releases}=await database(options);
    let ran=false;
    await assert.rejects(db.withNativeReadSnapshot(()=>{ran=true;}),{code:'application_fence_unavailable'});
    assert.equal(ran,false);
    assert.equal(calls.at(-1).text,'ROLLBACK');
    assert.deepEqual(releases,['ROLLBACK']);
    assert.equal(calls.length,3);
  }
});

test('a rejected COMMIT rolls back the reserved connection and an unconfirmed rollback quarantines it',async()=>{
  for(const rollbackFails of [false,true]) {
    const {db,calls,releases}=await database({failed:'COMMIT',rollbackFails});
    await assert.rejects(db.withNativeReadSnapshot(async tx=>tx.unsafe('SELECT 1')),/simulated query failure/);
    assert.deepEqual(calls.slice(-2).map(call=>call.text),['COMMIT','ROLLBACK']);
    assert.deepEqual(releases,rollbackFails?[]:['ROLLBACK']);
  }
});
