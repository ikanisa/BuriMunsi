import {momoTransactionSql} from './admin_momo_reads.js';

const noSources=`SELECT NULL::text kind,NULL::text source_id,NULL::timestamptz occurred_at,NULL::text status,
 NULL::text account_id,NULL::text source_digest,NULL::text payment_reference,NULL::text payer_status,
 NULL::text payer_reason,NULL::jsonb reservation WHERE false`;
const noTransfers=`SELECT NULL::text id,NULL::text payment_id,NULL::text account_id,NULL::timestamptz occurred_at,
 NULL::text reference,NULL::text payer,NULL::bigint amount,NULL::text status,false AS attention WHERE false`;
const noPayments=`SELECT NULL::text id,NULL::text reference,NULL::text provider_reference,NULL::text payer,NULL::bigint amount,
 NULL::timestamptz occurred_at,NULL::text status,false AS attention WHERE false`;

function paymentRows(financial,reconciliationDetail) {
 const attention=`(p.status='ambiguous' OR (p.status='recorded' AND p.member_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM app.ledger_entries e WHERE e.payment_id=p.id AND e.collection_id=p.collection_id))
   ${reconciliationDetail?"OR EXISTS(SELECT 1 FROM app.reconciliations r WHERE r.payment_id=p.id AND r.evidence_id=p.evidence_id AND r.status='proposed')":''})`;
 return `SELECT p.id,nullif(to_jsonb(p)->>'payment_reference','') AS reference,
   -- Legacy SMS evidence keys contain a private digest and source ID. Only provider references enter the display/search projection.
   CASE WHEN e.external_reference !~* '^sms:' THEN nullif(e.external_reference,'') END AS provider_reference,
   nullif(p.payer_display_name,'') AS payer,
   CASE WHEN p.currency='RWF' THEN p.amount_minor END AS amount,p.created_at::timestamptz AS occurred_at,
   p.status,${attention} AS attention
 FROM app.payments p LEFT JOIN app.payment_evidence e ON e.id=p.evidence_id AND (e.collection_id=p.collection_id OR e.collection_id IS NULL)
 WHERE p.collection_id=f.group_id ${financial?'':'AND '+attention}`;
}

function transferRows(env) {
 return `SELECT m.id,p.id AS payment_id,m.receiving_account_id AS account_id,
   coalesce(m.transaction_at,m.created_at)::timestamptz AS occurred_at,nullif(m.provider_transaction_id,'') AS reference,
   nullif(m.payer_name,'') AS payer,CASE WHEN m.currency='RWF' AND m.currency_scale=0 THEN m.amount_minor END AS amount,
   m.status,(m.has_conflict=1 OR m.status IN ('needs_allocation','awaiting_review','needs_review')) AS attention
 FROM (${momoTransactionSql(env)}) m
 LEFT JOIN private.burimunsi_payment_activity_transactions(f.group_id) sc
   ON sc.transaction_id=m.id AND sc.account_id=m.receiving_account_id
 LEFT JOIN app.payments p ON p.id=m.payment_id AND p.collection_id=f.group_id
   AND p.member_id IS NOT DISTINCT FROM m.beneficiary_member_id
 WHERE (m.group_id=f.group_id OR sc.transaction_id IS NOT NULL)
   AND (m.native_group_id IS NULL OR m.native_group_id=f.group_id)
   AND (m.payment_id IS NULL OR p.id IS NOT NULL)`;
}

// The browser sees one record per payment, per unlinked transfer, or per
// unlinked receipt. Never group identities using submitted names, amounts,
// references, or dates. A source linked to more than one transfer remains
// standalone, including when the other target is outside the operator's group.
export function paymentActivitySql(env,access) {
 const {financial,sms,reconciliationDetail,reveal}=access;
 const sourceRows=sms?`SELECT * FROM private.burimunsi_payment_activity_sources(f.group_id,${financial},${env.BURIMUNSI_ADMIN_SMS_OBSERVATIONS_ENABLED==='true'})`:noSources;
 const matches=financial&&sms?`SELECT s.kind,s.source_id,CASE WHEN count(DISTINCT l.transaction_id)=1 AND
     bool_and(coalesce(t.id IS NOT NULL AND a.raw_sms_id=s.source_id AND a.source_body_sha256=s.source_digest
       AND a.outcome=l.relation AND l.relation IN ('accepted','duplicate'),false)) THEN min(t.id) END AS transaction_id,
    bool_or(t.id IS NOT NULL AND (l.relation='conflict' OR a.outcome='conflict')) AS conflict
   FROM sources s JOIN app.momo_transaction_sources l ON l.raw_sms_id=s.source_id
   LEFT JOIN app.momo_parse_attempts a ON a.id=l.parse_attempt_id
   LEFT JOIN transfers t ON t.id=l.transaction_id GROUP BY s.kind,s.source_id`:
   `SELECT NULL::text kind,NULL::text source_id,NULL::text transaction_id,false AS conflict WHERE false`;
 return `WITH filters AS MATERIALIZED(SELECT ?::text AS group_id,?::text AS scope,?::text AS wanted_status,?::text AS search,
    ?::text AS account_id,?::timestamptz AS start_at,?::timestamptz AS end_at,?::int AS page_limit,?::int AS page_offset),
  scoped_payments AS MATERIALIZED(SELECT selected.* FROM filters f CROSS JOIN LATERAL(
    ${financial||reconciliationDetail?paymentRows(financial,reconciliationDetail):noPayments}) selected),
  transfers AS MATERIALIZED(SELECT selected.* FROM filters f CROSS JOIN LATERAL(
    ${financial?transferRows(env):noTransfers}) selected),
  sources AS MATERIALIZED(SELECT selected.* FROM filters f CROSS JOIN LATERAL(${sourceRows}) selected),
  matches AS MATERIALIZED(${matches}),
  receipts AS MATERIALIZED(
    SELECT s.*,t.id AS transaction_id,t.payment_id,
     CASE WHEN t.payment_id IS NOT NULL THEN 'payment' WHEN t.id IS NOT NULL THEN 'momo' ELSE s.kind END AS parent_kind,
     coalesce(t.payment_id,t.id,s.source_id) AS parent_id,
     (coalesce(m.conflict,false) OR s.status IN ('under_review','blocked','held','retrying','unresolved','unmatched','needs_review')) AS attention,
     jsonb_build_object('kind',s.kind,'id',s.source_id,'status',s.status,'collectionId',f.group_id,
        'paymentReference',s.payment_reference,'payerStatus',s.payer_status,'payerReason',s.payer_reason,
        'reservation',${reveal?'s.reservation':'NULL'}) AS detail
    FROM sources s CROSS JOIN filters f LEFT JOIN matches m ON m.kind=s.kind AND m.source_id=s.source_id
    LEFT JOIN transfers t ON t.id=m.transaction_id),
  records AS (
   SELECT 'payment' AS kind,p.id,p.occurred_at,coalesce(p.reference,p.provider_reference) AS reference,
    p.provider_reference,p.payer,p.amount,p.status,p.attention,
    ${financial?'p.id':'NULL::text'} AS payment_id,CASE WHEN ${reconciliationDetail} AND p.attention THEN p.id END AS review_id
   FROM scoped_payments p
   UNION ALL
   SELECT 'momo',t.id,t.occurred_at,t.reference,NULL,t.payer,t.amount,t.status,t.attention,NULL,NULL
    FROM transfers t WHERE t.payment_id IS NULL
   UNION ALL
   SELECT s.kind,s.source_id,s.occurred_at,NULL,NULL,NULL,NULL,s.status,s.attention,NULL,NULL
    FROM receipts s WHERE s.transaction_id IS NULL),
  transfer_groups AS (
   SELECT CASE WHEN t.payment_id IS NULL THEN 'momo' ELSE 'payment' END AS kind,coalesce(t.payment_id,t.id) AS id,
    array_agg(t.id ORDER BY t.id) AS ids,array_agg(t.account_id) AS accounts,array_agg(t.status) AS states,
    array_agg(t.reference) AS refs,array_agg(t.payer) AS payers,bool_or(t.attention) AS attention
   FROM transfers t GROUP BY 1,2),
  receipt_groups AS (
   SELECT s.parent_kind AS kind,s.parent_id AS id,array_agg(DISTINCT s.kind) AS kinds,
     array_agg(s.status) AS states,array_agg(s.account_id) AS accounts,array_agg(s.payment_reference) AS refs,
     bool_or(s.attention) AS attention,jsonb_agg(s.detail ORDER BY s.occurred_at DESC,s.kind,s.source_id) AS details
   FROM receipts s GROUP BY s.parent_kind,s.parent_id),
  enriched AS (
   SELECT r.*,coalesce(t.ids,ARRAY[]::text[]) AS momo_ids,coalesce(s.kinds,ARRAY[]::text[]) AS source_kinds,
    coalesce(s.details,'[]'::jsonb) AS details,
    coalesce(t.accounts,ARRAY[]::text[])||coalesce(s.accounts,ARRAY[]::text[]) AS accounts,
    coalesce(t.states,ARRAY[]::text[])||coalesce(s.states,ARRAY[]::text[]) AS states,
    ARRAY[r.reference,r.provider_reference,r.payer]||coalesce(t.refs,ARRAY[]::text[])||
     coalesce(t.payers,ARRAY[]::text[])||coalesce(s.refs,ARRAY[]::text[]) AS search_values,
    (r.attention OR coalesce(t.attention,false) OR coalesce(s.attention,false)) AS needs_attention
   FROM records r LEFT JOIN transfer_groups t ON t.kind=r.kind AND t.id=r.id LEFT JOIN receipt_groups s ON s.kind=r.kind AND s.id=r.id),
  filtered AS MATERIALIZED (
   SELECT e.* FROM enriched e CROSS JOIN filters f WHERE (f.scope='all' OR f.scope='payments' AND e.kind='payment'
     OR f.scope='momo' AND cardinality(e.momo_ids)>0 OR f.scope='sms' AND cardinality(e.source_kinds)>0
     OR f.scope='android' AND 'receiver_sms'=ANY(e.source_kinds) OR f.scope='captures' AND 'capture'=ANY(e.source_kinds)
     OR f.scope='attention' AND e.needs_attention)
   AND (f.wanted_status IS NULL OR e.status=f.wanted_status OR f.wanted_status=ANY(e.states)
     OR f.wanted_status='needs_attention' AND e.needs_attention)
   AND (f.search IS NULL OR EXISTS(SELECT 1 FROM unnest(e.search_values) v(value) WHERE strpos(lower(v.value),lower(f.search))>0))
   AND (f.account_id IS NULL OR f.account_id=ANY(e.accounts))
   AND (f.start_at IS NULL OR e.occurred_at>=f.start_at) AND (f.end_at IS NULL OR e.occurred_at<f.end_at)),
  page AS (SELECT * FROM filtered ORDER BY occurred_at DESC,kind,id LIMIT (SELECT page_limit FROM filters) OFFSET (SELECT page_offset FROM filters))
 SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS as_of,
    (SELECT count(*) FROM filtered) AS total,coalesce(jsonb_agg(jsonb_build_object(
     'kind',kind,'id',id,'occurredAt',to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
     'reference',reference,'payer',payer,'amountRwf',amount,'status',status,'attention',needs_attention,
     'paymentId',payment_id,'reconciliationId',review_id,'momoIds',momo_ids,'receipts',details)
     ORDER BY occurred_at DESC,kind,id),'[]'::jsonb) AS items FROM page`;
}
