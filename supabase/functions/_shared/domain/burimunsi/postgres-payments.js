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
const maxWireRwf = BigInt(Number.MAX_SAFE_INTEGER);

function wholeRwf(value) {
  if(value===null)return null;
  // Read PostgreSQL numeric text directly, including an optional zero scale.
  // Converting to Number first could turn a fractional or oversized amount into
  // an apparently valid whole-RWF value.
  const match=typeof value==='string'&&/^([0-9]{1,38})(?:\.0{1,38})?$/.exec(value);
  requireThat(match,'invalid_snapshot',503);
  const exact=BigInt(match[1]);
  return exact>maxWireRwf?null:Number(exact);
}

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

export async function readPaymentsHome(sql,groupId,asOf,projection,{includeSavings=false,adminTotals=false}={}) {
  const showSmsBalance = adminTotals && projection.canAnalyzeSms;
  const movementTotals = adminTotals ? `,
    coalesce(sum(amount_rwf) FILTER (WHERE direction='incoming'),0)::text AS incoming,
    coalesce(sum(amount_rwf) FILTER (WHERE direction='outgoing'),0)::text AS outgoing` :
    includeSavings ? ", (sum(amount_rwf) FILTER (WHERE direction='outgoing'))::text AS outgoing" : '';
  const counts=`SELECT count(*) AS payments,
    count(*) FILTER (WHERE allocation_state='unallocated') AS unallocated,
    (SELECT count(*) FROM app.memberships WHERE collection_id=$1 AND active=1) AS members${movementTotals}
    FROM burimunsi.payments WHERE collection_id=$1`;
  const query=includeSavings?`WITH counts AS (${counts})
    SELECT counts.*,s.lifetime_contributions_rwf::text AS lifetime_contributions,
      s.latest_wallet_balance_rwf::text AS latest_wallet_balance,s.reconciliation_status
    FROM counts CROSS JOIN private.burimunsi_home_savings($1) s`:showSmsBalance?`WITH counts AS (${counts})
    SELECT counts.*,private.burimunsi_admin_home_sms_balance($1)::text AS latest_sms_balance FROM counts`:counts;
  const rows=await sql.unsafe(`WITH home_totals AS (${query}), totals AS (
    SELECT home_totals.*,count(*) OVER () AS summary_rows FROM home_totals
  ), recent AS (${display}${newest} LIMIT 3)
  SELECT totals.*,recent.* FROM totals LEFT JOIN recent ON true ORDER BY recent.page_at DESC,recent.id DESC`,[groupId]);
  const [totals]=rows;
  requireThat(totals&&pgInteger(totals.summary_rows,{code:'invalid_snapshot'})===1,'invalid_snapshot',503);
  const home={paymentCount:pgInteger(totals.payments),memberCount:pgInteger(totals.members),
    unallocatedCount:pgInteger(totals.unallocated),recentPayments:rows.filter(row=>row.id!=null).map(row=>paymentRecord(row,projection)),asOf};
  if(adminTotals){
    for (const value of [totals.incoming,totals.outgoing]) {
      requireThat(typeof value==='string'&&/^(0|[1-9]\d{0,37})$/.test(value),'invalid_snapshot',503);
    }
    return {...home,paymentTotals:{incomingRwf:totals.incoming,outgoingRwf:totals.outgoing,
      ...(showSmsBalance && {latestSmsBalanceRwf:wholeRwf(totals.latest_sms_balance)})}};
  }
  if(!includeSavings)return home;
  return {...home,savings:{lifetimeContributionsRwf:wholeRwf(totals.lifetime_contributions),
    outgoingPaymentsRwf:wholeRwf(totals.outgoing),latestWalletBalanceRwf:wholeRwf(totals.latest_wallet_balance),
    reconciliationStatus:totals.reconciliation_status}};
}

// Keep the verified snapshot and earlier role/session locks when only an
// optional statement runs over budget. ROLLBACK TO also restores its timeout.
async function optionalPaymentRead(sql,milliseconds,read,mayOmit=()=>false) {
  await sql.unsafe(`SAVEPOINT burimunsi_optional_read; SET LOCAL statement_timeout='${milliseconds}ms'`);
  let value=null;
  try {
    value=await read();
  } catch(error) {
    const budgetExceeded=error?.code==='57014'&&error.message==='canceling statement due to statement timeout';
    if(!budgetExceeded&&!mayOmit(error))throw error;
  }
  await sql.unsafe('ROLLBACK TO SAVEPOINT burimunsi_optional_read; RELEASE SAVEPOINT burimunsi_optional_read');
  return value;
}

export async function readOptionalPaymentsHome(sql,groupId,asOf,projection) {
  const enhanced=await optionalPaymentRead(sql,450,()=>readPaymentsHome(sql,groupId,asOf,projection,{includeSavings:true}),
    error=>error?.code==='42883'||error?.code==='invalid_snapshot');
  return enhanced??readPaymentsHome(sql,groupId,asOf,projection);
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

export const MEMBER_STATEMENT_PAGE_SIZE = 25;
// Preserve the previous maximum of 100,000 offset plus a final 100-row read.
export const MEMBER_STATEMENT_MAX_ROWS = 100_100;

export async function readOptionalMemberPaymentBalance(sql,groupId,memberId,membershipId) {
  return optionalPaymentRead(sql,500,async()=>{
    const [row]=await sql.unsafe(`WITH membership AS MATERIALIZED (
      SELECT m.id FROM app.memberships m
      JOIN app.collections g ON g.id=m.collection_id AND g.status='active'
      JOIN app.users u ON u.id=m.user_id AND u.member_type IN ('app','direct')
      WHERE m.collection_id=$1 AND m.user_id=$2 AND m.id=$3
    ), movements AS MATERIALIZED (
      SELECT CASE WHEN p.direction='incoming' THEN p.amount_rwf ELSE -p.amount_rwf END AS net_rwf
      FROM burimunsi.payments p CROSS JOIN membership WHERE p.collection_id=$1 AND p.member_id=$2
      LIMIT ($4::int+1)
    ) SELECT membership.id AS membership_id,totals.* FROM membership CROSS JOIN LATERAL (
      SELECT count(*)::int AS total_count,coalesce(sum(net_rwf),0)::text AS closing_rwf FROM movements
    ) totals`,[groupId,memberId,membershipId,MEMBER_STATEMENT_MAX_ROWS]);
    requireThat(row?.membership_id===membershipId,'member_statement_unavailable',404);
    if(pgInteger(row.total_count,{minimum:0})>MEMBER_STATEMENT_MAX_ROWS)return null;
    requireThat(typeof row.closing_rwf==='string'&&/^(0|-?[1-9]\d{0,30})$/.test(row.closing_rwf),'invalid_snapshot',503);
    return {groupId,memberId,membershipId,closingRwf:row.closing_rwf};
  });
}

export async function readMemberPaymentStatement(sql, groupId, memberId, {offset, revision}) {
  const limit = MEMBER_STATEMENT_PAGE_SIZE;
  // The revision covers ordered transaction content, including any change
  // that leaves the row count unchanged. Every page's balance and closing
  // total use that same complete, bounded snapshot.
  const rows = await sql.unsafe(`WITH membership AS MATERIALIZED (
    SELECT m.id FROM app.memberships m
    JOIN app.collections g ON g.id=m.collection_id AND g.status='active'
    JOIN app.users u ON u.id=m.user_id AND u.member_type IN ('app','direct')
    WHERE m.collection_id=$1 AND m.user_id=$2
  ), movements AS MATERIALIZED (
    SELECT p.id,p.direction,p.amount_rwf,p.provider_reference,p.source_time,
      coalesce(p.occurred_at,p.created_at) AS page_at,
      CASE WHEN p.direction='incoming' THEN p.amount_rwf ELSE -p.amount_rwf END AS net_rwf
    FROM burimunsi.payments p CROSS JOIN membership
    WHERE p.collection_id=$1 AND p.member_id=$2
    LIMIT ($5::int+1)
  ), totals AS (
    SELECT count(*)::int AS total_count,coalesce(sum(net_rwf),0)::text AS closing_rwf,
      encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(jsonb_build_array(
        id,direction,amount_rwf,provider_reference,source_time,extract(epoch FROM page_at)
      )::text,'UTF8')),'hex'),'' ORDER BY page_at,id),''),'UTF8')),'hex') AS movements_sha256
    FROM movements
  ), statement AS (
    SELECT membership.id AS membership_id,total_count,closing_rwf,
      encode(sha256(convert_to(jsonb_build_array($1::text,$2::text,membership.id,movements_sha256)::text,'UTF8')),'hex') AS revision
    FROM membership CROSS JOIN totals
  )
  SELECT statement.*,page.* FROM statement LEFT JOIN LATERAL (
    SELECT id,direction,amount_rwf,provider_reference,source_time,page_at,
      sum(net_rwf) OVER (ORDER BY page_at,id ROWS UNBOUNDED PRECEDING)::text AS balance_rwf
    FROM movements
    WHERE statement.total_count<=$5 AND ($6::text IS NULL OR statement.revision=$6)
    ORDER BY page_at,id LIMIT $4 OFFSET $3
  ) page ON true ORDER BY page.page_at,page.id`, [groupId, memberId, offset, limit, MEMBER_STATEMENT_MAX_ROWS, revision ?? null]);
  requireThat(rows.length, 'member_statement_unavailable', 404);
  const summary = rows[0];
  const totalCount = pgInteger(summary.total_count, {minimum: 0});
  requireThat(totalCount <= MEMBER_STATEMENT_MAX_ROWS, 'member_statement_scope_too_large', 503);
  requireThat(!revision || summary.revision === revision, 'member_statement_changed', 409);
  requireThat(offset === 0 || offset < totalCount, 'invalid_query');
  const items = rows.filter(row => row.id != null).map(row => ({
    id: row.id, direction: row.direction, amountRwf: pgInteger(row.amount_rwf, {minimum: 1}),
    atRaw: row.source_time || iso(row.page_at), ftId: row.provider_reference, balanceRwf: row.balance_rwf,
  }));
  return {groupId, memberId, membershipId: summary.membership_id, totalCount, offset, limit,
    revision: summary.revision, closingRwf: summary.closing_rwf, items};
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
