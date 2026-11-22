import test from 'node:test';
import assert from 'node:assert/strict';
import {preliminaryCurrentOwner} from '../domain/admin_owner_precheck.js';
import {attestAdminPasscodeAccount,adminEmailVerifiedAt,requireFreshAdminEmail} from '../domain/admin_email_policy.js';
import {accountGuard} from '../domain/admin_accounts_legacy.js';
import {BURIMUNSI_ADMIN_ORIGIN,BURIMUNSI_PRODUCT_MODE} from '../burimunsi-standalone.js';

const original={id:'admin-one',principal_id:'principal-one',email:'info@ikanisa.com',role:'owner'};
const alternate={...original,email:'owner@example.invalid'};
const nativeEnv={BURIMUNSI_PRODUCT_MODE,BURIMUNSI_COLLECTION_ID:'review-group'};
function phoneAccount(storageRole,operatorRole,expiresIn=300) {
 const now=Math.floor(Date.now()/1000);
 const account={id:crypto.randomUUID(),principal_id:crypto.randomUUID(),auth_session_id:crypto.randomUUID(),
  public_id:crypto.randomUUID(),token_hash:'a'.repeat(64),auth_version:1,origin:BURIMUNSI_ADMIN_ORIGIN,
  expires_at:now+expiresIn,role:storageRole,email:null};
 return attestAdminPasscodeAccount(account,{accountId:crypto.randomUUID(),sessionId:account.auth_session_id,publicId:account.public_id,
  adminId:account.id,principalId:account.principal_id,collectionId:nativeEnv.BURIMUNSI_COLLECTION_ID,storageRole,operatorRole,
  verifiedAt:now-600,expiresAt:account.expires_at,proofId:crypto.randomUUID()});
}

test('dedicated managed administrators share one scoped role throughout a valid PIN session',async()=>{
 for(const storageRole of ['owner','admin','staff']){
  const managed=phoneAccount(storageRole,'admin');
  assert.equal(await preliminaryCurrentOwner(nativeEnv,managed),true);
  assert.doesNotThrow(()=>requireFreshAdminEmail(managed));
  assert.equal(adminEmailVerifiedAt(managed),null);
  assert.equal(await preliminaryCurrentOwner({...nativeEnv,BURIMUNSI_COLLECTION_ID:'different-group'},managed),false);
 }
 assert.equal(await preliminaryCurrentOwner(nativeEnv,phoneAccount('staff','staff')),false);
 assert.equal(await preliminaryCurrentOwner(nativeEnv,phoneAccount('owner','staff')),false);
 assert.equal(await preliminaryCurrentOwner(nativeEnv,{...phoneAccount('admin','admin')}),false);
 const expired=phoneAccount('admin','admin',-1);
 assert.equal(await preliminaryCurrentOwner(nativeEnv,expired),false);
 assert.throws(()=>requireFreshAdminEmail(expired),error=>error.status===401);
});

test('dedicated protected operations re-read the exact session and require the current personal grant',()=>{
 const managed=phoneAccount('admin','admin');
 const db={prepare(text){return {bind(...args){return {text,args};}};}};
 const {statement}=accountGuard({...nativeEnv,DB:db},managed,'admin_users.manage',{owner:true,fresh:true});
 assert.match(statement.text,/private\.burimunsi_browser_pin_session\(\?,\?,\?\)/);
 assert.match(statement.text,/session_value->>'operatorRole'='admin'/);
 assert.match(statement.text,/jsonb_exists\(session_value->'permissions'/);
 assert.ok(statement.args.includes(managed.principal_id)&&statement.args.includes(managed.public_id));
 assert.ok(statement.args.includes('admin_users.manage'));
 assert.equal(statement.args.length,statement.text.match(/\?/g).length);
});
function fixture(result=true){
 const calls=[];
 return {calls,env:{COLLECT_ADMIN_DYNAMIC_OWNER_AUTH_ENABLED:'true',DB:{prepare(sql){
  calls.push({sql});return {bind(...args){calls.at(-1).args=args;return {async first(){if(result instanceof Error)throw result;return {result};}};}};
 }}}};
}
test('legacy preliminary check is unchanged and does not query the dynamic binding',async()=>{
 const f=fixture();delete f.env.COLLECT_ADMIN_DYNAMIC_OWNER_AUTH_ENABLED;
 assert.equal(await preliminaryCurrentOwner(f.env,original),true);
 assert.equal(await preliminaryCurrentOwner(f.env,alternate),false);
 assert.equal(await preliminaryCurrentOwner(f.env,{...original,role:'admin'}),false);
 assert.deepEqual(f.calls,[]);
});
test('dynamic preliminary check uses exact database-resolved identities and fails closed',async()=>{
 for(const [result,allowed] of [[true,true],[false,false],[null,false],['true',false]]){
  const f=fixture(result);assert.equal(await preliminaryCurrentOwner(f.env,alternate),allowed);
  assert.deepEqual(f.calls,[{sql:'SELECT private.collect_owner_is(?,?,?) AS result',args:[alternate.id,alternate.principal_id,alternate.email]}]);
 }
 const f=fixture();assert.equal(await preliminaryCurrentOwner(f.env,{...alternate,principal_id:null}),false);assert.deepEqual(f.calls,[]);
});
test('fence failures remain service failures and other database errors are safely unavailable',async()=>{
 for(const code of ['application_fenced','application_fence_unavailable']){
  const original=Object.assign(new Error('synthetic fence'),{code});
  const f=fixture(original);await assert.rejects(preliminaryCurrentOwner(f.env,alternate),e=>e===original);
 }
 const f=fixture(new Error('synthetic private database detail'));
 await assert.rejects(preliminaryCurrentOwner(f.env,alternate),e=>e.status===503&&e.code==='owner_identity_unavailable'&&!e.message.includes('private'));
});
