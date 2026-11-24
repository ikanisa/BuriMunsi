import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmod,mkdtemp,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import {INVENTORY_FORMAT,POLICY_FORMAT,RESULT_FORMAT,verifyInventory} from './verify.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const wire=value=>Buffer.from(JSON.stringify(value)+'\n');
const source='a'.repeat(40),scope=sha('synthetic scope'),snapshot=sha('synthetic snapshot');
function entries() {
  return Array.from({length:61},(_,i)=>({
    identitySha256:sha('synthetic identity '+i),versionSha256:sha('synthetic version '+i),
    sizeBytes:i===60?1_390_766:1_066_666,bodySha256:sha('synthetic body digest '+i),
  }));
}
const fixture=objects=>({format:INVENTORY_FORMAT,sourceCommit:source,scopeSha256:scope,snapshotSha256:snapshot,objects});
function inputs(observed=fixture(entries()),modifyPolicy=()=>{},reference=wire(fixture(entries()))) {
  const policy={format:POLICY_FORMAT,sourceCommit:source,scopeSha256:scope,snapshotSha256:snapshot,
    referenceSha256:sha(reference),maxObjects:70,maxObjectBytes:2_000_000,maxTotalBytes:70_000_000};
  modifyPolicy(policy);
  const policyBytes=wire(policy);
  return {policyBytes,expectedPolicySha256:sha(policyBytes),referenceBytes:reference,
    observedBytes:Buffer.isBuffer(observed)?observed:wire(observed)};
}
function rejects(value,code) {
  assert.throws(()=>verifyInventory(value),{code});
}
test('accepts all 61 synthetic entries independently of order; emits no per-item evidence or restore claim',()=>{
  const result=verifyInventory(inputs(fixture(entries().reverse())));
  assert.deepEqual(result,{format:RESULT_FORMAT,status:'matched',objectCount:61,declaredBytes:65_390_726,
    readbackBytesVerified:false,operationalStorageRecoveryVerified:false,migrationAuthorized:false});
});
test('same count and bytes with unknown identity, swapped object bindings, new version or same-version body change all refuse',()=>{
  for(const [mutate,code] of [
    [rows=>{rows[12].identitySha256=sha('synthetic unapproved replacement');},'OBJECT_UNKNOWN_IDENTITY'],
    [rows=>{[rows[0].bodySha256,rows[1].bodySha256]=[rows[1].bodySha256,rows[0].bodySha256];},'OBJECT_BODY_HASH_CHANGED'],
    [rows=>{rows[12].versionSha256=sha('synthetic new version');},'OBJECT_VERSION_CHANGED'],
    [rows=>{rows[12].bodySha256=sha('synthetic same version changed body');},'OBJECT_BODY_HASH_CHANGED'],
    [rows=>{rows[12].sizeBytes-=1;rows[13].sizeBytes+=1;},'OBJECT_SIZE_CHANGED'],
  ]){
    const rows=entries();mutate(rows);
    rejects(inputs(fixture(rows)),code);
  }
});
test('refuses duplicate stable ID despite a different version, and missing or malformed bindings',()=>{
  const duplicate=entries();duplicate[10].identitySha256=duplicate[11].identitySha256;
  rejects(inputs(fixture(duplicate)),'OBJECT_DUPLICATE_IDENTITY');
  rejects(inputs(fixture(entries().slice(0,60))),'OBJECT_MISSING_IDENTITY');
  const missing=entries();delete missing[10].versionSha256;
  rejects(inputs(fixture(missing)),'OBJECT_SHAPE_INVALID');
  const malformed=entries();malformed[10].bodySha256='a'.repeat(64)+'\n';
  rejects(inputs(fixture(malformed)),'OBJECT_BINDING_INVALID');
  rejects(inputs(fixture(entries()),()=>{},wire(fixture(duplicate))),'OBJECT_DUPLICATE_IDENTITY');
});
test('independent approval and baseline pins refuse even matching forged inputs',()=>{
  const bad=inputs(fixture(entries()),p=>{p.maxObjects=500;});
  bad.expectedPolicySha256=inputs().expectedPolicySha256;
  rejects(bad,'POLICY_PIN_MISMATCH');
  const wrongReference=inputs();wrongReference.referenceBytes=wire(fixture(entries().reverse()));
  rejects(wrongReference,'REFERENCE_PIN_MISMATCH');
  for(const key of ['sourceCommit','scopeSha256','snapshotSha256']) {
    const wrong={...fixture(entries()),[key]:key==='sourceCommit'?'b'.repeat(40):sha('different '+key)};
    rejects(inputs(wrong),'INVENTORY_BINDING_MISMATCH');
    rejects(inputs(wrong,()=>{},wire(wrong)),'INVENTORY_BINDING_MISMATCH');
  }
});
test('refuses count, per-object, total bytes, unsafe limits and oversized manifest inputs',()=>{
  rejects(inputs(fixture(entries()),p=>{p.maxObjects=60;}),'OBJECT_COUNT_BOUND');
  rejects(inputs(fixture(entries()),p=>{p.maxObjectBytes=1_000_000;}),'OBJECT_SIZE_BOUND');
  rejects(inputs(fixture(entries()),p=>{p.maxTotalBytes=65_000_000;}),'TOTAL_SIZE_BOUND');
  rejects(inputs(fixture(entries()),p=>{p.maxObjects=1e12;}),'POLICY_LIMITS_INVALID');
  rejects(inputs(Buffer.alloc(4*1024*1024+1)),'INPUT_BYTES_BOUND');
  const bad=entries();bad[0].sizeBytes=-1;
  rejects(inputs(fixture(bad)),'OBJECT_SIZE_BOUND');
});
test('rejects duplicate/unknown JSON keys, invalid encoding and unsafe numeric wire before comparing',()=>{
  const good=JSON.stringify(fixture(entries()));
  rejects(inputs(Buffer.from(good.replace('"objects":','"objects":[],"objects":'))),'INPUT_JSON_INVALID');
  rejects(inputs(Buffer.from(good.replace('"sizeBytes":1066666','"sizeBytes":1066666.00000000001'))),'INPUT_JSON_INVALID');
  rejects(inputs(Buffer.from([0xff])),'INPUT_JSON_INVALID');
  rejects(inputs(fixture(entries().map((x,i)=>i===13?{...x,realName:'not-accepted'}:x))),'OBJECT_SHAPE_INVALID');
  const rogue=inputs(fixture(entries()),p=>{p.unapproved=true;});
  rejects(rogue,'POLICY_SHAPE_INVALID');
});
test('CLI opens only private bounded regular files, rejects symlinks, and hides private locators',async()=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'synthetic-inventory-')));
  const fixtureInput=inputs(fixture(entries().reverse()));
  const paths=['policy','reference','observed'].map(file=>join(directory,file));
  const command=fileURLToPath(new URL('./verify.mjs',import.meta.url));
  const call=(observed=paths[2],pin=fixtureInput.expectedPolicySha256)=>{
    try {return JSON.parse(execFileSync(process.execPath,[command,pin,paths[0],paths[1],observed],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));}
    catch(e){
      assert.equal(e.status,1);
      assert.equal(e.stderr,'');
      assert.ok(!e.stdout.includes(directory));
      return JSON.parse(e.stdout);
    }
  };
  try {
    await Promise.all(paths.map((path,i)=>writeFile(path,[fixtureInput.policyBytes,fixtureInput.referenceBytes,fixtureInput.observedBytes][i],{mode:0o600})));
    assert.equal(call().objectCount,61);
    const symbolic=join(directory,'synthetic-link');await symlink(paths[2],symbolic);
    assert.equal(call(symbolic).reason,'INPUT_PATH_INVALID');
    await chmod(paths[2],0o644);
    assert.equal(call().reason,'INPUT_FILE_INVALID');
    assert.equal(call('/nonexistent-synthetic-input',sha('wrong independent pin')).reason,'POLICY_PIN_MISMATCH');
    await chmod(paths[2],0o600);
    await writeFile(paths[2],Buffer.alloc(4*1024*1024+1));
    assert.equal(call().reason,'INPUT_BYTES_BOUND');
  } finally {await rm(directory,{recursive:true,force:true});}
});
