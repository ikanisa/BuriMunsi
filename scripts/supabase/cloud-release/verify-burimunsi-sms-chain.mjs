// Inspect the real payment chain without sending SMS or returning inbox contents.
import {management, PROJECT, record} from './access.mjs';

const query = `
WITH scope AS (
  SELECT min(collection_id) AS id FROM private.burimunsi_scopes HAVING count(*) = 1
), receipts AS (
  SELECT p.id, p.collection_id, p.member_id, p.currency, p.amount_minor, p.evidence_id
  FROM app.payments p JOIN scope s ON s.id = p.collection_id
  WHERE p.rail = 'rwanda_momo' AND p.status IN ('confirmed','reconciled')
), credits AS (
  SELECT p.id, count(l.id) AS entries, count(l.id) FILTER (
    WHERE l.collection_id = p.collection_id AND l.member_id = p.member_id
      AND l.amount_minor = p.amount_minor AND l.currency = p.currency AND p.currency = 'RWF'
      AND l.evidence_id = p.evidence_id AND EXISTS (
        SELECT 1 FROM app.contribution_posting_snapshots s
        WHERE s.payment_id = p.id AND s.ledger_entry_id = l.id AND s.posted_at = l.posted_at
      )
  ) AS matching_entries
  FROM receipts p LEFT JOIN app.ledger_entries l ON l.payment_id = p.id AND l.kind = 'contribution'
  GROUP BY p.id
), obligations AS (
  SELECT o.* FROM private.burimunsi_payment_sms_obligations o JOIN scope s ON s.id = o.collection_id
), deliveries AS (
  SELECT d.* FROM private.burimunsi_payment_sms_deliveries d JOIN scope s ON s.id = d.collection_id
), sent AS (
  SELECT d.payment_id, m.message_id, m.state AS gateway_state, d.provider_state
  FROM deliveries d JOIN obligations o USING (payment_id, ledger_entry_id, collection_id)
  JOIN collect_sms.messages m ON m.application_id = d.application_id AND m.message_id = d.message_id
    AND m.idempotency_key = d.idempotency_key AND m.kind = 'receipt'
    AND m.idempotency_key = 'buri-receipt:' || o.ledger_entry_id
    AND encode(sha256(convert_to(m.to_number,'UTF8')),'hex') = d.destination_sha256
    AND encode(sha256(convert_to(m.text,'UTF8')),'hex') = d.body_sha256
), provider_payments AS (
  SELECT t.receiving_account_id, t.provider_transaction_id, count(DISTINCT p.id) AS payments
  FROM receipts p JOIN app.momo_financial_links f ON f.payment_id = p.id
  JOIN app.momo_transactions t ON t.id = f.transaction_id
  WHERE t.event_kind = 'incoming_receipt' AND t.provider_transaction_id IS NOT NULL
  GROUP BY t.receiving_account_id, t.provider_transaction_id
), latest_check AS MATERIALIZED (
  SELECT x.* FROM private.burimunsi_inbox_checks x JOIN scope s ON s.id = x.collection_id
  ORDER BY x.checked_at DESC, x.installation_id LIMIT 1
), receipt_senders AS (
  SELECT count(*)::int AS ready_senders, max(last_seen_at) AS last_sender_heartbeat
  FROM collect_sms.devices
  WHERE ready = 1 AND revoked_at IS NULL AND allowed_kinds::jsonb ? 'receipt'
)
SELECT f.project_ref AS project, statement_timestamp() AS observed_at, f.epoch,
  to_regclass('burimunsi.payments') IS NOT NULL AS canonical_installed,
  to_regclass('private.burimunsi_allocation_receipts') IS NOT NULL AS allocation_sms_installed,
  to_regclass('private.burimunsi_verified_inbox_recoveries') IS NOT NULL AS verified_inbox_installed,
  f.mode AS release_state, c.enabled AND j.active AS scheduler_active, j.schedule,
  (SELECT max(d.observed_at) FROM collect_ops.jobs_dispatches d
   JOIN private.collect_managed_job_tickets t ON t.dispatch_id = d.id
   WHERE d.kind = 'scheduled' AND d.state = 'confirmed' AND t.completed_at IS NOT NULL
     AND d.http_status = 200 AND d.response_sha256 = t.response_sha256
     AND t.source_sha256 = f.source_sha256 AND d.created_at >= f.changed_at) AS last_signed_run,
  (SELECT count(*)::int FROM credits) AS posted_payments,
  (SELECT count(*)::int FROM credits WHERE entries = 1 AND matching_entries = 1) AS single_matching_credits,
  (SELECT count(*)::int FROM provider_payments WHERE payments > 1) AS provider_transfers_with_multiple_payments,
  (SELECT coalesce(jsonb_object_agg(disposition, total), '{}'::jsonb) FROM
    (SELECT disposition, count(*) AS total FROM obligations GROUP BY disposition) counts) AS payer_obligations,
  (SELECT count(*)::int FROM deliveries) AS payer_delivery_records,
  (SELECT count(*)::int FROM collect_sms.messages m JOIN obligations o
    ON m.idempotency_key = 'buri-receipt:' || o.ledger_entry_id WHERE m.kind = 'receipt') AS gateway_ledger_receipts,
  (SELECT count(*)::int FROM sent WHERE provider_state = 'delivered' AND gateway_state = 'delivered'
    AND EXISTS (SELECT 1 FROM collect_sms.attempt_evidence a WHERE a.message_id = sent.message_id
      AND a.parts_total > 0 AND a.delivered_count = a.parts_total)) AS payer_confirmed_all_parts,
  (SELECT count(*)::int FROM private.burimunsi_inbox_checks x WHERE x.collection_id = s.id) AS recorded_handset_checks,
  (SELECT jsonb_build_object('state', x.state, 'checkedAt', to_timestamp(x.checked_at / 1000.0), 'pageItems', x.page_items,
    'pageSourcesMatched', (SELECT count(i.source_id)::int FROM private.burimunsi_inbox_check_items i
      WHERE (i.collection_id, i.installation_id) = (x.collection_id, x.installation_id)),
    'pageHistoricalHolds', (SELECT count(*)::int FROM private.burimunsi_inbox_check_items i
      JOIN private.burimunsi_held_observation_sources h ON h.source_id = i.source_id
      WHERE (i.collection_id, i.installation_id) = (x.collection_id, x.installation_id)),
    'candidateCount', CASE WHEN x.state <> 'checking' THEN x.report->'candidateCount' END,
    'missingCount', CASE WHEN x.state <> 'checking' THEN x.report->'missingCount' END,
    'pendingCount', CASE WHEN x.state <> 'checking' THEN x.report->'pendingCount' END,
    'headsMatch', CASE WHEN x.state = 'verified' AND (x.report->>'candidateCount')::int = 0 THEN true
      WHEN x.state <> 'checking' AND x.report->>'phoneLatestKey' IS NOT NULL THEN
        (x.report->>'phoneLatestKey') IS NOT DISTINCT FROM (x.report->>'parsedLatestKey') END)
   FROM latest_check x) AS latest_recorded_handset_check,
  senders.ready_senders, senders.last_sender_heartbeat
FROM private.collect_fence_control f JOIN collect_ops.jobs_config c USING (singleton)
JOIN cron.job j ON j.jobid = c.cron_job_id CROSS JOIN scope s
CROSS JOIN receipt_senders senders WHERE f.singleton`;

async function inspect(statement) {
  const response = await management('database/query', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({query:"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='5s'; "+statement+'; ROLLBACK;',read_only:false}),
  });
  const result=response.json();
  if(result.length!==1 || result[0].project!==PROJECT) throw Error('expected_one_burimunsi_project');
  return result[0];
}
const summary=await inspect(query);
if(summary.canonical_installed) {
  const delivery=summary.allocation_sms_installed ? `,
    'allocationNotices',(SELECT coalesce(jsonb_object_agg(status,n),'{}'::jsonb) FROM
      (SELECT status,count(*)::int n FROM private.burimunsi_allocation_receipts WHERE collection_id=s.id GROUP BY status) states),
    'noticesWithoutIncomingAllocation',(SELECT count(*)::int FROM private.burimunsi_allocation_receipts r
      LEFT JOIN burimunsi.payments p ON p.id=r.payment_id AND p.collection_id=r.collection_id
        AND p.direction='incoming' AND p.member_id IS NOT NULL
      WHERE r.collection_id=s.id AND p.id IS NULL),
    'paymentsWithMultipleGatewayMessages',(SELECT count(*)::int FROM (
      SELECT r.payment_id FROM private.burimunsi_allocation_receipts r JOIN collect_sms.messages m
        ON m.application_id=r.application_id AND m.idempotency_key='allocation:'||r.attempt_id::text
      WHERE r.collection_id=s.id GROUP BY r.payment_id HAVING count(*)>1) repeated),
    'carrierConfirmedPayments',(SELECT count(*)::int FROM private.burimunsi_allocation_receipts r
      JOIN burimunsi.payments p ON p.id=r.payment_id AND p.collection_id=r.collection_id AND p.direction='incoming' AND p.member_id IS NOT NULL
      JOIN collect_sms.messages m ON m.message_id=r.application_id||':allocation:'||r.attempt_id::text
        AND m.application_id=r.application_id AND m.idempotency_key='allocation:'||r.attempt_id::text AND m.kind='receipt'
      WHERE r.collection_id=s.id AND r.status='delivered' AND r.provider_state='delivered' AND m.state='delivered'
        AND encode(sha256(convert_to(m.to_number,'UTF8')),'hex')=r.destination_sha256
        AND encode(sha256(convert_to(m.text,'UTF8')),'hex')=r.body_sha256
        AND EXISTS(SELECT FROM collect_sms.attempt_evidence a WHERE a.message_id=m.message_id
          AND a.parts_total>0 AND a.delivered_count=a.parts_total))` : '';
  const canonical = await inspect(`WITH scope AS
    (SELECT min(collection_id) AS id FROM private.burimunsi_scopes HAVING count(*)=1)
    SELECT f.project_ref AS project,f.epoch,jsonb_build_object(
      'payments',(SELECT count(*)::int FROM burimunsi.payments WHERE collection_id=s.id),
      'byDirectionAndAllocation',(SELECT coalesce(jsonb_object_agg(direction||'_'||allocation_state,n),'{}'::jsonb)
        FROM (SELECT direction,allocation_state,count(*)::int n FROM burimunsi.payments WHERE collection_id=s.id GROUP BY 1,2) totals),
      'repeatedTransferReferences',(SELECT count(*)::int FROM
        (SELECT 1 FROM burimunsi.payments WHERE collection_id=s.id AND provider_reference IS NOT NULL
          GROUP BY collection_id,receiving_account_id,provider,provider_reference HAVING count(*)>1) repeated),
      'storedRawEnvelopes',(SELECT count(*)::int FROM burimunsi.raw_sms WHERE collection_id=s.id),
      'durableHistoricalHolds',(SELECT count(*)::int FROM private.burimunsi_held_observation_sources h
        JOIN private.burimunsi_unresolved_observations o USING(source_id) WHERE o.collection_id=s.id)
      ${delivery}) AS payments FROM private.collect_fence_control f CROSS JOIN scope s WHERE f.singleton`);
  if(canonical.epoch!==summary.epoch)throw Error('release_changed_during_readback');
  summary.canonical=canonical.payments;
}
if (summary.verified_inbox_installed) {
  const check = await inspect(`WITH latest AS MATERIALIZED (
    SELECT c.* FROM private.burimunsi_inbox_checks c JOIN private.burimunsi_scopes s USING (collection_id)
    ORDER BY c.checked_at DESC, c.installation_id LIMIT 1
  ), page AS MATERIALIZED (
    SELECT i.source_id, h.source_id AS held, w.source_id AS witnessed, w.prior_source_id,
      w.prior_payment_id, j.state AS job_state, j.phase AS job_phase, p.id AS canonical_payment
    FROM latest c JOIN private.burimunsi_inbox_check_items i USING (collection_id,installation_id)
    LEFT JOIN private.burimunsi_held_observation_sources h ON h.source_id=i.source_id
    LEFT JOIN private.burimunsi_verified_inbox_recoveries w ON w.source_id=i.source_id
    LEFT JOIN private.burimunsi_auto_sms_jobs j ON j.source_id=i.source_id AND j.collection_id=c.collection_id
    LEFT JOIN burimunsi.payments p ON p.collection_id=c.collection_id
      AND p.id=coalesce(w.prior_payment_id,j.payment_id,j.transaction_id)
  )
  SELECT f.project_ref AS project, f.epoch, statement_timestamp() AS observed_at,
    (SELECT jsonb_build_object('state',c.state,'checkedAt',to_timestamp(c.checked_at/1000.0),
      'pageItems',c.page_items,'candidateCount',CASE WHEN c.state<>'checking' THEN c.report->'candidateCount' END,
      'missingCount',CASE WHEN c.state<>'checking' THEN c.report->'missingCount' END,
      'pendingCount',CASE WHEN c.state<>'checking' THEN c.report->'pendingCount' END,
      'headsMatch',CASE WHEN c.state='verified' AND (c.report->>'candidateCount')::int=0 THEN true
        WHEN c.state<>'checking' AND c.report->>'phoneLatestKey' IS NOT NULL THEN
          (c.report->>'phoneLatestKey') IS NOT DISTINCT FROM (c.report->>'parsedLatestKey') END) FROM latest c) AS phone,
    count(p.source_id)::int AS matched_sources, count(p.held)::int AS original_holds,
    count(*) FILTER(WHERE p.held IS NOT NULL AND p.witnessed IS NULL)::int AS holds_awaiting_witness,
    count(p.prior_source_id)::int AS prior_sources_reused,
    count(*) FILTER(WHERE p.witnessed IS NOT NULL AND p.prior_source_id IS NULL)::int AS new_sources_verified,
    count(*) FILTER(WHERE p.witnessed IS NOT NULL AND p.prior_source_id IS NULL AND p.job_phase='finished')::int AS new_jobs_finished,
    count(*) FILTER(WHERE p.witnessed IS NOT NULL AND p.prior_source_id IS NULL AND p.canonical_payment IS NOT NULL)::int AS new_sources_with_payment,
    (SELECT coalesce(jsonb_object_agg(job_state,n),'{}'::jsonb) FROM
      (SELECT job_state,count(*)::int AS n FROM page WHERE job_state IS NOT NULL GROUP BY job_state) states) AS page_job_states
  FROM private.collect_fence_control f LEFT JOIN page p ON true WHERE f.singleton GROUP BY f.project_ref,f.epoch`);
  if (check.epoch !== summary.epoch) throw Error('release_changed_during_inbox_readback');
  const {project, epoch, ...coverage} = check;
  summary.inboxRecovery = coverage;
}
record('sms-chain-' + Date.now() + '.json', summary);
console.log(JSON.stringify(summary, null, 2));
