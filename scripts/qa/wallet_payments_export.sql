-- Read-only custodian export for wallet_reconciliation.py. Supply all five
-- psql variables. A payment with unknown event time requires human placement.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL burimunsi.collection_id = :'collection_id';
COPY (
  SELECT collection_id, receiving_account_id, provider, 'RWF' AS currency,
         occurred_at, provider_reference, direction, amount_rwf, allocation_state
  FROM burimunsi.payments
  WHERE collection_id = :'collection_id'
    AND receiving_account_id = :'receiving_account_id'
    AND provider = :'provider'
    AND (occurred_at IS NULL OR
         (occurred_at >= :'start'::timestamptz AND occurred_at < :'end'::timestamptz))
  ORDER BY occurred_at NULLS LAST, id
) TO STDOUT WITH (FORMAT csv, HEADER);
COMMIT;
