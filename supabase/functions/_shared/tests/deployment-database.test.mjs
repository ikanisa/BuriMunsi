import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalProfile,MANAGED_SUPABASE_ORIGIN} from '../deployment-profile.js';
import {assertRuntimeDeployment, prepareDeploymentCheck} from '../deployment-database.js';

const profile={format:'collect.deployment.v1',id:'collect-production',mode:'managed',environment:'production',
 supabase_origin:MANAGED_SUPABASE_ORIGIN,
 member_api_origin:'https://api.collect.example',admin_origin:'https://admin.collect.example',
 public_origin:'https://collect.example',google_callback_origin:'https://api.collect.example'};
const env=(mode=profile.mode)=>{const raw=canonicalProfile({...profile,mode});return {COLLECT_DEPLOYMENT_PROFILE:raw,
 COLLECT_DEPLOYMENT_PROFILE_SHA256:createHash('sha256').update(raw).digest('hex')};};
function fake(rows=[{allowed:true}]){
 const calls=[];return {calls,async begin(fn){calls.push('begin');return fn(async(strings,...values)=>{
  const sql=strings.join('?');calls.push({sql,values});return sql.includes('collect_assert_deployment')?rows:[];
 });}};
}
test('legacy deployments without an explicit profile do not require an identity table',async()=>{
 const sql=fake();await assertRuntimeDeployment(sql,{});assert.deepEqual(sql.calls,[]);
});
test('Cloud profiles are matched against the immutable database identity',async()=>{
 const sql=fake(),input=env();await assertRuntimeDeployment(sql,input);
 assert.equal(sql.calls[0],'begin');assert.match(sql.calls[1].sql,/SET LOCAL ROLE collect_runtime/);
 assert.match(sql.calls[2].sql,/private\.collect_assert_deployment/);
 assert.deepEqual(sql.calls[2].values,[input.COLLECT_DEPLOYMENT_PROFILE_SHA256]);
});
test('a false, absent or ambiguous database assertion fails closed',async()=>{
 for(const rows of [[{allowed:false}],[],[{allowed:true},{allowed:true}]])await assert.rejects(assertRuntimeDeployment(fake(rows),env()),/deployment_identity_mismatch/);
});
test('an invalid profile digest fails before opening a database transaction',async()=>{
 const sql=fake();await assert.rejects(assertRuntimeDeployment(sql,{...env(),COLLECT_DEPLOYMENT_PROFILE_SHA256:'0'.repeat(64)}),/SHA256 mismatch/);
 assert.deepEqual(sql.calls,[]);
});

test('non-managed profiles are rejected before database work',async()=>{
 const sql=fake();await assert.rejects(assertRuntimeDeployment(sql,env('self_hosted')),/Invalid public deployment profile/);
 assert.deepEqual(sql.calls,[]);
});

test('standalone registration proof captures exact deployment and collection in one scoped query',async()=>{
 const input=env(),digest=input.COLLECT_DEPLOYMENT_PROFILE_SHA256;
 const check=await prepareDeploymentCheck(input,'this-group');
 input.COLLECT_DEPLOYMENT_PROFILE_SHA256='0'.repeat(64);
 for (const [rows,error] of [
  [[{allowed:true,scope_matches:true}],null],
  [[{allowed:true,scope_matches:false}],'burimunsi_collection_mismatch'],
  [[{allowed:true}],'burimunsi_collection_mismatch'],
  [[{allowed:false,scope_matches:true}],'deployment_identity_mismatch'],
  [[],'deployment_identity_mismatch'],
 ]) {
  let count=0;
  const result=check(async(parts,...bound)=>{
   count++;
   assert.deepEqual(bound,[digest,'this-group']);
   assert.match(parts.join('?'),/count\(\*\) = 1 AND bool_and\(id = \?\)/);
   assert.match(parts.join('?'),/SELECT id FROM app.collections LIMIT 2/);
   return rows;
  });
  if(error)await assert.rejects(result,{message:error});else await result;
  assert.equal(count,1);
 }
});

test('a phone read binds the checked deployment, sole group and original admission in one statement',async()=>{
 const input=env(),group='this-group',reg={id:'11111111-1111-4111-8111-111111111111',source:'a'.repeat(64),kind:'http_collect'};
 const check=await prepareDeploymentCheck(input,group),issued={kind:reg.kind};
 for(const [proof,error] of [
  [{allowed:true,scope_matches:true,result:issued},null],
  [{allowed:false,scope_matches:true,result:null},'deployment_identity_mismatch'],
  [{allowed:true,scope_matches:false,result:null},'burimunsi_collection_mismatch'],
 ]){
  const read=check(async(parts,...parameters)=>{
   const sql=parts.join('?');
   assert.match(sql,/WITH authorized AS MATERIALIZED/);
   assert.match(sql,/CASE WHEN allowed AND scope_matches THEN\s+private\.collect_fence_register/);
   assert.match(sql,/SELECT id FROM app\.collections LIMIT 2/);
   assert.deepEqual(parameters,[input.COLLECT_DEPLOYMENT_PROFILE_SHA256,group,reg.id,reg.source,reg.kind]);
   return [proof];
  },reg);
  if(error)await assert.rejects(read,{message:error});else assert.equal(await read,issued);
 }
 await assert.rejects(check(()=>assert.fail('unexpected query'),{...reg,kind:'jobs'}),/standalone_read_registration_required/);
 const shared=await prepareDeploymentCheck(input);
 await assert.rejects(shared(()=>assert.fail('unexpected query'),reg),/standalone_read_registration_required/);
});
