// Run only within the checked-in socket-only PG17 / postgres.js fixture.
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {handleAdmin} from '../../functions/_shared/domain/admin_bridge.js';

const origin='https://burimunsi-admin.ikanisa.com';
const homeHeader='X-BuriMunsi-Session-Home';
const withoutAsOf=({asOf,...home})=>{
  assert.ok(Number.isFinite(Date.parse(asOf)));
  return home;
};

function intercept(pool,transform) {
  return {async reserve(){
    const connection=await pool.reserve();
    const tx=(...args)=>connection(...args);
    tx.unsafe=(text,...params)=>transform(connection,text,params);
    tx.release=()=>connection.release();
    return tx;
  }};
}

export async function verifyBrowserHomeBootstrap({admitted,pool,fixtureSql,businessStatements,group,accounts}) {
  async function call(path,{cookie,csrf,selector,collection=group,businessPool=pool}={}) {
    const headers=new Headers({Origin:origin});
    if(cookie)headers.set('Cookie','__Host-collect_admin='+cookie);
    if(selector!==undefined)headers.set(homeHeader,selector);
    if(csrf){
      headers.set('X-Collect-CSRF',csrf);
      headers.set('X-Collect-Requested-With','collect-admin');
      headers.set('Content-Type','application/json');
    }
    const request=new Request(origin+'/api/admin/'+path,{headers,method:csrf?'POST':'GET',body:csrf?'{}':undefined});
    return admitted(async db=>{
      let failure;
      const response=await handleAdmin(request,{DB:db,BURIMUNSI_COLLECTION_ID:collection,
        BURIMUNSI_PRODUCT_MODE:'standalone',ADMIN_ORIGINS:origin,INTERNAL_ERROR_OBSERVER:error=>{
          failure={code:error.code,message:error.message};
        }});
      const body=await response.text();
      return {status:response.status,cache:response.headers.get('Cache-Control'),body,data:JSON.parse(body),failure};
    },'http_admin',undefined,businessPool);
  }

  const viewers=new Map();
  for(const account of accounts){
    const cookie=randomBytes(32).toString('hex');
    const cookieHash=createHash('sha256').update(cookie).digest('hex');
    await admitted(db=>db.transaction(async sql=>{
      await db.context(sql);
      const [result]=await sql.unsafe('SELECT private.burimunsi_browser_pin_issue($1,$2,$3,$3,$4,$5,$6,$7) AS ok',
        [group,account.id,account.version,cookieHash,randomUUID(),randomUUID(),origin]);
      assert.equal(result.ok,true);
    }),'http_admin');
    viewers.set(account.role,{cookie,cookieHash});
  }
  const admin=viewers.get('admin'),staff=viewers.get('staff');

  const empty=await call('auth/session',{cookie:staff.cookie,selector:'1'});
  assert.equal(empty.status,200,empty.body);
  assert.equal(empty.data.homeCollectionId,group);
  assert.deepEqual(empty.data.homeBootstrap.home.recentPayments,[]);

  await fixtureSql(`INSERT INTO burimunsi.payments
    (id,collection_id,receiving_account_id,provider,direction,amount_rwf,occurred_at)
    SELECT 'browser-home-payment-'||n,$1,'browser-fixture-wallet','mtn_momo',
      CASE n%2 WHEN 1 THEN 'incoming' ELSE 'outgoing' END,n,now()-n*interval '1 minute'
    FROM generate_series(1,32) AS source(n)`,[group]);

  const measurements={};
  for(const [role,{cookie}] of viewers){
    const sample=[];
    for(let iteration=0;iteration<5;iteration++){
      const start=businessStatements.length,legacyStarted=performance.now();
      const ordinary=await call('auth/session',{cookie});
      const direct=await call('burimunsi/home',{cookie});
      const legacyMs=performance.now()-legacyStarted;
      const pivot=businessStatements.length,optInStarted=performance.now();
      const together=await call('auth/session',{cookie,selector:'1'});
      const optInMs=performance.now()-optInStarted;
      assert.deepEqual([ordinary.status,direct.status,together.status],[200,200,200],
        JSON.stringify({ordinary:ordinary.data.user?.role,direct:direct.data.error,together:together.data.error}));
      const {homeCollectionId,homeBootstrap,...session}=together.data;
      assert.deepEqual(session,ordinary.data);
      assert.equal(together.cache,'no-store, private');
      assert.equal(homeCollectionId,group);
      if(role==='admin')assert.equal(homeCollectionId,session.adminIdentity.collectionId);
      else assert.equal(session.adminIdentity,undefined);
      assert.deepEqual(Object.keys(homeBootstrap).sort(),['actorId','collectionId','home','sessionId','version']);
      assert.equal(homeBootstrap.version,1);
      assert.equal(homeBootstrap.actorId,session.user.id);
      assert.equal(homeBootstrap.sessionId,session.user.sessionId);
      assert.equal(homeBootstrap.collectionId,group);
      assert.deepEqual(withoutAsOf(homeBootstrap.home),withoutAsOf(direct.data));
      assert.equal(homeBootstrap.home.paymentCount,32);
      assert.equal(homeBootstrap.home.recentPayments.length,3);
      assert.equal(Object.hasOwn(homeBootstrap.home.paymentTotals,'latestSmsBalanceRwf'),role==='admin');

      const legacy=businessStatements.slice(start,pivot),optIn=businessStatements.slice(pivot);
      const starts=statements=>statements.filter(text=>text.startsWith('BEGIN ISOLATION LEVEL ')).length;
      assert.deepEqual([starts(legacy),starts(optIn)],[3,1]);
      assert.equal(optIn.at(-1),'ROLLBACK');
      assert.ok(optIn.length<legacy.length);
      sample.push([legacyMs,optInMs,legacy.length,optIn.length]);
    }
    const median=index=>Number(sample.map(row=>row[index]).sort((a,b)=>a-b)[2].toFixed(1));
    measurements[role]={samples:sample.length,legacyMs:median(0),optInMs:median(1),
      legacyStatements:median(2),optInStatements:median(3),http:[2,1],reservations:[3,1]};
  }
  console.log('PASS scoped browser Home bootstrap parity and measured PostgreSQL calls',JSON.stringify(measurements));

  const base=await call('auth/session',admin);
  const noOptIn=await call('auth/session',{cookie:admin.cookie,selector:'1, 1'});
  assert.equal(noOptIn.body,base.body);
  const noCookie=await call('auth/session',{selector:'1'});
  assert.equal(noCookie.status,200,noCookie.body);
  assert.equal(noCookie.data.user,null);
  assert.equal(noCookie.data.homeBootstrap,undefined);
  const wrongScopeStart=businessStatements.length;
  const wrongScope=await call('auth/session',{cookie:admin.cookie,selector:'1',collection:'different-collection'});
  assert.equal(wrongScope.data.homeBootstrap,undefined);
  assert.ok(!businessStatements.slice(wrongScopeStart).some(text=>text.includes('WITH home_totals')));

  let timedOut=false;
  const slow=intercept(pool,async(connection,text,params)=>{
    if(!text.includes('WITH home_totals'))return connection.unsafe(text,...params);
    try{await connection.unsafe('SELECT pg_sleep(2)');}
    catch(error){assert.equal(error.code,'57014');timedOut=true;throw error;}
    assert.fail('optional statement exceeded its PostgreSQL timeout');
  });
  const timeout=await call('auth/session',{cookie:admin.cookie,selector:'1',businessPool:slow});
  assert.equal(timedOut,true);
  assert.equal(timeout.status,200,timeout.body);
  assert.equal(timeout.body,base.body);

  const partial=intercept(pool,(connection,text,params)=>text.includes('WITH home_totals')
    ?connection.unsafe('SELECT 1::bigint AS summary_rows'):connection.unsafe(text,...params));
  const incomplete=await call('auth/session',{cookie:admin.cookie,selector:'1',businessPool:partial});
  assert.equal(incomplete.body,base.body);

  const withoutWalletScope=intercept(pool,async(connection,text,params)=>{
    const rows=await connection.unsafe(text,...params);
    return text.includes('AS can_read_sms')?rows.map(row=>({...row,can_read_sms:false})):rows;
  });
  const walletMismatchStart=businessStatements.length;
  const walletMismatch=await call('auth/session',{cookie:admin.cookie,selector:'1',businessPool:withoutWalletScope});
  assert.equal(walletMismatch.body,base.body);
  assert.ok(!businessStatements.slice(walletMismatchStart).some(text=>text.includes('WITH home_totals')));

  let revokedGrant;
  const revoking=intercept(pool,async(connection,text,params)=>{
    const rows=await connection.unsafe(text,...params);
    if(/^SELECT private\.burimunsi_browser_pin_session\(/.test(text)){
      [revokedGrant]=await fixtureSql(`DELETE FROM app.admin_grants g
        WHERE g.user_id=$1 AND g.permission='overview.read' RETURNING to_jsonb(g) AS record`,[base.data.user.principalId]);
      assert.ok(revokedGrant);
    }
    return rows;
  });
  try{
    const raced=await call('auth/session',{cookie:admin.cookie,selector:'1',businessPool:revoking});
    assert.ok(raced.status===200&&raced.body===base.body,JSON.stringify({status:raced.status,failure:raced.failure}));
    const denied=await call('auth/session',{cookie:admin.cookie,selector:'1'});
    assert.equal(denied.status,200,denied.body);
    assert.equal(denied.data.user.permissions.includes('overview.read'),false);
    assert.equal(denied.data.homeBootstrap,undefined);
    assert.equal(denied.data.homeCollectionId,undefined);
  }finally{
    if(revokedGrant)await fixtureSql('INSERT INTO app.admin_grants SELECT (jsonb_populate_record(NULL::app.admin_grants,$1::jsonb)).*',
      [revokedGrant.record]);
  }

  const loggedOut=await call('auth/logout',{cookie:admin.cookie,csrf:base.data.csrfToken,selector:'1'});
  assert.equal(loggedOut.status,200,loggedOut.body);
  assert.deepEqual(loggedOut.data,{ok:true});
  const stale=await call('auth/session',{cookie:admin.cookie,selector:'1'});
  assert.equal(stale.status,200,stale.body);
  assert.equal(stale.body,noCookie.body);
  const expiredCookie=randomBytes(32).toString('hex');
  const expiredHash=createHash('sha256').update(expiredCookie).digest('hex');
  // Seed an already expired copy without changing a session's immutable identity.
  const [expiredProof]=await fixtureSql(`WITH previous AS (
    SELECT b.*,a.auth_version FROM private.burimunsi_browser_pin_sessions b
      JOIN app.admin_sessions a ON a.token_hash=b.cookie_hash WHERE b.cookie_hash=$1
  ), principal AS (
    INSERT INTO app.auth_sessions(id,user_id,surface,auth_at,created_at,expires_at)
    SELECT $3,principal_id,'admin',issued_at-3600,issued_at-3600,expires_at-3600 FROM previous RETURNING id
  ), browser AS (
    INSERT INTO private.burimunsi_browser_pin_sessions(session_id,cookie_hash,public_id,collection_id,origin,profile_sha256,
      account_id,account_version,credential_version,admin_id,principal_id,authority,issued_at,expires_at,verified_at,proof_id)
    SELECT principal.id,$2,$4::uuid,collection_id,origin,profile_sha256,account_id,account_version,credential_version,
      admin_id,principal_id,authority,issued_at-3600,expires_at-3600,verified_at-3600,gen_random_uuid()
    FROM previous CROSS JOIN principal RETURNING session_id,cookie_hash,public_id,admin_id,origin,issued_at,expires_at
  ), web AS (
    INSERT INTO app.admin_sessions(token_hash,public_id,user_id,auth_version,auth_session_id,origin,created_at,expires_at)
    SELECT browser.cookie_hash,browser.public_id::text,browser.admin_id,previous.auth_version,browser.session_id,
      browser.origin,browser.issued_at,browser.expires_at FROM browser CROSS JOIN previous RETURNING token_hash
  ) SELECT (SELECT count(*) FROM principal)=1 AND (SELECT count(*) FROM web)=1 AS expired`,
    [staff.cookieHash,expiredHash,randomUUID(),randomUUID()]);
  assert.equal(expiredProof.expired,true);
  const expired=await call('auth/session',{cookie:expiredCookie,selector:'1'});
  assert.equal(expired.body,noCookie.body);
  console.log('PASS optional timeout, partial projection, wallet scope mismatch, current grant revocation, switched scope, logout and expiry do not expose Home');
}
