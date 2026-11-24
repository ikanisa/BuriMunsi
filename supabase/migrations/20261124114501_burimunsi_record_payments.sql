-- Record validated incoming and outgoing M-Money events in Payments. Raw
-- observations, provider attempts and historical journals retain their IDs.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE shape name;
BEGIN
  PERFORM private._collect_fence_require_operator();
  IF session_user <> 'postgres' OR current_user <> 'postgres'
    OR NOT EXISTS (SELECT 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced')
    OR EXISTS (SELECT 1 FROM collect_ops.jobs_config WHERE singleton AND enabled)
    OR EXISTS (SELECT 1 FROM collect_ops.jobs_dispatches WHERE state IN ('awaiting','unconfirmed')) THEN
    RAISE EXCEPTION 'burimunsi_payment_record_requires_fence' USING ERRCODE='55000';
  END IF;
  SELECT conname INTO STRICT shape
  FROM pg_constraint
  WHERE conrelid='private.burimunsi_auto_sms_jobs'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%attempt_id%transaction_id%facts_sha256%relation%payment_outcome%';
  EXECUTE format('ALTER TABLE private.burimunsi_auto_sms_jobs DROP CONSTRAINT %I',shape);
END;
$preflight$;

ALTER TABLE private.burimunsi_auto_sms_jobs
  ADD COLUMN payment_id text REFERENCES burimunsi.payments(id),
  DROP CONSTRAINT burimunsi_auto_sms_jobs_state_check,
  ADD CONSTRAINT burimunsi_auto_sms_jobs_state_check
    CHECK (state IN ('processing','retry','failed','completed','security_message','non_payment')),
  ADD CONSTRAINT burimunsi_auto_payment_job_shape CHECK (
    (state='processing' AND phase IN ('preflight','dispatched') AND lease_token IS NOT NULL AND lease_until IS NOT NULL
      AND next_attempt_at IS NULL AND last_error IS NULL AND retry_lease IS NULL
      AND attempt_id IS NULL AND transaction_id IS NULL AND payment_id IS NULL
      AND facts_sha256 IS NULL AND relation IS NULL AND payment_outcome IS NULL)
    OR (state='retry' AND phase='preflight' AND lease_token IS NULL AND lease_until IS NULL
      AND next_attempt_at IS NOT NULL AND last_error IS NOT NULL AND retry_lease IS NOT NULL
      AND attempt_id IS NULL AND transaction_id IS NULL AND payment_id IS NULL
      AND facts_sha256 IS NULL AND relation IS NULL AND payment_outcome IS NULL)
    OR (state='failed' AND phase='finished' AND lease_token IS NULL AND lease_until IS NULL
      AND next_attempt_at IS NULL AND last_error IS NOT NULL AND retry_lease IS NOT NULL AND attempt_count>=5
      AND attempt_id IS NULL AND transaction_id IS NULL AND payment_id IS NULL
      AND facts_sha256 IS NULL AND relation IS NULL AND payment_outcome IS NULL)
    OR (state='completed' AND phase='finished' AND lease_token IS NULL AND lease_until IS NULL
      AND next_attempt_at IS NULL AND last_error IS NULL AND retry_lease IS NULL
      AND attempt_id IS NOT NULL AND ((transaction_id IS NULL) <> (payment_id IS NULL))
      AND facts_sha256 IS NOT NULL AND relation IS NOT NULL AND payment_outcome IS NOT NULL)
    OR (state='security_message' AND phase='finished' AND lease_token IS NULL AND lease_until IS NULL
      AND next_attempt_at IS NULL AND last_error IS NULL AND retry_lease IS NULL
      AND attempt_id IS NULL AND transaction_id IS NULL AND payment_id IS NULL
      AND facts_sha256 IS NULL AND relation IS NULL AND payment_outcome IS NULL)
    OR (state='non_payment' AND phase='finished' AND lease_token IS NULL AND lease_until IS NULL
      AND next_attempt_at IS NULL AND last_error IS NULL AND retry_lease IS NULL
      AND attempt_id IS NOT NULL AND transaction_id IS NULL AND payment_id IS NULL
      AND facts_sha256 IS NOT NULL AND relation IS NULL AND payment_outcome IS NOT NULL)
  );
CREATE INDEX burimunsi_auto_sms_payment_id
  ON private.burimunsi_auto_sms_jobs(payment_id) WHERE payment_id IS NOT NULL;

CREATE TRIGGER collect_fence_statement_v1 BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
  ON burimunsi.raw_sms FOR EACH STATEMENT EXECUTE FUNCTION private._collect_fence_statement();
ALTER TABLE burimunsi.raw_sms ENABLE ALWAYS TRIGGER collect_fence_statement_v1;
CREATE TRIGGER collect_fence_statement_v1 BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
  ON burimunsi.payments FOR EACH STATEMENT EXECUTE FUNCTION private._collect_fence_statement();
ALTER TABLE burimunsi.payments ENABLE ALWAYS TRIGGER collect_fence_statement_v1;

CREATE FUNCTION private.burimunsi_bind_raw_sms() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $raw$
DECLARE
  source private.burimunsi_unresolved_observations%ROWTYPE;
  previous_frame text := current_setting('burimunsi.observation_frame',true);
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'collect_runtime'
    OR current_setting('collect.edge_verified',true) IS DISTINCT FROM 'true'
    OR NEW.collection_id IS DISTINCT FROM current_setting('burimunsi.collection_id',true) THEN
    RAISE EXCEPTION 'burimunsi_raw_sms_scope' USING ERRCODE='42501';
  END IF;
  PERFORM set_config('burimunsi.observation_frame','1',true);
  SELECT * INTO source FROM private.burimunsi_unresolved_observations
    WHERE source_id=NEW.id AND collection_id=NEW.collection_id AND object_sha256=NEW.object_sha256;
  IF NOT FOUND OR NOT private.burimunsi_observation_storage_matches(source.object_key,
    jsonb_build_object('ownerId',source.principal_user_id,'purpose','sms_receipt','entityId',source.source_id),NEW.object_sha256)
    OR NOT EXISTS (SELECT 1 FROM private.storage_objects WHERE object_key=source.object_key
      AND size=octet_length(NEW.ciphertext) AND sha256=encode(pg_catalog.sha256(NEW.ciphertext),'hex')) THEN
    RAISE EXCEPTION 'burimunsi_raw_sms_changed' USING ERRCODE='23514';
  END IF;
  PERFORM set_config('burimunsi.observation_frame',coalesce(previous_frame,''),true);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('burimunsi.observation_frame',coalesce(previous_frame,''),true);
  RAISE;
END;
$raw$;
REVOKE ALL ON FUNCTION private.burimunsi_bind_raw_sms() FROM PUBLIC,anon,authenticated,service_role,collect_runtime;
CREATE TRIGGER burimunsi_raw_sms_source BEFORE INSERT ON burimunsi.raw_sms
  FOR EACH ROW EXECUTE FUNCTION private.burimunsi_bind_raw_sms();
ALTER TABLE burimunsi.raw_sms ENABLE ALWAYS TRIGGER burimunsi_raw_sms_source;

-- The browser's fresh, audited SMS-reveal proof remains authoritative for
-- access to encrypted originals retained in either location.
CREATE FUNCTION private.burimunsi_observation_admin_payment_source(p_collection text,p_source text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $admin$
DECLARE
  proof jsonb;
  original burimunsi.raw_sms%ROWTYPE;
  inline_envelope text;
  previous_scope text := current_setting('burimunsi.collection_id',true);
BEGIN
  proof := private.burimunsi_observation_admin_source(p_collection,p_source);
  IF proof IS NULL THEN RETURN NULL; END IF;
  PERFORM set_config('burimunsi.collection_id',p_collection,true);
  SELECT * INTO original FROM burimunsi.raw_sms WHERE id=p_source AND collection_id=p_collection;
  IF FOUND THEN
    IF original.object_sha256 IS DISTINCT FROM proof->>'objectSha256'
      OR encode(sha256(original.ciphertext),'hex') IS DISTINCT FROM proof->>'cipherSha256'
      OR octet_length(original.ciphertext)::text IS DISTINCT FROM proof->>'cipherSize' THEN
      RAISE EXCEPTION 'burimunsi_raw_sms_changed' USING ERRCODE='23514';
    END IF;
    inline_envelope := convert_from(original.ciphertext,'UTF8');
  END IF;
  PERFORM set_config('burimunsi.collection_id',coalesce(previous_scope,''),true);
  RETURN jsonb_build_object('source',proof,'inlineEnvelope',inline_envelope);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('burimunsi.collection_id',coalesce(previous_scope,''),true);
  RAISE;
END;
$admin$;
REVOKE ALL ON FUNCTION private.burimunsi_observation_admin_payment_source(text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.burimunsi_observation_admin_payment_source(text,text) TO collect_runtime;

REVOKE INSERT ON burimunsi.payments FROM collect_runtime;
CREATE POLICY burimunsi_payments_record_frame ON burimunsi.payments TO postgres
  USING (current_setting('role',true)='collect_runtime'
    AND current_setting('collect.edge_verified',true)='true'
    AND current_setting('burimunsi.payment_record_frame',true)='1'
    AND collection_id=nullif(current_setting('burimunsi.collection_id',true),''))
  WITH CHECK (current_setting('role',true)='collect_runtime'
    AND current_setting('collect.edge_verified',true)='true'
    AND current_setting('burimunsi.payment_record_frame',true)='1'
    AND collection_id=nullif(current_setting('burimunsi.collection_id',true),''));

CREATE OR REPLACE FUNCTION private.burimunsi_auto_finish(
  p_source text,p_lease uuid,p_fingerprint text,p_profile_sha text,
  p_attempt uuid,p_model text,p_output jsonb,p_facts jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $finish$
DECLARE
  snapshot jsonb; proof jsonb; profile jsonb;
  job private.burimunsi_auto_sms_jobs%ROWTYPE; matched burimunsi.payments%ROWTYPE;
  expected_keys constant text[] := ARRAY['amount_minor','counterparty_identifier','counterparty_name','currency','event_kind',
    'fee_minor','original_transaction_id','payment_outcome','provider_transaction_id','source_mode','transaction_at',
    'transaction_datetime_raw','wallet_balance_after_minor'];
  keys text[]; fact text; fact_type text;
  kind text; outcome text; reference text; wallet_provider text; wallet_timezone text; payment_direction text; amount bigint;
  occurred timestamptz; source_time text; facts_hash text; selected text; matches text[];
  event_relation text := 'accepted'; result_state text := 'completed';
  stamp timestamptz;
  stamp_ms bigint;
  previous_job_frame text := current_setting('burimunsi.native_receipt_frame',true);
  previous_record_frame text := current_setting('burimunsi.payment_record_frame',true);
BEGIN
  PERFORM private.burimunsi_auto_jobs_guard();
  PERFORM pg_advisory_xact_lock(734636924058501::bigint);
  stamp := clock_timestamp();
  stamp_ms := floor(extract(epoch FROM stamp)*1000)::bigint;
  snapshot := private.burimunsi_auto_snapshot(p_source);
  proof := snapshot->'proof'; profile := snapshot->'profile';
  IF proof IS NULL OR proof->>'fingerprint' IS DISTINCT FROM p_fingerprint OR profile IS NULL
    OR profile->>'profileSha256' IS DISTINCT FROM p_profile_sha OR p_attempt IS NULL OR p_lease IS NULL
    OR p_model IS NULL OR p_model='local' OR p_model !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    OR jsonb_typeof(p_facts) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_output) IS DISTINCT FROM 'object' OR octet_length(p_output::text)>65536
    OR p_output->>'schema_version' IS DISTINCT FROM 'momo-native-extraction.v2' THEN
    RAISE EXCEPTION 'burimunsi_auto_invalid' USING ERRCODE='22023';
  END IF;
  SELECT array_agg(key ORDER BY key COLLATE "C") INTO keys FROM jsonb_object_keys(p_facts) AS fields(key);
  IF keys IS DISTINCT FROM expected_keys THEN RAISE EXCEPTION 'burimunsi_auto_invalid' USING ERRCODE='22023'; END IF;
  FOREACH fact IN ARRAY ARRAY['event_kind','payment_outcome','source_mode'] LOOP
    IF jsonb_typeof(p_facts->fact) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'burimunsi_auto_invalid' USING ERRCODE='22023';
    END IF;
  END LOOP;
  FOREACH fact IN ARRAY ARRAY['provider_transaction_id','original_transaction_id','currency','counterparty_name',
    'counterparty_identifier','transaction_at','transaction_datetime_raw'] LOOP
    fact_type := jsonb_typeof(p_facts->fact);
    IF fact_type NOT IN ('string','null') OR (fact_type='string' AND (length(p_facts->>fact) NOT BETWEEN 1 AND 512
      OR p_facts->>fact ~ '[[:cntrl:]]')) THEN
      RAISE EXCEPTION 'burimunsi_auto_invalid' USING ERRCODE='22023';
    END IF;
  END LOOP;
  FOREACH fact IN ARRAY ARRAY['amount_minor','fee_minor','wallet_balance_after_minor'] LOOP
    fact_type := jsonb_typeof(p_facts->fact);
    IF fact_type NOT IN ('number','null') OR (fact_type='number' AND
      (p_facts->>fact !~ '^(0|[1-9][0-9]{0,15})$' OR (p_facts->>fact)::numeric>9007199254740991)) THEN
      RAISE EXCEPTION 'burimunsi_auto_invalid' USING ERRCODE='22023';
    END IF;
  END LOOP;
  kind := p_facts->>'event_kind';
  outcome := p_facts->>'payment_outcome';
  reference := p_facts->>'provider_transaction_id';
  amount := (p_facts->>'amount_minor')::bigint;
  source_time := coalesce(p_facts->>'transaction_datetime_raw','');
  IF p_facts->>'source_mode' NOT IN ('live','catch_up')
    OR kind NOT IN ('incoming_receipt','outgoing','reversal','failed','pending','other','unknown')
    OR outcome NOT IN ('successful','failed','pending','unknown') OR amount=0
    OR reference IS NOT NULL AND (length(reference)>160 OR reference ~ '[[:space:]]')
    OR p_facts->>'original_transaction_id' IS NOT NULL AND length(p_facts->>'original_transaction_id')>160
    OR p_facts->>'currency' IS NOT NULL AND p_facts->>'currency'<>'RWF'
    OR p_facts->>'transaction_at' IS NOT NULL AND
      (p_facts->>'transaction_at' !~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
       OR NOT pg_input_is_valid(p_facts->>'transaction_at','timestamp with time zone'))
    OR kind IN ('incoming_receipt','outgoing','reversal') AND outcome<>'successful'
    OR kind='failed' AND outcome<>'failed' OR kind='pending' AND outcome<>'pending' THEN
    RAISE EXCEPTION 'burimunsi_auto_invalid' USING ERRCODE='22023';
  END IF;
  occurred := (p_facts->>'transaction_at')::timestamptz;
  facts_hash := encode(sha256(convert_to(jsonb_build_object('model',p_model,'output',p_output,'facts',p_facts)::text,'UTF8')),'hex');

  PERFORM set_config('burimunsi.native_receipt_frame','1',true);
  SELECT * INTO job FROM private.burimunsi_auto_sms_jobs WHERE source_id=p_source FOR UPDATE;
  IF NOT FOUND OR ROW(job.collection_id,job.source_fingerprint,job.profile_sha256)
      IS DISTINCT FROM ROW(snapshot->'actor'->>'collectionId',p_fingerprint,p_profile_sha)
    OR job.collection_id IS DISTINCT FROM current_setting('burimunsi.collection_id',true) THEN
    RAISE EXCEPTION 'burimunsi_auto_source_changed' USING ERRCODE='40001';
  END IF;
  IF job.state IN ('completed','non_payment') THEN
    IF job.attempt_id IS DISTINCT FROM p_attempt OR job.facts_sha256 IS DISTINCT FROM facts_hash THEN
      RAISE EXCEPTION 'burimunsi_auto_conflict' USING ERRCODE='23505';
    END IF;
    PERFORM set_config('burimunsi.native_receipt_frame',coalesce(previous_job_frame,''),true);
    RETURN jsonb_build_object('sourceId',p_source,'transactionId',coalesce(job.payment_id,job.transaction_id),
      'state',job.state,'relation',job.relation);
  END IF;
  IF job.lease_token IS DISTINCT FROM p_lease OR job.lease_until<=stamp_ms OR job.event_identity_sha256 IS NULL
    OR job.phase<>'dispatched' THEN
    RAISE EXCEPTION 'burimunsi_auto_source_changed' USING ERRCODE='40001';
  END IF;
  SELECT account.provider,account.timezone INTO wallet_provider,wallet_timezone
  FROM app.momo_receiving_accounts account
  JOIN private.burimunsi_scopes scope ON scope.receiving_account_id=account.id
  WHERE scope.collection_id=job.collection_id AND account.id=job.receiving_account_id AND account.status='active'
  FOR SHARE OF scope,account;
  IF NOT FOUND OR wallet_provider IS DISTINCT FROM profile->'profile'->>'provider'
    OR wallet_timezone IS DISTINCT FROM profile->'profile'->>'timezone' THEN
    RAISE EXCEPTION 'burimunsi_auto_source_changed' USING ERRCODE='40001';
  END IF;

  IF kind NOT IN ('incoming_receipt','outgoing') OR amount IS NULL
    OR p_facts->>'currency' IS DISTINCT FROM 'RWF' THEN
    result_state := 'non_payment';
    event_relation := NULL;
  ELSE
    payment_direction := CASE WHEN kind='incoming_receipt' THEN 'incoming' ELSE 'outgoing' END;
    PERFORM set_config('burimunsi.payment_record_frame','1',true);
    SELECT array_agg(payment.id ORDER BY payment.id COLLATE "C") INTO matches
    FROM burimunsi.payments payment
    WHERE payment.collection_id=job.collection_id AND payment.receiving_account_id=job.receiving_account_id
      AND payment.provider=wallet_provider
      AND (payment.sms_source_id=p_source OR (reference IS NOT NULL AND payment.provider_reference=reference)
       OR EXISTS (
        SELECT 1 FROM private.burimunsi_auto_sms_jobs prior
        JOIN private.burimunsi_native_receipt_origins origin ON origin.source_id=prior.source_id
          AND origin.collection_id=prior.collection_id AND origin.fingerprint=prior.source_fingerprint
        WHERE prior.collection_id=job.collection_id AND prior.receiving_account_id=job.receiving_account_id
          AND coalesce(prior.payment_id,prior.transaction_id)=payment.id AND prior.source_id<>job.source_id
          AND prior.state='completed' AND prior.relation IN ('accepted','duplicate','conflict')
          AND (prior.event_identity_sha256=job.event_identity_sha256
            OR (payment.provider_reference IS NOT NULL AND origin.body_sha256=proof->>'bodySha256')
            OR (job.event_inbox_sha256 IS NOT NULL AND prior.event_inbox_sha256=job.event_inbox_sha256
              AND NOT (job.event_has_service_time AND EXISTS (
                SELECT 1 FROM private.burimunsi_auto_sms_jobs strong
                WHERE strong.collection_id=job.collection_id AND strong.receiving_account_id=job.receiving_account_id
                  AND coalesce(strong.payment_id,strong.transaction_id)=payment.id
                  AND strong.state='completed' AND strong.relation IN ('accepted','duplicate','conflict')
                  AND strong.event_has_service_time AND strong.event_identity_sha256<>job.event_identity_sha256
              ))))
       ));
    IF cardinality(matches)>1 THEN
      RAISE EXCEPTION 'burimunsi_native_event_ambiguous' USING ERRCODE='40001';
    END IF;
    IF cardinality(matches)=1 THEN
      SELECT * INTO STRICT matched FROM burimunsi.payments WHERE id=matches[1] FOR UPDATE;
      selected := matched.id;
      event_relation := CASE WHEN ROW(matched.direction,matched.amount_rwf,matched.occurred_at,matched.counterparty_name,matched.counterparty_identifier)
        IS NOT DISTINCT FROM ROW(payment_direction,amount,occurred,p_facts->>'counterparty_name',p_facts->>'counterparty_identifier')
        AND (reference IS NULL OR matched.provider_reference IS NULL OR matched.provider_reference=reference)
        THEN 'duplicate' ELSE 'conflict' END;
    ELSE
      selected := p_source;
      INSERT INTO burimunsi.payments(id,collection_id,receiving_account_id,provider,provider_reference,
        direction,amount_rwf,occurred_at,source_time,counterparty_name,counterparty_identifier,sms_source_id,created_at,updated_at)
      VALUES (selected,job.collection_id,job.receiving_account_id,wallet_provider,reference,
        payment_direction,amount,occurred,source_time,p_facts->>'counterparty_name',p_facts->>'counterparty_identifier',p_source,stamp,stamp);
    END IF;
  END IF;

  INSERT INTO app.momo_parse_attempts(id,raw_sms_id,attempt_number,model_id,schema_version,prompt_version,parser_version,
    profile_version,profile_json,source_body_sha256,output_json,validation_json,outcome,created_at)
  VALUES (p_attempt::text,p_source,1,p_model,'momo-native-extraction.v2','burimunsi-auto.v2','burimunsi-auto.v2',
    profile->'profile'->>'profile_version',profile->'profile'->>'profile_json',proof->>'bodySha256',p_output::text,'[]',
    coalesce(event_relation,'non_payment'),app.strftime('%Y-%m-%dT%H:%M:%fZ'));
  UPDATE private.burimunsi_auto_sms_jobs
    SET state=result_state,phase='finished',lease_token=NULL,lease_until=NULL,
      attempt_id=p_attempt,payment_id=selected,facts_sha256=facts_hash,relation=event_relation,payment_outcome=outcome,updated_at=stamp_ms
    WHERE source_id=p_source;
  IF private.burimunsi_auto_snapshot(p_source) IS DISTINCT FROM snapshot THEN
    RAISE EXCEPTION 'burimunsi_auto_source_changed' USING ERRCODE='40001';
  END IF;
  PERFORM set_config('burimunsi.payment_record_frame',coalesce(previous_record_frame,''),true);
  PERFORM set_config('burimunsi.native_receipt_frame',coalesce(previous_job_frame,''),true);
  RETURN jsonb_build_object('sourceId',p_source,'transactionId',selected,'state',result_state,'relation',event_relation);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('burimunsi.payment_record_frame',coalesce(previous_record_frame,''),true);
  PERFORM set_config('burimunsi.native_receipt_frame',coalesce(previous_job_frame,''),true);
  RAISE;
END;
$finish$;

CREATE POLICY burimunsi_payments_inbox_frame ON burimunsi.payments FOR SELECT TO postgres
  USING (current_setting('role',true)='collect_runtime'
    AND current_setting('collect.edge_verified',true)='true'
    AND current_setting('burimunsi.inbox_frame',true)='1'
    AND collection_id=nullif(current_setting('burimunsi.collection_id',true),''));
CREATE POLICY burimunsi_raw_sms_inbox_frame ON burimunsi.raw_sms FOR SELECT TO postgres
  USING (current_setting('role',true)='collect_runtime'
    AND current_setting('collect.edge_verified',true)='true'
    AND current_setting('burimunsi.inbox_frame',true)='1'
    AND collection_id=nullif(current_setting('burimunsi.collection_id',true),''));

-- The inbox can attest a terminal parse only while the same source, parse
-- attempt, wallet and payment remain bound. A valid notice also completes
-- inbox capture without creating a payment. Archived originals use the same
-- immutable Storage journal proof used before the inline table existed.
CREATE FUNCTION private._burimunsi_payment_inbox_outcome(
  p_source private.burimunsi_unresolved_observations,
  p_job private.burimunsi_auto_sms_jobs
) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $inbox$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM private.burimunsi_native_receipt_origins origin
    JOIN app.sms_receipts receipt ON receipt.id=origin.source_id
    JOIN app.momo_parse_attempts attempt ON attempt.id=(p_job).attempt_id::text
      AND attempt.raw_sms_id=origin.source_id AND attempt.source_body_sha256=origin.body_sha256
      AND attempt.schema_version='momo-native-extraction.v2' AND attempt.parser_version='burimunsi-auto.v2'
    JOIN private.storage_objects saved ON saved.object_key=receipt.object_key
    LEFT JOIN burimunsi.raw_sms raw ON raw.id=origin.source_id AND raw.collection_id=origin.collection_id
    LEFT JOIN burimunsi.payments payment ON payment.id=(p_job).payment_id
      AND payment.collection_id=origin.collection_id AND payment.receiving_account_id=(p_job).receiving_account_id
    WHERE origin.source_id=(p_source).source_id AND origin.collection_id=(p_source).collection_id
      AND origin.collection_id=nullif(current_setting('burimunsi.collection_id',true),'')
      AND ROW(origin.account_id,origin.principal_user_id,origin.installation_id,origin.grant_id,origin.grant_version,
        origin.request_id,origin.fingerprint,origin.body_sha256,origin.object_sha256)
        IS NOT DISTINCT FROM ROW((p_source).account_id,(p_source).principal_user_id,(p_source).installation_id,
          (p_source).grant_id,(p_source).grant_version,(p_source).request_id,(p_source).fingerprint,(p_source).body_sha256,(p_source).object_sha256)
      AND ROW(receipt.owner_user_id,receipt.body_sha256,receipt.object_sha256,receipt.object_key,receipt.size_bytes)
        IS NOT DISTINCT FROM ROW(origin.principal_user_id,origin.body_sha256,origin.object_sha256,
          (p_source).object_key,(p_source).size_bytes)
      AND private.burimunsi_observation_storage_matches(receipt.object_key,
        jsonb_build_object('ownerId',origin.principal_user_id,'purpose','sms_receipt','entityId',origin.source_id),origin.object_sha256)
      AND (raw.id IS NULL OR (raw.object_sha256=origin.object_sha256 AND octet_length(raw.ciphertext)=saved.size
        AND encode(sha256(raw.ciphertext),'hex')=saved.sha256))
      AND (p_job).phase='finished' AND (p_job).facts_sha256 IS NOT NULL
      AND (
        ((p_job).state='non_payment' AND (p_job).payment_id IS NULL AND attempt.outcome='non_payment')
        OR ((p_job).state='completed' AND (p_job).payment_outcome='successful'
          AND (p_job).relation IN ('accepted','duplicate') AND attempt.outcome=(p_job).relation
          AND payment.id IS NOT NULL AND ((p_job).relation='duplicate' OR payment.sms_source_id=origin.source_id))
      )
  ) THEN CASE WHEN (p_job).relation='duplicate' THEN 'duplicate' ELSE 'parsed' END
  ELSE 'unknown' END
$inbox$;
REVOKE ALL ON FUNCTION private._burimunsi_payment_inbox_outcome(private.burimunsi_unresolved_observations,
  private.burimunsi_auto_sms_jobs) FROM PUBLIC,anon,authenticated,service_role,collect_runtime;

DO $compatibility$
DECLARE
  routine record; body text; definition text;
  from_at integer; through_at integer; replacement text;
  native_before constant text := '   native_ok:=false;'||chr(10);
  native_after constant text := '   IF r.status_code=200 AND NOT coalesce(r.timed_out,true)';
  native_only constant text := $native$
   native_ok:=false;
   IF d.native_contract IS NULL THEN
    native_ok:=NOT coalesce(payload?'native_sms_admission',false) AND NOT coalesce(payload?'native_auto_processing',false)
     AND NOT coalesce(payload?'native_sms_ledger',false);
   ELSIF payload->'native_sms_admission'=d.native_contract AND payload->'native_auto_processing'->>'status'='complete'
    AND NOT coalesce(payload?'native_sms_ledger',false) AND payload->'native_auto_processing'->'processed' IN('0'::jsonb,'1'::jsonb)
    AND jsonb_typeof(payload->'native_auto_processing'->'results')='array' THEN
    native_ok:=to_jsonb(jsonb_array_length(payload->'native_auto_processing'->'results'))=payload->'native_auto_processing'->'processed'
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'native_auto_processing'->'results') item WHERE
      ((item->>'state'='completed' AND item->>'relation' IN('accepted','duplicate','conflict') AND item=jsonb_build_object('state',item->>'state','relation',item->>'relation'))
       OR (item->>'state' IN('security_message','non_payment','not_claimed','retry') AND item=jsonb_build_object('state',item->>'state'))) IS NOT TRUE);
   END IF;
$native$;
BEGIN
  FOR routine IN SELECT * FROM (VALUES
    ('private.burimunsi_auto_begin(text,uuid,text,text)',
      'IF j.state=''completed'' THEN',
      'IF j.state IN (''completed'',''non_payment'') THEN'),
    ('private.burimunsi_auto_begin(text,uuid,text,text)',
      '''state'',''completed'',''started'',false,'||chr(10)||'    ''transactionId'',j.transaction_id',
      '''state'',j.state,''started'',false,'||chr(10)||'    ''transactionId'',coalesce(j.payment_id,j.transaction_id)'),
    ('private.burimunsi_observation_processing_status(jsonb)',
      'ELSIF j.state=''completed'' AND j.posting_last_error IS NOT NULL THEN status:=''needs_review'';',
      'ELSIF j.state=''non_payment'' THEN status:=coalesce(private._burimunsi_inbox_outcome(source,a->>''collectionId''),''unknown'');'),
    ('private._burimunsi_inbox_outcome(text,text)',
      'WHEN j.state=''security_message'' THEN ''security''',
      'WHEN j.state=''security_message'' THEN ''security'''||chr(10)||
      '  WHEN j.payment_id IS NOT NULL OR j.state=''non_payment'' THEN private._burimunsi_payment_inbox_outcome(r,j)'),
    ('private._burimunsi_inbox_outcome(text,text)',
      'AND j.posting_last_error IS NULL AND EXISTS(',
      'AND (j.posting_last_error IS NULL OR EXISTS(SELECT 1 FROM burimunsi.payments p WHERE p.id=j.transaction_id'||
      ' AND p.collection_id=r.collection_id AND p.receiving_account_id=s.receiving_account_id)) AND EXISTS('),
    ('private._burimunsi_wake_sms_worker()',
      'unnest(ARRAY[NEW.next_attempt_at,NEW.posting_next_attempt_at])',
      'unnest(ARRAY[NEW.next_attempt_at])')
  ) AS changes(signature,original,replacement) LOOP
    SELECT prosrc,pg_get_functiondef(oid) INTO STRICT body,definition
    FROM pg_proc WHERE oid=to_regprocedure(routine.signature) AND proowner='postgres'::regrole;
    IF length(body)-length(replace(body,routine.original,''))<>length(routine.original) THEN
      RAISE EXCEPTION 'burimunsi_payment_record_predecessor_changed: %',routine.signature USING ERRCODE='55000';
    END IF;
    EXECUTE replace(definition,body,replace(body,routine.original,routine.replacement));
  END LOOP;

  SELECT prosrc,pg_get_functiondef(oid) INTO STRICT body,definition FROM pg_proc
    WHERE oid='collect_ops.reconcile_jobs()'::regprocedure AND proowner='postgres'::regrole AND NOT prosecdef;
  from_at := strpos(body,native_before);
  through_at := strpos(body,native_after);
  IF from_at=0 OR through_at<=from_at
    OR strpos(substr(body,from_at,through_at-from_at),'jsonb_array_elements(payload->''native_sms_ledger''->''results'')')=0 THEN
    RAISE EXCEPTION 'burimunsi_payment_reconcile_predecessor_changed' USING ERRCODE='55000';
  END IF;
  replacement := substr(body,1,from_at-1)||ltrim(native_only,chr(10))||substr(body,through_at);
  EXECUTE replace(definition,body,replacement);

  SELECT prosrc,pg_get_functiondef(oid) INTO STRICT body,definition FROM pg_proc
    WHERE oid='private.burimunsi_native_job_candidates(text,integer)'::regprocedure
      AND proowner='postgres'::regrole AND prosecdef;
  from_at := strpos(body,'  ELSIF p_lane=''post'' AND p_limit BETWEEN 1 AND 4 THEN');
  through_at := strpos(body,'  ELSE'||chr(10)||'    RAISE EXCEPTION ''burimunsi_jobs_invalid_selection''');
  IF from_at=0 OR through_at<=from_at
    OR strpos(substr(body,from_at,through_at-from_at),'RETURN private.burimunsi_native_sms_post_candidates(p_limit)')=0 THEN
    RAISE EXCEPTION 'burimunsi_payment_candidates_predecessor_changed' USING ERRCODE='55000';
  END IF;
  replacement := substr(body,1,from_at-1)||
    '  ELSIF p_lane=''post'' AND p_limit BETWEEN 1 AND 4 THEN RETURN ''[]''::jsonb;'||chr(10)||substr(body,through_at);
  EXECUTE replace(definition,body,replacement);
END;
$compatibility$;

CREATE FUNCTION private.burimunsi_admin_payment_observation_outcomes(p_collection text,p_sources text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $outcomes$
DECLARE
  result jsonb;
  previous_scope text:=current_setting('burimunsi.collection_id',true);
  previous_inbox text:=current_setting('burimunsi.inbox_frame',true);
  previous_native text:=current_setting('burimunsi.native_receipt_frame',true);
  previous_pin text:=current_setting('burimunsi.pin_frame',true);
BEGIN
  IF p_sources IS NULL OR cardinality(p_sources)>100 OR array_position(p_sources,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_observation_sources' USING ERRCODE='22023';
  END IF;
  PERFORM private.burimunsi_observation_admin_scope(p_collection,false);
  PERFORM set_config('burimunsi.collection_id',p_collection,true),
    set_config('burimunsi.inbox_frame','1',true),set_config('burimunsi.native_receipt_frame','1',true);
  WITH outcomes AS MATERIALIZED (
    SELECT ids.source_id,ids.position,j.state,j.relation,
      private._burimunsi_inbox_outcome(ids.source_id,p_collection) AS inbox_outcome,
      EXISTS(SELECT FROM burimunsi.payments p WHERE p.collection_id=p_collection
        AND p.receiving_account_id=scope.receiving_account_id
        AND p.id=coalesce(j.payment_id,j.transaction_id)) AS has_payment
    FROM unnest(p_sources) WITH ORDINALITY ids(source_id,position)
    JOIN private.burimunsi_scopes scope ON scope.collection_id=p_collection
    LEFT JOIN private.burimunsi_auto_sms_jobs j ON j.source_id=ids.source_id AND j.collection_id=scope.collection_id
      AND j.receiving_account_id=scope.receiving_account_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('sourceId',source_id,'processing',CASE
      WHEN inbox_outcome='needs_review' THEN 'held'
      WHEN state='failed' OR relation='conflict' THEN 'blocked'
      WHEN inbox_outcome='duplicate' THEN 'duplicate'
      WHEN inbox_outcome='security' THEN 'excluded'
      WHEN state='retry' THEN 'retrying'
      WHEN inbox_outcome='parsed' AND has_payment THEN 'parsed'
      WHEN inbox_outcome='parsed' THEN 'non_payment'
      WHEN inbox_outcome='historical' THEN 'historical'
      WHEN state IN ('completed','non_payment') THEN 'blocked'
      ELSE 'pending' END,'paymentReference',NULL,'payerStatus',NULL,'payerReason',NULL) ORDER BY position),'[]'::jsonb)
  INTO result FROM outcomes;
  PERFORM set_config('burimunsi.collection_id',coalesce(previous_scope,''),true),
    set_config('burimunsi.inbox_frame',coalesce(previous_inbox,''),true),
    set_config('burimunsi.native_receipt_frame',coalesce(previous_native,''),true),
    set_config('burimunsi.pin_frame',coalesce(previous_pin,''),true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('burimunsi.collection_id',coalesce(previous_scope,''),true),
    set_config('burimunsi.inbox_frame',coalesce(previous_inbox,''),true),
    set_config('burimunsi.native_receipt_frame',coalesce(previous_native,''),true),
    set_config('burimunsi.pin_frame',coalesce(previous_pin,''),true);
  RAISE;
END;
$outcomes$;
REVOKE ALL ON FUNCTION private.burimunsi_admin_payment_observation_outcomes(text,text[])
  FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;
GRANT EXECUTE ON FUNCTION private.burimunsi_admin_payment_observation_outcomes(text,text[]) TO collect_runtime;

REVOKE EXECUTE ON FUNCTION private.burimunsi_native_sms_post_candidates(integer),
  private.burimunsi_native_sms_post_snapshot(text),private.burimunsi_native_sms_post_defer(text,integer),
  private.burimunsi_native_sms_post_facts(text,text,jsonb,jsonb),
  private.burimunsi_native_sms_post_retry(text,text) FROM collect_runtime;

DROP FUNCTION IF EXISTS private.burimunsi_payment_activity_sources(text,boolean,boolean);
DROP FUNCTION IF EXISTS private.burimunsi_payment_activity_transactions(text);

-- Archived receipts and old notification records remain available for audit.
-- Fresh observations and parse retries are the only receipt job wake sources.
DROP TRIGGER burimunsi_wake_gateway_receipt ON app.sms_receipts;
DROP TRIGGER burimunsi_wake_payer_obligation ON private.burimunsi_payment_sms_obligations;
DROP TRIGGER burimunsi_wake_payment_stage ON private.burimunsi_auto_sms_jobs;
DROP TRIGGER burimunsi_wake_delivery_event ON collect_sms.messages;
DROP TRIGGER burimunsi_wake_payer_retry ON private.burimunsi_payment_sms_deliveries;
DROP TRIGGER burimunsi_wake_native_retry ON private.burimunsi_auto_sms_jobs;
CREATE CONSTRAINT TRIGGER burimunsi_wake_native_retry AFTER UPDATE ON private.burimunsi_auto_sms_jobs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.next_attempt_at IS DISTINCT FROM NEW.next_attempt_at)
  EXECUTE FUNCTION private._burimunsi_wake_sms_worker();

COMMIT;
