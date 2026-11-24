import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {link,lstat,open,opendir,realpath,stat,unlink} from 'node:fs/promises';
import {isAbsolute,join,normalize,relative,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {INVENTORY_FORMAT,InventoryError,parseApprovedReference,parseStrictJson,readBounded,verifyInventory} from './verify.mjs';

const FORMAT='collect.storage.synthetic-byte-readback-map.v1';
const RESULT='collect.storage.synthetic-byte-readback.v1';
const CAPS=Object.freeze({policy:4096,reference:4*1024*1024,map:128*1024,objects:256,objectBytes:64*1024*1024,totalBytes:128*1024*1024});
const OUTPUT='observed-manifest.json';
const CHECKOUT=fileURLToPath(new URL('../../../',import.meta.url)).replace(new RegExp(sep+'$'),'');
const digest=buffer=>createHash('sha256').update(buffer).digest('hex');
const isHash=value=>typeof value==='string'&&value.length===64&&/^[a-f0-9]+$/u.test(value);
const invariant=(condition,code)=>{if(!condition)throw new InventoryError(code);};
const ordinalName=n=>String(n).padStart(6,'0')+'.opaque';
function exact(value,keys) {
  invariant(value!==null&&typeof value==='object'&&!Array.isArray(value)&&
    Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)),'MAP_SHAPE_INVALID');
}
function mapPlan(bytes, expectedSha, approved, expectedPolicySha) {
  invariant(isHash(expectedSha)&&digest(bytes)===expectedSha,'MAP_PIN_MISMATCH');
  const plan=parseStrictJson(bytes);
  exact(plan,['format','syntheticOnly','policySha256','referenceSha256','sourceCommit','scopeSha256','snapshotSha256','files']);
  const p=approved.policy;
  invariant(plan.format===FORMAT&&plan.syntheticOnly===true&&plan.policySha256===expectedPolicySha&&
    plan.referenceSha256===p.referenceSha256&&plan.sourceCommit===p.sourceCommit&&plan.scopeSha256===p.scopeSha256&&
    plan.snapshotSha256===p.snapshotSha256,'MAP_SCOPE_MISMATCH');
  invariant(Array.isArray(plan.files)&&plan.files.length===approved.reference.objects.size&&plan.files.length<=CAPS.objects,'MAP_COUNT_BOUND');
  let bytesTotal=0;
  const seen=new Set();
  return plan.files.map((row,index)=>{
    exact(row,['ordinal','identitySha256','versionSha256','sizeBytes']);
    const ref=approved.reference.objects.get(row.identitySha256);
    invariant(row.ordinal===index+1&&ref&&isHash(row.identitySha256)&&!seen.has(row.identitySha256)&&
      row.versionSha256===ref.versionSha256&&row.sizeBytes===ref.sizeBytes,'MAP_OBJECT_MISMATCH');
    invariant(row.sizeBytes<=CAPS.objectBytes&&row.sizeBytes<=CAPS.totalBytes-bytesTotal,'READBACK_SIZE_BOUND');
    bytesTotal+=row.sizeBytes;seen.add(row.identitySha256);
    return {filename:ordinalName(row.ordinal),row,ref};
  });
}
function inside(path,root) {
  const r=relative(root,path);
  return r===''||!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep);
}
function overlap(a,b) {return inside(a,b)||inside(b,a);}
function sameNode(a,b) {return a.dev===b.dev&&a.ino===b.ino;}
function unchanged(a,b) {return sameNode(a,b)&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.size===b.size&&a.nlink===b.nlink;}
async function privateRoot(path) {
  invariant(typeof path==='string'&&isAbsolute(path)&&normalize(path)===path&&await realpath(path)===path,'ROOT_PATH_INVALID');
  const found=await stat(path,{bigint:true});
  invariant(found.isDirectory()&&found.uid===BigInt(process.getuid())&&(found.mode&0o777n)===0o700n,'ROOT_NOT_PRIVATE');
  return found;
}
async function exactEntries(root, files) {
  const remaining=new Set(files);
  const directory=await opendir(root,{bufferSize:4});
  try {
    while(true) {
      const e=await directory.read();
      if(!e) break;
      invariant(remaining.delete(e.name)&&e.isFile(),'ROOT_INVENTORY_MISMATCH');
    }
    invariant(remaining.size===0,'ROOT_INVENTORY_MISMATCH');
  } finally {await directory.close();}
}
async function hashFile(path, expectedBytes) {
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const chunk=Buffer.alloc(64*1024);
  try {
    const pre=await fd.stat({bigint:true});
    invariant(pre.isFile()&&pre.uid===BigInt(process.getuid())&&(pre.mode&0o777n)===0o600n&&pre.nlink===1n,'BODY_FILE_INVALID');
    invariant(pre.size===BigInt(expectedBytes),'BODY_LENGTH_MISMATCH');
    const hash=createHash('sha256');
    let offset=0;
    while(offset<=expectedBytes) {
      const maximum=Math.min(chunk.length,expectedBytes-offset+1);
      const {bytesRead}=await fd.read(chunk,0,maximum,offset);
      if(!bytesRead)break;
      offset+=bytesRead;
      invariant(offset<=expectedBytes,'BODY_LENGTH_MISMATCH');
      hash.update(chunk.subarray(0,bytesRead));
    }
    const post=await fd.stat({bigint:true});
    invariant(offset===expectedBytes,'BODY_LENGTH_MISMATCH');
    invariant(unchanged(pre,post),'BODY_FILE_CHANGED');
    return {bodySha256:hash.digest('hex'),stat:post};
  } finally { chunk.fill(0);await fd.close(); }
}
async function publishPrivate(output, bytes, pre) {
  invariant(unchanged(pre,await privateRoot(output)),'OUTPUT_CHANGED');
  const temporary=join(output,'.observed-'+randomUUID()+'.tmp');
  const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {
    try {await file.writeFile(bytes);await file.sync();} finally {await file.close();}
    invariant(sameNode(pre,await privateRoot(output)),'OUTPUT_CHANGED');
    await link(temporary,join(output,OUTPUT));
  } finally {await unlink(temporary);}
}

export async function witness(args) {
  invariant(args.length===7&&isHash(args[0])&&isHash(args[3]),'USAGE_INVALID');
  const [expectedPolicySha256,policyPath,referencePath,mapSha,mapPath,restoreRoot,outputRoot]=args;
  const [policyInput,referenceInput,mapInput]=await Promise.all([
    readBounded(policyPath,CAPS.policy),readBounded(referencePath,CAPS.reference),readBounded(mapPath,CAPS.map),
  ]);
  const {bytes:policyBytes}=policyInput,{bytes:referenceBytes}=referenceInput;
  const approved=parseApprovedReference({policyBytes,expectedPolicySha256,referenceBytes});
  const plan=mapPlan(mapInput.bytes,mapSha,approved,expectedPolicySha256);
  const [restorePre,outputPre,checkout]=await Promise.all([privateRoot(restoreRoot),privateRoot(outputRoot),realpath(CHECKOUT)]);
  invariant(!overlap(restoreRoot,outputRoot)&&!sameNode(restorePre,outputPre)&&
    !overlap(restoreRoot,checkout)&&!overlap(outputRoot,checkout),'ROOT_SCOPE_OVERLAP');
  await exactEntries(outputRoot,[]);
  await exactEntries(restoreRoot,plan.map(item=>item.filename));
  const objects=[],checked=[];
  for(const {filename,row,ref} of plan) {
    const path=join(restoreRoot,filename);
    const readback=await hashFile(path,row.sizeBytes);
    invariant(readback.bodySha256===ref.bodySha256,'BODY_HASH_MISMATCH');
    checked.push({path,stat:readback.stat});
    objects.push({identitySha256:row.identitySha256,versionSha256:row.versionSha256,sizeBytes:row.sizeBytes,bodySha256:readback.bodySha256});
  }
  for (const item of checked) {
    const current=await lstat(item.path,{bigint:true});
    invariant(current.isFile()&&unchanged(item.stat,current),'BODY_FILE_CHANGED');
  }
  invariant(unchanged(restorePre,await privateRoot(restoreRoot)),'ROOT_CHANGED');
  const {sourceCommit,scopeSha256,snapshotSha256}=approved.policy;
  const observedBytes=Buffer.from(JSON.stringify({format:INVENTORY_FORMAT,sourceCommit,scopeSha256,snapshotSha256,objects})+'\n');
  const matched=verifyInventory({policyBytes,expectedPolicySha256,referenceBytes,observedBytes});
  await publishPrivate(outputRoot,observedBytes,outputPre);
  return {format:RESULT,status:'matched',syntheticOnly:true,objectCount:matched.objectCount,readbackBytes:matched.declaredBytes,
    operationalStorageRecoveryVerified:false,independentCustodyVerified:false,migrationAuthorized:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {console.log(JSON.stringify(await witness(process.argv.slice(2))));}
  catch(error) {
    console.log(JSON.stringify({format:RESULT,status:'refused',reason:error instanceof InventoryError?error.code:'INPUT_UNAVAILABLE'}));
    process.exitCode=1;
  }
}
