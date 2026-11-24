import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmod,link,mkdir,mkdtemp,readFile,readdir,realpath,rm,stat,symlink,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {INVENTORY_FORMAT,POLICY_FORMAT,verifyInventory} from './verify.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const wire=value=>Buffer.from(JSON.stringify(value)+'\n');
const sourceCommit='a'.repeat(40),scopeSha256=hash('synthetic scope'),snapshotSha256=hash('synthetic approved snapshot');
const fmt='collect.storage.synthetic-byte-readback-map.v1';
const cli=fileURLToPath(new URL('./readback.mjs',import.meta.url));
const ordinal=i=>String(i+1).padStart(6,'0')+'.opaque';

async function testContext(t,{sizes, count=61}={}) {
  const privateDir=await realpath(await mkdtemp(join(tmpdir(),'synthetic-readback-')));
  t.after(async()=>rm(privateDir,{recursive:true,force:true}));
  const restore=join(privateDir,'synthetic-inert'), output=join(privateDir,'new-receipts');
  await Promise.all([mkdir(restore,{mode:0o700}),mkdir(output,{mode:0o700})]);
  const bodies=Array.from({length:count},(_,i)=>i===0?Buffer.alloc(0):Buffer.from('synthetic bytes '+String(i).padStart(6,'0')));
  const objects=bodies.map((body,i)=>({identitySha256:hash('synthetic opaque identity '+i),versionSha256:hash('synthetic opaque version '+i),
    sizeBytes:sizes?.[i]??body.length,bodySha256:hash(body)}));
  const referenceBytes=wire({format:INVENTORY_FORMAT,sourceCommit,scopeSha256,snapshotSha256,objects});
  const referenceSha256=hash(referenceBytes);
  const policyBytes=wire({format:POLICY_FORMAT,sourceCommit,scopeSha256,snapshotSha256,referenceSha256,
    maxObjects:500,maxObjectBytes:128*1024*1024,maxTotalBytes:512*1024*1024});
  const policySha256=hash(policyBytes);
  const plan={format:fmt,syntheticOnly:true,policySha256,referenceSha256,sourceCommit,scopeSha256,snapshotSha256,
    files:objects.map(({bodySha256:_,...o},i)=>({ordinal:i+1,...o}))};
  const policyPath=join(privateDir,'policy.json'), refPath=join(privateDir,'reference.json'), mapPath=join(privateDir,'map.json');
  const bodyPath=i=>join(restore,ordinal(i));
  await Promise.all([writeFile(policyPath,policyBytes,{mode:0o600}),writeFile(refPath,referenceBytes,{mode:0o600}),
    ...bodies.map((body,i)=>writeFile(bodyPath(i),body,{mode:0o600}))]);
  async function bind(value=plan) {
    const bytes=wire(value);await writeFile(mapPath,bytes,{mode:0o600});return hash(bytes);
  }
  let mapSha=await bind();
  function run({digest=mapSha, source=restore, destination=output}={}) {
    try {return JSON.parse(execFileSync(process.execPath,[cli,policySha256,policyPath,refPath,digest,mapPath,source,destination],
      {stdio:['ignore','pipe','pipe'],encoding:'utf8'}));}
    catch(e) {
      assert.equal(e.status,1);assert.equal(e.stderr,'');assert.ok(!e.stdout.includes(privateDir));
      assert.ok(!e.stdout.includes(objects[0].identitySha256));
      return JSON.parse(e.stdout);
    }
  }
  async function refuse(reason,args) {
    assert.equal(run(args).reason,reason);
    assert.deepEqual(await readdir(output),[]);
  }
  return {objects,bodies,bodyPath,output,restore,privateDir,policyBytes,policySha256,referenceBytes,plan,bind,run,refuse};
}
test('hashes all 61 separately supplied synthetic files including zero bytes and publishes a compatible 0600 private manifest',async t=>{
  const c=await testContext(t);
  const result=c.run();
  assert.deepEqual(Object.keys(result),['format','status','syntheticOnly','objectCount','readbackBytes',
    'operationalStorageRecoveryVerified','independentCustodyVerified','migrationAuthorized']);
  assert.equal(result.status,'matched');
  assert.equal(result.objectCount,61);
  assert.equal(result.readbackBytes,c.bodies.reduce((total,body)=>total+body.length,0));
  for(const field of ['operationalStorageRecoveryVerified','independentCustodyVerified','migrationAuthorized'])assert.equal(result[field],false);
  assert.deepEqual(await readdir(c.output),['observed-manifest.json']);
  const path=join(c.output,'observed-manifest.json');
  assert.equal((await stat(path)).mode&0o777,0o600);
  const observedBytes=await readFile(path);
  assert.equal(JSON.parse(observedBytes).objects[0].bodySha256,hash(Buffer.alloc(0)));
  assert.deepEqual(JSON.parse(observedBytes).objects,c.objects);
  assert.equal(verifyInventory({policyBytes:c.policyBytes,expectedPolicySha256:c.policySha256,referenceBytes:c.referenceBytes,observedBytes}).objectCount,61);
  assert.equal(c.run().reason,'ROOT_INVENTORY_MISMATCH');
  assert.deepEqual(await readFile(path),observedBytes);
});
test('refuses corrupt length or same-size changed/swap bytes without leaving a manifest',async t=>{
  const c=await testContext(t);
  const target=c.bodyPath(59), old=c.bodies[59];
  await writeFile(target,Buffer.concat([old,Buffer.of(0)]));
  await c.refuse('BODY_LENGTH_MISMATCH');
  await writeFile(target,Buffer.alloc(old.length,9));
  await c.refuse('BODY_HASH_MISMATCH');
  await writeFile(target,c.bodies[58]);
  await writeFile(c.bodyPath(58),old);
  await c.refuse('BODY_HASH_MISMATCH');
});
test('refuses a symlink, hard link, extra directory entry, or unsafe output/path without publishing',async t=>{
  const c=await testContext(t);
  await unlink(c.bodyPath(1));
  await symlink(c.bodyPath(2),c.bodyPath(1));
  await c.refuse('ROOT_INVENTORY_MISMATCH');
  await unlink(c.bodyPath(1));
  await link(c.bodyPath(2),c.bodyPath(1));
  await c.refuse('BODY_FILE_INVALID');
  await unlink(c.bodyPath(1));
  await writeFile(c.bodyPath(1),c.bodies[1],{mode:0o600});
  const extra=join(c.restore,'unapproved');
  await writeFile(extra,'unexpected',{mode:0o600});
  await c.refuse('ROOT_INVENTORY_MISMATCH');
  await unlink(extra);
  await c.refuse('ROOT_PATH_INVALID',{source:c.restore+'/../synthetic-inert'});
  await c.refuse('ROOT_SCOPE_OVERLAP',{destination:c.restore});
  await chmod(c.output,0o755);
  await c.refuse('ROOT_NOT_PRIVATE');
});
test('pins reviewed map, source, version, identity and fixed ordinals before any body file opens',async t=>{
  const c=await testContext(t);
  const check=async(value,reason)=>c.refuse(reason,{digest:await c.bind(value),source:'/nonexistent-synthetic-root'});
  await c.refuse('MAP_PIN_MISMATCH',{digest:hash('unapproved policy'),source:'/nonexistent-synthetic-root'});
  for(const [mutate,reason] of [
    [p=>{p.syntheticOnly=false;},'MAP_SCOPE_MISMATCH'],
    [p=>{p.snapshotSha256=hash('some other snapshot');},'MAP_SCOPE_MISMATCH'],
    [p=>{p.files=p.files.slice(1);},'MAP_COUNT_BOUND'],
    [p=>{p.files[1].identitySha256=p.files[2].identitySha256;},'MAP_OBJECT_MISMATCH'],
    [p=>{p.files[1].filename='../unapproved';},'MAP_SHAPE_INVALID'],
    [p=>{p.files[1].ordinal=0;},'MAP_OBJECT_MISMATCH'],
    [p=>{p.files[1].versionSha256=hash('some other version');},'MAP_OBJECT_MISMATCH'],
    [p=>{p.files[1].sizeBytes+=1;},'MAP_OBJECT_MISMATCH'],
  ]) {const next=structuredClone(c.plan);mutate(next);await check(next,reason);}
});
test('refuses incorrect per-file budget and combined budget even if the pinned synthetic plan matches reference',async t=>{
  const mib=1024*1024;
  const per=await testContext(t,{count:1,sizes:[65*mib]});
  await per.refuse('READBACK_SIZE_BOUND',{source:'/nonexistent-synthetic-root'});
  const total=await testContext(t,{count:3,sizes:[64*mib,64*mib,1]});
  await total.refuse('READBACK_SIZE_BOUND',{source:'/nonexistent-synthetic-root'});
});
