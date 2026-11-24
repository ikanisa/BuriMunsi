import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {isAbsolute,normalize} from 'node:path';
import {pathToFileURL} from 'node:url';

export const POLICY_FORMAT = 'collect.storage.object-inventory-policy.v1';
export const INVENTORY_FORMAT = 'collect.storage.object-inventory.v1';
export const RESULT_FORMAT = 'collect.storage.object-inventory-verification.v1';
const HARD = Object.freeze({policyBytes:4096, inventoryBytes:4*1024*1024, objects:10000, objectBytes:1024**4, totalBytes:16*1024**4});
const HEX = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const isHash = value => typeof value === 'string' && value.length === 64 && HEX.test(value);
const own = (value,key) => Object.hasOwn(value,key);
const bounded = (value, maximum, min=1) => Number.isSafeInteger(value) && value >= min && value <= maximum;

class InventoryError extends Error {
  constructor(code) { super(code); this.name='InventoryError'; this.code=code; }
}
const requireThat = (condition,code) => {if(!condition) throw new InventoryError(code);};
function exact(value,keys,code) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => own(value,key)),code);
}
function inspectBytes(bytes,cap) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= cap,'INPUT_BYTES_BOUND');
}
function parse(bytes) {
  try {
    // Strict wire form prevents duplicate/overwritten keys, malformed UTF-8,
    // unexpected escape aliases, signed zero and precision-losing numeric input.
    const text = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
    const payload = text.endsWith('\n') ? text.slice(0,-1) : text;
    const value = JSON.parse(payload);
    requireThat(JSON.stringify(value)===payload,'INPUT_JSON_INVALID');
    return value;
  } catch { throw new InventoryError('INPUT_JSON_INVALID'); }
}
function policy(bytes, expectedDigest) {
  inspectBytes(bytes,HARD.policyBytes);
  requireThat(isHash(expectedDigest) && hash(bytes)===expectedDigest,'POLICY_PIN_MISMATCH');
  const value = parse(bytes);
  exact(value,['format','sourceCommit','scopeSha256','snapshotSha256','referenceSha256','maxObjects','maxObjectBytes','maxTotalBytes'],'POLICY_SHAPE_INVALID');
  requireThat(value.format===POLICY_FORMAT && typeof value.sourceCommit==='string' &&
    value.sourceCommit.length===40 && COMMIT.test(value.sourceCommit) &&
    [value.scopeSha256,value.snapshotSha256,value.referenceSha256].every(isHash),'POLICY_BINDING_INVALID');
  requireThat(bounded(value.maxObjects,HARD.objects) && bounded(value.maxObjectBytes,HARD.objectBytes) &&
    bounded(value.maxTotalBytes,Math.min(HARD.totalBytes,MAX_SAFE)) && value.maxObjectBytes<=value.maxTotalBytes,'POLICY_LIMITS_INVALID');
  return value;
}
function inventory(bytes, p) {
  inspectBytes(bytes,HARD.inventoryBytes);
  const value = parse(bytes);
  exact(value,['format','sourceCommit','scopeSha256','snapshotSha256','objects'],'INVENTORY_SHAPE_INVALID');
  requireThat(value.format===INVENTORY_FORMAT && value.sourceCommit===p.sourceCommit &&
    value.scopeSha256===p.scopeSha256 && value.snapshotSha256===p.snapshotSha256,'INVENTORY_BINDING_MISMATCH');
  requireThat(Array.isArray(value.objects) && bounded(value.objects.length,p.maxObjects,0),'OBJECT_COUNT_BOUND');
  const objects = new Map();
  let total=0;
  for(const row of value.objects) {
    exact(row,['identitySha256','versionSha256','sizeBytes','bodySha256'],'OBJECT_SHAPE_INVALID');
    requireThat([row.identitySha256,row.versionSha256,row.bodySha256].every(isHash),'OBJECT_BINDING_INVALID');
    requireThat(!objects.has(row.identitySha256),'OBJECT_DUPLICATE_IDENTITY');
    requireThat(bounded(row.sizeBytes,p.maxObjectBytes,0),'OBJECT_SIZE_BOUND');
    requireThat(row.sizeBytes<=p.maxTotalBytes-total,'TOTAL_SIZE_BOUND');
    total+=row.sizeBytes;
    objects.set(row.identitySha256,row);
  }
  return {objects,total};
}

/** Compare strictly bounded manifests. The separately supplied policy hash is the trust anchor. */
export function verifyInventory({policyBytes,expectedPolicySha256,referenceBytes,observedBytes}) {
  const p=policy(policyBytes,expectedPolicySha256);
  inspectBytes(referenceBytes,HARD.inventoryBytes);
  requireThat(hash(referenceBytes)===p.referenceSha256,'REFERENCE_PIN_MISMATCH');
  const reference=inventory(referenceBytes,p), observed=inventory(observedBytes,p);
  for(const [identity, seen] of observed.objects) {
    const a=reference.objects.get(identity);
    requireThat(a,'OBJECT_UNKNOWN_IDENTITY');
    requireThat(a.versionSha256===seen.versionSha256,'OBJECT_VERSION_CHANGED');
    requireThat(a.sizeBytes===seen.sizeBytes,'OBJECT_SIZE_CHANGED');
    requireThat(a.bodySha256===seen.bodySha256,'OBJECT_BODY_HASH_CHANGED');
  }
  requireThat(reference.objects.size===observed.objects.size,'OBJECT_MISSING_IDENTITY');
  return {format:RESULT_FORMAT,status:'matched',objectCount:observed.objects.size,declaredBytes:observed.total,
    readbackBytesVerified:false, operationalStorageRecoveryVerified:false, migrationAuthorized:false};
}

async function readBounded(path,cap) {
  requireThat(typeof path==='string' && isAbsolute(path) && normalize(path)===path,'INPUT_PATH_INVALID');
  requireThat(await realpath(path)===path,'INPUT_PATH_INVALID');
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const pre=await fd.stat({bigint:true});
    requireThat(pre.isFile() && pre.uid===BigInt(process.getuid()) && (pre.mode&0o777n)===0o600n &&
      pre.nlink===1n,'INPUT_FILE_INVALID');
    requireThat(pre.size>0n && pre.size<=BigInt(cap),'INPUT_BYTES_BOUND');
    const size=Number(pre.size), bytes=Buffer.alloc(size+1);
    let position=0;
    while(position<bytes.length) {
      const {bytesRead}=await fd.read(bytes,position,bytes.length-position,position);
      if(!bytesRead) break;
      position+=bytesRead;
    }
    const post=await fd.stat({bigint:true});
    requireThat(position===size && pre.size===post.size && pre.mtimeNs===post.mtimeNs &&
      pre.ctimeNs===post.ctimeNs && pre.nlink===post.nlink,'INPUT_FILE_CHANGED');
    return bytes.subarray(0,size);
  } finally { await fd.close(); }
}

async function main(args) {
  requireThat(args.length===4 && isHash(args[0]),'USAGE_INVALID');
  const [expectedPolicySha256,policyPath,referencePath,observedPath]=args;
  const policyBytes=await readBounded(policyPath,HARD.policyBytes);
  const p=policy(policyBytes,expectedPolicySha256);
  const referenceBytes=await readBounded(referencePath,HARD.inventoryBytes);
  // Verify the approved baseline before opening the candidate manifest.
  requireThat(hash(referenceBytes)===p.referenceSha256,'REFERENCE_PIN_MISMATCH');
  inventory(referenceBytes,p);
  const observedBytes=await readBounded(observedPath,HARD.inventoryBytes);
  return verifyInventory({policyBytes,expectedPolicySha256,referenceBytes,observedBytes});
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
  catch (error) {
    console.log(JSON.stringify({format:RESULT_FORMAT,status:'refused',reason:error instanceof InventoryError?error.code:'INPUT_UNAVAILABLE'}));
    process.exitCode=1;
  }
}
