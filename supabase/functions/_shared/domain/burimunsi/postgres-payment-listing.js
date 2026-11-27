import {requireThat} from './errors.js';
import {pgInteger} from './postgres-values.js';
import {paymentRecord} from './postgres-payments.js';

const source='FROM burimunsi.payments p LEFT JOIN app.users member ON member.id=p.member_id WHERE p.collection_id=$1';

// Hash typed SQL values in a fixed order. No timestamp or entire collection
// crosses the driver boundary to authenticate a cursor. Member renames and
// exact event-time changes invalidate a previously signed page.
export async function paymentListingRevision(sql,groupId,memberId,showSms=false){
  const [row]=await sql.unsafe(`SELECT encode(sha256(coalesce(string_agg(sha256(convert_to(jsonb_build_array(
    p.id,p.direction,p.amount_rwf,p.provider_reference,p.source_time,extract(epoch FROM p.occurred_at),
    extract(epoch FROM p.created_at),p.member_id,p.version,p.counterparty_name,p.counterparty_identifier,
    member.full_name,member.momo_number,CASE WHEN $2::boolean THEN p.sms_source_id END,
    EXISTS(SELECT FROM burimunsi.payment_evidence_holds h WHERE h.payment_id=p.id AND h.collection_id=p.collection_id)
  )::text,'UTF8')),''::bytea ORDER BY p.id COLLATE "C"),''::bytea)),'hex') AS revision
    ${source}${memberId?' AND p.member_id=$3':''}`,memberId?[groupId,showSms,memberId]:[groupId,showSms]);
  requireThat(typeof row?.revision==='string'&&/^[a-f0-9]{64}$/.test(row.revision),'snapshot_unavailable',503);
  return row.revision;
}

export async function readCanonicalPaymentPage(sql,{groupId,memberId,listing,after},projection){
  const {q,filter,limit,sort,advanced,fromAt,untilAt,minRwf,maxRwf,direction}=listing;
  const args=[groupId],bind=value=>'$'+args.push(value),conditions=[];
  if(memberId)conditions.push('p.member_id='+bind(memberId));
  if(filter!=='all')conditions.push('p.allocation_state='+bind(filter));
  if(direction!=='all')conditions.push('p.direction='+bind(direction));
  if(fromAt)conditions.push('p.occurred_at>='+bind(fromAt)+'::timestamptz');
  if(untilAt)conditions.push('p.occurred_at<'+bind(untilAt)+'::timestamptz');
  if(minRwf!==null)conditions.push('p.amount_rwf>='+bind(minRwf)+'::bigint');
  if(maxRwf!==null)conditions.push('p.amount_rwf<='+bind(maxRwf)+'::bigint');
  if(q){
    const fields=advanced?`p.id,p.counterparty_name,p.counterparty_identifier,p.provider_reference,p.amount_rwf,
      coalesce(nullif(p.source_time,''),to_char(coalesce(p.occurred_at,p.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      member.full_name,private.burimunsi_member_phone(member.momo_number),'0'||substr(private.burimunsi_member_phone(member.momo_number),5)`:
      'p.provider_reference,p.counterparty_name,p.counterparty_identifier,p.amount_rwf,p.source_time,member.full_name,member.momo_number';
    conditions.push(`strpos(lower(concat_ws(' ',${fields}) COLLATE pg_catalog."en-US-x-icu"),lower(${bind(q)}::text COLLATE pg_catalog."en-US-x-icu"))>0`);
  }
  const offset=after?.offset??0;
  requireThat(!after||Object.keys(after).length===1&&Number.isSafeInteger(offset)&&offset>0,'invalid_cursor');
  const where=source+(conditions.length?' AND '+conditions.join(' AND '):'');
  const order=(!advanced?'page_at DESC NULLS LAST,id COLLATE "C" DESC':({
    newest:'occurred_at DESC NULLS LAST',oldest:'occurred_at ASC NULLS LAST',
    amount_asc:'amount_rwf ASC',amount_desc:'amount_rwf DESC',
  })[sort]+',id COLLATE "C" ASC');
  const rows=await sql.unsafe(`WITH totals AS (SELECT count(*) AS total ${where}),page AS (
    SELECT p.*,member.full_name AS member_name,member.momo_number AS member_phone,coalesce(p.occurred_at,p.created_at) AS page_at
    ${where} ORDER BY ${order.replace('id COLLATE','p.id COLLATE')} LIMIT ${bind(limit)} OFFSET ${bind(offset)}
  ) SELECT totals.total,page.* FROM totals LEFT JOIN page ON true ORDER BY ${order}`,args);
  const totalCount=pgInteger(rows[0]?.total,{minimum:0});
  requireThat(offset===0||offset<totalCount,'invalid_cursor');
  const items=rows.filter(row=>row.id!=null).map(row=>paymentRecord(row,projection));
  const next=offset+items.length;
  return {items,totalCount,after:next<totalCount?{offset:next}:null};
}
