import {ApiError,now,uuid} from './core.js';
import {receiptFactColumns,receiptFactJoins,withReceiptFacts} from './receipt_facts.js';

const fail=(s,c,m)=>{throw new ApiError(s,c,m);};
const exactMomoMeasurement=value=>{if(!Number.isSafeInteger(value))fail(503,'invalid_source_data','Transaction measurements are unavailable.');return value;};
const paymentFields=[
 'id','provider','provider_transaction_id','original_transaction_id','payer_name','payer_last3','member_name','group_name',
 'payment_id','beneficiary_member_id','group_id','native_group_id','credited_amount_minor','version','created_at','transaction_at',
 'has_conflict','receiving_account_id','recipient_name','public_code','amount_minor','currency','currency_scale','fee_minor',
 'wallet_balance_after_minor','status','event_kind','allocation_state','provider_confirmation','settlement_status',
 'payment_version','intent_id','transaction_timezone','transaction_time_source','receiving_context',
];
const paymentFactFields=[
 'contract_version','kind','transaction_id','provider','provider_transaction_id','event_kind','payer_name','payer_last3',
 'amount_minor','currency','currency_scale','fee_minor','wallet_balance_after_minor','transaction_at','normalization_timezone',
 'transaction_time_source','public_reference','provider_confirmation','settlement_status',
];
const pickFields=(value,fields)=>Object.fromEntries(fields.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));

function transactionView(row,sourceHistory){
 const transaction=withReceiptFacts(row);
 if(sourceHistory)return transaction;
 // Preserve the validated financial projection without publishing underlying
 // receipt IDs, digests, parser evidence, or raw payer evidence.
 return {...pickFields(transaction,paymentFields),source_history_available:false,
  receipt_facts:pickFields(transaction.receipt_facts,paymentFactFields)};
}

export async function momoReceivingAccounts(env, url) {
 queryMomoFilters(url, []);
 const [accounts] = await env.DB.batch([
  env.DB.prepare(`SELECT id,provider,public_code,recipient_name,currency,timezone,status,profile_status,profile_version,created_at
   FROM momo_receiving_accounts ORDER BY created_at DESC,id`),
 ]);
 return {rows:accounts.results};
}

export async function momoGatewayBindings(env, url) {
 queryMomoFilters(url, []);
 const [bindings] = await env.DB.batch([
  env.DB.prepare(`SELECT b.*,c.last_contact_at,c.last_sms_at,c.pending_count,c.oldest_pending_at
   FROM momo_gateway_bindings b LEFT JOIN momo_gateway_credentials c ON c.binding_id=b.id
   ORDER BY b.created_at DESC,b.id LIMIT 100`),
 ]);
 return {rows:bindings.results};
}

// The legacy assignment workflow accepts only its original managed receipt.
// A native observation deliberately has no managed session or receiver hash:
// its configured capture scope is not evidence of the receiving account.
export const MANAGED_MOMO_SOURCE_SQL=`EXISTS(SELECT 1 FROM momo_transaction_sources managed_source
 JOIN sms_receipts managed_raw ON managed_raw.id=managed_source.raw_sms_id
 JOIN momo_parse_attempts managed_attempt ON managed_attempt.id=managed_source.parse_attempt_id
  AND managed_attempt.raw_sms_id=managed_source.raw_sms_id AND managed_attempt.outcome='accepted'
  AND managed_attempt.source_body_sha256=managed_raw.body_sha256
 WHERE managed_source.transaction_id=t.id AND managed_source.parse_attempt_id=t.parse_attempt_id
 AND managed_source.relation='accepted' AND managed_raw.originating_session_id IS NOT NULL
 AND managed_raw.receiver_hash IS NOT NULL)`;
// The native scope lookup is installed by the additive auto-transaction
// migration. Keep the existing managed query usable until that feature is
// explicitly enabled on a deployment containing the lookup.
export function momoTransactionSql(env,{byId=false}={}){
 const native=env?.BURIMUNSI_NATIVE_AUTO_TRANSACTIONS_ENABLED==='true';
 const source=byId?'(SELECT * FROM momo_transactions WHERE id=?)':'momo_transactions';
 // Enrichment is source-bound and separately retained: immutable first parse
 // rows remain intact. Project the same validated native facts as the app.
 const transactionSource=native?`${source} original
 CROSS JOIN LATERAL (SELECT private.burimunsi_admin_transaction_facts(original.id) AS value OFFSET 0) native_context
 CROSS JOIN LATERAL (SELECT native_context.value->'facts' AS facts, native_context.value->'scope' AS scope) native_facts
 CROSS JOIN LATERAL jsonb_populate_record(NULL::app.momo_transactions,to_jsonb(original) ||
  jsonb_strip_nulls(jsonb_build_object(
   'event_kind',native_facts.facts->'event_kind','amount_minor',native_facts.facts->'amount_minor',
   'currency',native_facts.facts->'currency','currency_scale',CASE WHEN native_facts.facts->>'currency'='RWF' THEN 0 ELSE NULL END,
   'payer_name',native_facts.facts->'counterparty_name','payer_identifier',native_facts.facts->'counterparty_identifier',
   'payer_last3',CASE WHEN native_facts.facts->>'counterparty_identifier' ~ '^[*xX•+0-9 ()-]*[0-9]{3}$' THEN right(native_facts.facts->>'counterparty_identifier',3) ELSE NULL END,
   'fee_minor',native_facts.facts->'fee_minor','wallet_balance_after_minor',native_facts.facts->'wallet_balance_after_minor',
   'transaction_at',native_facts.facts->'transaction_at','transaction_datetime_raw',native_facts.facts->'transaction_datetime_raw',
   'transaction_time_source',native_facts.facts->'transaction_time_source','transaction_timezone',native_facts.facts->'transaction_timezone',
   'provider_transaction_id',native_facts.facts->'provider_transaction_id','original_transaction_id',native_facts.facts->'original_transaction_id'
  ))) AS t`:`${source} t`;
 const nativeGroup=native?"CASE WHEN native_facts.scope->>'kind'='visible' THEN native_facts.scope->>'groupId' ELSE NULL END":'NULL';
 const nativeFilter=native?"WHERE native_facts.scope->>'kind' IN ('managed','visible') AND (rf_capture.id IS NULL OR rf_capture.originating_session_id IS NOT NULL OR native_facts.scope->>'kind'='visible')":
  'WHERE (rf_capture.id IS NULL OR rf_capture.originating_session_id IS NOT NULL)';
 return `SELECT t.*,${receiptFactColumns},a.public_code,a.recipient_name,l.payment_id,l.beneficiary_member_id,${nativeGroup} AS native_group_id,coalesce(p.collection_id,${nativeGroup}) AS group_id,g.title AS group_name,u.full_name AS member_name,
 p.revision AS payment_version,p.intent_id,coalesce((SELECT sum(e.amount_minor) FROM ledger_entries e WHERE e.payment_id=p.id),0) AS credited_amount_minor,
 CASE WHEN p.status='reversed' THEN 'reversed' WHEN p.status IN('reconciled','confirmed') THEN 'credited'
 WHEN ${nativeGroup} IS NOT NULL OR t.event_kind NOT IN ('incoming_receipt','reversal') THEN 'recorded'
 WHEN t.has_conflict=1 OR t.allocation_state='needs_review' THEN 'needs_review' WHEN l.payment_id IS NOT NULL THEN 'awaiting_review' ELSE 'needs_allocation' END AS status
 FROM ${transactionSource} JOIN momo_receiving_accounts a ON a.id=t.receiving_account_id ${receiptFactJoins}
 LEFT JOIN momo_financial_links l ON l.transaction_id=t.id LEFT JOIN payments p ON p.id=l.payment_id
 LEFT JOIN collections g ON g.id=coalesce(p.collection_id,${nativeGroup}) LEFT JOIN users u ON u.id=l.beneficiary_member_id ${nativeFilter}`;
}
export function queryMomoFilters(url,allowed){for(const key of url.searchParams.keys())if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)fail(400,'invalid_filter','This MoMo filter is unavailable.');
 const offset=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??25),search=url.searchParams.get('search')??'',status=url.searchParams.get('status')??'';
 if(!Number.isInteger(offset)||offset<0||offset>2147483647||!Number.isInteger(limit)||limit<1||limit>100||search.length>200||/[\x00-\x1f\x7f]/.test(search))fail(400,'invalid_filter','Choose a valid transaction filter.');
 return {offset,limit,search,status};}

export async function momoTransactionCandidates(env, transactionId, {search, limit, offset}) {
 const candidates = `FROM momo_transactions t JOIN momo_receiving_accounts a ON a.id=t.receiving_account_id
  JOIN collections g JOIN memberships m ON m.collection_id=g.id JOIN users u ON u.id=m.user_id
  WHERE t.id=? AND ${MANAGED_MOMO_SOURCE_SQL} AND t.has_conflict=0 AND t.allocation_state='unallocated'
  AND g.status='active' AND m.active=1 AND u.access_status='active' AND u.member_type!='operator'
  AND g.receiver_network=a.provider AND
  (CASE WHEN g.receiver_momo_number GLOB '07*' AND length(g.receiver_momo_number)=10 THEN '250'||substr(g.receiver_momo_number,2) ELSE replace(g.receiver_momo_number,'+','') END)=
  (CASE WHEN a.public_code GLOB '07*' AND length(a.public_code)=10 THEN '250'||substr(a.public_code,2) ELSE replace(a.public_code,'+','') END)
  AND (?='' OR instr(lower(u.full_name),lower(?))>0 OR instr(u.public_id,?)>0)`;
 const values = [transactionId, search, search, search];
 const [count, matches] = await env.DB.batch([
  env.DB.prepare(`SELECT count(*) AS n ${candidates}`).bind(...values),
  env.DB.prepare(`SELECT g.id AS group_id,g.title AS group_name,u.id AS member_id,u.full_name AS member_name,u.public_id AS member_public_id
   ${candidates} ORDER BY u.full_name,g.title,u.id,g.id LIMIT ? OFFSET ?`).bind(...values, limit, offset),
 ]);
 return {rows:matches.results, total:exactMomoMeasurement(count.results[0].n), limit, offset};
}

export async function momoTransactionDetail(scoped, env, url, rawId,{sourceHistory=true}={}) {
 queryMomoFilters(url, []);
 const transactionId = uuid(rawId);
 const db = scoped.DB;
 const statements=[db.prepare(momoTransactionSql(env,{byId:true})).bind(transactionId)];
 if(sourceHistory)statements.push(
  db.prepare(`SELECT s.raw_sms_id,s.relation,s.created_at,a.id AS attempt_id,a.outcome,a.model_id,a.schema_version,a.parser_version,a.validation_json
   FROM momo_transaction_sources s JOIN momo_parse_attempts a ON a.id=s.parse_attempt_id
   WHERE s.transaction_id=? ORDER BY a.created_at DESC LIMIT 100`).bind(transactionId),
  db.prepare("SELECT DISTINCT parse_attempt_id FROM momo_transaction_sources WHERE transaction_id=? AND relation='conflict' ORDER BY parse_attempt_id LIMIT 101").bind(transactionId),
  db.prepare("SELECT actor_user_id,details_json,created_at FROM audit_log WHERE action='momo.conflict.reviewed' AND entity_id=? ORDER BY id DESC LIMIT 25").bind(transactionId),
 );
 const [transactions,sources,attempts,reviews]=await db.batch(statements);
 if (!transactions.results.length) fail(404, 'not_found', 'This transaction is unavailable.');
 return {
  transaction:transactionView(transactions.results[0],sourceHistory),
  sources:sources?.results??[],
  conflicting_attempt_ids:attempts?.results.map(row=>row.parse_attempt_id)??[],
  conflict_reviews:reviews?.results??[],
 };
}

export async function momoSourcePage(env, url) {
 const {limit, offset, status} = queryMomoFilters(url, ['limit', 'offset', 'status']);
 if (status && !['pending', 'processing', 'retry', 'completed', 'needs_review', 'source_unresolved'].includes(status)) {
  fail(400, 'invalid_filter', 'Choose a valid processing state.');
 }
 const jobs = 'FROM momo_processing_jobs j JOIN sms_receipts s ON s.id=j.raw_sms_id AND s.originating_session_id IS NOT NULL' +
  (status ? ' WHERE j.state=?' : '');
 const values = status ? [status] : [];
 const [count, page] = await env.DB.batch([
  env.DB.prepare(`SELECT count(*) AS total ${jobs}`).bind(...values),
  env.DB.prepare(`WITH page AS (
   SELECT j.*,s.body_sha256,s.received_at_device,s.created_at AS received_at
   ${jobs} ORDER BY j.created_at DESC,j.raw_sms_id LIMIT ? OFFSET ?
  ) SELECT page.*,latest.id AS latest_attempt_id,latest.outcome AS latest_attempt_outcome
   FROM page LEFT JOIN momo_parse_attempts latest ON latest.id=(
     SELECT a.id FROM momo_parse_attempts a WHERE a.raw_sms_id=page.raw_sms_id ORDER BY a.attempt_number DESC LIMIT 1
   ) ORDER BY page.created_at DESC,page.raw_sms_id`).bind(...values, limit, offset),
 ]);
 return {rows:page.results, total:count.results[0].total, limit, offset};
}
export function momoTransactionPredicates(url,f){const where=[],args=[];
 if(url.searchParams.has('receiving_account_id')&&url.searchParams.has('account_scope_id'))
  fail(400,'invalid_filter','Choose only one account filter.');
 if(f.search){where.push('(provider_transaction_id LIKE ? OR payer_name LIKE ?)');args.push('%'+f.search+'%','%'+f.search+'%');}
 if(f.status==='needs_attention')where.push("(status IN('needs_allocation','awaiting_review','needs_review') OR has_conflict=1)");
 else if(f.status){if(!['recorded','needs_allocation','awaiting_review','credited','reversed','needs_review'].includes(f.status))fail(400,'invalid_filter','Choose a supported payment state.');where.push(f.status==='needs_review'?'(status=? OR has_conflict=1)':'status=?');args.push(f.status);}
 for(const key of ['receiving_account_id','group_id'])if(url.searchParams.has(key)){
  where.push(key==='receiving_account_id'?`(${key}=? AND native_group_id IS NULL)`:`${key}=?`);
  args.push(uuid(url.searchParams.get(key),key));}
 // Opt-in contract: the account is the configured native capture scope or the
 // recorded managed receiving account, not proof of an SMS destination. Keep
 // the older receiving-account filter unchanged for already-installed clients.
 if(url.searchParams.has('account_scope_id')){
  where.push('receiving_account_id=?');args.push(uuid(url.searchParams.get('account_scope_id'),'account_scope_id'));
 }
 for(const [key,op]of [['from','>='],['to','<=']])if(url.searchParams.has(key)){const value=url.searchParams.get(key);if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)||!Number.isFinite(Date.parse(value)))fail(400,'invalid_filter','Use an exact UTC transaction date.');where.push(`transaction_at ${op} ?`);args.push(value);}
 return {where:where.length?' WHERE '+where.join(' AND '):'',args};}
export function momoTransactionPageRow(row,accountScope,{sourceHistory=true}={}){
 const facts=transactionView(row,sourceHistory);
 if(accountScope!==null&&row.receiving_account_id!==accountScope)
  fail(503,'invalid_source_data','Transaction account scope changed. Refresh to check again.');
 // Only the explicit new filter discloses this scoped identifier. The legacy
 // receiving-account fields remain null for native observations.
 return accountScope!==null&&row.native_group_id!=null
  ?{...facts,capture_scope_account_id:row.receiving_account_id}:facts;
}
export async function momoTransactionPage(env,url,{sourceHistory=true}={}){
 const f=queryMomoFilters(url,['limit','offset','search','status','receiving_account_id','account_scope_id','group_id','from','to']);
 const filter=momoTransactionPredicates(url,f);
 // Share the guarded receipt projection and filtered rows between totals and
 // pagination. Even an empty later page carries the complete filtered totals.
 const [result]=await env.DB.batch([env.DB.prepare(`WITH records AS MATERIALIZED (
  SELECT * FROM (${momoTransactionSql(env)}) projected${filter.where}
 ), totals AS (
  SELECT count(*) AS page_total,
   coalesce(sum(amount_minor) FILTER (WHERE event_kind='incoming_receipt'),0) AS page_received,
   coalesce(sum(credited_amount_minor),0) AS page_credited,
   coalesce(sum(amount_minor) FILTER (WHERE event_kind='incoming_receipt' AND credited_amount_minor=0 AND status!='reversed'),0) AS page_unallocated
  FROM records
 ), page AS (
  SELECT * FROM records ORDER BY coalesce(transaction_at,created_at) DESC,id LIMIT ? OFFSET ?
 ) SELECT totals.*,page.* FROM totals LEFT JOIN page ON true
 ORDER BY coalesce(page.transaction_at,page.created_at) DESC,page.id`).bind(...filter.args,f.limit,f.offset)]);
 const summary=result.results[0];
 const scope=url.searchParams.has('account_scope_id')?uuid(url.searchParams.get('account_scope_id'),'account_scope_id'):null;
 const rows=result.results.flatMap(({page_total,page_received,page_credited,page_unallocated,...row})=>
  row.id===null?[]:[momoTransactionPageRow(row,scope,{sourceHistory})]);
 return {contract_version:1,rows,total:exactMomoMeasurement(summary.page_total),limit:f.limit,offset:f.offset,
  totals:{received_minor:exactMomoMeasurement(summary.page_received),credited_minor:exactMomoMeasurement(summary.page_credited),
   unallocated_minor:exactMomoMeasurement(summary.page_unallocated)},currency:'RWF',date_basis:'provider_transaction_time',as_of:now()};
}
export async function momoPaymentChecks(env,url){
 const f=queryMomoFilters(url,['limit','offset']),cte=`WITH typed AS (
  SELECT r.*,CASE WHEN json_valid(r.message) THEN r.message ELSE '{}' END AS context FROM support_requests r WHERE r.kind='payment_review'
 ),checked AS (
  SELECT r.id,r.user_id AS member_id,u.public_id AS member_public_id,u.full_name AS member_name,r.collection_id AS group_id,g.title AS group_name,
   i.id AS intent_id,i.amount_minor AS expected_amount_minor,i.currency,r.created_at AS requested_at,r.status AS request_status,
   json_extract(r.context,'$.provider_reference') AS provider_reference,json_extract(r.context,'$.evidence_note') AS evidence_note
  FROM typed r JOIN payment_intents i ON i.id=json_extract(r.context,'$.intent_id') AND i.member_id=r.user_id AND i.collection_id=r.collection_id
   JOIN users u ON u.id=r.user_id JOIN collections g ON g.id=r.collection_id
  WHERE json_type(r.context,'$.contract_version')='integer' AND json_extract(r.context,'$.contract_version')=1
   AND json_type(r.context,'$.intent_id')='text' AND json_type(r.context,'$.collection_id')='text'
   AND json_extract(r.context,'$.collection_id')=r.collection_id
   AND json_type(r.context,'$.provider_reference') IN('null','text') AND coalesce(length(json_extract(r.context,'$.provider_reference')),0)<=160
   AND json_type(r.context,'$.evidence_note') IN('null','text') AND coalesce(length(json_extract(r.context,'$.evidence_note')),0)<=2000
   AND (SELECT count(*) FROM json_each(r.context))=5
   AND NOT EXISTS(SELECT 1 FROM json_each(r.context) WHERE key NOT IN('contract_version','intent_id','collection_id','provider_reference','evidence_note'))
 )`;
 const result=await env.DB.batch([env.DB.prepare(`${cte} SELECT count(*) AS total FROM checked`),
  env.DB.prepare(`${cte} SELECT * FROM checked ORDER BY requested_at DESC,id DESC LIMIT ? OFFSET ?`).bind(f.limit,f.offset)]),total=exactMomoMeasurement(result[0].results[0].total);
 return {contract_version:1,rows:result[1].results.map(row=>({...row,expected_amount_minor:exactMomoMeasurement(row.expected_amount_minor),source:'member_request',provider_reference_verified:false,financial_effects:0})),total,limit:f.limit,offset:f.offset,next_offset:f.offset+result[1].results.length<total?f.offset+result[1].results.length:null};
}
