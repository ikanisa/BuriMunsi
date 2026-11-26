// Optional read-only PostgreSQL qualification with exclusively synthetic CTEs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadBuriPostgresFixture} from './postgres-fixture.mjs';
import {SMART_SUGGESTIONS_CTE,PAYMENT_SUGGESTIONS_CTE,findOnboardingCandidate,listOnboardingSuggestions,
 paymentSuggestionsRevision} from '../../domain/burimunsi/smart-onboarding-suggestions.js';

const fixture=loadBuriPostgresFixture();
async function qualifyPaymentSuggestions() {
 const groupId='group-1',created='2026-11-22T07:00:00.123456Z',mode={paymentsOnly:true};
 const payments=[];
 const add=(name,number,extra={})=>{
  const i=payments.length+1;
  const row={id:`10000000-0000-4000-8000-${String(i).padStart(12,'0')}`,collection_id:groupId,receiving_account_id:'wallet',
   direction:'incoming',allocation_state:'unallocated',sms_source_id:'receipt-'+i,counterparty_name:name,
   counterparty_identifier:number,occurred_at:null,created_at:created,...extra};
  payments.push(row);return row;
 };
 const full=add('Aline Example','+250 (780) 000-123');
 const recent=add('Aline Example','*****123',{id:'non-uuid-source-private',occurred_at:'2026-11-23T08:09:10.000012Z'});
 const hint=add('Independent Payer','*****123');
 add('Ambiguous','0780000456');add('Ambiguous','0781000456');add('Ambiguous','*****456');
 add('Already Known','0780000789');add('Already Known','*****789');
 add('Same Member','*****555');add('Merchant Code','41258');add('Name 0780000333','*****333');
 add('Outgoing','*****333',{direction:'outgoing'});add('Allocated','*****333',{allocation_state:'allocated'});
 add('Missing Source','*****333',{sms_source_id:null});add('Missing Hint',null);
 add('Other Wallet','*****333',{receiving_account_id:'other-wallet'});add('Foreign Group','*****333',{collection_id:'group-2'});
 const tables={
  'burimunsi.payments':{columns:'id text,collection_id text,receiving_account_id text,direction text,allocation_state text,sms_source_id text,counterparty_name text,counterparty_identifier text,occurred_at timestamptz,created_at timestamptz',rows:payments},
  'private.burimunsi_scopes':{columns:'collection_id text,receiving_account_id text,enabled boolean,active_binding_id text',rows:[{collection_id:groupId,receiving_account_id:'wallet',enabled:false,active_binding_id:null}]},
  'app.collections':{columns:'id text,status text,currency text',rows:[{id:groupId,status:'active',currency:'RWF'}]},
  'app.momo_receiving_accounts':{columns:'id text,status text,currency text',rows:[{id:'wallet',status:'active',currency:'RWF'}]},
  'app.memberships':{columns:'collection_id text,user_id text',rows:[{collection_id:groupId,user_id:'member'},{collection_id:groupId,user_id:'member-2'},{collection_id:'group-2',user_id:'other'}]},
  'app.users':{columns:'id text,full_name text,momo_number text,phone text',rows:[{id:'member',full_name:'Different stored name',momo_number:null,phone:'0780000789'},{id:'member-2',full_name:'Same Member',momo_number:'0780000555',phone:null},{id:'other',full_name:'Independent Payer',phone:'0781000123'}]},
 };
 const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
 const sql={async unsafe(query,params){
  assert.ok(query.startsWith(PAYMENT_SUGGESTIONS_CTE));
  const definitions=Object.entries(tables).map(([name,{columns,rows}],i)=>{
   query=query.replaceAll(name,'fixture_'+i);
   return `fixture_${i} AS (SELECT * FROM jsonb_to_recordset(${quote(JSON.stringify(rows))}::jsonb) AS r(${columns}))`;
  });
  assert.doesNotMatch(query,/\b(?:app|private|burimunsi)\.(?:payments|burimunsi_|momo_)/);
  query=query.replace('WITH sources AS (',`WITH ${definitions.join(',')}, sources AS (`);
  const child=fixture.run('postgres',['-Atq'],`BEGIN READ ONLY;
   PREPARE hints AS WITH result AS (${query}) SELECT coalesce(json_agg(result),'[]') FROM result;
   EXECUTE hints(${params.map(quote).join(',')}); ROLLBACK;`);
  assert.equal(child.status,0,child.stderr);
  return JSON.parse(child.stdout);
 }};
 const list=(query={})=>listOnboardingSuggestions(sql,{groupId,...query},mode);
 const match=(candidateId,phone,group=groupId)=>findOnboardingCandidate(sql,{groupId:group,candidateId,phone},mode);
 const revision=()=>paymentSuggestionsRevision(sql,{groupId});
 const first=await list({limit:1}),next=await list({limit:1,after:first.after});
 assert.equal(first.totalCount,2);assert.deepEqual(first.after,{offset:1});assert.equal(next.after,null);
 const chosen=first.items[0];
 assert.deepEqual({...chosen,candidateId:'redacted'},{candidateId:'redacted',momoName:'Aline Example',last3:'123',sourceCount:2,latestSeenAt:'2026-11-23T08:09:10.000012Z'});
 assert.match(chosen.candidateId,/^[a-f0-9-]{14}8[a-f0-9-]{21}$/);
 assert.doesNotMatch(JSON.stringify(first),/0780000123|non-uuid-source-private|\+250/);
 assert.equal(next.items[0].candidateId,hint.id);assert.equal(next.items[0].latestSeenAt,created);
 assert.equal((await list({q:'ALI'})).totalCount,1);assert.equal((await list({q:'123'})).totalCount,2);
 assert.deepEqual(await match(chosen.candidateId,'0780000123'),{last3:'123'});
 assert.equal(await match(chosen.candidateId,'0781000123'),null);
 assert.deepEqual(await match(hint.id,'0781000123'),{last3:'123'});assert.equal(await match(hint.id,'0781000124'),null);
 assert.equal(await match(chosen.candidateId,'0780000123','group-2'),null);
 const before=await revision();assert.equal(await revision(),before);
 recent.allocation_state='allocated';assert.notEqual(await revision(),before);
 assert.equal(await match(chosen.candidateId,'0780000123'),null);
 assert.equal((await list({q:'Aline'})).items[0].candidateId,full.id);
 tables['app.collections'].rows[0].status='inactive';assert.equal((await list()).totalCount,0);
}

test('Postgres suggestions preserve managed phones and native name/masked-suffix identity', {skip:!fixture},async()=>{
 const ids=Array.from({length:25},(_,i)=>`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
 const native=i=>i===5||i>=8;
 const phones=['0780000816','+250 780 000 816','0781000816','0780000819','0780000820','*****821','0780000822','0780000823'];
 const tx=ids.map((id,i)=>({id,receiving_account_id:'wallet',parse_attempt_id:`a${i}`,event_kind:'incoming_receipt',mode:native(i)?'historical':'live',has_conflict:i===7?1:0,allocation_state:'unallocated',currency:'RWF',payer_name:i===2?'Straße Example':'Áline Example',payer_identifier:phones[i]??'*****999',transaction_at:new Date(Date.UTC(2026,10,13,8,0,i)).toISOString()}));
 const nativeNames={5:'Native New',8:'NATIVE, NEW',9:'Other Native',10:'Registered Native',14:'Ambiguous Native',15:'Ambiguous Native',16:'Ambiguous Native',19:'Known Native',20:'Known Native'};
 const nativePhones={5:'*****821',8:'*****821',9:'*****821',10:'*****823',14:'0785000825',15:'0786000825',16:'*****825',19:'*****826',20:'0787000826'};
 // Suggestions are identity hints: missing financial amounts/balances do not
 // authorize a credit, and do not suppress an otherwise valid name/suffix.
 const projections=ids.flatMap((id,i)=>native(i)?[{source_id:`r${i}`,value:{sourceId:i===17?'wrong-source':`r${i}`,outcome:i===13?'failed':'successful',facts:i===24?null:{event_kind:i===12?'outgoing':'incoming_receipt',payment_outcome:i===13?'failed':i===22?'unknown':'successful',amount_minor:null,currency:'RWF',counterparty_name:i===21?'Invalid\nName':nativeNames[i]??'Excluded Native',counterparty_identifier:i===18?'*****12':nativePhones[i]??'*****999',wallet_balance_after_minor:null,transaction_at:tx[i].transaction_at,source_mode:'catch_up'}}}]:[]);
 const tables={
  'private.burimunsi_transaction_scopes':{columns:'collection_id text,receiving_account_id text,transaction_id text,source_binding_id text,source_binding_version bigint,native_source_id text',rows:ids.map((id,i)=>({collection_id:i===4||i===11?'other-group':'group-1',receiving_account_id:'wallet',transaction_id:id,source_binding_id:native(i)?null:'binding',source_binding_version:native(i)?null:1,native_source_id:native(i)?`r${i}`:null}))},
  'private.burimunsi_scopes':{columns:'collection_id text,receiving_account_id text,enabled boolean,active_binding_id text,binding_version bigint',rows:[{collection_id:'group-1',receiving_account_id:'wallet',enabled:true,active_binding_id:'binding',binding_version:1}]},
  'app.collections':{columns:'id text,status text,receiver_network text,receiver_momo_number text',rows:[{id:'group-1',status:'active',receiver_network:'mtn',receiver_momo_number:'41258'}]},
  'app.momo_transactions':{columns:'id text,receiving_account_id text,parse_attempt_id text,event_kind text,mode text,has_conflict integer,allocation_state text,currency text,payer_name text,payer_identifier text,transaction_at text',rows:tx},
  'app.momo_receiving_accounts':{columns:'id text,status text,profile_status text,provider text,public_code text,receiver_hash text,profile_version text,profile_json text',rows:[{id:'wallet',status:'active',profile_status:'approved',provider:'mtn',public_code:'41258',receiver_hash:'hash',profile_version:'v1',profile_json:'{}'}]},
  'app.momo_transaction_sources':{columns:'transaction_id text,parse_attempt_id text,raw_sms_id text,relation text',rows:ids.map((id,i)=>({transaction_id:id,parse_attempt_id:`a${i}`,raw_sms_id:`r${i}`,relation:'accepted'}))},
  'app.sms_receipts':{columns:'id text,owner_user_id text,originating_session_id text,receiver_hash text,body_sha256 text',rows:ids.map((_,i)=>({id:`r${i}`,owner_user_id:'owner',originating_session_id:'session',receiver_hash:'hash',body_sha256:'body'}))},
  'app.momo_parse_attempts':{columns:'id text,raw_sms_id text,outcome text,source_body_sha256 text,profile_version text,profile_json text',rows:ids.map((_,i)=>({id:`a${i}`,raw_sms_id:`r${i}`,outcome:'accepted',source_body_sha256:i===23?'wrong-body':'body',profile_version:'v1',profile_json:'{}'}))},
  'app.momo_gateway_captures':{columns:'raw_sms_id text,credential_id text,completeness text,source_mode text',rows:ids.map((_,i)=>({raw_sms_id:`r${i}`,credential_id:'credential',completeness:i===6?'incomplete':'complete',source_mode:'live'}))},
  'app.momo_gateway_credentials':{columns:'id text,binding_id text,revoked_at text',rows:[{id:'credential',binding_id:'binding',revoked_at:null}]},
  'app.momo_gateway_bindings':{columns:'id text,receiving_account_id text,owner_user_id text,status text,version bigint',rows:[{id:'binding',receiving_account_id:'wallet',owner_user_id:'owner',status:'active',version:1}]},
  'app.momo_processing_jobs':{columns:'raw_sms_id text,binding_id text,binding_version bigint,receiving_account_id text,mode text,state text,last_error text',rows:ids.map((_,i)=>({raw_sms_id:`r${i}`,binding_id:'binding',binding_version:1,receiving_account_id:'wallet',mode:'live',state:'completed',last_error:null}))},
  'app.momo_financial_links':{columns:'transaction_id text',rows:[]},
  'app.memberships':{columns:'collection_id text,user_id text',rows:[{collection_id:'group-1',user_id:'member'},{collection_id:'group-1',user_id:'native-member'},{collection_id:'other-group',user_id:'other-member'}]},
  'app.users':{columns:'id text,full_name text,momo_number text,phone text',rows:[{id:'member',full_name:'Managed Registered',momo_number:'+250 (780) 000-819',phone:null},{id:'native-member',full_name:'Registered Native',momo_number:'0790000823',phone:null},{id:'other-member',full_name:'Native New',momo_number:'0790000821',phone:null}]},
  'synthetic_native_projection':{columns:'source_id text,value jsonb',rows:projections},
 };
 let query=SMART_SUGGESTIONS_CTE;const definitions=[];
 for(const [name,fixture] of Object.entries(tables)){
  const alias=`fixture_${definitions.length}`,json=JSON.stringify(fixture.rows).replaceAll("'","''");
  definitions.push(`${alias} AS (SELECT * FROM jsonb_to_recordset('${json}'::jsonb) AS rows(${fixture.columns}))`);
  query=query.replaceAll(name,alias);
 }
 query=query.replaceAll('private.burimunsi_auto_projection(x.native_source_id)','(SELECT value FROM synthetic_native_projection WHERE source_id=x.native_source_id)');
 query=query.replaceAll('synthetic_native_projection',`fixture_${definitions.length-1}`);
 query=query.replace('WITH managed_admitted AS (',`WITH ${definitions.join(',')}, managed_admitted AS (`);
 // Exercise the native-only scope actually used when no managed gateway is
 // installed, as well as a deliberately disabled managed binding.
 const activeScope='"enabled":true,"active_binding_id":"binding"';
 assert.equal(query.split(activeScope).length,2);
 const nativeOnly=query.replace(activeScope,'"enabled":false,"active_binding_id":null');
 const disabledBinding=query.replace(activeScope,'"enabled":false,"active_binding_id":"binding"');
 for(const text of [query,nativeOnly,disabledBinding])assert.doesNotMatch(text,/\b(?:app|private)\./);
 const candidateList=`SELECT coalesce(json_agg(json_build_object('id',candidate_id,'last3',last3,'count',source_count) ORDER BY candidate_id),'[]'::json) FROM filtered;`;
 const candidateMatch=`SELECT count(*) FROM filtered WHERE candidate_id=$3
   AND EXISTS(SELECT 1 FROM grouped WHERE candidate_id=$3 AND (payer_phone=$4 OR
    (payer_phone IS NULL AND last3=right($4::text,3) AND (known_phone IS NULL OR known_phone=$4))));`;
 const sql=`BEGIN READ ONLY; PREPARE candidate(text,text) AS ${query}
  ${candidateList}
  EXECUTE candidate('group-1',''); EXECUTE candidate('group-1','aline'); EXECUTE candidate('group-1','Áline'); EXECUTE candidate('group-1','Áline');
  EXECUTE candidate('group-1','strasse'); EXECUTE candidate('group-1','Straße'); EXECUTE candidate('group-1','816');
  EXECUTE candidate('group-1','819'); EXECUTE candidate('other-group',''); EXECUTE candidate('group-1','821');
  PREPARE candidate_match(text,text,text,text) AS ${query} ${candidateMatch}
  EXECUTE candidate_match('group-1','','${ids[1]}','+250780000816');
  EXECUTE candidate_match('group-1','','${ids[1]}','+250781000816');
  EXECUTE candidate_match('group-1','','${ids[8]}','+250780000821');
  EXECUTE candidate_match('group-1','','${ids[8]}','+250780000820');
  EXECUTE candidate_match('group-1','','${ids[20]}','+250787000826');
  EXECUTE candidate_match('group-1','','${ids[20]}','+250786000826');
  PREPARE native_only(text,text) AS ${nativeOnly} ${candidateList}
  EXECUTE native_only('group-1',''); EXECUTE native_only('other-group','');
  PREPARE disabled_binding(text,text) AS ${disabledBinding} ${candidateList}
  EXECUTE disabled_binding('group-1','');
  PREPARE native_match(text,text,text,text) AS ${nativeOnly} ${candidateMatch}
  EXECUTE native_match('group-1','','${ids[8]}','+250780000821');
  EXECUTE native_match('group-1','','${ids[8]}','+250780000820'); ROLLBACK;`;
 const child=fixture.run('postgres',['-Atq'],sql);
 assert.equal(child.status,0,child.stderr);
 const [all,accent,decomposed,precomposed,expanded,sharpS,suffix,registered,other,nativeSuffix,exactMatch,sameSuffix,nativeMatch,nativeWrong,knownMatch,knownWrong,nativeOnlyItems,nativeOther,disabledItems,nativeOnlyMatch,nativeOnlyWrong]=child.stdout.trim().split('\n').map(line=>JSON.parse(line));
 assert.deepEqual(all,[{id:ids[1],last3:'816',count:2},{id:ids[2],last3:'816',count:1},{id:ids[8],last3:'821',count:2},{id:ids[9],last3:'821',count:1},{id:ids[20],last3:'826',count:2}]);
 assert.deepEqual(accent,[all[0]]);assert.deepEqual(decomposed,accent);assert.deepEqual(precomposed,accent);
 assert.deepEqual(expanded,[all[1]]);assert.deepEqual(sharpS,expanded);assert.deepEqual(suffix,all.slice(0,2));assert.deepEqual(registered,[]);assert.deepEqual(other,[]);
 assert.deepEqual(nativeSuffix,all.slice(2,4));
 assert.equal(exactMatch,1);assert.equal(sameSuffix,0);assert.equal(nativeMatch,1);assert.equal(nativeWrong,0);assert.equal(knownMatch,1);assert.equal(knownWrong,0);
 assert.deepEqual(nativeOnlyItems,all.slice(2));assert.deepEqual(nativeOther,[]);assert.deepEqual(disabledItems,[]);
 assert.equal(nativeOnlyMatch,1);assert.equal(nativeOnlyWrong,0);
 await qualifyPaymentSuggestions();
});
