import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollectTransport} from '../src/supabase-transport.js';
import {BURIMUNSI_ADMIN_COOKIE, BURIMUNSI_ADMIN_ORIGIN, MANAGED_ADMIN_COOKIE} from '../src/admin-session-realm.js';

const origin='https://platform-admin.collect.ikanisa.com';
test('owner identity opt-in is forwarded only to the exact Admin session GET',async()=>{
 for(const [path,method,version,expected] of [
  ['/api/admin/auth/session','GET','1','1'],
  ['/functions/v1/admin-api/api/admin/auth/session','GET','1','1'],
  ['/api/admin/auth/session','GET','2',null],
  ['/api/admin/auth/session','GET','1, 1',null],
  ['/api/admin/auth/session/','GET','1',null],
  ['/api/admin/auth/session','POST','1',null],
  ['/api/admin/auth/phone-passcode','POST','1',null],
  ['/api/admin/auth/passcode/verify','POST','1',null],
  ['/api/admin/team','GET','1',null],
  ['/v1/profile','GET','1',null],
 ]){
  let calls=0;
  const proxy=createCollectTransport({frontendOrigin:origin,fetchImpl:async upstream=>{
   calls++;assert.equal(upstream.headers.get('X-Collect-Owner-Identity-Version'),expected);
   return Response.json({ok:true});
  }});
  const headers={Origin:origin,'X-Collect-Owner-Identity-Version':version,
   ...(method==='POST'?{'Content-Type':'application/json','X-Collect-Requested-With':'collect-admin'}:{})};
  const response=await proxy(new Request(origin+path,{method,headers,...(method==='POST'?{body:'{}'}:{})}));
  assert.equal(response.status,200,`${method} ${path} ${version}`);assert.equal(calls,1);
 }
});

test('Home opt-in reaches only the exact cookie-scoped BuriMunsi session GET',async()=>{
 const path='/api/admin/auth/session';
 const cookie=`${BURIMUNSI_ADMIN_COOKIE}=fixture-token`;
 for(const [url,method,value,credentials,wanted] of [
  [path,'GET','1',{Cookie:cookie},'1'],
  [path,'GET','2',{Cookie:cookie},null],
  [path,'GET','1, 1',{Cookie:cookie},null],
  [path+'?other=1','GET','1',{Cookie:cookie},null],
  [path,'GET','1',{Cookie:cookie,Authorization:'Bearer fixture'},null],
  ['/api/admin/auth/phone-passcode','POST','1',{Cookie:cookie},null],
  ['/api/admin/burimunsi/home','GET','1',{Cookie:cookie},null],
 ]){
  const observed=[];
  const proxy=createCollectTransport({frontendOrigin:BURIMUNSI_ADMIN_ORIGIN,allowedFrontendOrigins:[BURIMUNSI_ADMIN_ORIGIN],burimunsi:true,
   fetchImpl:async req=>{
    observed.push(req.headers.get('X-BuriMunsi-Session-Home'));
    if (method==='POST') return Response.json({ok:true},{headers:{'Set-Cookie':'__Host-collect_admin=fixture-token; Secure; HttpOnly; SameSite=Strict; Path=/'}});
    return Response.json({ok:true},{headers:{'Cache-Control':'public, max-age=600'}});
   }});
  const result=await proxy(new Request(BURIMUNSI_ADMIN_ORIGIN+url,{method,headers:{Origin:BURIMUNSI_ADMIN_ORIGIN,'X-BuriMunsi-Session-Home':value,
   ...credentials,...(method==='POST'?{'Content-Type':'application/json','X-Collect-Requested-With':'collect-admin'}:{})},
   ...(method==='POST'?{body:'{}'}:{})}));
  assert.equal(result.status,200,`${method} ${url}`);
  assert.deepEqual(observed,[wanted]);
  assert.match(result.headers.get('Cache-Control'),/no-store/);
 }
 const anonymous=createCollectTransport({frontendOrigin:BURIMUNSI_ADMIN_ORIGIN,allowedFrontendOrigins:[BURIMUNSI_ADMIN_ORIGIN],burimunsi:true,
  fetchImpl:async()=>assert.fail('Anonymous session dispatch')});
 const result=await anonymous(new Request(BURIMUNSI_ADMIN_ORIGIN+path,{headers:{'X-BuriMunsi-Session-Home':'1'}}));
 assert.deepEqual(await result.json(),{user:null,expiresAt:null,csrfToken:null,ownerEmail:null});
 const legacy=createCollectTransport({frontendOrigin:origin,isolateAdminSession:true,
  fetchImpl:async req=>{assert.equal(req.headers.get('X-BuriMunsi-Session-Home'),null);return Response.json({ok:true});}});
 assert.equal((await legacy(new Request(origin+path,{headers:{Cookie:`${MANAGED_ADMIN_COOKIE}=fixture-token`,'X-BuriMunsi-Session-Home':'1'}}))).status,200);
});
