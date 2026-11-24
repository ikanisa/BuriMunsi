import {requireThat} from './errors.js';
import {pgInteger} from './postgres-values.js';
import {normalizePhone} from './values.js';

const from = `FROM burimunsi.payments p LEFT JOIN app.users member ON member.id=p.member_id
  WHERE p.collection_id=$1`;
const display = `SELECT p.*,member.full_name AS member_name,member.momo_number AS member_phone,
  coalesce(p.occurred_at,p.created_at) AS page_at ${from}`;
const newest = ' ORDER BY coalesce(p.occurred_at,p.created_at) DESC,p.id DESC';
const escaped = value => '%'+value.replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_')+'%';
const iso = value => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export async function setPaymentsScope(sql,groupId) {
  await sql.unsafe("SELECT set_config('burimunsi.collection_id',$1,true)",[groupId]);
}

export function paymentRecord(row,{showSms=false}={}) {
  return {
    id:row.id,groupId:row.collection_id,direction:row.direction,amountRwf:pgInteger(row.amount_rwf),
    atRaw:row.source_time||iso(row.page_at),ftId:row.provider_reference,state:row.allocation_state,
    version:pgInteger(row.version),payerNameRaw:row.counterparty_name??'',
    payerPhoneRaw:row.counterparty_identifier??'',memberId:row.member_id??null,memberName:row.member_name??null,
    memberPhone:row.member_phone?normalizePhone(row.member_phone):null,
    sourceId:showSms?row.sms_source_id??null:null,
    ...(showSms&&row.sms_source_id?{sourceKind:'observation'}:{}),
  };
}

export async function readPaymentsHome(sql,groupId,asOf,projection) {
  const [totals]=await sql.unsafe(`SELECT count(*) AS payments,
    count(*) FILTER (WHERE allocation_state='unallocated') AS unallocated,
    (SELECT count(*) FROM app.memberships WHERE collection_id=$1 AND active=1) AS members
    FROM burimunsi.payments WHERE collection_id=$1`,[groupId]);
  const rows=await sql.unsafe(display+newest+' LIMIT 3',[groupId]);
  return {paymentCount:pgInteger(totals.payments),memberCount:pgInteger(totals.members),
    unallocatedCount:pgInteger(totals.unallocated),recentPayments:rows.map(row=>paymentRecord(row,projection)),asOf};
}

export async function readPayment(sql,groupId,id,projection) {
  const [row]=await sql.unsafe(display+' AND p.id=$2',[groupId,id]);
  return row?paymentRecord(row,projection):null;
}

export async function readPayments(sql,groupId,{q='',status=null,direction=null,memberId=null,limit=25,offset=0,showSms=false}={}) {
  const args=[groupId],conditions=[];
  if(q){
    args.push(escaped(q));
    conditions.push(`concat_ws(' ',p.provider_reference,p.counterparty_name,p.counterparty_identifier,
      p.amount_rwf,p.source_time,member.full_name,member.momo_number) ILIKE $${args.length} ESCAPE '\\'`);
  }
  if(status&&status!=='all'){args.push(status);conditions.push('p.allocation_state=$'+args.length);}
  if(direction&&direction!=='all'){args.push(direction);conditions.push('p.direction=$'+args.length);}
  if(memberId){args.push(memberId);conditions.push('p.member_id=$'+args.length);}
  const suffix=conditions.length?' AND '+conditions.join(' AND '):'';
  const count='SELECT count(*) AS total '+from+suffix;
  const page=display+suffix+newest+' LIMIT $'+(args.length+1)+' OFFSET $'+(args.length+2);
  const rows=await sql.unsafe(`WITH totals AS (${count}), page AS (${page})
    SELECT page.*,totals.total FROM totals LEFT JOIN page ON true
    ORDER BY page.page_at DESC,page.id DESC`,[...args,limit,offset]);
  const totalCount=pgInteger(rows[0].total);
  const items=rows.filter(row=>row.id!=null).map(row=>paymentRecord(row,{showSms}));
  return {items,totalCount,offset,limit,nextOffset:offset+items.length<totalCount?offset+items.length:null};
}

// Bound the scan before applying text search. A broad collection over the
// reviewed limit returns no projection, never totals for a truncated sample.
export const PAYMENT_ANALYSIS_LIMIT=5000;
export async function readPaymentAnalysisRows(sql,groupId,{q,showSms}) {
  const rows=await sql.unsafe(`WITH candidate AS MATERIALIZED (
   SELECT p.id,p.collection_id,p.occurred_at,p.created_at,p.source_time,p.direction,p.amount_rwf::text AS amount_rwf,
    p.provider_reference,p.counterparty_name,p.counterparty_identifier,p.member_id,p.allocation_state,p.version,
    CASE WHEN $3::boolean THEN p.sms_source_id ELSE NULL END AS sms_source_id,
    coalesce(p.occurred_at,p.created_at) AS page_at
   FROM burimunsi.payments p WHERE p.collection_id=$1
   LIMIT ($4::int+1)
  ), checked AS (SELECT count(*)::int AS candidate_count FROM candidate)
  SELECT result.*,checked.candidate_count FROM checked
  LEFT JOIN LATERAL (
   SELECT p.*,member.full_name AS member_name,member.momo_number AS member_phone
   FROM candidate p LEFT JOIN app.users member ON member.id=p.member_id
   WHERE checked.candidate_count<=$4::int AND ($2::text='' OR
    concat_ws(' ',p.provider_reference,p.counterparty_name,p.counterparty_identifier,p.amount_rwf,
      p.source_time,member.full_name,member.momo_number) ILIKE $2 ESCAPE '\\')
  ) result ON true ORDER BY result.page_at DESC,result.id DESC`,[groupId,q?escaped(q):'',showSms,PAYMENT_ANALYSIS_LIMIT]);
  const count=pgInteger(rows[0]?.candidate_count);
  requireThat(count<=PAYMENT_ANALYSIS_LIMIT,'payment_analysis_scope_too_large',503);
  const amounts=new Map(),records=[];
  for(const row of rows){
    if(row.id==null)continue;
    // Payload keeps a numeric per-row amount only under the schema's safe
    // limit. Sum the original decimal supplied by PostgreSQL, not that value.
    const amount=row.amount_rwf;
    requireThat(typeof amount==='string'&&/^[1-9][0-9]*$/.test(amount),'payment_totals_unavailable',503);
    const record=paymentRecord(row,{showSms});
    requireThat(String(record.amountRwf)===amount&&!amounts.has(record.id),'payment_totals_unavailable',503);
    amounts.set(record.id,BigInt(amount));records.push(record);
  }
  return {rows:records,amounts};
}

export async function paymentListingRows(sql,groupId,memberId=null) {
  return sql.unsafe(display+(memberId?' AND p.member_id=$2':'')+' ORDER BY p.id LIMIT 100001',memberId?[groupId,memberId]:[groupId]);
}

export async function assignPayment(sql,{groupId,paymentId,memberId,expectedVersion}) {
  const [member]=await sql.unsafe(`SELECT m.user_id FROM app.memberships m JOIN app.users u ON u.id=m.user_id
    WHERE m.collection_id=$1 AND m.user_id=$2 AND m.active=1 AND u.access_status='active' AND u.member_type<>'operator'
    FOR SHARE OF m,u`,[groupId,memberId]);
  requireThat(member?.user_id===memberId,'member_unavailable',409);
  const [payment]=await sql.unsafe(`UPDATE burimunsi.payments SET member_id=$3,version=version+1,updated_at=clock_timestamp()
    WHERE collection_id=$1 AND id=$2 AND version=$4 AND member_id IS NULL
    RETURNING id,member_id,allocation_state,version`,[groupId,paymentId,memberId,expectedVersion]);
  requireThat(payment?.id===paymentId&&payment.member_id===memberId&&payment.allocation_state==='allocated','payment_changed',409);
  return {paymentId,memberId,state:payment.allocation_state,version:pgInteger(payment.version)};
}
