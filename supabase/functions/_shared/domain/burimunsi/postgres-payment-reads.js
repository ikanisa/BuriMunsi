import {pgInteger} from './postgres-values.js';
import {projectPayment} from './postgres-record-projections.js';

export const paymentReferenceSql="to_jsonb(p)->>'payment_reference'";
const creditLine = `l.kind='contribution' AND l.amount_minor=t.amount_minor
  AND p.amount_minor=t.amount_minor AND l.evidence_id=p.evidence_id AND l.member_id=p.member_id
  AND p.member_id=f.beneficiary_member_id AND u.id=p.member_id`;
// Match the transaction scope and bound of the existing listing before asking
// for all native display projections in the same read-only snapshot.
export const nativePaymentListingScope = `WITH payment_scope AS MATERIALIZED (
 SELECT x.* FROM private.burimunsi_transaction_scopes x
 JOIN app.momo_transactions t ON t.id=x.transaction_id AND t.receiving_account_id=x.receiving_account_id
 WHERE x.collection_id=$1 ORDER BY t.id LIMIT 100001
), native_projection AS MATERIALIZED (
 SELECT p.source_id, p.value FROM private.burimunsi_auto_projection_batch($1, ARRAY(
  SELECT DISTINCT x.native_source_id FROM payment_scope x WHERE x.native_source_id IS NOT NULL
 )) p
), payment_sources AS (
 SELECT s.transaction_id,count(*) FILTER (WHERE s.relation='conflict') AS conflict_count,
   min(s.raw_sms_id) FILTER (WHERE s.relation='accepted') AS first_source
 FROM app.momo_transaction_sources s JOIN payment_scope x ON x.transaction_id=s.transaction_id
 WHERE s.relation IN ('accepted','conflict') GROUP BY s.transaction_id
), payment_credit AS (
 SELECT t.id AS transaction_id,count(*) AS ledger_count,
   count(*)=1 AND coalesce(bool_and(${creditLine}),false) AS posted
 FROM payment_scope x
 JOIN app.momo_transactions t ON t.id=x.transaction_id AND t.receiving_account_id=x.receiving_account_id
 JOIN app.momo_financial_links f ON f.transaction_id=t.id
 JOIN app.payments p ON p.id=f.payment_id AND p.collection_id=x.collection_id
 JOIN app.ledger_entries l ON l.payment_id=p.id AND l.collection_id=x.collection_id
 LEFT JOIN app.memberships pm ON pm.collection_id=x.collection_id AND pm.user_id=coalesce(p.member_id,f.beneficiary_member_id)
 LEFT JOIN app.users u ON u.id=pm.user_id
 GROUP BY t.id
) `;

export const paymentsSql=(auto,{includeReference=false,batch=false,includePageOrder=false}={})=>`SELECT t.id,x.collection_id,
 ${includeReference?paymentReferenceSql+' AS display_reference,':''}${includePageOrder?'t.transaction_at AS page_order,':''}
 ${auto?"coalesce(native.value->'facts'->>'counterparty_name',t.payer_name)":"t.payer_name"} AS payer_name,
 ${auto?"coalesce(native.value->'facts'->>'counterparty_identifier',t.payer_identifier)":"t.payer_identifier"} AS payer_identifier,
 ${auto?"coalesce((native.value->'facts'->>'amount_minor')::bigint,t.amount_minor)":"t.amount_minor"} AS amount_minor,
 ${auto?"coalesce(native.value->'facts'->>'transaction_at',t.transaction_at)":"t.transaction_at"} AS transaction_at,
 ${auto?"coalesce(native.value->'facts'->>'transaction_timezone',t.transaction_timezone)":"t.transaction_timezone"} AS transaction_timezone,
 ${auto?"coalesce(native.value->'facts'->>'transaction_datetime_raw',t.transaction_datetime_raw)":"t.transaction_datetime_raw"} AS transaction_datetime_raw,
 ${auto?"coalesce(native.value->'facts'->>'provider_transaction_id',t.provider_transaction_id)":"t.provider_transaction_id"} AS provider_transaction_id,
 t.allocation_state,t.has_conflict,t.version,t.created_at,t.event_kind AS canonical_event_kind,u.id AS member_id,u.full_name AS member_full_name,u.momo_number,p.status AS payment_status,coalesce(credit.posted,false) AS ledger_posted,
 ${batch?`coalesce(src.conflict_count,0)>0`:`EXISTS(SELECT 1 FROM app.momo_transaction_sources bad WHERE bad.transaction_id=t.id AND bad.relation='conflict')`} AS source_conflict,
 ${batch?'src.first_source':`(SELECT min(src.raw_sms_id) FROM app.momo_transaction_sources src WHERE src.transaction_id=t.id AND src.relation='accepted')`} AS source_id${auto?",x.native_source_id,coalesce(native.value->'facts'->>'event_kind',t.event_kind) AS event_kind,coalesce((native.value->'facts'->>'fee_minor')::bigint,t.fee_minor) AS fee_minor,coalesce((native.value->'facts'->>'wallet_balance_after_minor')::bigint,t.wallet_balance_after_minor) AS wallet_balance_after_minor,native.value AS native_meta":''}
 FROM ${batch?'payment_scope':'private.burimunsi_transaction_scopes'} x
 JOIN app.momo_transactions t ON t.id=x.transaction_id AND t.receiving_account_id=x.receiving_account_id
 LEFT JOIN app.momo_financial_links f ON f.transaction_id=t.id
 LEFT JOIN app.payments p ON p.id=f.payment_id AND p.collection_id=x.collection_id
 LEFT JOIN app.memberships pm ON pm.collection_id=x.collection_id AND pm.user_id=coalesce(p.member_id,CASE WHEN p.id IS NOT NULL THEN f.beneficiary_member_id END)
 LEFT JOIN app.users u ON u.id=pm.user_id
 ${batch?`LEFT JOIN payment_sources src ON src.transaction_id=t.id LEFT JOIN payment_credit credit ON credit.transaction_id=t.id`:
  `LEFT JOIN LATERAL (SELECT count(*)=1 AND coalesce(bool_and(${creditLine}),false) AS posted
  FROM app.ledger_entries l WHERE l.payment_id=p.id AND l.collection_id=x.collection_id) credit ON true`}
 LEFT JOIN LATERAL (SELECT regexp_replace(coalesce(u.momo_number,''),'[ ()-]','','g') AS compact) phone_raw ON true
 LEFT JOIN LATERAL (SELECT CASE WHEN phone_raw.compact LIKE '00%' THEN '+'||substr(phone_raw.compact,3) ELSE phone_raw.compact END AS value) phone_input ON true
 LEFT JOIN LATERAL (SELECT CASE WHEN phone_input.value ~ '^0[0-9]{9}$' THEN '+250'||substr(phone_input.value,2)
   WHEN phone_input.value ~ '^[0-9]{9}$' THEN '+250'||phone_input.value
   WHEN phone_input.value ~ '^250[0-9]{9}$' THEN '+'||phone_input.value ELSE phone_input.value END AS normalized) member_phone ON true
 ${batch?'LEFT JOIN native_projection native ON native.source_id=x.native_source_id':auto?'LEFT JOIN LATERAL (SELECT private.burimunsi_auto_projection(x.native_source_id) AS value WHERE x.native_source_id IS NOT NULL) native ON true':''}
 WHERE x.collection_id=$1`;
// Only an actual positive net ledger contribution in the same collection is a
// credit. A receipt, a payment status alone, or another group's ledger is not.
const creditedSql=auto=>`SELECT x.transaction_id,sum(l.amount_minor) AS credited_amount${auto?',x.native_source_id':''}
 FROM private.burimunsi_transaction_scopes x
 JOIN app.momo_transactions t ON t.id=x.transaction_id AND t.receiving_account_id=x.receiving_account_id
 JOIN app.momo_financial_links f ON f.transaction_id=t.id
 JOIN app.payments p ON p.id=f.payment_id AND p.collection_id=x.collection_id
 JOIN app.ledger_entries l ON l.payment_id=p.id AND l.collection_id=x.collection_id
 WHERE x.collection_id=$1 AND t.event_kind='incoming_receipt' AND t.has_conflict=0
  AND p.status IN ('reconciled','confirmed')
 GROUP BY x.transaction_id${auto?',x.native_source_id':''} HAVING count(*)=1 AND coalesce(bool_and(l.kind='contribution' AND l.amount_minor=t.amount_minor
  AND p.amount_minor=t.amount_minor AND l.evidence_id=p.evidence_id AND l.member_id=p.member_id AND p.member_id=f.beneficiary_member_id
  AND EXISTS(SELECT 1 FROM app.memberships m WHERE m.collection_id=x.collection_id AND m.user_id=p.member_id)),false)`;
const NO_CONFLICT=`t.has_conflict=0 AND NOT EXISTS(SELECT 1 FROM app.momo_transaction_sources bad WHERE bad.transaction_id=t.id AND bad.relation='conflict')`;
const IS_POSTED=`coalesce(p.status IN ('reconciled','confirmed'),false) AND credit.posted`;
const UNPOSTED_READABLE=`${NO_CONFLICT} AND p.status IS DISTINCT FROM 'reversed' AND p.status IS DISTINCT FROM 'corrected' AND NOT (${IS_POSTED})`;
const UNALLOCATED_INCOMING=`t.event_kind='incoming_receipt' AND t.allocation_state='unallocated' AND ${UNPOSTED_READABLE}`;
const managedOnly=auto=>auto?' AND x.native_source_id IS NULL':'';

export function paymentAllocationFilterSql(auto,filter) {
  switch(filter){
    case 'unallocated': return managedOnly(auto)+' AND '+UNALLOCATED_INCOMING;
    case 'allocated': return ` AND ${NO_CONFLICT} AND p.status IN ('reconciled','confirmed') AND credit.posted`;
    case 'processing': return managedOnly(auto)+` AND t.allocation_state<>'unallocated' AND ${UNPOSTED_READABLE}`;
    default: return '';
  }
}

// Common canonical names need no catalog scan. Historical zones keep exact
// database timezone-name validation before conversion.
function validHomeZone(column) {
  return `CASE WHEN ${column} COLLATE "C" IN ('Africa/Kigali','UTC','Etc/UTC') THEN true
    ELSE EXISTS (SELECT 1 FROM zones z WHERE z.name=${column}) END`;
}

export async function readCanonicalHome(sql,g,at,auto) {
  // Share the credited set and timezone names across the two receipt reads.
  // A missing or malformed source timestamp must never become today's receipt.
  const nativeTimes = auto ? `native_times AS MATERIALIZED (
    SELECT * FROM private.burimunsi_home_payment_times($1, ARRAY(
      SELECT DISTINCT c.native_source_id FROM credited c WHERE c.native_source_id IS NOT NULL
    ))
  ),` : '';
  const recentAt = auto ? 'coalesce(n.transaction_at,t.transaction_at)' : 't.transaction_at';
  const recentZone = auto ? 'coalesce(n.transaction_timezone,t.transaction_timezone)' : 't.transaction_timezone';
  const rows=await sql.unsafe(`WITH credited AS MATERIALIZED (${creditedSql(auto)}),
    zones AS MATERIALIZED (SELECT name FROM pg_timezone_names),
    totals AS (SELECT coalesce(sum(amount_minor),0) AS balance FROM app.ledger_entries WHERE collection_id=$1),
    today AS (SELECT coalesce(sum(c.credited_amount),0) AS today FROM credited c
            JOIN app.momo_transactions t ON t.id=c.transaction_id
            WHERE CASE WHEN t.transaction_at ~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
             AND pg_input_is_valid(t.transaction_at,'timestamp with time zone')
             AND ${validHomeZone('t.transaction_timezone')}
            THEN t.transaction_at::timestamptz >= (date_trunc('day',$2::timestamptz AT TIME ZONE t.transaction_timezone) AT TIME ZONE t.transaction_timezone)
             AND t.transaction_at::timestamptz < ((date_trunc('day',$2::timestamptz AT TIME ZONE t.transaction_timezone)+interval '1 day') AT TIME ZONE t.transaction_timezone)
             AND t.transaction_at::timestamptz <= $2::timestamptz ELSE false END),
    counts AS (SELECT
    (SELECT count(*) FROM app.memberships WHERE collection_id=$1 AND active=1) AS members,
    count(*) AS unallocated,coalesce(sum(t.amount_minor),0) AS unallocated_amount
    FROM private.burimunsi_transaction_scopes x JOIN app.momo_transactions t ON t.id=x.transaction_id
    LEFT JOIN app.momo_financial_links f ON f.transaction_id=t.id
    LEFT JOIN app.payments p ON p.id=f.payment_id AND p.collection_id=x.collection_id
    LEFT JOIN LATERAL (SELECT count(*)=1 AND coalesce(bool_and(l.kind='contribution' AND l.amount_minor=t.amount_minor AND p.amount_minor=t.amount_minor
     AND l.evidence_id=p.evidence_id AND l.member_id=p.member_id AND p.member_id=f.beneficiary_member_id
     AND EXISTS(SELECT 1 FROM app.memberships m WHERE m.collection_id=x.collection_id AND m.user_id=p.member_id)),false) AS posted
     FROM app.ledger_entries l WHERE l.payment_id=p.id AND l.collection_id=x.collection_id) credit ON true
    WHERE x.collection_id=$1${managedOnly(auto)} AND ${UNALLOCATED_INCOMING}),
    ${nativeTimes}
    recent_times AS (
      SELECT c.transaction_id,c.credited_amount,
        CASE WHEN ${recentAt} ~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
          AND pg_input_is_valid(${recentAt},'timestamp with time zone')
          AND ${validHomeZone(recentZone)}
        THEN ${recentAt}::timestamptz END AS ordered_at
      FROM credited c JOIN app.momo_transactions t ON t.id=c.transaction_id
      ${auto?'LEFT JOIN native_times n ON n.source_id=c.native_source_id':''}
    ),
    recent_ids AS MATERIALIZED (
      SELECT transaction_id,credited_amount,ordered_at FROM recent_times
      WHERE ordered_at <= $2::timestamptz ORDER BY ordered_at DESC,transaction_id DESC LIMIT 3
    ),
    recent AS (
      SELECT q.*,c.credited_amount,c.ordered_at FROM recent_ids c
      JOIN LATERAL (${paymentsSql(auto)} AND t.id=c.transaction_id OFFSET 0) q ON true
    )
    SELECT totals.balance,today.today,counts.*,recent.* FROM totals CROSS JOIN today CROSS JOIN counts
    LEFT JOIN recent ON true ORDER BY recent.ordered_at DESC,recent.id DESC`,[g,at]);
  const [summary]=rows;
  return {
    groupBalanceRwf:pgInteger(summary.balance),
    todayRwf:pgInteger(summary.today),
    memberCount:pgInteger(summary.members),
    unallocatedCount:pgInteger(summary.unallocated),
    unallocatedAmountRwf:pgInteger(summary.unallocated_amount),
    recentPayments:rows.filter(row=>row.id!=null).map(row=>projectPayment({...row,amount_minor:row.credited_amount})),
    asOf:at,
  };
}
