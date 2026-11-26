BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $preflight$
BEGIN
  PERFORM private._collect_fence_require_operator();
  IF session_user<>'postgres' OR current_user<>'postgres'
    OR NOT EXISTS (SELECT FROM private.collect_fence_control WHERE singleton AND mode='fenced')
    OR EXISTS (SELECT FROM collect_ops.jobs_config WHERE singleton AND enabled)
    OR EXISTS (SELECT FROM collect_ops.jobs_dispatches WHERE state IN ('awaiting','unconfirmed')) THEN
    RAISE EXCEPTION 'burimunsi_home_savings_requires_fence' USING ERRCODE='55000';
  END IF;
END;
$preflight$;

-- Retain only the normalized, source-dated scalars for the original accepted
-- payment, inside the same transaction as its successful parse.
CREATE TABLE private.burimunsi_payment_wallet_observations (
  payment_id text PRIMARY KEY REFERENCES burimunsi.payments(id) ON DELETE CASCADE,
  source_id text NOT NULL UNIQUE REFERENCES app.sms_receipts(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL,
  balance_rwf bigint CHECK (balance_rwf BETWEEN 0 AND 9007199254740991),
  fee_rwf bigint CHECK (fee_rwf BETWEEN 0 AND 9007199254740991),
  facts_sha256 text NOT NULL CHECK (facts_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (balance_rwf IS NOT NULL OR fee_rwf IS NOT NULL)
);
ALTER TABLE private.burimunsi_payment_wallet_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.burimunsi_payment_wallet_observations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.burimunsi_payment_wallet_observations
  FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;

-- Recover older, already accepted standalone observations only when their
-- complete reconstructed facts match the original parser-validation digest.
-- Numeric parsing here produces candidates, never an independent posting or
-- balance assertion. Unrecognized formats remain unqualified.
WITH accepted AS MATERIALIZED (
  SELECT p.id,p.sms_source_id,p.direction,p.amount_rwf,p.provider_reference,
    p.counterparty_name,p.counterparty_identifier,p.occurred_at,p.source_time,
    j.payment_outcome,j.facts_sha256,a.model_id,
    CASE WHEN pg_input_is_valid(a.output_json,'jsonb') THEN a.output_json::jsonb END AS output
  FROM burimunsi.payments p
  JOIN private.burimunsi_auto_sms_jobs j ON j.payment_id=p.id AND j.source_id=p.sms_source_id
    AND j.collection_id=p.collection_id AND j.receiving_account_id=p.receiving_account_id
  JOIN private.burimunsi_native_receipt_origins o ON o.source_id=j.source_id
    AND o.collection_id=j.collection_id AND o.fingerprint=j.source_fingerprint
  JOIN app.sms_receipts r ON r.id=o.source_id AND r.owner_user_id=o.principal_user_id
    AND r.body_sha256=o.body_sha256 AND r.object_sha256=o.object_sha256
  JOIN app.momo_parse_attempts a ON a.id=j.attempt_id::text AND a.raw_sms_id=r.id AND a.source_body_sha256=r.body_sha256
  WHERE j.state='completed' AND j.phase='finished' AND j.relation='accepted' AND j.payment_outcome='successful'
    AND a.schema_version='momo-native-extraction.v2' AND a.parser_version='burimunsi-auto.v2' AND a.outcome='accepted'
    AND p.occurred_at IS NOT NULL AND p.source_time<>'' AND octet_length(a.output_json)<=65536
), tokens AS (
  SELECT a.*,
    regexp_replace(trim(output->>'wallet_balance_after_raw'),'^(RWF|FRW|RF)[[:space:]]+|[[:space:]]+(RWF|FRW|RF)$','','gi') AS balance_token,
    regexp_replace(trim(output->>'fee_amount_raw'),'^(RWF|FRW|RF)[[:space:]]+|[[:space:]]+(RWF|FRW|RF)$','','gi') AS fee_token
  FROM accepted a WHERE output->>'schema_version'='momo-native-extraction.v2'
), candidates AS (
  SELECT t.*,
    CASE WHEN balance_token ~ '^(0|[1-9][0-9]{0,15}|[1-9][0-9]{0,2}(,[0-9]{3}){1,5})$'
      THEN replace(balance_token,',','')::numeric END AS balance_rwf,
    CASE WHEN fee_token ~ '^(0|[1-9][0-9]{0,15}|[1-9][0-9]{0,2}(,[0-9]{3}){1,5})$'
      THEN replace(fee_token,',','')::numeric END AS fee_rwf
  FROM tokens t
)
INSERT INTO private.burimunsi_payment_wallet_observations(payment_id,source_id,observed_at,balance_rwf,fee_rwf,facts_sha256)
SELECT c.id,c.sms_source_id,c.occurred_at,c.balance_rwf::bigint,c.fee_rwf::bigint,c.facts_sha256 FROM candidates c
WHERE (balance_token IS NULL OR balance_rwf BETWEEN 0 AND 9007199254740991)
  AND (fee_token IS NULL OR fee_rwf BETWEEN 0 AND 9007199254740991)
  AND (balance_rwf IS NOT NULL OR fee_rwf IS NOT NULL)
  AND EXISTS (
    -- Older rows did not retain the source mode separately. The original
    -- digest must authenticate one of the two documented modes.
    SELECT FROM (VALUES ('live'),('catch_up')) AS accepted_mode(source_mode)
    WHERE c.facts_sha256=encode(sha256(convert_to(jsonb_build_object('model',model_id,'output',output,'facts',
      jsonb_build_object('source_mode',accepted_mode.source_mode,
        'event_kind',CASE direction WHEN 'incoming' THEN 'incoming_receipt' ELSE 'outgoing' END,
        'payment_outcome',payment_outcome,'provider_transaction_id',provider_reference,
        'original_transaction_id',CASE WHEN length(output->>'original_transaction_id_raw') BETWEEN 1 AND 160
          AND output->>'original_transaction_id_raw' !~ '[[:space:]]' THEN output->>'original_transaction_id_raw' END,
        'amount_minor',amount_rwf,'currency','RWF','counterparty_name',counterparty_name,'counterparty_identifier',counterparty_identifier,
        'transaction_at',to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'transaction_datetime_raw',source_time,'fee_minor',fee_rwf,'wallet_balance_after_minor',balance_rwf))::text,'UTF8')),'hex')
  );

CREATE TRIGGER collect_fence_statement_v1 BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
  ON private.burimunsi_payment_wallet_observations
  FOR EACH STATEMENT EXECUTE FUNCTION private._collect_fence_statement();
ALTER TABLE private.burimunsi_payment_wallet_observations ENABLE ALWAYS TRIGGER collect_fence_statement_v1;

-- Amend only the deployed parse finalizer and preserve its function identity,
-- permissions, status, locking, and idempotent early return.
DO $finalizer$
DECLARE
  definition text;
  body_digest text;
  anchor constant text := $anchor$  IF private.burimunsi_auto_snapshot(p_source) IS DISTINCT FROM snapshot THEN
    RAISE EXCEPTION 'burimunsi_auto_source_changed' USING ERRCODE='40001';
  END IF;$anchor$;
  capture constant text := $capture$
  IF result_state='completed' AND event_relation='accepted' AND occurred IS NOT NULL AND source_time<>''
    AND (p_facts->>'wallet_balance_after_minor' IS NOT NULL OR p_facts->>'fee_minor' IS NOT NULL) THEN
    INSERT INTO private.burimunsi_payment_wallet_observations(
      payment_id,source_id,observed_at,balance_rwf,fee_rwf,facts_sha256)
    VALUES (selected,p_source,occurred,(p_facts->>'wallet_balance_after_minor')::bigint,
      (p_facts->>'fee_minor')::bigint,facts_hash);
  END IF;$capture$;
BEGIN
  SELECT pg_get_functiondef(oid),encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO STRICT definition,body_digest
  FROM pg_proc WHERE oid='private.burimunsi_auto_finish(text,uuid,text,text,uuid,text,jsonb,jsonb)'::regprocedure;
  IF body_digest<>'f5fc7fe76ad9c563bb7555715a9816f4a1572610b4d2df5ba864280d30f33e70'
    OR length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
    RAISE EXCEPTION 'burimunsi_home_savings_finalizer_changed' USING ERRCODE='55000';
  END IF;
  EXECUTE replace(definition,anchor,anchor||capture);
END;
$finalizer$;

-- The statement and separate review remain in protected operator custody.
-- Store only their digests and the verified whole-RWF, same-wallet summary.
CREATE TABLE private.burimunsi_home_reconciliation_checkpoints (
  collection_id text NOT NULL REFERENCES private.burimunsi_scopes(collection_id),
  receiving_account_id text NOT NULL REFERENCES app.momo_receiving_accounts(id),
  opened_at timestamptz NOT NULL,
  closed_at timestamptz NOT NULL,
  statement_sha256 text NOT NULL CHECK (statement_sha256 ~ '^[0-9a-f]{64}$'),
  review_sha256 text NOT NULL CHECK (review_sha256 ~ '^[0-9a-f]{64}$' AND review_sha256<>statement_sha256),
  movements_sha256 text NOT NULL CHECK (movements_sha256 ~ '^[0-9a-f]{64}$' AND movements_sha256<>statement_sha256
    AND movements_sha256<>review_sha256),
  movement_count bigint NOT NULL CHECK (movement_count>0),
  opening_rwf bigint NOT NULL CHECK (opening_rwf BETWEEN 0 AND 9007199254740991),
  incoming_rwf bigint NOT NULL CHECK (incoming_rwf BETWEEN 0 AND 9007199254740991),
  outgoing_rwf bigint NOT NULL CHECK (outgoing_rwf BETWEEN 0 AND 9007199254740991),
  fees_rwf bigint NOT NULL CHECK (fees_rwf BETWEEN 0 AND 9007199254740991),
  reversal_credits_rwf bigint NOT NULL CHECK (reversal_credits_rwf BETWEEN 0 AND 9007199254740991),
  reversal_debits_rwf bigint NOT NULL CHECK (reversal_debits_rwf BETWEEN 0 AND 9007199254740991),
  closing_rwf bigint NOT NULL CHECK (closing_rwf BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (collection_id,receiving_account_id,closed_at),
  CHECK (opened_at<=closed_at),
  CHECK (opening_rwf+incoming_rwf-outgoing_rwf-fees_rwf+reversal_credits_rwf-reversal_debits_rwf=closing_rwf)
);
ALTER TABLE private.burimunsi_home_reconciliation_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.burimunsi_home_reconciliation_checkpoints FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.burimunsi_home_reconciliation_checkpoints
  FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;
CREATE TRIGGER collect_fence_statement_v1 BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
  ON private.burimunsi_home_reconciliation_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION private._collect_fence_statement();
ALTER TABLE private.burimunsi_home_reconciliation_checkpoints ENABLE ALWAYS TRIGGER collect_fence_statement_v1;
CREATE TRIGGER collect_fence_no_erasure BEFORE UPDATE OR DELETE OR TRUNCATE
  ON private.burimunsi_home_reconciliation_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION private._collect_fence_no_erasure();
ALTER TABLE private.burimunsi_home_reconciliation_checkpoints ENABLE ALWAYS TRIGGER collect_fence_no_erasure;

CREATE FUNCTION private._burimunsi_home_statement_basis(
  p_collection text,p_receiving_account text,p_opened_at timestamptz,p_closed_at timestamptz)
RETURNS TABLE(movement_count bigint,movements_sha256 text,incoming_rwf numeric,outgoing_rwf numeric,complete_scope boolean)
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $basis$
  SELECT count(*),encode(sha256(convert_to(coalesce(string_agg(
      p.provider_reference||chr(9)||p.direction||chr(9)||p.amount_rwf::text||chr(9)||
      (extract(epoch FROM p.occurred_at)*1000)::bigint::text||chr(10),''
      ORDER BY p.provider_reference COLLATE "C"),''),'UTF8')),'hex'),
    sum(p.amount_rwf) FILTER (WHERE p.direction='incoming'),
    sum(p.amount_rwf) FILTER (WHERE p.direction='outgoing'),
    coalesce(bool_and(p.receiving_account_id=p_receiving_account AND p.provider=w.provider
      AND p.provider_reference IS NOT NULL AND p.provider_reference !~ '[[:cntrl:][:space:]]'
      AND p.occurred_at IS NOT NULL AND p.occurred_at BETWEEN p_opened_at AND p_closed_at
      AND p.occurred_at=date_trunc('milliseconds',p.occurred_at)
      AND NOT EXISTS (SELECT FROM private.burimunsi_auto_sms_jobs j WHERE j.collection_id=p.collection_id
        AND j.receiving_account_id=p.receiving_account_id AND j.payment_id=p.id AND j.relation='conflict')
      AND NOT EXISTS (SELECT FROM app.momo_transactions t WHERE t.id=p.id AND t.receiving_account_id=p.receiving_account_id
        AND (t.has_conflict<>0 OR EXISTS (SELECT FROM app.momo_transaction_sources x
          WHERE x.transaction_id=t.id AND x.relation='conflict')))),false)
  FROM burimunsi.payments p
  JOIN app.momo_receiving_accounts w ON w.id=p_receiving_account AND w.currency='RWF' AND w.status='active'
  WHERE p.collection_id=p_collection
$basis$;
REVOKE ALL ON FUNCTION private._burimunsi_home_statement_basis(text,text,timestamptz,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;

-- The existing independent finance review must bind the entire provider RWF
-- wallet history to the closing timestamp and reconcile opening, movements
-- and fees/reversals separately. Reviewers derive the movement digest from
-- that provider statement, never from Payments: sort its principal rows by
-- provider reference in byte order, concatenate UTF-8 lines
-- reference TAB incoming|outgoing TAB whole RWF TAB UTC epoch ms LF, then
-- SHA-256. Retain the original statement and signed review outside Git.
-- The operator calls this function with a bound private review in a normal
-- approved fenced SQL transaction. No provider data or digest is returned.
CREATE FUNCTION private.burimunsi_admit_home_reconciliation_checkpoint(
  p_collection text,p_receiving_account text,p_opened_at timestamptz,p_closed_at timestamptz,
  p_statement_sha256 text,p_review_sha256 text,p_movements_sha256 text,p_movement_count bigint,
  p_opening_rwf bigint,p_incoming_rwf bigint,p_outgoing_rwf bigint,p_fees_rwf bigint,
  p_reversal_credits_rwf bigint,p_reversal_debits_rwf bigint,p_closing_rwf bigint
) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $checkpoint$
BEGIN
  PERFORM private._collect_fence_require_operator();
  IF session_user<>'postgres' OR current_user<>'postgres' OR p_closed_at>statement_timestamp()
    OR NOT EXISTS (SELECT FROM private.collect_fence_control WHERE singleton AND mode='fenced')
    OR EXISTS (SELECT FROM collect_ops.jobs_config WHERE singleton AND enabled)
    OR EXISTS (SELECT FROM collect_ops.jobs_dispatches WHERE state IN ('awaiting','unconfirmed'))
    OR NOT EXISTS (SELECT FROM private.burimunsi_scopes s JOIN app.collections c ON c.id=s.collection_id
      WHERE s.collection_id=p_collection AND s.receiving_account_id=p_receiving_account AND c.status='active' AND c.currency='RWF') THEN
    RAISE EXCEPTION 'burimunsi_home_checkpoint_scope_changed' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT FROM private._burimunsi_home_statement_basis(
      p_collection,p_receiving_account,p_opened_at,p_closed_at) b WHERE b.complete_scope
    AND b.movement_count=p_movement_count AND b.movements_sha256=p_movements_sha256
    AND coalesce(b.incoming_rwf,0)=p_incoming_rwf AND coalesce(b.outgoing_rwf,0)=p_outgoing_rwf) THEN
    RAISE EXCEPTION 'burimunsi_home_checkpoint_movement_mismatch' USING ERRCODE='22023';
  END IF;
  INSERT INTO private.burimunsi_home_reconciliation_checkpoints VALUES (
    p_collection,p_receiving_account,p_opened_at,p_closed_at,p_statement_sha256,p_review_sha256,
    p_movements_sha256,p_movement_count,p_opening_rwf,p_incoming_rwf,p_outgoing_rwf,p_fees_rwf,
    p_reversal_credits_rwf,p_reversal_debits_rwf,p_closing_rwf)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND AND NOT EXISTS (
    SELECT FROM private.burimunsi_home_reconciliation_checkpoints e WHERE e.collection_id=p_collection
      AND e.receiving_account_id=p_receiving_account AND e.closed_at=p_closed_at
      AND ROW(e.opened_at,e.statement_sha256,e.review_sha256,e.movements_sha256,e.movement_count,e.opening_rwf,e.incoming_rwf,
        e.outgoing_rwf,e.fees_rwf,e.reversal_credits_rwf,e.reversal_debits_rwf,e.closing_rwf)
      IS NOT DISTINCT FROM ROW(p_opened_at,p_statement_sha256,p_review_sha256,p_movements_sha256,p_movement_count,p_opening_rwf,
        p_incoming_rwf,p_outgoing_rwf,p_fees_rwf,p_reversal_credits_rwf,p_reversal_debits_rwf,p_closing_rwf)
  ) THEN
    RAISE EXCEPTION 'burimunsi_home_checkpoint_conflict' USING ERRCODE='23505';
  END IF;
END;
$checkpoint$;
REVOKE ALL ON FUNCTION private.burimunsi_admit_home_reconciliation_checkpoint(
  text,text,timestamptz,timestamptz,text,text,text,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint)
  FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;

CREATE FUNCTION private.burimunsi_home_savings(p_collection text)
RETURNS TABLE(lifetime_contributions_rwf numeric,latest_wallet_balance_rwf numeric,reconciliation_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $home$
DECLARE actor record;
BEGIN
  PERFORM private._collect_fence_require_runtime();
  SELECT * INTO actor FROM private.burimunsi_pin_context();
  IF NOT FOUND OR p_collection IS DISTINCT FROM actor.collection_id
    OR p_collection IS DISTINCT FROM current_setting('burimunsi.collection_id',true)
    OR ('records.read'=ANY(actor.capabilities)) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'burimunsi_home_savings_denied' USING ERRCODE='42501';
  END IF;

  RETURN QUERY WITH scope AS MATERIALIZED (
    SELECT s.collection_id,s.receiving_account_id
    FROM private.burimunsi_scopes s JOIN app.collections c ON c.id=s.collection_id AND c.status='active'
    WHERE s.collection_id=p_collection AND c.currency='RWF'
  ), effective_contributions AS MATERIALIZED (
    SELECT l.amount_minor,l.member_id,p.id AS legacy_payment_id
    FROM scope s
    JOIN app.ledger_entries l ON l.collection_id=s.collection_id AND l.kind='contribution' AND l.amount_minor>0 AND l.currency='RWF'
    JOIN app.payments p ON p.id=l.payment_id AND p.collection_id=l.collection_id
      AND p.status IN ('reconciled','confirmed') AND p.member_id=l.member_id AND p.amount_minor=l.amount_minor
      AND p.evidence_id=l.evidence_id AND p.currency=l.currency
    JOIN app.memberships m ON m.collection_id=l.collection_id AND m.user_id=l.member_id
    WHERE NOT EXISTS (SELECT FROM app.ledger_entries inverse WHERE inverse.reverses_entry_id=l.id)
  ), contributions AS (
    SELECT sum(c.amount_minor) AS total FROM effective_contributions c
  ), wallet_payments AS MATERIALIZED (
    SELECT p.id,p.collection_id,p.receiving_account_id,p.sms_source_id,p.direction,p.amount_rwf,p.member_id,p.occurred_at
    FROM scope s JOIN app.momo_receiving_accounts w ON w.id=s.receiving_account_id AND w.currency='RWF' AND w.status='active'
    JOIN burimunsi.payments p ON p.collection_id=s.collection_id AND p.receiving_account_id=s.receiving_account_id
    WHERE p.occurred_at<=statement_timestamp()
  ), observations AS (
    SELECT v.balance_rwf,p.occurred_at
    FROM wallet_payments p
    JOIN private.burimunsi_payment_wallet_observations v ON v.payment_id=p.id AND v.source_id=p.sms_source_id
      AND v.observed_at=p.occurred_at
    JOIN private.burimunsi_auto_sms_jobs j ON j.payment_id=p.id AND j.source_id=v.source_id
      AND j.collection_id=p.collection_id AND j.receiving_account_id=p.receiving_account_id AND j.facts_sha256=v.facts_sha256
    WHERE v.balance_rwf IS NOT NULL AND j.state='completed' AND j.phase='finished' AND j.relation='accepted'
      AND j.payment_outcome='successful'
      AND NOT EXISTS (SELECT FROM private.burimunsi_auto_sms_jobs bad
        WHERE bad.payment_id=p.id AND bad.collection_id=p.collection_id AND bad.receiving_account_id=p.receiving_account_id
          AND bad.state='completed' AND bad.relation='conflict')
    UNION ALL
    SELECT t.wallet_balance_after_minor,p.occurred_at
    FROM wallet_payments p
    JOIN private.burimunsi_transaction_scopes x ON x.transaction_id=p.id AND x.collection_id=p.collection_id
      AND x.receiving_account_id=p.receiving_account_id AND x.native_source_id=p.sms_source_id
    JOIN app.momo_transactions t ON t.id=x.transaction_id AND t.receiving_account_id=x.receiving_account_id
    JOIN app.momo_parse_attempts a ON a.id=t.parse_attempt_id AND a.outcome='accepted'
    JOIN app.momo_transaction_sources link ON link.transaction_id=t.id AND link.parse_attempt_id=a.id
      AND link.raw_sms_id=a.raw_sms_id AND link.raw_sms_id=p.sms_source_id AND link.relation='accepted'
    JOIN app.sms_receipts r ON r.id=link.raw_sms_id AND r.body_sha256=a.source_body_sha256
    WHERE t.currency='RWF' AND t.currency_scale=0 AND t.has_conflict=0
      AND t.event_kind=CASE p.direction WHEN 'incoming' THEN 'incoming_receipt' ELSE 'outgoing' END
      AND t.transaction_time_source='sms_body_and_provider_profile'
      AND t.wallet_balance_after_minor BETWEEN 0 AND 9007199254740991
      AND CASE WHEN t.transaction_at ~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
        AND pg_input_is_valid(t.transaction_at,'timestamp with time zone') THEN t.transaction_at::timestamptz=p.occurred_at ELSE false END
      AND NOT EXISTS (SELECT FROM app.momo_transaction_sources bad WHERE bad.transaction_id=t.id AND bad.relation='conflict')
  ), latest AS (
    SELECT max(o.occurred_at) AS observed_at,
      CASE WHEN min(o.balance_rwf)=max(o.balance_rwf) THEN min(o.balance_rwf)::numeric END AS balance
    FROM observations o WHERE o.occurred_at=(SELECT max(v.occurred_at) FROM observations v)
  ), comparison AS (
    SELECT q.closing_rwf
    FROM latest l
    JOIN scope s ON l.balance IS NOT NULL
    JOIN private.burimunsi_home_reconciliation_checkpoints q ON q.collection_id=s.collection_id
      AND q.receiving_account_id=s.receiving_account_id AND q.closed_at=l.observed_at
    CROSS JOIN contributions c
    CROSS JOIN LATERAL private._burimunsi_home_statement_basis(
      q.collection_id,q.receiving_account_id,q.opened_at,q.closed_at) b
    WHERE b.complete_scope AND b.movement_count=q.movement_count AND b.movements_sha256=q.movements_sha256
      AND b.incoming_rwf=q.incoming_rwf AND b.outgoing_rwf=q.outgoing_rwf AND c.total=q.incoming_rwf
      -- The existing wire comparison has no opening, fee or reversal term.
      AND q.opening_rwf-q.fees_rwf+q.reversal_credits_rwf-q.reversal_debits_rwf=0
      AND q.fees_rwf>=coalesce((SELECT sum(v.fee_rwf) FROM wallet_payments p
        JOIN private.burimunsi_payment_wallet_observations v ON v.payment_id=p.id AND v.source_id=p.sms_source_id
          AND v.observed_at=p.occurred_at),0)
      AND NOT EXISTS (SELECT FROM wallet_payments p WHERE p.direction='incoming' AND NOT EXISTS (
        SELECT FROM app.momo_financial_links f JOIN effective_contributions posted ON posted.legacy_payment_id=f.payment_id
        WHERE f.transaction_id=p.id AND posted.amount_minor=p.amount_rwf
          AND posted.member_id=p.member_id AND f.beneficiary_member_id=posted.member_id))
  )
  SELECT CASE WHEN c.total BETWEEN 0 AND 9007199254740991 THEN c.total END,l.balance,
    CASE WHEN v.closing_rwf IS NULL THEN 'unavailable' WHEN v.closing_rwf=l.balance THEN 'reconciled' ELSE 'mismatch' END
  FROM contributions c CROSS JOIN latest l LEFT JOIN comparison v ON true;
END;
$home$;
REVOKE ALL ON FUNCTION private.burimunsi_home_savings(text)
  FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;
GRANT EXECUTE ON FUNCTION private.burimunsi_home_savings(text) TO collect_runtime;

COMMIT;
