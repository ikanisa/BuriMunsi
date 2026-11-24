-- Reconcile retained pre-enrollment sources on a fresh, verified standalone phone page.
-- No existing allocation, payment, parser attempt or imported source is rewritten.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';
DO $install$
BEGIN
  PERFORM private._collect_fence_require_operator();
  PERFORM pg_advisory_xact_lock(7346371,1),pg_advisory_xact_lock(7346371,2);
  PERFORM 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced' FOR UPDATE;
  IF NOT FOUND OR session_user<>'postgres' OR current_user<>'postgres'
    OR to_regclass('private.burimunsi_allocation_receipts') IS NULL THEN
    RAISE EXCEPTION 'verified_inbox_recovery_predecessor_required' USING ERRCODE='55000';
  END IF;
END;
$install$;

CREATE TABLE private.burimunsi_verified_inbox_recoveries (
  source_id text PRIMARY KEY REFERENCES private.burimunsi_held_observation_sources(source_id),
  run_id uuid NOT NULL,
  request_id uuid NOT NULL,
  content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  object_sha256 text NOT NULL CHECK(object_sha256 ~ '^[a-f0-9]{64}$'),
  prior_source_id text REFERENCES private.burimunsi_unresolved_observations(source_id),
  prior_payment_id text REFERENCES burimunsi.payments(id),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((prior_source_id IS NULL)=(prior_payment_id IS NULL) AND prior_source_id IS DISTINCT FROM source_id)
);
ALTER TABLE private.burimunsi_verified_inbox_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.burimunsi_verified_inbox_recoveries FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.burimunsi_verified_inbox_recoveries FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;
CREATE POLICY verified_inbox_owner_frame ON private.burimunsi_verified_inbox_recoveries TO postgres
 USING(current_setting('role',true)='collect_runtime' AND current_setting('collect.edge_verified',true)='true'
   AND current_setting('burimunsi.inbox_frame',true)='1')
 WITH CHECK(current_setting('role',true)='collect_runtime' AND current_setting('collect.edge_verified',true)='true'
   AND current_setting('burimunsi.inbox_frame',true)='1');
CREATE TRIGGER collect_fence_statement_v1 BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON private.burimunsi_verified_inbox_recoveries
 FOR EACH STATEMENT EXECUTE FUNCTION private._collect_fence_statement();
ALTER TABLE private.burimunsi_verified_inbox_recoveries ENABLE ALWAYS TRIGGER collect_fence_statement_v1;
CREATE TRIGGER retain_verified_inbox_recovery BEFORE UPDATE OR DELETE OR TRUNCATE ON private.burimunsi_verified_inbox_recoveries
 FOR EACH STATEMENT EXECUTE FUNCTION private._collect_fence_no_erasure();
ALTER TABLE private.burimunsi_verified_inbox_recoveries ENABLE ALWAYS TRIGGER retain_verified_inbox_recovery;
CREATE INDEX burimunsi_observation_group_body ON private.burimunsi_unresolved_observations(collection_id,body_sha256);

-- Only the signed-in phone page can open a recovery. It supplies the same
-- content witness that verified the encrypted bytes and the final journal.
CREATE FUNCTION private._burimunsi_reconcile_held_payment_page(p_run uuid,p_items jsonb,ctx jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE
  candidate record; previous record;
  receipt_frame text:=current_setting('burimunsi.native_receipt_frame',true);
BEGIN
  PERFORM set_config('burimunsi.native_receipt_frame','1',true);
  FOR candidate IN
    SELECT o.*,q.source_key_content_sha256
    FROM jsonb_array_elements(p_items) input
    JOIN private.burimunsi_held_observation_sources h ON h.source_id=input->>'sourceId'
    JOIN private.burimunsi_unresolved_observations o ON o.source_id=h.source_id
    JOIN private.burimunsi_observation_requests q ON q.source_id=o.source_id
    JOIN private.burimunsi_observation_consents consent ON consent.collection_id=o.collection_id AND consent.account_id=o.account_id
      AND consent.installation_id=o.installation_id AND consent.grant_id=o.grant_id AND consent.grant_version=o.grant_version
      AND consent.enabled AND consent.generation=o.consent_generation
    JOIN private.burimunsi_inbox_checks c ON c.collection_id=o.collection_id AND c.installation_id=o.installation_id
    JOIN private.burimunsi_inbox_check_items i ON i.collection_id=c.collection_id AND i.installation_id=c.installation_id AND i.source_id=o.source_id
    WHERE c.run_id=p_run AND c.state='checking'
      AND (o.collection_id,o.account_id,o.principal_user_id,o.installation_id,o.grant_id,o.grant_version,o.consent_generation,o.profile_tuple_sha256)
        =(ctx->>'collectionId',(ctx->>'accountId')::uuid,ctx->>'principalUserId',(ctx->>'installationId')::uuid,
          (ctx->>'grantId')::uuid,(ctx->>'grantVersion')::bigint,(ctx->>'consentGeneration')::bigint,ctx->>'profile_tuple_sha256')
      AND (q.collection_id,q.account_id,q.principal_user_id,q.installation_id,q.grant_id,q.grant_version,q.initial_consent_generation,
           q.initial_profile_tuple_sha256,q.request_id,q.fingerprint,q.source_key_body_sha256)
        =(o.collection_id,o.account_id,o.principal_user_id,o.installation_id,o.grant_id,o.grant_version,o.consent_generation,
          o.profile_tuple_sha256,o.request_id,o.fingerprint,o.body_sha256)
      AND q.source_key=i.source_key AND i.source_key=input->>'key' AND i.body_sha256=o.body_sha256
      AND q.source_key_content_sha256=input->>'verifiedContentSha256'
      AND NOT private.collect_imported_native_source(o.source_id)
      AND NOT private.collect_imported_native_job_transaction(o.source_id)
      AND NOT EXISTS(SELECT FROM private.burimunsi_auto_sms_jobs j WHERE j.source_id=o.source_id)
      AND NOT EXISTS(SELECT FROM private.burimunsi_verified_inbox_recoveries v WHERE v.source_id=o.source_id)
      AND private.burimunsi_observation_storage_matches(o.object_key,
        jsonb_build_object('ownerId',o.principal_user_id,'purpose','sms_receipt','entityId',o.source_id),o.object_sha256)
  LOOP
    -- An earlier source with the same body can be adopted only when the
    -- original sender, phone and carrier times, subscription, wallet, profile,
    -- retained source and successful parse all agree on a single payment.
    WITH earlier AS MATERIALIZED (
      SELECT o.source_id,p.id AS payment_id,
        q.source_key_content_sha256=candidate.source_key_content_sha256
        AND o.profile_sha256=candidate.profile_sha256
        AND p.id IS NOT NULL AND j.state='completed' AND j.relation IN ('accepted','duplicate')
        AND NOT EXISTS(SELECT FROM private.burimunsi_held_observation_sources h WHERE h.source_id=o.source_id)
        AND private._burimunsi_inbox_outcome(o.source_id,o.collection_id) IN ('parsed','duplicate') AS proven
      FROM private.burimunsi_unresolved_observations o
      LEFT JOIN private.burimunsi_observation_requests q USING(source_id)
      LEFT JOIN private.burimunsi_auto_sms_jobs j ON j.source_id=o.source_id AND j.collection_id=o.collection_id
      LEFT JOIN burimunsi.payments p ON p.id=coalesce(j.payment_id,j.transaction_id)
        AND p.collection_id=o.collection_id AND p.receiving_account_id=j.receiving_account_id
      WHERE o.collection_id=candidate.collection_id AND o.body_sha256=candidate.body_sha256 AND o.source_id<>candidate.source_id
        AND (j.source_id IS NOT NULL OR NOT EXISTS(SELECT FROM private.burimunsi_held_observation_sources h WHERE h.source_id=o.source_id))
    )
    SELECT count(*) AS sources,count(*) FILTER(WHERE proven) AS verified,count(DISTINCT payment_id) AS payments,
      min(source_id) AS source_id,min(payment_id) AS payment_id INTO previous FROM earlier;
    IF previous.sources>0 AND (previous.verified<>previous.sources OR previous.payments<>1) THEN CONTINUE; END IF;
    -- A reserved original that never reached a definitive Storage commit
    -- cannot be recovered through a different request or installation.
    IF EXISTS(SELECT FROM private.burimunsi_observation_requests q
      WHERE q.collection_id=candidate.collection_id AND q.source_key_body_sha256=candidate.body_sha256
        AND NOT EXISTS(SELECT FROM private.burimunsi_unresolved_observations o WHERE o.source_id=q.source_id))
    THEN CONTINUE; END IF;
    -- An archived parse lacking its source chain still blocks automatic replay.
    IF EXISTS(SELECT FROM app.momo_parse_attempts a WHERE a.source_body_sha256=candidate.body_sha256
      AND NOT EXISTS(SELECT FROM private.burimunsi_unresolved_observations o WHERE o.source_id=a.raw_sms_id
        AND o.collection_id=candidate.collection_id AND o.body_sha256=candidate.body_sha256 AND o.source_id<>candidate.source_id))
    THEN CONTINUE; END IF;
    INSERT INTO private.burimunsi_verified_inbox_recoveries
      (source_id,run_id,request_id,content_sha256,object_sha256,prior_source_id,prior_payment_id)
    VALUES(candidate.source_id,p_run,candidate.request_id,candidate.source_key_content_sha256,candidate.object_sha256,previous.source_id,previous.payment_id)
    ON CONFLICT(source_id) DO NOTHING;
  END LOOP;
  PERFORM set_config('burimunsi.native_receipt_frame',coalesce(receipt_frame,''),true);
END;
$fn$;
REVOKE ALL ON FUNCTION private._burimunsi_reconcile_held_payment_page(uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;

-- Recheck the stored evidence at every status read, worker claim and commit.
CREATE FUNCTION private._burimunsi_verified_held_mode(p_source text,p_group text)
RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE w record;
BEGIN
  SELECT v.*,o.body_sha256,o.profile_sha256 INTO w FROM private.burimunsi_verified_inbox_recoveries v
  JOIN private.burimunsi_unresolved_observations o ON o.source_id=v.source_id AND o.collection_id=p_group
  JOIN private.burimunsi_observation_requests q ON q.source_id=o.source_id AND q.request_id=v.request_id
    AND q.fingerprint=o.fingerprint AND q.source_key_content_sha256=v.content_sha256 AND q.source_key_body_sha256=o.body_sha256
  JOIN private.burimunsi_observation_consents c ON c.collection_id=o.collection_id AND c.account_id=o.account_id
    AND c.installation_id=o.installation_id AND c.grant_id=o.grant_id AND c.grant_version=o.grant_version
    AND c.enabled AND c.generation=o.consent_generation
  WHERE v.source_id=p_source AND v.object_sha256=o.object_sha256 AND o.request_id=v.request_id
    AND NOT private.collect_imported_native_source(o.source_id) AND NOT private.collect_imported_native_job_transaction(o.source_id)
    AND private.burimunsi_observation_storage_matches(o.object_key,
      jsonb_build_object('ownerId',o.principal_user_id,'purpose','sms_receipt','entityId',o.source_id),o.object_sha256);
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF w.prior_source_id IS NULL THEN RETURN 'parse'; END IF;
  IF EXISTS(SELECT FROM private.burimunsi_unresolved_observations o
    JOIN private.burimunsi_observation_requests q USING(source_id)
    JOIN private.burimunsi_auto_sms_jobs j ON j.source_id=o.source_id AND j.collection_id=o.collection_id
    JOIN burimunsi.payments p ON p.id=w.prior_payment_id AND p.id=coalesce(j.payment_id,j.transaction_id)
      AND p.collection_id=o.collection_id AND p.receiving_account_id=j.receiving_account_id
    WHERE o.source_id=w.prior_source_id AND o.collection_id=p_group AND o.body_sha256=w.body_sha256 AND o.profile_sha256=w.profile_sha256
      AND q.source_key_content_sha256=w.content_sha256 AND j.state='completed' AND j.relation IN ('accepted','duplicate')
      AND NOT EXISTS(SELECT FROM private.burimunsi_held_observation_sources h WHERE h.source_id=o.source_id))
  THEN
    IF private._burimunsi_inbox_outcome(w.prior_source_id,p_group) IN ('parsed','duplicate') THEN RETURN 'duplicate'; END IF;
  END IF;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION private._burimunsi_verified_held_mode(text,text) FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;

DO $upgrade$
DECLARE change record; body text; definition text;
BEGIN
  FOR change IN SELECT * FROM (VALUES
    ('private.burimunsi_observation_inbox_page(uuid,jsonb)',
      ' UPDATE private.burimunsi_inbox_checks SET page_items=active.page_items',
      $new$ IF EXISTS(SELECT FROM jsonb_array_elements(p_items) i WHERE i?'verifiedContentSha256') THEN
  PERFORM private._burimunsi_reconcile_held_payment_page(p_run,p_items,ctx);
 END IF;
 UPDATE private.burimunsi_inbox_checks SET page_items=active.page_items$new$),
    ('private._burimunsi_observation_automatable(text)',
      'AND NOT EXISTS(SELECT 1 FROM private.burimunsi_held_observation_sources h WHERE h.source_id=o.source_id)',
      $new$AND CASE WHEN NOT EXISTS(SELECT 1 FROM private.burimunsi_held_observation_sources h WHERE h.source_id=o.source_id) THEN true
    WHEN private._burimunsi_verified_held_mode(o.source_id,o.collection_id)='parse' THEN
     (private._collect_fence_admission(nullif(current_setting('collect.fence_admission_id',true),'')::uuid,
      nullif(current_setting('collect.fence_epoch',true),'')::bigint,current_setting('collect.fence_source_sha256',true))).kind='jobs'
    ELSE false END$new$),
    ('private._burimunsi_inbox_outcome(text,text)',
      'WHEN hold.source_id IS NOT NULL THEN ''needs_review''',
      $new$WHEN hold.source_id IS NOT NULL AND verified.mode IS DISTINCT FROM 'parse'
   THEN CASE WHEN verified.mode='duplicate' THEN 'duplicate' ELSE 'needs_review' END$new$),
    ('private._burimunsi_inbox_outcome(text,text)',
      ' LEFT JOIN private.collect_imported_native_history h ON h.source_id=r.source_id',
      $new$ LEFT JOIN LATERAL (SELECT private._burimunsi_verified_held_mode(r.source_id,r.collection_id) AS mode
    WHERE hold.source_id IS NOT NULL OFFSET 0) verified ON true
 LEFT JOIN private.collect_imported_native_history h ON h.source_id=r.source_id$new$),
    ('private.burimunsi_observation_processing_status(jsonb)',
      $old$IF private.collect_imported_native_source(source) THEN
     status:=coalesce(private._burimunsi_inbox_outcome(source,a->>'collectionId'),'historical');$old$,
      $new$status:=private._burimunsi_inbox_outcome(source,a->>'collectionId');
    IF private.collect_imported_native_source(source) THEN status:=coalesce(status,'historical');$new$),
    ('private.burimunsi_observation_processing_status(jsonb)',
      $old$ELSIF private._burimunsi_inbox_outcome(source,a->>'collectionId')='needs_review' THEN status:='needs_review';$old$,
      $new$ELSIF status IN ('needs_review','duplicate') THEN NULL;$new$),
    ('private.burimunsi_admin_payment_observation_outcomes(text,text[],boolean)',
      'DECLARE base jsonb;', 'DECLARE previous_inbox text:=current_setting(''burimunsi.inbox_frame'',true);base jsonb;'),
    ('private.burimunsi_admin_payment_observation_outcomes(text,text[],boolean)',
      $old$PERFORM set_config('burimunsi.collection_id',p_collection,true),set_config('burimunsi.native_receipt_frame','1',true);$old$,
      $new$PERFORM set_config('burimunsi.inbox_frame','1',true),set_config('burimunsi.collection_id',p_collection,true),set_config('burimunsi.native_receipt_frame','1',true);$new$),
    ('private.burimunsi_admin_payment_observation_outcomes(text,text[],boolean)',
      '  LEFT JOIN private.burimunsi_allocation_receipts r ON r.collection_id=p_collection AND r.payment_id=coalesce(j.payment_id,j.transaction_id)',
      $new$  LEFT JOIN private.burimunsi_verified_inbox_recoveries v ON v.source_id=i.item->>'sourceId'
    AND i.item->>'processing'='duplicate' AND v.prior_source_id IS NOT NULL
  LEFT JOIN private.burimunsi_allocation_receipts r ON r.collection_id=p_collection AND r.payment_id=coalesce(j.payment_id,j.transaction_id,v.prior_payment_id)$new$),
    ('private.burimunsi_admin_payment_observation_outcomes(text,text[],boolean)',
      $old$PERFORM set_config('burimunsi.collection_id',coalesce(previous_group,''),true),
    set_config('burimunsi.native_receipt_frame',coalesce(previous_frame,''),true);$old$,
      $new$PERFORM set_config('burimunsi.inbox_frame',coalesce(previous_inbox,''),true),set_config('burimunsi.collection_id',coalesce(previous_group,''),true),set_config('burimunsi.native_receipt_frame',coalesce(previous_frame,''),true);$new$),
    ('private._burimunsi_wake_sms_worker()',
      '''private.burimunsi_allocation_receipts''::regclass)',
      '''private.burimunsi_allocation_receipts''::regclass,''private.burimunsi_verified_inbox_recoveries''::regclass)')
  ) changes(signature,anchor,replacement) LOOP
    SELECT prosrc,pg_get_functiondef(oid) INTO STRICT body,definition FROM pg_proc
      WHERE oid=to_regprocedure(change.signature) AND proowner='postgres'::regrole AND prosecdef;
    IF length(body)-length(replace(body,change.anchor,''))<>length(change.anchor) THEN
      RAISE EXCEPTION 'verified_inbox_predecessor_changed: %',change.signature USING ERRCODE='55000';
    END IF;
    EXECUTE replace(definition,body,replace(body,change.anchor,change.replacement));
  END LOOP;
END;
$upgrade$;
CREATE CONSTRAINT TRIGGER burimunsi_wake_verified_inbox AFTER INSERT ON private.burimunsi_verified_inbox_recoveries
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.prior_source_id IS NULL)
 EXECUTE FUNCTION private._burimunsi_wake_sms_worker();
-- A signed invocation parses one source. A burst coalesces its first signal
-- into one operation. Finishing an item wakes the worker for remaining items.
CREATE CONSTRAINT TRIGGER burimunsi_wake_next_inbox_item AFTER UPDATE ON private.burimunsi_auto_sms_jobs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.phase IS DISTINCT FROM NEW.phase AND NEW.phase='finished')
 EXECUTE FUNCTION private._burimunsi_wake_sms_worker();
COMMIT;
