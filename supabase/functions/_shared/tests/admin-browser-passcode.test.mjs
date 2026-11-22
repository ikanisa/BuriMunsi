import assert from 'node:assert/strict';
import test from 'node:test';
import {handleAdmin} from '../domain/admin_bridge.js';
import {adminAccountSession, adminCanonicalActor} from '../domain/admin_session.js';
import {digest} from '../domain/core.js';
import {adminEmailProofId, requireFreshAdminEmail} from '../domain/admin_email_policy.js';
import {nativePinHasher} from '../domain/burimunsi/native-secrets.js';

const origin = 'https://burimunsi-admin.ikanisa.com';
const phone = '+250780000111';
const staffPhone = '+250780000222';
const pin = '2468';
const group = 'synthetic-group';
const owner = 'synthetic-owner';
const principal = 'synthetic-principal';

function request(path, {body, cookie, csrf, from = origin, bearer} = {}) {
  const headers = new Headers({Origin: from});
  if (body) {
    headers.set('X-Collect-Requested-With', 'collect-admin');
    headers.set('Content-Type', 'application/json');
  }
  if (cookie) headers.set('Cookie', cookie);
  if (csrf) headers.set('X-Collect-CSRF', csrf);
  if (bearer) headers.set('Authorization', 'Bearer '+bearer);
  return new Request(origin + '/api/admin/auth/' + path,
    {method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined});
}

async function fixture() {
  const env = {BURIMUNSI_PRODUCT_MODE:'standalone', BURIMUNSI_COLLECTION_ID:group,
    ADMIN_ORIGINS:origin, BURIMUNSI_PIN_PEPPER_ID:'synthetic-v1',
    BURIMUNSI_PIN_PEPPER_BASE64:Buffer.alloc(32, 17).toString('base64')};
  const account = {id:crypto.randomUUID(), role:'admin', phone, credentialVersion:1, version:1,
    pinHash:await nativePinHasher(env).hash(phone, pin)};
  const sessions = new Map();
  let budgetAllowed = true;
  let issued = 0;
  let refreshed = 0;
  env.DB = {setBrowserPasscodeAccount: account => assert.equal(account.principal_id, principal),
    prepare: statement => ({bind: (...values) => ({first: async () => {
    assert.equal(values[0], group);
    let result;
    if (statement.includes('browser_pin_candidate(')) {
      assert.equal(values[2], await digest(values[1]));
      assert.match(values[4], /^[a-f0-9]{64}$/);
      result = {allowed:budgetAllowed, account:budgetAllowed && values[1] === phone ? account : null};
    } else if (statement.includes('browser_pin_issue(')) {
      const [, accountId, credentialVersion, version, hash, sessionId, publicId, boundOrigin] = values;
      assert.equal(accountId, account.id);
      assert.equal(credentialVersion, account.credentialVersion);
      assert.equal(version, account.version);
      assert.equal(boundOrigin, origin);
      assert.match(hash, /^[a-f0-9]{64}$/);
      const now = Math.floor(Date.now()/1000);
      sessions.set(hash,{adminId:owner, principalId:principal, verifiedAt:now, expiresAt:now+1800,
        proofId:crypto.randomUUID(), accountId, authVersion:1, collectionId:group, sessionId, publicId, phone,
        name:'Synthetic Operator', email:'owner@example.test', permissions:['overview.read']});
      issued++;
      result = true;
    } else if (statement.includes('browser_pin_session(')) {
      assert.equal(values[2], origin);
      result = sessions.get(values[1])??null;
    } else if (statement.includes('browser_pin_verify(')) {
      const session = sessions.get(values[1]);
      assert.equal(session.accountId, values[3]);
      assert.equal(values[4], account.credentialVersion);
      session.verifiedAt = Math.floor(Date.now()/1000);
      refreshed++;
      result = true;
    } else if (statement.includes('browser_pin_logout(')) {
      assert.equal(values[2], origin);
      result = sessions.delete(values[1]);
    } else {
      assert.fail('Unexpected SQL');
    }
    return {result};
  }})})};
  return {env, denyBudget:()=>{budgetAllowed=false;}, issued:()=>issued, refreshed:()=>refreshed};
}

test('the existing native Admin credentials open an opaque same-origin browser session', async () => {
  const {env, issued, refreshed} = await fixture();
  const response = await handleAdmin(request('phone-passcode',{body:{phone:'0780000111',pin}}),env);
  assert.equal(response.status, 200);
  const value = await response.json();
  const cookie = response.headers.get('Set-Cookie');
  assert.match(cookie, /^__Host-collect_admin=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=1800; Secure$/);
  const browserCookie = cookie.split(';')[0];
  assert.equal(value.user.role, 'owner');
  assert.equal(value.user.authMethod, 'phone_passcode');
  assert.equal(value.user.phone, phone);
  assert.equal(issued(), 1);

  const sessionRequest = request('session',{cookie:browserCookie});
  const session = await (await handleAdmin(sessionRequest,env)).json();
  assert.equal(session.user.sessionId, value.user.sessionId);
  assert.equal(session.csrfToken, value.csrfToken);
  const account = await adminAccountSession(sessionRequest,env);
  const actor = await adminCanonicalActor(sessionRequest,env,account,'overview.read');
  assert.equal(actor.userId, principal);
  assert.equal(actor.assuranceLevel, 1);
  assert.equal(adminEmailProofId(actor), null);
  assert.ok(requireFreshAdminEmail(actor));

  const badCsrf = await handleAdmin(request('passcode/verify',{body:{pin},cookie:browserCookie}),env);
  assert.equal(badCsrf.status,403);
  assert.equal(refreshed(),0);
  const recheck = await handleAdmin(request('passcode/verify',{body:{pin},cookie:browserCookie,csrf:value.csrfToken}),env);
  assert.equal(recheck.status,200);
  assert.equal((await recheck.json()).sessionId,value.user.sessionId);
  assert.equal(refreshed(),1);

  const logout = await handleAdmin(request('logout',{body:{},cookie:browserCookie,csrf:value.csrfToken}),env);
  assert.equal(logout.status,200);
  assert.match(logout.headers.get('Set-Cookie'),/Max-Age=0/);
  assert.equal((await (await handleAdmin(sessionRequest,env)).json()).user,null);
});

test('standalone browser auth refuses Staff, legacy auth, untrusted origin and exhausted PIN budget', async () => {
  const {env, issued, denyBudget} = await fixture();
  const staff = await handleAdmin(request('phone-passcode',{body:{phone:staffPhone,pin}}),env);
  assert.equal(staff.status,401);
  assert.equal(staff.headers.get('Set-Cookie'),null);
  const old = await handleAdmin(request('otp',{body:{email:'former@example.test'}}),env);
  assert.equal(old.status,404);
  const wrongOrigin = await handleAdmin(request('phone-passcode',{body:{phone,pin},from:'https://other.example.test'}),env);
  assert.equal(wrongOrigin.status,403);
  const foreignToken = await handleAdmin(request('session',{bearer:'foreign-provider-token'}),env);
  assert.equal(foreignToken.status,403);
  denyBudget();
  assert.equal((await handleAdmin(request('phone-passcode',{body:{phone,pin}}),env)).status,429);
  assert.equal(issued(),0);
});
