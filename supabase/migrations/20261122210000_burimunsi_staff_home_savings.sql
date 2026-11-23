-- Bind the original SMS clock to its existing retained-event identity. Read
-- only the aggregate figures needed by the signed-in Staff Home.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $install$
BEGIN
 PERFORM private._collect_fence_require_operator();
 IF session_user <> 'postgres' OR current_user <> 'postgres' THEN
  RAISE EXCEPTION 'burimunsi_home_savings_requires_fence' USING ERRCODE='55000';
 END IF;
 -- Match release_v3: ingress, effects, singleton row. Hold through COMMIT.
 PERFORM pg_catalog.pg_advisory_xact_lock(7346371,1);
 PERFORM pg_catalog.pg_advisory_xact_lock(7346371,2);
 PERFORM 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced' FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'burimunsi_home_savings_requires_fence' USING ERRCODE='55000';
 END IF;
END;
$install$;

ALTER TABLE private.burimunsi_auto_sms_jobs ADD COLUMN original_sms_at timestamptz,
 ADD CONSTRAINT burimunsi_original_sms_identity CHECK(original_sms_at IS NULL OR event_identity_sha256 IS NOT NULL);

-- Preserve the existing event fields' immutability and the metadata-only
-- maintenance guard. The new clock is written once, after reproducing the
-- retained envelope's already-bound v3 event and inbox hashes.
CREATE OR REPLACE FUNCTION private.burimunsi_auto_event_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$
BEGIN
 IF current_setting('burimunsi.native_event_backfill',true)='1'
  AND (to_jsonb(NEW)-ARRAY['event_identity_sha256','event_inbox_sha256','event_has_service_time','original_sms_at'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['event_identity_sha256','event_inbox_sha256','event_has_service_time','original_sms_at']) THEN
  RAISE EXCEPTION 'burimunsi_native_event_metadata_only' USING ERRCODE='23514';
 END IF;
 IF ROW(NEW.event_identity_sha256,NEW.event_inbox_sha256,NEW.event_has_service_time)
  IS DISTINCT FROM ROW(OLD.event_identity_sha256,OLD.event_inbox_sha256,OLD.event_has_service_time) AND
  (OLD.event_identity_sha256 IS NOT NULL OR NEW.event_identity_sha256 IS NULL OR
   current_setting('burimunsi.native_event_frame',true) IS DISTINCT FROM '1') THEN
  RAISE EXCEPTION 'burimunsi_native_event_immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.original_sms_at IS DISTINCT FROM OLD.original_sms_at
  AND (OLD.original_sms_at IS NOT NULL OR current_setting('burimunsi.original_sms_clock',true) IS DISTINCT FROM '1') THEN
  RAISE EXCEPTION 'burimunsi_original_sms_immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$fn$;

CREATE FUNCTION private._burimunsi_original_sms_hash(p_body text,p_at text,p_kind text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $fn$
 SELECT encode(sha256(convert_to('{"bodySha256":'||to_json(p_body)::text
  ||',"format":"collect.native.sms.event.v3","originalSmsAt":'||coalesce(to_json(p_at)::text,'null')
  ||',"timeKind":'||to_json(p_kind)::text||'}','UTF8')),'hex');
$fn$;
REVOKE ALL ON FUNCTION private._burimunsi_original_sms_hash(text,text,text)
 FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;

CREATE FUNCTION private._burimunsi_save_original_sms_time(p_source text,p_fingerprint text,p_event jsonb,
 p_inbox text,p_service text,p_maintenance boolean) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE
 stamp text; body_hash text; preferred timestamptz; event_kind text; verified_rows integer;
 prior_frame text:=current_setting('burimunsi.native_receipt_frame',true);
 prior_backfill text:=current_setting('burimunsi.native_event_backfill',true);
 prior_clock text:=current_setting('burimunsi.original_sms_clock',true);
BEGIN
 FOREACH stamp IN ARRAY ARRAY[p_inbox,p_service] LOOP
  IF stamp IS NOT NULL AND (stamp !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
   OR NOT pg_input_is_valid(stamp,'timestamp with time zone')) THEN
   RAISE EXCEPTION 'burimunsi_original_sms_invalid' USING ERRCODE='22023';
  END IF;
  IF stamp IS NOT NULL AND to_char(stamp::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> stamp THEN
   RAISE EXCEPTION 'burimunsi_original_sms_invalid' USING ERRCODE='22023';
  END IF;
 END LOOP;
 PERFORM set_config('burimunsi.native_receipt_frame','1',true);
 IF p_maintenance THEN PERFORM set_config('burimunsi.native_event_backfill','1',true); END IF;
 PERFORM set_config('burimunsi.original_sms_clock','1',true);
 SELECT r.body_sha256 INTO STRICT body_hash FROM private.burimunsi_auto_sms_jobs j
  JOIN app.sms_receipts r ON r.id=j.source_id
  WHERE j.source_id=p_source AND j.source_fingerprint=p_fingerprint
   AND j.event_identity_sha256=p_event->>'identity'
   AND j.event_inbox_sha256 IS NOT DISTINCT FROM (p_event->>'inboxIdentity')
   AND j.event_has_service_time=(p_service IS NOT NULL);
 event_kind:=CASE WHEN p_service IS NOT NULL THEN 'service_centre' WHEN p_inbox IS NOT NULL THEN 'inbox' ELSE 'no_original_time' END;
 IF private._burimunsi_original_sms_hash(body_hash,coalesce(p_service,p_inbox),event_kind)
   IS DISTINCT FROM (p_event->>'identity')
  OR (CASE WHEN p_inbox IS NOT NULL THEN private._burimunsi_original_sms_hash(body_hash,p_inbox,'inbox') END)
   IS DISTINCT FROM (p_event->>'inboxIdentity') THEN
  RAISE EXCEPTION 'burimunsi_original_sms_changed' USING ERRCODE='40001';
 END IF;
 preferred:=coalesce(p_inbox,p_service)::timestamptz;
 IF preferred IS NOT NULL THEN
  UPDATE private.burimunsi_auto_sms_jobs SET original_sms_at=preferred WHERE source_id=p_source
   AND source_fingerprint=p_fingerprint AND (original_sms_at IS NULL OR original_sms_at=preferred);
  GET DIAGNOSTICS verified_rows=ROW_COUNT;
  IF verified_rows<>1 THEN RAISE EXCEPTION 'burimunsi_original_sms_changed' USING ERRCODE='40001'; END IF;
 END IF;
 PERFORM set_config('burimunsi.original_sms_clock',coalesce(prior_clock,''),true);
 PERFORM set_config('burimunsi.native_event_backfill',coalesce(prior_backfill,''),true);
 PERFORM set_config('burimunsi.native_receipt_frame',coalesce(prior_frame,''),true);
 RETURN true;
END;
$fn$;
REVOKE ALL ON FUNCTION private._burimunsi_save_original_sms_time(text,text,jsonb,text,text,boolean)
 FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;

CREATE FUNCTION private.burimunsi_auto_event_bind(p_source text,p_lease uuid,p_fingerprint text,p_event jsonb,
 p_inbox text,p_service text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
BEGIN
 IF private.burimunsi_auto_event_bind(p_source,p_lease,p_fingerprint,p_event) IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'burimunsi_native_event_changed' USING ERRCODE='40001';
 END IF;
 RETURN private._burimunsi_save_original_sms_time(p_source,p_fingerprint,p_event,p_inbox,p_service,false);
END;
$fn$;
REVOKE ALL ON FUNCTION private.burimunsi_auto_event_bind(text,uuid,text,jsonb,text,text)
 FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;
GRANT EXECUTE ON FUNCTION private.burimunsi_auto_event_bind(text,uuid,text,jsonb,text,text) TO collect_runtime;

CREATE FUNCTION private.burimunsi_auto_event_backfill(p_source text,p_fingerprint text,p_event jsonb,
 p_inbox text,p_service text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
BEGIN
 IF private.burimunsi_auto_event_backfill(p_source,p_fingerprint,p_event) IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'burimunsi_native_event_changed' USING ERRCODE='40001';
 END IF;
 RETURN private._burimunsi_save_original_sms_time(p_source,p_fingerprint,p_event,p_inbox,p_service,true);
END;
$fn$;
REVOKE ALL ON FUNCTION private.burimunsi_auto_event_backfill(text,text,jsonb,text,text)
 FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;

-- A legacy managed capture provides device/SMSC timestamps as text. Neither
-- upload time nor the printed transaction time gives the original SMS order.
CREATE FUNCTION private._burimunsi_home_sms_instant(value text) RETURNS timestamptz
LANGUAGE sql STABLE STRICT SET search_path=pg_catalog,pg_temp AS $fn$
 SELECT CASE WHEN value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$'
  AND pg_input_is_valid(value,'timestamp with time zone') THEN value::timestamptz END;
$fn$;
REVOKE ALL ON FUNCTION private._burimunsi_home_sms_instant(text)
 FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;

CREATE FUNCTION private.burimunsi_home_savings(p_collection text,p_as_of timestamptz)
RETURNS TABLE(lifetime_contributions numeric,outgoing_payments numeric,wallet_balance bigint,last_wallet_sms_at text,reconciliation_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE actor record; prior_frame text:=current_setting('burimunsi.native_receipt_frame',true);
BEGIN
 PERFORM private._collect_fence_require_runtime();
 SELECT * INTO actor FROM private.burimunsi_pin_context();
 IF NOT FOUND OR actor.collection_id IS DISTINCT FROM p_collection OR p_as_of IS NULL
  OR p_collection IS DISTINCT FROM current_setting('burimunsi.collection_id',true)
  OR ('records.read'=ANY(actor.capabilities)) IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'burimunsi_home_savings_denied' USING ERRCODE='42501';
 END IF;
 PERFORM private.burimunsi_pin_assert_actor(NULL,actor.collection_id,NULL,1,NULL);
 PERFORM set_config('burimunsi.native_receipt_frame','1',true);
 RETURN QUERY WITH contributions AS (
  SELECT coalesce(sum(l.amount_minor),0) AS total
  FROM app.ledger_entries l JOIN app.payments p ON p.id=l.payment_id AND p.collection_id=l.collection_id
  WHERE l.collection_id=p_collection AND l.kind='contribution' AND l.amount_minor>0 AND l.currency='RWF'
   AND p.status IN ('reconciled','confirmed') AND l.member_id=p.member_id AND l.evidence_id=p.evidence_id
   AND l.amount_minor=p.amount_minor AND l.currency=p.currency
   AND EXISTS (SELECT 1 FROM app.memberships m WHERE m.collection_id=l.collection_id AND m.user_id=l.member_id)
   AND NOT EXISTS (SELECT 1 FROM app.ledger_entries inverse WHERE inverse.reverses_entry_id=l.id)
 ), managed_sources AS MATERIALIZED (
  -- A current wallet or SIM alone cannot identify the historical group.
  SELECT r.id,r.body_sha256,j.state AS job_state,private._burimunsi_home_sms_instant(c.service_centre_at) AS service_at,
    coalesce(private._burimunsi_home_sms_instant(c.inbox_received_at),private._burimunsi_home_sms_instant(c.service_centre_at),
      private._burimunsi_home_sms_instant(r.received_at_device)) AS sms_at
  FROM private.burimunsi_scopes scope JOIN app.momo_receiving_accounts w ON w.id=scope.receiving_account_id AND w.currency='RWF'
  JOIN private.burimunsi_sms_source_scopes x
   ON x.collection_id=scope.collection_id AND x.receiving_account_id=scope.receiving_account_id
  JOIN app.sms_receipts r ON r.id=x.source_id AND r.owner_user_id=x.owner_user_id
   AND r.body_sha256=x.source_body_sha256 AND r.object_sha256=x.object_sha256
  JOIN app.momo_gateway_captures c ON c.raw_sms_id=r.id AND c.credential_id=x.credential_id AND c.completeness='complete'
  JOIN app.momo_gateway_credentials k ON k.id=c.credential_id AND k.binding_id=x.binding_id
  JOIN app.momo_gateway_bindings b ON b.id=k.binding_id AND b.receiving_account_id=x.receiving_account_id AND b.owner_user_id=x.owner_user_id
  JOIN app.momo_processing_jobs j ON j.raw_sms_id=r.id AND j.binding_id=x.binding_id AND j.binding_version=x.binding_version
   AND j.receiving_account_id=x.receiving_account_id AND j.state IN ('completed','needs_review')
  WHERE scope.collection_id=p_collection
 ), records AS MATERIALIZED (
  SELECT t.id,x.receiving_account_id,r.body_sha256,CASE WHEN j.event_has_service_time THEN j.event_identity_sha256 END AS service_identity,
    coalesce(j.posting_facts->>'provider_transaction_id',t.provider_transaction_id) AS provider_id,
    coalesce(j.posting_facts->>'event_kind',t.event_kind) AS kind,
    coalesce(j.posting_facts->>'payment_outcome',j.payment_outcome,
      CASE WHEN x.native_source_id IS NULL THEN a.output_json::jsonb->>'payment_outcome' END) AS outcome,
    coalesce(j.posting_facts->>'currency',t.currency) AS currency,
    coalesce((j.posting_facts->>'amount_minor')::bigint,t.amount_minor) AS amount,
    coalesce((j.posting_facts->>'wallet_balance_after_minor')::bigint,t.wallet_balance_after_minor) AS balance,
    CASE WHEN x.native_source_id IS NOT NULL THEN j.original_sms_at ELSE
      coalesce(managed.sms_at,CASE WHEN source_scope.source_id IS NOT NULL THEN private._burimunsi_home_sms_instant(r.received_at_device) END) END AS sms_at,
    t.has_conflict<>0 OR EXISTS (SELECT 1 FROM app.momo_transaction_sources bad
      WHERE bad.transaction_id=t.id AND bad.relation='conflict') AS conflicted
  FROM private.burimunsi_scopes scope JOIN app.momo_receiving_accounts w ON w.id=scope.receiving_account_id AND w.currency='RWF'
  JOIN private.burimunsi_transaction_scopes x
   ON x.collection_id=scope.collection_id AND x.receiving_account_id=scope.receiving_account_id
  JOIN app.momo_transactions t ON t.id=x.transaction_id AND t.receiving_account_id=x.receiving_account_id
  JOIN app.momo_parse_attempts a ON a.id=t.parse_attempt_id AND a.outcome='accepted'
  JOIN app.momo_transaction_sources src ON src.transaction_id=t.id AND src.parse_attempt_id=t.parse_attempt_id
   AND src.raw_sms_id=a.raw_sms_id AND src.relation='accepted'
  JOIN app.sms_receipts r ON r.id=src.raw_sms_id AND r.body_sha256=a.source_body_sha256
  LEFT JOIN private.burimunsi_auto_sms_jobs j ON j.source_id=x.native_source_id AND j.source_id=src.raw_sms_id
   AND j.transaction_id=t.id AND j.collection_id=x.collection_id AND j.receiving_account_id=x.receiving_account_id
   AND j.state='completed' AND j.relation='accepted'
  LEFT JOIN private.burimunsi_sms_source_scopes source_scope ON x.native_source_id IS NULL AND source_scope.source_id=src.raw_sms_id
   AND source_scope.collection_id=x.collection_id AND source_scope.receiving_account_id=x.receiving_account_id
   AND source_scope.source_body_sha256=r.body_sha256 AND source_scope.owner_user_id=r.owner_user_id AND source_scope.object_sha256=r.object_sha256
  LEFT JOIN managed_sources managed ON managed.id=src.raw_sms_id AND x.native_source_id IS NULL
  WHERE scope.collection_id=p_collection AND (x.native_source_id IS NULL OR j.source_id IS NOT NULL)
 ), managed_attempts AS (
  SELECT m.id,m.body_sha256,m.sms_at,m.service_at,a.output_json::jsonb AS output,marks.witness,marks.has_debit,
    marks.balance_candidate OR a.output_json::jsonb->>'wallet_balance_after_raw' IS NOT NULL AS balance_candidate,
    marks.n=1 AND marks.witness->>'code'='burimunsi_wallet_debit_v1'
      AND marks.witness ?& ARRAY['code','providerTransactionId','amountRwf','walletBalanceAfterRwf']
      AND marks.witness-ARRAY['code','providerTransactionId','amountRwf','walletBalanceAfterRwf']='{}'::jsonb AS debit_shape,
    marks.n=1 AND marks.witness->>'code'='burimunsi_wallet_balance_v1'
      AND marks.witness ? 'walletBalanceAfterRwf'
      AND marks.witness-ARRAY['code','walletBalanceAfterRwf']='{}'::jsonb AS balance_shape
  FROM managed_sources m
  JOIN LATERAL (SELECT raw_sms_id,source_body_sha256,outcome,output_json,validation_json FROM app.momo_parse_attempts candidate
    WHERE candidate.raw_sms_id=m.id ORDER BY attempt_number DESC LIMIT 1) a
   ON a.source_body_sha256=m.body_sha256 AND a.outcome='non_payment'
  CROSS JOIN LATERAL (
   SELECT count(*) AS n,(array_agg(marker))[1] AS witness,
    coalesce(bool_or(marker->>'code'='burimunsi_wallet_debit_v1'),false) AS has_debit,
    coalesce(bool_or(marker->>'code'='burimunsi_wallet_balance_v1' OR marker->>'walletBalanceAfterRwf' IS NOT NULL),false) AS balance_candidate
   FROM jsonb_array_elements(
     CASE WHEN jsonb_typeof(a.validation_json::jsonb)='array' THEN a.validation_json::jsonb ELSE '[]'::jsonb END) marker
    WHERE marker->>'code' IN ('burimunsi_wallet_debit_v1','burimunsi_wallet_balance_v1')
  ) marks
  WHERE m.job_state='completed' AND (marks.n>0 OR (a.output_json::jsonb->>'event_kind'='outgoing'
    AND a.output_json::jsonb->>'payment_outcome'='successful') OR a.output_json::jsonb->>'wallet_balance_after_raw' IS NOT NULL)
 ), managed_values AS (
  SELECT m.*,witness->>'providerTransactionId' AS provider_id,
   CASE WHEN jsonb_typeof(witness->'amountRwf')='number' THEN (witness->>'amountRwf')::numeric END AS amount,
   CASE WHEN jsonb_typeof(witness->'walletBalanceAfterRwf')='number' THEN (witness->>'walletBalanceAfterRwf')::numeric END AS balance
  FROM managed_attempts m
 ), managed AS (
  SELECT v.*,coalesce(balance_shape AND balance=trunc(balance) AND balance BETWEEN 0 AND 9007199254740991,false) AS balance_only,
   coalesce(debit_shape AND jsonb_typeof(witness->'providerTransactionId')='string'
   AND length(provider_id) BETWEEN 1 AND 160 AND provider_id !~ '[[:space:][:cntrl:]]'
   AND amount=trunc(amount) AND amount BETWEEN 1 AND 9007199254740991
   AND (witness->'walletBalanceAfterRwf'='null'::jsonb OR (balance=trunc(balance) AND balance BETWEEN 0 AND 9007199254740991))
   AND (output->>'event_kind' IS NULL OR output->>'event_kind'='outgoing')
   AND (output->>'payment_outcome' IS NULL OR output->>'payment_outcome'='successful'),false) AS verified
  FROM managed_values v
 ), physical_matches AS (
  -- Some native sources lack the provider reference recovered from the same
  -- managed SMS. Match the immutable body and original SMSC (or inbox) time.
  -- A missing clock is uncertainty, never proof of a second debit.
  SELECT r.id,m.provider_id,CASE WHEN r.service_identity IS NOT NULL AND m.service_at IS NOT NULL THEN
    r.service_identity=private._burimunsi_original_sms_hash(m.body_sha256,
     to_char(m.service_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'service_centre')
   ELSE r.sms_at=m.sms_at END AS same_sms
  FROM records r JOIN managed m ON m.verified AND m.body_sha256=r.body_sha256
  WHERE r.kind='outgoing'
 ), aliases AS (
  SELECT id,min(provider_id) FILTER(WHERE same_sms) AS provider_id,
   count(DISTINCT provider_id) FILTER(WHERE same_sms) AS matching_ids,bool_or(same_sms IS NULL) AS missing_clock
  FROM physical_matches GROUP BY id
 ), keyed AS (
  SELECT r.*,coalesce('provider:'||r.provider_id,'provider:'||a.provider_id,'transaction:'||r.id) AS event_key,
   coalesce(a.matching_ids>1 OR (a.matching_ids=1 AND r.provider_id IS NOT NULL AND a.provider_id<>r.provider_id)
    OR (r.provider_id IS NULL AND a.matching_ids=0 AND a.missing_clock),false) AS ambiguous
  FROM records r LEFT JOIN aliases a ON a.id=r.id
 ), debits AS (
  SELECT event_key,amount,conflicted OR ambiguous AS disputed
   FROM keyed WHERE kind='outgoing' AND outcome='successful' AND currency='RWF' AND amount>0
  UNION ALL
  SELECT 'provider:'||m.provider_id,m.amount,EXISTS(SELECT 1 FROM physical_matches match
    JOIN keyed r ON r.id=match.id WHERE match.provider_id=m.provider_id AND match.same_sms AND r.ambiguous)
   FROM managed m WHERE m.verified
 ), debit_events AS (
  SELECT event_key,min(amount) AS amount,min(amount)=max(amount) AND NOT bool_or(disputed) AS agreed
  FROM debits GROUP BY event_key
 ), outgoing AS (
  SELECT coalesce(sum(amount) FILTER (WHERE agreed),0) AS total,
   NOT EXISTS(SELECT 1 FROM managed WHERE NOT verified AND
    (has_debit OR (output->>'event_kind'='outgoing' AND output->>'payment_outcome'='successful')))
   AND NOT EXISTS(SELECT 1 FROM keyed WHERE kind='outgoing' AND (conflicted OR ambiguous OR
    outcome IS NULL OR outcome='unknown' OR
    (outcome='successful' AND (amount IS NULL OR amount<=0 OR currency IS DISTINCT FROM 'RWF'))))
   AND coalesce(bool_and(agreed),true) AS complete
  FROM debit_events
 ), wallet_reports AS (
  SELECT kind,event_key,balance::bigint,sms_at
   FROM keyed WHERE balance>=0 AND (currency='RWF' OR currency IS NULL) AND NOT (conflicted OR ambiguous)
  UNION ALL
  SELECT 'outgoing','provider:'||provider_id,balance::bigint,sms_at FROM managed WHERE verified AND balance IS NOT NULL
  UNION ALL
  SELECT 'balance',coalesce('receipt:'||body_sha256||':'||extract(epoch FROM coalesce(service_at,sms_at))::text,'source:'||id),
    balance::bigint,sms_at FROM managed WHERE balance_only
 ), wallet_events AS (
  -- A duplicate/replay of the same provider transaction is not a newer
  -- financial event. Omit neither an unresolved clock nor conflicting values.
  SELECT kind,event_key,min(balance) AS balance,max(balance) AS largest,
   min(sms_at) AS sms_at FROM wallet_reports GROUP BY kind,event_key
 ), uncertain_wallets AS (
  -- Only use model evidence to withhold a potentially stale display. It never
  -- supplies a wallet amount. A strictly later clean report can supersede it.
  SELECT sms_at FROM managed WHERE balance_candidate AND NOT (balance_only OR (verified AND balance IS NOT NULL))
  UNION ALL
  SELECT sms_at FROM keyed WHERE (conflicted OR ambiguous) AND balance>=0 AND (currency='RWF' OR currency IS NULL)
  UNION ALL
  SELECT CASE WHEN j.source_id IS NOT NULL THEN j.original_sms_at ELSE m.sms_at END
  FROM records k JOIN app.momo_transaction_sources s ON s.transaction_id=k.id AND s.relation='conflict'
  JOIN app.momo_parse_attempts a ON a.id=s.parse_attempt_id AND a.raw_sms_id=s.raw_sms_id
  JOIN app.sms_receipts r ON r.id=s.raw_sms_id AND r.body_sha256=a.source_body_sha256
  LEFT JOIN private.burimunsi_auto_sms_jobs j ON j.source_id=s.raw_sms_id AND j.transaction_id=k.id
    AND j.collection_id=p_collection AND j.receiving_account_id=k.receiving_account_id AND j.state='completed' AND j.relation='conflict'
  LEFT JOIN managed_sources m ON m.id=s.raw_sms_id
  WHERE (j.source_id IS NOT NULL OR m.id IS NOT NULL) AND (j.posting_facts->>'wallet_balance_after_minor' IS NOT NULL
    OR a.output_json::jsonb->>'wallet_balance_after_raw' IS NOT NULL)
 ), newest AS (
  SELECT max(sms_at) AS at FROM (SELECT sms_at FROM wallet_events UNION ALL SELECT sms_at FROM uncertain_wallets) stamps
   HAVING NOT coalesce(bool_or(sms_at IS NULL OR sms_at>p_as_of),false)
 ), wallet AS (
  SELECT min(w.balance) AS balance,n.at FROM newest n JOIN wallet_events w ON w.sms_at=n.at
  WHERE NOT EXISTS(SELECT 1 FROM uncertain_wallets u WHERE u.sms_at=n.at)
  GROUP BY n.at HAVING min(w.balance)=max(w.largest)
 )
 SELECT contributions.total,outgoing.total,wallet.balance,to_char(wallet.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  CASE WHEN wallet.balance IS NULL OR NOT outgoing.complete THEN 'unavailable'
       WHEN contributions.total-outgoing.total=wallet.balance THEN 'balanced' ELSE 'mismatch' END
 FROM contributions CROSS JOIN outgoing LEFT JOIN wallet ON true;
 PERFORM set_config('burimunsi.native_receipt_frame',coalesce(prior_frame,''),true);
END;
$fn$;
REVOKE ALL ON FUNCTION private.burimunsi_home_savings(text,timestamptz)
 FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;
GRANT EXECUTE ON FUNCTION private.burimunsi_home_savings(text,timestamptz) TO collect_runtime;

COMMIT;
