import {first,uuid,integer,now} from './core.js';
import {coreStatuses,coreOrdering,coreSearch} from './admin_search.js';
import {marker,contributionBasis,collectedBasis,fail,unavailable,iso,exact,amountString} from './admin_record_values.js';
import {lists,rosterSource,membershipSql,membershipRow,payeeSql,payeeRow,ledgerSql,ledgerRow,evidenceMetadataSql,evidenceMetadata} from './admin_record_sources.js';

// These read adapters receive an already authorized D1 binding from the route.
export {marker,permission,lists,list,filters,overview,operatingDetail,relatedPage,ledgerSql,ledgerRow,evidenceMetadataSql,evidenceMetadata,exact,iso,fail,unavailable};

const permission={groups:'collections',users:'users',members:'users',payees:'receivers',transactions:'payments',ledgers:'ledger'};

export const adminBridgeMetrics={
 users:'Users',app_users:'App users',direct_users:'Direct users',admin_users:'Admin users',staff_users:'Staff users',
 groups:'Groups',active_members:'Active members',payees:'Payees',active_payees:'Active payees',transactions:'Transactions',
 unallocated_transactions:'Unallocated transactions',ledger_entries:'Ledger entries',reversed_entries:'Reversal entries',payment_evidence:'Retained payment evidence',
 total_recorded_rwf:'Recorded evidence amount',total_reconciled_rwf:'Reconciled evidence amount',
 total_unallocated_rwf:'Unallocated evidence amount',total_net_contributions_rwf:'Net recorded contributions',
};

const listFilters=['country','search','status','limit','offset','sort'];
function filters(url,allowed=listFilters,type=null){
 for(const key of url.searchParams.keys())if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)fail(400,'invalid_filter','This filter is not supported.');
 if((url.searchParams.get('country')??'RW')!=='RW')fail(400,'invalid_filter','Only the Rwanda workspace is available.');
 const numeric=(key,fallback,min,max)=>{const raw=url.searchParams.get(key);if(raw===null)return fallback;if(!/^(0|[1-9][0-9]*)$/.test(raw))fail(400,'invalid_filter',`Invalid ${key}.`);return integer(Number(raw),key,min,max);};
 const search=url.searchParams.get('search')??'';if(search.length>200||/[\u0000-\u001f\u007f]/.test(search))fail(400,'invalid_filter','Search must contain at most 200 printable characters.');
 const sort=url.searchParams.get('sort')??'created_at_desc';if(type)coreOrdering(type,sort);else if(!['created_at_asc','created_at_desc'].includes(sort))fail(400,'invalid_filter','This sort is unsupported.');
 return {search:search.trim(),status:url.searchParams.get('status')??'',limit:numeric('limit',25,1,100),offset:numeric('offset',0,0,2147483647),sort};
}
async function list(env,type,url,{id:resourceId=null,activeOnly=false,eligiblePeople=false,groupId=null,rosterGroupId=null}={}){
 const roster=type==='members'&&rosterGroupId!==null;
 const spec=roster?rosterSource:lists[type],filterType=roster?'roster':type;
 if(!spec)unavailable();
 const f=filters(url,roster?[...listFilters,'directory']:listFilters,filterType),args=[],predicates=[];
 if(roster&&url.searchParams.get('directory')!=='roster')fail(400,'invalid_filter','This member directory is unavailable.');
 if(resourceId){predicates.push('id=?');args.push(uuid(resourceId));}
 if(activeOnly)predicates.push("status='active'");
 if(eligiblePeople)predicates.push("member_type!='operator'");
 if(groupId){
  if(type==='payees'){predicates.push('group_id=?');args.push(uuid(groupId));}
  else if(type==='members'){predicates.push("id IN (SELECT user_id FROM memberships WHERE collection_id=? AND active=1) AND EXISTS(SELECT 1 FROM collections WHERE id=? AND status='active')");args.push(uuid(groupId),groupId);}
  else fail(400,'invalid_filter','This lookup filter is unavailable.');
 }
 if(f.status){if(!coreStatuses[filterType].includes(f.status))fail(400,'invalid_filter','This status is unavailable for these records.');predicates.push(roster?'membership_status=?':'status=?');args.push(f.status);}
 if(f.search){const search=coreSearch(filterType,f.search,spec.search);predicates.push(...search.predicates);args.push(...search.args);}
 const where=predicates.length?` WHERE ${predicates.map(p=>`(${p})`).join(' AND ')}`:'',ordering=coreOrdering(filterType,f.sort);
 // A skipped member does not need a balance or membership count unless it sorts or filters the page.
 const pageSql = type==='members' && f.offset>0
  ? `SELECT records.* FROM records JOIN (
       SELECT id FROM records${where} ORDER BY ${ordering} LIMIT ? OFFSET ?
     ) selected USING (id)`
  : `SELECT * FROM records${where} ORDER BY ${ordering} LIMIT ? OFFSET ?`;
 const [page]=await env.DB.batch([env.DB.prepare(`WITH records AS NOT MATERIALIZED (${spec.query}),
  totals AS (SELECT count(*) AS page_total FROM records${where}), page AS (${pageSql})
  SELECT page.*,totals.page_total FROM totals LEFT JOIN page ON true ORDER BY ${ordering}`)
  .bind(...(roster?[rosterGroupId]:[]),...args,...args,f.limit,f.offset)]);
 const total=exact(page.results[0].page_total);
 const result=page.results.flatMap(row=>row.id===null?[]:[spec.row(row)]);
 if(result.length!==Math.max(0,Math.min(f.limit,total-f.offset)))fail(503,'invalid_source_data','Workspace measurements are unavailable.');
 return {...marker,rows:result,total};
}

// A scoped relationship count and page use the same guarded statement.
function relatedPageStatement(env,query,args,{limit=25,offset=0}={}){
 return env.DB.prepare(`WITH records AS NOT MATERIALIZED (${query}),
  totals AS (SELECT count(*) AS page_total FROM records), page AS (SELECT * FROM records ORDER BY id LIMIT ? OFFSET ?)
  SELECT page.*,totals.page_total FROM totals LEFT JOIN page ON true ORDER BY page.id`).bind(...args,limit,offset);
}
function relatedPageResult(result,map,{limit=25,offset=0}={}){
 const total=exact(result.results[0].page_total);
 const values=result.results.flatMap(row=>row.id===null?[]:[map(row)]);
 if(values.length!==Math.max(0,Math.min(limit,total-offset)))fail(503,'invalid_source_data','Related records are unavailable.');
 return {rows:values,page:{total,limit,offset,next_offset:offset+values.length<total?offset+values.length:null}};
}
async function relatedPage(env,query,args,map,options={}){
 const [result]=await env.DB.batch([relatedPageStatement(env,query,args,options)]);
 return relatedPageResult(result,map,options);
}
function allowedOperations(type,resource,account,receiverLocked=false){
 if(account.role==='staff')return [];
 const allowed=[],add=(name,cap)=>{if(account.permissions.includes(cap))allowed.push(name);};
 if(type==='groups'&&resource.status!=='archived'){
  add('updateGroup','collections.manage');
  if(resource.status==='active'){add('createMembership','users.manage');add('updateMembership','users.manage');if(!receiverLocked)add('updatePayee','receivers.manage');add('createTransaction','payments.manage');}
 }else if(type==='users'&&resource.member_type!=='operator'&&resource.status!=='deleted'){
  add('updateUser','users.manage');if(resource.status==='active')add('createMembership','users.manage');
 }else if(type==='payees'&&resource.status==='active'&&!receiverLocked)add('updatePayee','receivers.manage');
 else if(type==='transactions'&&['reconciled','confirmed'].includes(resource.status)&&resource.allocated_amount_rwf===resource.amount_rwf)add('reverseTransaction','payments.reconcile');
 return allowed;
}
async function operatingDetail(env,account,type,resourceId,url,{rosterGroupId=null}={}){
 const relation=url.searchParams.get('relation'),f=filters(url,['relation','limit','offset']);
 if(!relation&&(url.searchParams.has('limit')||url.searchParams.has('offset')))fail(400,'invalid_filter','Choose a related record page.');
 const baseUrl=new URL(url.origin);
 if(rosterGroupId)baseUrl.searchParams.set('directory','roster');
 const result=await list(env,type,baseUrl,{id:resourceId,rosterGroupId});
 if(!result.rows.length)fail(404,'not_found','This record was not found.');
 let resource=result.rows[0];const relations={},related={},related_pages={};
 if(type==='groups'){
  const source=await first(env,'SELECT description,creator_user_id FROM collections WHERE id=?',resourceId);
  resource={...resource,description:source.description,owner_user_id:source.creator_user_id};
  if(account.permissions.includes('users.read'))relations.memberships=[`${membershipSql} WHERE m.collection_id=?`,[resourceId],membershipRow];
  if(account.permissions.includes('receivers.read'))relations.payees=[`SELECT * FROM (${payeeSql}) WHERE group_id=?`,[resourceId],payeeRow];
 }else if(type==='members'&&rosterGroupId){
  if(account.permissions.includes('collections.read'))relations.memberships=[`${membershipSql} WHERE m.user_id=? AND m.collection_id=?`,[resourceId,rosterGroupId],membershipRow];
 }else if(type==='users'){
  if(account.permissions.includes('collections.read'))relations.memberships=[`${membershipSql} WHERE m.user_id=?`,[resourceId],membershipRow];
 }else if(type==='payees')resource={...resource,label:resource.title,group_title:resource.group_name};
 else if(type==='transactions'){
  relations.evidence=[evidenceMetadataSql,[resourceId],evidenceMetadata];
  if(account.permissions.includes('ledger.read'))relations.ledger_entries=[`SELECT * FROM (${ledgerSql}) WHERE payment_id=?`,[resourceId],ledgerRow];
 }
 if(relation&&!Object.hasOwn(relations,relation))fail(400,'invalid_filter','This related record page is unavailable.');
 const selected=Object.entries(relations).filter(([name])=>!relation||name===relation);
 if(selected.length){
  const options=relation?f:{};
  const results=await env.DB.batch(selected.map(([, [query,args]])=>relatedPageStatement(env,query,args,options)));
  selected.forEach(([name,[,,map]],index)=>{
   const page=relatedPageResult(results[index],map,options);
   related[name]=page.rows;
   related_pages[name]=page.page;
  });
 }
 let receiverLocked=type==='groups'&&(resource.is_platform_sponsored===true||resource.visibility==='public_approved');
 if(type==='payees'){const group=await first(env,'SELECT is_platform_sponsored,visibility_status FROM collections WHERE id=?',resource.group_id);receiverLocked=!group||group.is_platform_sponsored===1||group.visibility_status==='public_approved';}
 const allowed=allowedOperations(type,resource,account,receiverLocked);
 return {...marker,resource_type:type,resource,current_actor_id:account.id,can_manage:allowed.length>0,
  allowed_operations:allowed,related,related_pages,related_truncated:false};
}
async function overview(env,url){
 filters(url,['country']);const [result]=await env.DB.batch([env.DB.prepare(`SELECT people.*,operators.*,group_stats.*,payment_stats.*,ledger_stats.*,
 (SELECT count(DISTINCT user_id) FROM memberships WHERE active=1) AS active_members,
 (SELECT count(*) FROM payment_evidence) AS payment_evidence
 FROM (SELECT count(*) AS users,count(*) FILTER(WHERE member_type='app') AS app_users,
  count(*) FILTER(WHERE member_type='direct') AS direct_users FROM users) people
 CROSS JOIN (SELECT count(*) FILTER(WHERE role IN ('owner','admin') AND status='active') AS admin_users,
  count(*) FILTER(WHERE role='staff' AND status='active') AS staff_users FROM admin_users) operators
 CROSS JOIN (SELECT count(*) AS groups,count(*) FILTER(WHERE receiver_momo_number IS NOT NULL) AS payees,
  count(*) FILTER(WHERE receiver_momo_number IS NOT NULL AND status='active') AS active_payees FROM collections) group_stats
 CROSS JOIN (SELECT count(*) AS transactions,
  count(*) FILTER(WHERE status IN ('recorded','ambiguous') AND member_id IS NULL) AS unallocated_transactions,
  CAST(coalesce(sum(amount_minor),0) AS TEXT) AS total_recorded_rwf,
  CAST(coalesce(sum(amount_minor) FILTER(WHERE status IN ('reconciled','confirmed')),0) AS TEXT) AS total_reconciled_rwf,
  CAST(coalesce(sum(amount_minor) FILTER(WHERE status IN ('recorded','ambiguous') AND member_id IS NULL),0) AS TEXT) AS total_unallocated_rwf
  FROM payments) payment_stats
 CROSS JOIN (SELECT count(*) AS ledger_entries,count(*) FILTER(WHERE kind='reversal') AS reversed_entries,
  CAST(coalesce(sum(amount_minor),0) AS TEXT) AS total_net_contributions_rwf FROM ledger_entries) ledger_stats`)]);
 const source=result.results[0],amountKeys=Object.keys(adminBridgeMetrics).filter(k=>k.startsWith('total_')),
  countKeys=Object.keys(adminBridgeMetrics).filter(k=>!k.startsWith('total_'));
 const counts=Object.fromEntries(countKeys.map(k=>[k,exact(source[k])])),amounts=Object.fromEntries(amountKeys.map(k=>[k,amountString(source[k])]));
 return {...marker,country_code:'RW',measured_at:now(),counts,amounts,contribution_basis:contributionBasis,collected_basis:collectedBasis,reconciliations_available:true,
  metrics:Object.entries(adminBridgeMetrics).map(([key,label])=>({key,label,value:String(source[key]),status:'measured'}))};
}
