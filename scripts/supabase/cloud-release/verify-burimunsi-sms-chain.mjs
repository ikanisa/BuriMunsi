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
), receipt_senders AS (
  SELECT count(*)::int AS ready_senders, max(last_seen_at) AS last_sender_heartbeat
  FROM collect_sms.devices
  WHERE ready = 1 AND revoked_at IS NULL AND allowed_kinds::jsonb ? 'receipt'
)
SELECT f.project_ref AS project, statement_timestamp() AS observed_at, f.epoch,
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
  senders.ready_senders, senders.last_sender_heartbeat
FROM private.collect_fence_control f JOIN collect_ops.jobs_config c USING (singleton)
JOIN cron.job j ON j.jobid = c.cron_job_id CROSS JOIN scope s
CROSS JOIN receipt_senders senders WHERE f.singleton`;

const response = await management('database/query', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  // The Management API's read_only role cannot see the private journals.
  // Use the operator's identity with an explicit read-only database transaction.
  body: JSON.stringify({query: 'BEGIN READ ONLY; ' + query + '; ROLLBACK;', read_only: false}),
});
const rows = response.json();
if (rows.length !== 1 || rows[0].project !== PROJECT) throw Error('expected_one_burimunsi_collection');
record('sms-chain-' + Date.now() + '.json', rows[0]);
console.log(JSON.stringify(rows[0], null, 2));
