import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {adminOperationWrite} from '../domain/admin_operations.js';
import {attestAdminEmailAccount,bindAdminEmailActor} from '../domain/admin_email_policy.js';
import {test} from './helpers/fenced-node-test.js';

function fixture(t){
 const sql=new DatabaseSync(':memory:');
 t.after(()=>sql.close());
 sql.exec(`
  CREATE TABLE users(
   id TEXT PRIMARY KEY,public_id TEXT UNIQUE NOT NULL,full_name TEXT,phone TEXT UNIQUE,email TEXT UNIQUE,
   member_type TEXT,momo_provider TEXT,momo_number TEXT,momo_pay_code TEXT,access_status TEXT,
   created_at TEXT,updated_at TEXT
  );
  CREATE TABLE admin_users(id TEXT PRIMARY KEY,email TEXT NOT NULL,status TEXT NOT NULL);
  CREATE TABLE admin_principal_links(admin_user_id TEXT PRIMARY KEY,user_id TEXT UNIQUE NOT NULL);
  CREATE TABLE admin_bridge_guards(id TEXT PRIMARY KEY,passed INTEGER CONSTRAINT admin_bridge_state CHECK(passed=1));
  CREATE TABLE admin_bridge_requests(
   admin_user_id TEXT,idempotency_key TEXT,request_id TEXT,session_id TEXT,operation TEXT,
   body_sha256 TEXT,created_at TEXT,PRIMARY KEY(admin_user_id,idempotency_key)
  );
  CREATE TABLE request_receipts(
   user_id TEXT,request_id TEXT,operation TEXT,session_id TEXT,body_sha256 TEXT,response_json TEXT,
   created_at TEXT,PRIMARY KEY(user_id,request_id)
  );
  CREATE TABLE audit_log(actor_user_id TEXT,actor_session_id TEXT,action TEXT,entity_type TEXT,
   entity_id TEXT,request_id TEXT,details_json TEXT,created_at TEXT);
 `);
 const account={id:crypto.randomUUID(),principal_id:crypto.randomUUID(),auth_user_id:crypto.randomUUID(),
  auth_session_id:crypto.randomUUID(),public_id:crypto.randomUUID(),token_hash:'0'.repeat(64),
  origin:'https://admin.example.invalid',auth_version:1,role:'admin',permissions:['users.manage']};
 attestAdminEmailAccount(account,{contract_version:1,public_session_id:account.public_id,
  email_verified_at:Math.floor(Date.now()/1000),proof_id:crypto.randomUUID()});
 const actor=bindAdminEmailActor({userId:account.principal_id,sessionId:account.auth_session_id,surface:'admin',
  assuranceLevel:1,permissions:new Set(account.permissions)},account);
 const base={DB:{
  prepare(statement){return {bind(...values){return {statement,values,async first(){
   return sql.prepare(statement).get(...values)??null;
  }};}};},
  async batch(statements){
   sql.exec('BEGIN');
   try{
    const result=statements.map(({statement,values})=>{
     // Current Admin authority is supplied by the fixture. The alias, person
     // guard, person insert, receipt and audit execute as a real transaction.
     if(/^(?:INSERT INTO|DELETE FROM) mutation_guards\b/.test(statement))return {meta:{changes:1}};
     return {meta:sql.prepare(statement).run(...values)};
    });
    sql.exec('COMMIT');
    return result;
   }catch(error){
    sql.exec('ROLLBACK');
    throw error;
   }
  },
 }};
 const url=new URL('/api/admin/operations/users',account.origin);
 const create=(body,key=crypto.randomUUID())=>{
  const request=new Request(url,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},
   body:JSON.stringify({display_name:'Synthetic person',reason:'Synthetic person create',...body})});
  return adminOperationWrite(request,base,base,account,actor,['users'],url);
 };
 const counts=()=>Object.fromEntries(['users','admin_bridge_requests','request_receipts','audit_log','admin_bridge_guards']
  .map(table=>[table,sql.prepare('SELECT count(*) AS count FROM '+table).get().count]));
 return {sql,create,counts};
}

test('new App contact uses canonical email and the original request remains replayable',async t=>{
 const {sql,create,counts}=fixture(t);
 const key='synthetic-original-person-key';
 const body={email:'  Mixed.Case@Example.Invalid '};
 const receipt=await (await create(body,key)).json();
 const person=sql.prepare('SELECT email,member_type FROM users WHERE id=?').get(receipt.resource_id);
 assert.equal(person.email,'mixed.case@example.invalid');
 assert.equal(person.member_type,'app');
 assert.deepEqual(await (await create(body,key)).json(),receipt);
 await assert.rejects(create({email:'mixed.case@example.invalid'},key),{status:409,code:'request_conflict'});
 assert.deepEqual(counts(),{users:1,admin_bridge_requests:1,request_receipts:1,audit_log:1,admin_bridge_guards:0});
});

test('retained people and linked current or invited Admin identities block new App records atomically',async t=>{
 for(const identity of ['retained-email','retained-phone','active','invited']){
  await t.test(identity,async child=>{
   const {sql,create,counts}=fixture(child);
   const prior=crypto.randomUUID(),operator=crypto.randomUUID();
   const email='existing@example.invalid',phone='+250788123456';
   sql.prepare('INSERT INTO users(id,public_id,email,phone,member_type,access_status) VALUES(?,?,?,?,?,?)')
    .run(prior,'000001',identity==='retained-email'?'Existing@Example.Invalid':null,
     identity==='retained-phone'?phone:null,identity.startsWith('retained-')?'app':'operator','suspended');
   if(!identity.startsWith('retained-')){
    sql.prepare('INSERT INTO admin_users VALUES(?,?,?)').run(operator,email,identity);
    sql.prepare('INSERT INTO admin_principal_links VALUES(?,?)').run(operator,prior);
   }
   const baseline=counts();
   await assert.rejects(create(identity==='retained-phone'?{phone_e164:'0788123456'}:{email:'EXISTING@example.invalid'}),
    {status:409,code:'stale_state'});
   assert.deepEqual(counts(),baseline);
   if(identity==='retained-email')assert.equal(sql.prepare('SELECT email FROM users WHERE id=?').get(prior).email,
    'Existing@Example.Invalid');
  });
 }
});

test('Direct beneficiaries keep their payment profile without acquiring App credentials',async t=>{
 const {sql,create,counts}=fixture(t);
 await create({email:'member@example.invalid',phone_e164:'+250788123456'});
 const receipt=await (await create({member_type:'direct',email:'MEMBER@example.invalid',phone_e164:'0788123456',
  momo_number:'0788123456',momo_provider:'mtn_momo'})).json();
 const person=sql.prepare('SELECT email,phone,momo_number,member_type FROM users WHERE id=?').get(receipt.resource_id);
 assert.deepEqual({...person},{email:null,phone:null,momo_number:'0788123456',member_type:'direct'});
 assert.equal(counts().users,2);
});

test('competing App requests for one canonical email commit one person and one receipt',async t=>{
 const {create,counts}=fixture(t);
 const results=await Promise.allSettled([
  create({email:'first@example.invalid'}),
  create({email:'FIRST@example.invalid'}),
 ]);
 assert.deepEqual(results.map(result=>result.status).sort(),['fulfilled','rejected']);
 const conflict=results.find(result=>result.status==='rejected').reason;
 assert.equal(conflict.status,409);
 assert.equal(conflict.code,'stale_state');
 assert.deepEqual(counts(),{users:1,admin_bridge_requests:1,request_receipts:1,audit_log:1,admin_bridge_guards:0});
});
