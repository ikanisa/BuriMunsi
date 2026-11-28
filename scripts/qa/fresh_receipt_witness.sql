-- Read-only witness for one independently observed, ordinary incoming MoMo
-- receipt. Run with -X -qAt -v ON_ERROR_STOP=1 and private psql bindings.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';

SELECT (
  length(:'collection_id') BETWEEN 1 AND 160
  AND length(:'receiving_account_id') BETWEEN 1 AND 160
  AND length(:'provider') BETWEEN 1 AND 160
  AND :'provider_reference' ~ '^[^[:space:]]{1,160}$'
  AND :'amount_rwf'::bigint BETWEEN 1 AND 9007199254740991
  AND :'start' ~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
  AND :'end' ~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
  AND :'end'::timestamptz > :'start'::timestamptz
  AND :'end'::timestamptz - :'start'::timestamptz <= interval '1 day'
) AS valid_witness_input \gset
\if :valid_witness_input
SET LOCAL burimunsi.collection_id = :'collection_id';
SELECT json_build_object(
  'visible_reference_rows', count(*),
  'matching_incoming_rows', count(*) FILTER (WHERE direction = 'incoming' AND amount_matches AND event_in_window),
  'fresh_sms_linked_rows', count(*) FILTER (
    WHERE direction = 'incoming' AND amount_matches AND event_in_window
      AND payment_in_window AND capture_in_window
  )
)
FROM (
  SELECT p.direction, p.amount_rwf = :'amount_rwf'::bigint AS amount_matches,
         p.occurred_at >= :'start'::timestamptz AND p.occurred_at < :'end'::timestamptz AS event_in_window,
         p.created_at >= :'start'::timestamptz AND p.created_at < :'end'::timestamptz AS payment_in_window,
         s.stored_at >= :'start'::timestamptz AND s.stored_at < :'end'::timestamptz AS capture_in_window
  FROM burimunsi.payments p
  LEFT JOIN burimunsi.raw_sms s ON s.id = p.sms_source_id AND s.collection_id = p.collection_id
  WHERE p.collection_id = :'collection_id'
    AND p.receiving_account_id = :'receiving_account_id'
    AND p.provider = :'provider'
    AND p.provider_reference = :'provider_reference'
) witness;
\else
-- Raise a fixed error rather than returning an apparent zero-count result.
SELECT 'invalid_fresh_receipt_witness_input'::integer;
\endif
COMMIT;
