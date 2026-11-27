import {requireThat} from './errors.js';
import {pgInteger} from './postgres-values.js';
import {canonicalJson,sha256} from './values.js';
import {paymentRecord} from './postgres-payments.js';

// Every SQL identifier and ordering expression comes from this allowlist. The
// route checks column permissions before compiling the operator's criteria.
const columns={
  reference:'provider_reference',time:'occurred_at',amount:'amount_rwf',direction:'direction',
  allocation:'allocation_state',counterparty:'counterparty_name',member:'member_name',
  counterpartyId:'counterparty_identifier',memberPhone:'member_phone',sms:"CASE WHEN sms_source_id IS NULL THEN 'none' ELSE 'linked' END",
  memberName:"coalesce(nullif(btrim(member_name),''),counterparty_name)",
  memberNumber:"coalesce(nullif(btrim(member_phone),''),counterparty_identifier)",
};
const categories=new Set(['allocation','direction','sms']);
// PostgreSQL spells the ISO calendar year zero as 1 BC.
const sqlDate=value=>value.startsWith('0000-')?'0001'+value.slice(4)+' BC':value;
const escaped=value=>'%'+value.replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_')+'%';

export async function readPaymentAnalysis(sql,groupId,criteria,{showSms,canAllocate=false}={}) {
  const {q,offset,limit,filters,sort}=criteria;
  const values=[groupId,!!showSms],bind=value=>'$'+values.push(value);
  const conditions=[];
  const expression=key=>{
    requireThat(Object.hasOwn(columns,key)&&(key!=='sms'||showSms),'invalid_payment_analysis',400);
    return ['amount','time'].includes(key)?columns[key]:"nullif(btrim("+columns[key]+"),'')";
  };
  for(const filter of filters){
    const {key,text,min,max,choices,presence}=filter,field=expression(key);
    if(presence!=='any')conditions.push(field+(presence==='blank'?' IS NULL':' IS NOT NULL'));
    if(text.trim())conditions.push(`strpos(burimunsi.payment_search_text(${field}) COLLATE "C",burimunsi.payment_search_text(${bind(text.trim())}))>0`);
    if(choices.length){
      requireThat(categories.has(key),'invalid_payment_analysis',400);
      conditions.push(field+' IN ('+choices.map(choice=>bind(choice)+'::text').join(',')+')');
    }
    if(min)conditions.push(key==='time'?`${field}>=(${bind(sqlDate(min))}::date::timestamp AT TIME ZONE 'Africa/Kigali')`:`${field}>=${bind(min)}::numeric`);
    if(max)conditions.push(key==='time'?`${field}<((${bind(sqlDate(max))}::date+1)::timestamp AT TIME ZONE 'Africa/Kigali')`:`${field}<=${bind(max)}::numeric`);
  }
  const search=q?` AND concat_ws(' ',p.provider_reference,p.counterparty_name,p.counterparty_identifier,p.amount_rwf,
    p.source_time,member.full_name,member.momo_number) ILIKE ${bind(escaped(q))} ESCAPE '\\'`:'';
  const field=expression(sort.key),direction=sort.direction==='asc'?'ASC':'DESC';
  const sortExpression=field+(['time','amount'].includes(sort.key)?'':' COLLATE burimunsi.payment_analysis_order');
  const ordering='sort_value '+direction+' NULLS LAST,page_at DESC,id COLLATE "C" DESC';
  const rows=await sql.unsafe(`WITH searched AS MATERIALIZED (
    SELECT p.id,p.collection_id,p.direction,p.amount_rwf,p.provider_reference,p.occurred_at,p.source_time,p.allocation_state,
      p.version,p.counterparty_name,p.counterparty_identifier,p.member_id,member.full_name AS member_name,
      private.burimunsi_member_phone(member.momo_number) AS member_phone,
      CASE WHEN $2::boolean THEN p.sms_source_id ELSE NULL END AS sms_source_id,
      coalesce(p.occurred_at,p.created_at) AS page_at,
      EXISTS(SELECT FROM burimunsi.payment_evidence_holds h WHERE h.collection_id=p.collection_id AND h.payment_id=p.id) AS evidence_disputed
    FROM burimunsi.payments p LEFT JOIN app.users member ON member.id=p.member_id
    WHERE p.collection_id=$1${search}
  ), matched AS MATERIALIZED (
    SELECT searched.*,${sortExpression} AS sort_value FROM searched${conditions.length?' WHERE '+conditions.join(' AND '):''}
  ), totals AS (
    SELECT (SELECT count(*) FROM searched) AS total_count,count(*) AS matching_count,
      encode(sha256(coalesce(string_agg(sha256(convert_to(jsonb_build_array(
        id,direction,amount_rwf,provider_reference,source_time,extract(epoch FROM occurred_at),extract(epoch FROM page_at),
        allocation_state,version,counterparty_name,counterparty_identifier,member_id,member_name,member_phone,sms_source_id,evidence_disputed
      )::text,'UTF8')),''::bytea ORDER BY id COLLATE "C"),''::bytea)),'hex') AS content_revision,
      coalesce(sum(amount_rwf) FILTER (WHERE direction='incoming'),0)::text AS incoming,
      coalesce(sum(amount_rwf) FILTER (WHERE direction='outgoing'),0)::text AS outgoing FROM matched
  ), page AS (
    SELECT * FROM matched ORDER BY ${ordering} LIMIT ${bind(limit)} OFFSET ${bind(offset)}
  )
  SELECT page.*,totals.*
  FROM totals LEFT JOIN page ON true ORDER BY ${ordering}`,values);
  const summary=rows[0],totalCount=pgInteger(summary?.total_count,{minimum:0}),matchingCount=pgInteger(summary.matching_count,{minimum:0,maximum:totalCount});
  requireThat([summary.incoming,summary.outgoing].every(n=>typeof n==='string'&&/^(0|[1-9]\d{0,30})$/.test(n)),'payment_totals_unavailable',503);
  requireThat(typeof summary.content_revision==='string'&&/^[a-f0-9]{64}$/.test(summary.content_revision),'invalid_snapshot',503);
  const revision=await sha256(canonicalJson({groupId,q,filters,sort,showSms:!!showSms,canAllocate,totalCount,content:summary.content_revision}));
  requireThat(criteria.revision===undefined||criteria.revision===revision,'payment_analysis_changed',409);
  const items=rows.filter(row=>row.id!=null).map(row=>({...paymentRecord(row,{showSms,financialDate:true}),
    canAllocate:canAllocate&&!row.evidence_disputed}));
  requireThat(items.length===Math.min(limit,Math.max(0,matchingCount-offset)),'invalid_snapshot',503);
  return {items,revision,totalCount,matchingCount,directionTotalsRwf:{incoming:summary.incoming,outgoing:summary.outgoing},missing:0,offset,limit};
}
