-- Handset inbox reconciliation. Its short-lived page journal stores opaque
-- device keys and verified source identities. The existing ledger is the only
-- financial writer. A held recovery is durable before any Storage upload.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';
DO $preflight$
BEGIN
 PERFORM private._collect_fence_require_operator();
 IF NOT EXISTS(SELECT 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced') THEN
  RAISE EXCEPTION 'inbox_migration_fence_required' USING ERRCODE='55000';
 END IF;
END;$preflight$;

CREATE TABLE private.burimunsi_held_observation_sources(
 source_id text PRIMARY KEY REFERENCES private.burimunsi_observation_requests(source_id)
);
CREATE TABLE private.burimunsi_inbox_checks(
 collection_id text NOT NULL REFERENCES private.burimunsi_scopes(collection_id), installation_id uuid NOT NULL,
 account_id uuid NOT NULL, grant_id uuid NOT NULL, grant_version bigint NOT NULL CHECK(grant_version>0),
 consent_generation bigint NOT NULL CHECK(consent_generation>0), profile_tuple text NOT NULL CHECK(profile_tuple ~ '^[a-f0-9]{64}$'),
 run_id uuid NOT NULL, page_items integer NOT NULL DEFAULT 0 CHECK(page_items BETWEEN 0 AND 100000),
 state text NOT NULL CHECK(state IN('checking','incomplete','verified')),
 checked_at bigint NOT NULL, report jsonb NOT NULL, PRIMARY KEY(collection_id,installation_id),
 FOREIGN KEY(account_id,collection_id) REFERENCES private.burimunsi_accounts(id,collection_id),
 FOREIGN KEY(grant_id,collection_id) REFERENCES private.burimunsi_device_grants(id,collection_id)
);
CREATE TABLE private.burimunsi_inbox_check_items(
 collection_id text NOT NULL, installation_id uuid NOT NULL,
 source_key text NOT NULL CHECK(source_key ~ '^[a-f0-9]{64}$'),
 source_id text,
 body_sha256 text NOT NULL CHECK(body_sha256 ~ '^[a-f0-9]{64}$'), phone_at timestamptz NOT NULL,
 scan_order integer NOT NULL CHECK(scan_order BETWEEN 1 AND 100000),
 PRIMARY KEY(collection_id,installation_id,source_key),
 UNIQUE(collection_id,installation_id,source_id),
 FOREIGN KEY(collection_id,installation_id) REFERENCES private.burimunsi_inbox_checks(collection_id,installation_id)
);
DO $policies$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['burimunsi_held_observation_sources','burimunsi_inbox_checks','burimunsi_inbox_check_items'] LOOP
  EXECUTE format('ALTER TABLE private.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE private.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON private.%I FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime',t);
  EXECUTE format('CREATE POLICY inbox_owner_frame ON private.%I TO postgres
   USING(current_setting(''role'',true)=''collect_runtime'' AND current_setting(''collect.edge_verified'',true)=''true'' AND current_setting(''burimunsi.inbox_frame'',true)=''1'')
   WITH CHECK(current_setting(''role'',true)=''collect_runtime'' AND current_setting(''collect.edge_verified'',true)=''true'' AND current_setting(''burimunsi.inbox_frame'',true)=''1'')',t);
  EXECUTE format('CREATE TRIGGER collect_fence_statement_v1 BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON private.%I FOR EACH STATEMENT EXECUTE FUNCTION private._collect_fence_statement()',t);
  EXECUTE format('ALTER TABLE private.%I ENABLE ALWAYS TRIGGER collect_fence_statement_v1',t);
 END LOOP;
END;$policies$;
CREATE TRIGGER held_source_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON private.burimunsi_held_observation_sources
 FOR EACH STATEMENT EXECUTE FUNCTION private._collect_fence_no_erasure();
ALTER TABLE private.burimunsi_held_observation_sources ENABLE ALWAYS TRIGGER held_source_retained;

CREATE FUNCTION private.burimunsi_observation_held_matches(
 p_key text,p_request uuid,p_fingerprint text,p_body text,p_generation bigint
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE ctx jsonb:=private.burimunsi_observation_context();
 final_value boolean;
 prior_inbox text:=current_setting('burimunsi.inbox_frame',true);
 prior_observation text:=current_setting('burimunsi.observation_frame',true);
BEGIN
 PERFORM set_config('burimunsi.inbox_frame','1',true);
 PERFORM set_config('burimunsi.observation_frame','1',true);
 IF (ctx->>'consentGeneration')::bigint IS DISTINCT FROM p_generation THEN
  RAISE EXCEPTION 'burimunsi_observation_consent_changed' USING ERRCODE='42501';END IF;
 final_value:=EXISTS(SELECT 1 FROM private.burimunsi_held_observation_sources h
  JOIN private.burimunsi_observation_requests q ON q.source_id=h.source_id
  WHERE q.collection_id=ctx->>'collectionId' AND q.account_id=(ctx->>'accountId')::uuid
   AND q.principal_user_id=ctx->>'principalUserId' AND q.installation_id=(ctx->>'installationId')::uuid
   AND q.grant_id=(ctx->>'grantId')::uuid AND q.grant_version=(ctx->>'grantVersion')::bigint
   AND q.initial_profile_tuple_sha256=ctx->>'profile_tuple_sha256'
   AND q.initial_consent_generation=p_generation AND q.request_id=p_request AND q.fingerprint=p_fingerprint
   AND q.source_key=p_key AND q.source_key_body_sha256=p_body);
 PERFORM set_config('burimunsi.inbox_frame',coalesce(prior_inbox,''),true);
 PERFORM set_config('burimunsi.observation_frame',coalesce(prior_observation,''),true);
 RETURN final_value;
END;$fn$;

CREATE FUNCTION private.burimunsi_observation_held_prepare(p_key text,p_content text,p_body text,p_request uuid,
 p_fingerprint text,p_source text,p_profile_version text,p_profile_sha text,p_generation bigint)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE ctx jsonb:=private.burimunsi_observation_context();candidate jsonb;
 final_value jsonb;
 prior_inbox text:=current_setting('burimunsi.inbox_frame',true);
 prior_observation text:=current_setting('burimunsi.observation_frame',true);
BEGIN
 PERFORM set_config('burimunsi.inbox_frame','1',true);
 PERFORM set_config('burimunsi.observation_frame','1',true);
 PERFORM private.burimunsi_setup_fence();
 IF (ctx->>'consentGeneration')::bigint IS DISTINCT FROM p_generation THEN
  RAISE EXCEPTION 'burimunsi_observation_consent_changed' USING ERRCODE='42501';END IF;
 -- Same lock as ordinary source admission. An already-admitted ordinary
 -- receipt can never be relabelled as held or used to acknowledge a new key.
 PERFORM pg_advisory_xact_lock(hashtextextended((ctx->>'collectionId')||':'||p_key,7346371));
 IF EXISTS(SELECT 1 FROM private.burimunsi_observation_requests q WHERE q.collection_id=ctx->>'collectionId' AND q.source_key=p_key)
  AND NOT private.burimunsi_observation_held_matches(p_key,p_request,p_fingerprint,p_body,p_generation) THEN
  RAISE EXCEPTION 'burimunsi_held_identity_conflict' USING ERRCODE='23505';END IF;
 candidate:=private.burimunsi_observation_key_prepare(p_key,p_content,p_body,p_request,p_fingerprint,p_source,p_profile_version,p_profile_sha,p_generation);
 IF candidate->>'kind' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'burimunsi_held_identity_conflict' USING ERRCODE='23505';END IF;
 INSERT INTO private.burimunsi_held_observation_sources VALUES(p_source) ON CONFLICT DO NOTHING;
 final_value:=candidate;
 PERFORM set_config('burimunsi.inbox_frame',coalesce(prior_inbox,''),true);
 PERFORM set_config('burimunsi.observation_frame',coalesce(prior_observation,''),true);
 RETURN final_value;
END;$fn$;

-- Checked by the jobs selector AND the authoritative per-source worker path.
-- A later opt-in cannot revive automatic financial processing under a prior
-- consent generation. New live/catch-up receipts still use canonical posting.
CREATE FUNCTION private._burimunsi_observation_automatable(p_source text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE
 final_value boolean;
 prior_inbox text:=current_setting('burimunsi.inbox_frame',true);
 prior_observation text:=current_setting('burimunsi.observation_frame',true);
BEGIN
 PERFORM set_config('burimunsi.inbox_frame','1',true);
 PERFORM set_config('burimunsi.observation_frame','1',true);
 final_value:=EXISTS(SELECT 1 FROM private.burimunsi_unresolved_observations o
  JOIN private.burimunsi_observation_consents c ON c.collection_id=o.collection_id AND c.account_id=o.account_id
   AND c.installation_id=o.installation_id AND c.grant_id=o.grant_id AND c.grant_version=o.grant_version
   AND c.enabled AND c.generation=o.consent_generation
  WHERE o.source_id=p_source AND NOT EXISTS(SELECT 1 FROM private.burimunsi_held_observation_sources h WHERE h.source_id=o.source_id));
 PERFORM set_config('burimunsi.inbox_frame',coalesce(prior_inbox,''),true);
 PERFORM set_config('burimunsi.observation_frame',coalesce(prior_observation,''),true);
 RETURN final_value;
END;$fn$;

-- The paired gateway owns these receipts. Read its existing envelope, source
-- binding and parser outcome without creating a second financial source.
CREATE FUNCTION private._burimunsi_inbox_gateway(p_group text,p_source text,p_envelope uuid)
 RETURNS TABLE(source_id text,envelope text,owner_id text,object_key text,object_sha text,size_bytes bigint,
  body_sha text,fingerprint text,binding text,binding_version bigint,installation uuid,account_id uuid,
  grant_id uuid,grant_version bigint,subscription bigint,created_ms bigint,outcome text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
 SELECT r.id,r.client_envelope_id,r.owner_user_id,r.object_key,r.object_sha256,r.size_bytes,r.body_sha256,cap.identity_sha256,
  x.binding_id,x.binding_version,x.installation_id,x.custodian_account_id,x.grant_id,x.grant_version,cap.subscription_id,
  floor(extract(epoch FROM x.associated_at)*1000)::bigint,
  CASE WHEN j.state IN('needs_review','source_unresolved') THEN 'needs_review'
    WHEN j.state='retry' THEN 'retrying' WHEN j.state IN('pending','processing') THEN 'pending'
    WHEN j.state='completed' AND j.last_error IS NULL AND pa.outcome='non_payment' THEN 'parsed'
    WHEN j.state='completed' AND j.last_error IS NULL AND pa.outcome IN('accepted','duplicate','conflict')
     AND EXISTS(SELECT 1 FROM app.momo_transaction_sources ts JOIN app.momo_transactions t ON t.id=ts.transaction_id
      WHERE ts.raw_sms_id=r.id AND ts.parse_attempt_id=pa.id AND ts.relation=pa.outcome AND t.receiving_account_id=x.receiving_account_id)
      THEN CASE pa.outcome WHEN 'accepted' THEN 'parsed' ELSE pa.outcome END ELSE 'unknown' END
 FROM private.burimunsi_sms_source_scopes x JOIN private.burimunsi_scopes s ON s.collection_id=x.collection_id
 JOIN app.sms_receipts r ON r.id=x.source_id AND r.body_sha256=x.source_body_sha256 AND r.object_sha256=x.object_sha256
  AND r.owner_user_id=x.owner_user_id AND r.object_key='sms/'||x.source_id
 JOIN app.momo_gateway_captures cap ON cap.raw_sms_id=r.id AND cap.credential_id=x.credential_id
 JOIN app.momo_gateway_credentials k ON k.id=cap.credential_id AND k.binding_id=x.binding_id AND k.installation_id=x.installation_id::text
 JOIN app.momo_gateway_bindings b ON b.id=k.binding_id AND b.receiving_account_id=x.receiving_account_id AND b.version=x.binding_version
 LEFT JOIN app.momo_processing_jobs j ON j.raw_sms_id=r.id AND j.binding_id=x.binding_id AND j.binding_version=x.binding_version
  AND j.receiving_account_id=x.receiving_account_id
 LEFT JOIN LATERAL (SELECT a.id,a.outcome FROM app.momo_parse_attempts a WHERE a.raw_sms_id=r.id AND a.source_body_sha256=r.body_sha256
  ORDER BY a.attempt_number DESC LIMIT 1) pa ON true
 WHERE x.collection_id=p_group AND x.provenance='gateway_capture' AND x.proof_id=x.source_id AND s.receiving_account_id=x.receiving_account_id
  AND (p_source IS NULL OR r.id=p_source) AND (p_envelope IS NULL OR r.client_envelope_id=p_envelope::text)
  AND EXISTS(SELECT 1 FROM private.storage_put_intents i JOIN private.storage_objects saved ON saved.object_key=i.object_key
   AND saved.operation_id=i.operation_id AND saved.sha256=i.sha256 AND saved.size=i.size AND saved.scope=i.scope
   AND saved.http_metadata=i.http_metadata AND saved.custom_metadata=i.custom_metadata
   WHERE i.object_key=r.object_key AND i.state='committed' AND i.active_attempt IS NULL AND NOT i.upload_unresolved AND NOT i.delete_tombstone
    AND i.scope=jsonb_build_object('ownerId',r.owner_user_id,'purpose','sms_receipt','entityId',r.id)
    AND saved.custom_metadata->>'sha256'=r.object_sha256
    AND NOT EXISTS(SELECT 1 FROM private.storage_delete_intents d WHERE d.object_key=i.object_key))
$fn$;

CREATE FUNCTION private.burimunsi_observation_gateway_lookup(p_envelope uuid,p_body text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE ctx jsonb:=private.burimunsi_observation_context();g record;
BEGIN
 PERFORM private.burimunsi_observation_actor(true);
 SELECT * INTO g FROM private._burimunsi_inbox_gateway(ctx->>'collectionId',NULL,p_envelope) x
  WHERE x.owner_id=ctx->>'principalUserId' AND x.installation=(ctx->>'installationId')::uuid
   AND x.account_id=(ctx->>'accountId')::uuid AND x.grant_id=(ctx->>'grantId')::uuid AND x.grant_version=(ctx->>'grantVersion')::bigint;
 IF NOT FOUND THEN
  -- An admitted envelope with missing/changed scope or Storage is uncertain.
  IF EXISTS(SELECT 1 FROM app.sms_receipts r WHERE r.owner_user_id=ctx->>'principalUserId' AND r.client_envelope_id=p_envelope::text) THEN
   RAISE EXCEPTION 'burimunsi_observation_storage_changed' USING ERRCODE='55000';END IF;
  RETURN NULL;
 END IF;
 IF g.body_sha IS DISTINCT FROM p_body THEN RAISE EXCEPTION 'burimunsi_observation_source_conflict' USING ERRCODE='23505';END IF;
 RETURN jsonb_build_object('sourceId',g.source_id,'id',g.source_id,'requestId',g.envelope,'gatewayEnvelopeId',g.envelope,
  'gatewayBindingId',g.binding,'gatewayBindingVersion',g.binding_version,'subscriptionId',g.subscription,
  'bodySha256',g.body_sha,'object_key',g.object_key,'object_sha256',g.object_sha,'size_bytes',g.size_bytes,'createdAt',g.created_ms,
  'principalUserId',g.owner_id,'sessionId',ctx->>'sessionId','consentGeneration',ctx->'consentGeneration','fingerprint',g.fingerprint);
END;$fn$;

-- A read of an immutable import can establish an earlier successful parse only
-- when its own source, wallet, request, fingerprint, transaction and job agree.
-- Imported evidence remains denied to every automatic writer.
CREATE FUNCTION private._burimunsi_inbox_outcome(p_source text,p_group text)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE
 final_value text;
 prior_inbox text:=current_setting('burimunsi.inbox_frame',true);
 prior_observation text:=current_setting('burimunsi.observation_frame',true);
 prior_native_receipt text:=current_setting('burimunsi.native_receipt_frame',true);
BEGIN
 PERFORM set_config('burimunsi.inbox_frame','1',true);
 PERFORM set_config('burimunsi.observation_frame','1',true);
 PERFORM set_config('burimunsi.native_receipt_frame','1',true);
 final_value:=coalesce((SELECT CASE WHEN hold.source_id IS NOT NULL THEN 'needs_review'
  WHEN h.source_id IS NOT NULL AND (j.source_id IS NULL OR h.request_id<>r.request_id OR h.body_sha256<>r.body_sha256
   OR h.object_sha256<>r.object_sha256 OR h.source_fingerprint<>r.fingerprint OR h.transaction_id IS DISTINCT FROM j.transaction_id) THEN 'historical'
  WHEN j.state='security_message' THEN 'security'
  WHEN j.state='completed' AND j.relation IN('accepted','duplicate') AND j.facts_sha256 IS NOT NULL
   AND j.posting_last_error IS NULL AND EXISTS(
    SELECT 1 FROM app.momo_parse_attempts pa JOIN app.momo_transaction_sources ts
     ON ts.raw_sms_id=r.source_id AND ts.transaction_id=j.transaction_id AND ts.parse_attempt_id=pa.id AND ts.relation=j.relation
    JOIN app.momo_transactions t ON t.id=ts.transaction_id AND t.receiving_account_id=s.receiving_account_id
    JOIN private.burimunsi_transaction_scopes scope ON scope.transaction_id=t.id AND scope.collection_id=r.collection_id
    WHERE pa.raw_sms_id=r.source_id AND pa.source_body_sha256=r.body_sha256 AND pa.outcome=j.relation AND pa.id=j.attempt_id::text)
   THEN CASE WHEN j.relation='duplicate' THEN 'duplicate' ELSE 'parsed' END
  WHEN h.source_id IS NOT NULL THEN 'historical' ELSE 'unknown' END
 FROM private.burimunsi_unresolved_observations r
 JOIN private.burimunsi_scopes s ON s.collection_id=r.collection_id
 LEFT JOIN private.burimunsi_held_observation_sources hold ON hold.source_id=r.source_id
 LEFT JOIN private.collect_imported_native_history h ON h.source_id=r.source_id AND h.collection_id=r.collection_id
 LEFT JOIN private.burimunsi_auto_sms_jobs j ON j.source_id=r.source_id AND j.collection_id=r.collection_id
  AND j.receiving_account_id=s.receiving_account_id AND j.source_fingerprint=r.fingerprint AND j.profile_sha256=r.profile_sha256
 WHERE r.source_id=p_source AND r.collection_id=p_group),
 (SELECT g.outcome FROM private._burimunsi_inbox_gateway(p_group,p_source,NULL) g WHERE g.source_id=p_source));
 PERFORM set_config('burimunsi.inbox_frame',coalesce(prior_inbox,''),true);
 PERFORM set_config('burimunsi.observation_frame',coalesce(prior_observation,''),true);
 PERFORM set_config('burimunsi.native_receipt_frame',coalesce(prior_native_receipt,''),true);
 RETURN final_value;
END;$fn$;

DO $guards$
DECLARE item record;oldbody text;definition text;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('private.burimunsi_auto_snapshot(text)',
    ' IF private.collect_imported_native_source(p_source) OR private.collect_imported_native_job_transaction(p_source)',
    ' IF NOT private._burimunsi_observation_automatable(p_source) OR private.collect_imported_native_source(p_source) OR private.collect_imported_native_job_transaction(p_source)'),
  ('private.burimunsi_auto_candidates(text)',
    ' WHERE NOT private.collect_imported_native_source(o.source_id)',
    ' WHERE private._burimunsi_observation_automatable(o.source_id) AND NOT private.collect_imported_native_source(o.source_id)'),
  ('private.burimunsi_observation_processing_status(jsonb)',
    ' old_frame text:=current_setting(''burimunsi.native_receipt_frame'',true);',
    ' old_observation text:=current_setting(''burimunsi.observation_frame'',true);old_frame text:=current_setting(''burimunsi.native_receipt_frame'',true);'),
  ('private.burimunsi_observation_processing_status(jsonb)',
    ' a:=private.burimunsi_observation_actor(false);',
    ' a:=private.burimunsi_observation_actor(false);PERFORM set_config(''burimunsi.observation_frame'',''1'',true);'),
  ('private.burimunsi_observation_processing_status(jsonb)',
    ' RETURN jsonb_build_object(''groupId'',a->>''collectionId'',''statuses'',result);',
    ' PERFORM set_config(''burimunsi.observation_frame'',coalesce(old_observation,''''),true); RETURN jsonb_build_object(''groupId'',a->>''collectionId'',''statuses'',result);'),
  ('private.burimunsi_observation_processing_status(jsonb)',
    'EXCEPTION WHEN OTHERS THEN PERFORM set_config(''burimunsi.native_receipt_frame'',coalesce(old_frame,''''),true);RAISE;',
    'EXCEPTION WHEN OTHERS THEN PERFORM set_config(''burimunsi.observation_frame'',coalesce(old_observation,''''),true);PERFORM set_config(''burimunsi.native_receipt_frame'',coalesce(old_frame,''''),true);RAISE;'),
  ('private.burimunsi_observation_processing_status(jsonb)',
    '  IF owned THEN',
    $new$  IF NOT owned THEN
    PERFORM private.burimunsi_observation_context();
    SELECT x.outcome INTO status FROM private._burimunsi_inbox_gateway(a->>'collectionId',source,NULL) x
     WHERE x.owner_id=a->>'principalUserId' AND x.installation=(a->>'installationId')::uuid
      AND x.account_id=(a->>'accountId')::uuid AND x.grant_id=(a->>'grantId')::uuid AND x.grant_version=(a->>'grantVersion')::bigint;
    status:=coalesce(status,'unknown');
   END IF;
  IF owned THEN$new$),
  ('private.burimunsi_observation_processing_status(jsonb)',
    $old$IF private.collect_imported_native_source(source) THEN status:='historical';$old$,
    $new$IF private.collect_imported_native_source(source) THEN
     status:=coalesce(private._burimunsi_inbox_outcome(source,a->>'collectionId'),'historical');
    ELSIF private._burimunsi_inbox_outcome(source,a->>'collectionId')='needs_review' THEN status:='needs_review';$new$),
  ('private.burimunsi_observation_processing_status(jsonb)',
    $old$ELSIF j.state='completed' AND j.relation='duplicate' THEN status:='duplicate';$old$,
    $new$ELSIF j.state='completed' AND j.relation='duplicate' THEN status:=coalesce(private._burimunsi_inbox_outcome(source,a->>'collectionId'),'unknown');$new$),
  ('private.burimunsi_observation_processing_status(jsonb)',
    $old$ELSIF j.state='completed' THEN status:='parsed';END IF;$old$,
    $new$ELSIF j.state='completed' THEN status:=coalesce(private._burimunsi_inbox_outcome(source,a->>'collectionId'),'unknown');END IF;$new$)
 ) AS t(signature,anchor,replacement) LOOP
  SELECT p.prosrc,pg_get_functiondef(p.oid) INTO STRICT oldbody,definition FROM pg_proc p WHERE p.oid=to_regprocedure(item.signature);
  IF length(oldbody)-length(replace(oldbody,item.anchor,''))<>length(item.anchor)
   OR length(definition)-length(replace(definition,oldbody,''))<>length(oldbody) THEN
   RAISE EXCEPTION 'inbox_predecessor_changed: %',item.signature USING ERRCODE='55000';END IF;
  EXECUTE replace(definition,oldbody,replace(oldbody,item.anchor,item.replacement));
 END LOOP;
END;$guards$;
-- Use actual retained observation, gateway capture and worker lineage. The
-- durable source ID, rather than equal body text, identifies distinct receipts.
CREATE FUNCTION private.burimunsi_observation_reconcile_verified_status() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE base jsonb:=private.burimunsi_observation_reconcile_status();cid text:=base->>'groupId';
 extra text;unmatched boolean;n bigint;gateway_count integer;
 final_value jsonb;
 prior_observation text:=current_setting('burimunsi.observation_frame',true);
 prior_native_receipt text:=current_setting('burimunsi.native_receipt_frame',true);
 prior_inbox text:=current_setting('burimunsi.inbox_frame',true);
BEGIN
 PERFORM set_config('burimunsi.observation_frame','1',true);
 PERFORM set_config('burimunsi.native_receipt_frame','1',true);
 PERFORM set_config('burimunsi.inbox_frame','1',true);
 IF cid IS NULL OR cid IS DISTINCT FROM current_setting('burimunsi.collection_id',true) THEN
  RAISE EXCEPTION 'burimunsi_observation_denied' USING ERRCODE='42501';END IF;
 WITH gateway AS MATERIALIZED (SELECT * FROM private._burimunsi_inbox_gateway(cid,NULL,NULL)), evidence AS (
  SELECT o.source_id FROM private.burimunsi_native_receipt_origins o WHERE o.collection_id=cid
  UNION SELECT scoped.source_id FROM private.burimunsi_sms_source_scopes scoped WHERE scoped.collection_id=cid
  UNION SELECT h.source_id FROM private.collect_imported_native_history h WHERE h.collection_id=cid
  UNION SELECT j.source_id FROM private.burimunsi_auto_sms_jobs j WHERE j.collection_id=cid
  UNION SELECT cap.raw_sms_id FROM private.burimunsi_scopes s
   JOIN app.momo_gateway_bindings b ON b.id=s.active_binding_id AND b.receiving_account_id=s.receiving_account_id
   JOIN app.momo_gateway_credentials k ON k.binding_id=b.id JOIN app.momo_gateway_captures cap ON cap.credential_id=k.id
   WHERE s.collection_id=cid
  UNION SELECT ts.raw_sms_id FROM private.burimunsi_transaction_scopes scoped
   JOIN app.momo_transaction_sources ts ON ts.transaction_id=scoped.transaction_id WHERE scoped.collection_id=cid
 ), rows AS (
  SELECT e.source_id,r.source_id AS retained,s.id AS canonical,r.body_sha256,r.object_sha256,g.source_id AS gateway_id,g.outcome AS gateway_outcome,
   r.principal_user_id IS DISTINCT FROM s.owner_user_id OR (x.source_id IS NOT NULL AND
    ROW(x.owner_user_id,x.source_body_sha256,x.object_sha256) IS DISTINCT FROM ROW(r.principal_user_id,r.body_sha256,r.object_sha256)) AS changed_custody,
   s.body_sha256 AS canonical_body,s.object_sha256 AS canonical_object,s.object_key,
   j.state,j.relation,j.facts_sha256,j.transaction_id,j.posting_last_error,h.source_id AS held
  FROM evidence e LEFT JOIN private.burimunsi_unresolved_observations r ON r.source_id=e.source_id AND r.collection_id=cid
  LEFT JOIN app.sms_receipts s ON s.id=e.source_id LEFT JOIN private.burimunsi_auto_sms_jobs j ON j.source_id=e.source_id AND j.collection_id=cid
  LEFT JOIN private.burimunsi_held_observation_sources h ON h.source_id=e.source_id LEFT JOIN gateway g ON g.source_id=e.source_id
  LEFT JOIN private.burimunsi_sms_source_scopes x ON x.source_id=e.source_id AND x.collection_id=cid LIMIT 100001
 )
 SELECT count(*),count(*) FILTER(WHERE gateway_id IS NOT NULL AND retained IS NULL),
   coalesce(bool_or(gateway_id IS NULL AND (retained IS NULL OR canonical IS NULL OR changed_custody OR canonical_body IS DISTINCT FROM body_sha256
   OR canonical_object IS DISTINCT FROM object_sha256 OR object_key IS DISTINCT FROM 'sms/'||source_id)),false),
   encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(to_jsonb(rows)::text,'UTF8')),'hex'),'' ORDER BY source_id),''),'UTF8')),'hex')
 INTO n,gateway_count,unmatched,extra FROM rows;
 gateway_count:=gateway_count+(base->>'recordedCount')::integer;
 IF n>100000 OR gateway_count>100000 THEN RAISE EXCEPTION 'burimunsi_observation_snapshot_limit' USING ERRCODE='54000';END IF;
 final_value:=base||jsonb_build_object('hasUnmatchedCanonical',unmatched,'recordedCount',gateway_count,'hasRecorded',gateway_count>0,
  'revision',encode(sha256(convert_to((base->>'revision')||extra,'UTF8')),'hex'));
 PERFORM set_config('burimunsi.observation_frame',coalesce(prior_observation,''),true);
 PERFORM set_config('burimunsi.native_receipt_frame',coalesce(prior_native_receipt,''),true);
 PERFORM set_config('burimunsi.inbox_frame',coalesce(prior_inbox,''),true);
 RETURN final_value;
END;$fn$;

CREATE FUNCTION private.burimunsi_observation_inbox_page(p_run uuid,p_items jsonb) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE ctx jsonb:=private.burimunsi_observation_context();cid text:=ctx->>'collectionId';device uuid:=(ctx->>'installationId')::uuid;
 active private.burimunsi_inbox_checks%ROWTYPE;prior private.burimunsi_inbox_check_items%ROWTYPE;item jsonb;source text;received timestamptz;
 final_value boolean;
 prior_inbox text:=current_setting('burimunsi.inbox_frame',true);
 prior_observation text:=current_setting('burimunsi.observation_frame',true);
BEGIN
 PERFORM set_config('burimunsi.inbox_frame','1',true);
 PERFORM set_config('burimunsi.observation_frame','1',true);
 PERFORM private.burimunsi_setup_fence();
 IF p_run IS NULL OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 20
  OR (SELECT count(DISTINCT x->>'key') FROM jsonb_array_elements(p_items) x)<>jsonb_array_length(p_items) THEN
  RAISE EXCEPTION 'invalid_inbox_page' USING ERRCODE='22023';END IF;
 SELECT * INTO active FROM private.burimunsi_inbox_checks WHERE collection_id=cid AND installation_id=device FOR UPDATE;
 IF NOT FOUND OR active.run_id<>p_run OR active.state<>'checking' OR active.account_id<>(ctx->>'accountId')::uuid
  OR active.grant_id<>(ctx->>'grantId')::uuid OR active.grant_version<>(ctx->>'grantVersion')::bigint
  OR active.consent_generation<>(ctx->>'consentGeneration')::bigint OR active.profile_tuple<>ctx->>'profile_tuple_sha256' THEN
  RAISE EXCEPTION 'inbox_check_changed' USING ERRCODE='40001';END IF;
 FOR item IN SELECT jsonb_array_elements(p_items) LOOP
  source:=item->>'sourceId';received:=(item->>'inboxReceivedAt')::timestamptz;
  IF coalesce(item->>'key','') !~ '^[a-f0-9]{64}$' OR coalesce(item->>'bodySha256','') !~ '^[a-f0-9]{64}$'
   OR received IS NULL OR NOT isfinite(received) OR NOT item?'sourceId' THEN
   RAISE EXCEPTION 'invalid_inbox_page' USING ERRCODE='22023';END IF;
  IF source IS NOT NULL AND NOT EXISTS(SELECT 1 FROM private.burimunsi_unresolved_observations r
   WHERE r.source_id=source AND r.collection_id=cid AND r.body_sha256=item->>'bodySha256') AND NOT EXISTS(
   SELECT 1 FROM private._burimunsi_inbox_gateway(cid,source,NULL) g WHERE g.body_sha=item->>'bodySha256'
    AND g.installation=device AND g.account_id=active.account_id AND g.grant_id=active.grant_id AND g.grant_version=active.grant_version) THEN
   RAISE EXCEPTION 'inbox_source_changed' USING ERRCODE='40001';END IF;
  SELECT * INTO prior FROM private.burimunsi_inbox_check_items WHERE collection_id=cid AND installation_id=device AND source_key=item->>'key';
  IF FOUND THEN
   IF ROW(prior.source_id,prior.body_sha256,prior.phone_at) IS DISTINCT FROM ROW(source,item->>'bodySha256',received) THEN
    RAISE EXCEPTION 'inbox_source_changed' USING ERRCODE='40001';END IF;
  ELSE
   active.page_items:=active.page_items+1;
   IF active.page_items>100000 THEN RAISE EXCEPTION 'inbox_check_limit' USING ERRCODE='54000';END IF;
   INSERT INTO private.burimunsi_inbox_check_items(collection_id,installation_id,source_key,source_id,body_sha256,phone_at,scan_order)
    VALUES(cid,device,item->>'key',source,item->>'bodySha256',received,active.page_items);
  END IF;
 END LOOP;
 UPDATE private.burimunsi_inbox_checks SET page_items=active.page_items WHERE collection_id=cid AND installation_id=device;
 final_value:=true;
 PERFORM set_config('burimunsi.inbox_frame',coalesce(prior_inbox,''),true);
 PERFORM set_config('burimunsi.observation_frame',coalesce(prior_observation,''),true);
 RETURN final_value;
END;$fn$;

CREATE FUNCTION private.burimunsi_observation_inbox_check(p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE ctx jsonb:=private.burimunsi_observation_context();cid text:=ctx->>'collectionId';device uuid:=(ctx->>'installationId')::uuid;
 account uuid:=(ctx->>'accountId')::uuid;grantid uuid:=(ctx->>'grantId')::uuid;version bigint:=(ctx->>'grantVersion')::bigint;
 generation bigint:=(ctx->>'consentGeneration')::bigint;profile text:=ctx->>'profile_tuple_sha256';
 run uuid:=(p->>'runId')::uuid;phase text:=p->>'state';active private.burimunsi_inbox_checks%ROWTYPE;
 candidates integer:=(p->>'candidateCount')::integer;missing integer:=(p->>'missingCount')::integer;pending integer:=(p->>'pendingCount')::integer;
 phone text:=p->>'phoneLatestKey';parsed text:=p->>'parsedLatestKey';rev text:=p->>'collectionRevision';
 stamp bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;collection jsonb;
 actual integer;unresolved integer;phone_head text;parsed_head text;
 final_value jsonb;
 prior_inbox text:=current_setting('burimunsi.inbox_frame',true);
 prior_observation text:=current_setting('burimunsi.observation_frame',true);
BEGIN
 PERFORM set_config('burimunsi.inbox_frame','1',true);
 PERFORM set_config('burimunsi.observation_frame','1',true);
 PERFORM private.burimunsi_setup_fence();
 IF (p->>'expectedConsentGeneration')::bigint IS DISTINCT FROM generation THEN
  RAISE EXCEPTION 'burimunsi_observation_consent_changed' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['runId','state','expectedConsentGeneration','candidateCount','missingCount','pendingCount','phoneLatestKey','parsedLatestKey','collectionRevision']
  OR p-ARRAY['runId','state','expectedConsentGeneration','candidateCount','missingCount','pendingCount','phoneLatestKey','parsedLatestKey','collectionRevision']<>'{}'::jsonb
  OR run IS NULL OR phase IS NULL OR phase NOT IN('checking','incomplete','verified') OR candidates IS NULL OR missing IS NULL OR pending IS NULL
  OR candidates NOT BETWEEN 0 AND 100000 OR missing NOT BETWEEN 0 AND candidates OR pending NOT BETWEEN 0 AND candidates-missing
  OR (phone IS NOT NULL AND phone !~ '^[a-f0-9]{64}$') OR (parsed IS NOT NULL AND parsed !~ '^[a-f0-9]{64}$')
  OR (rev IS NOT NULL AND rev !~ '^[a-f0-9]{64}$') THEN RAISE EXCEPTION 'invalid_inbox_check' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(cid||':'||device::text,7346372));
 SELECT * INTO active FROM private.burimunsi_inbox_checks WHERE collection_id=cid AND installation_id=device FOR UPDATE;
 IF phase='checking' THEN
  IF candidates<>0 OR missing<>0 OR pending<>0 OR phone IS NOT NULL OR parsed IS NOT NULL OR rev IS NOT NULL THEN
   RAISE EXCEPTION 'invalid_inbox_check' USING ERRCODE='22023';END IF;
  IF active.run_id=run THEN
   IF active.state<>'checking' OR ROW(active.account_id,active.grant_id,active.grant_version,active.consent_generation,active.profile_tuple)
     IS DISTINCT FROM ROW(account,grantid,version,generation,profile) THEN RAISE EXCEPTION 'inbox_check_changed' USING ERRCODE='40001';END IF;
  ELSE
   DELETE FROM private.burimunsi_inbox_check_items WHERE collection_id=cid AND installation_id=device;
   INSERT INTO private.burimunsi_inbox_checks(collection_id,installation_id,account_id,grant_id,grant_version,consent_generation,
    profile_tuple,run_id,page_items,state,checked_at,report) VALUES(cid,device,account,grantid,version,generation,profile,run,0,phase,stamp,p)
   ON CONFLICT(collection_id,installation_id) DO UPDATE SET account_id=excluded.account_id,grant_id=excluded.grant_id,
    grant_version=excluded.grant_version,consent_generation=excluded.consent_generation,profile_tuple=excluded.profile_tuple,
    run_id=excluded.run_id,page_items=0,state=excluded.state,checked_at=excluded.checked_at,report=excluded.report;
  END IF;
 ELSE
  IF active.run_id IS DISTINCT FROM run OR ROW(active.account_id,active.grant_id,active.grant_version,active.consent_generation,active.profile_tuple)
   IS DISTINCT FROM ROW(account,grantid,version,generation,profile) OR (active.state<>'checking' AND active.report IS DISTINCT FROM p) THEN
   RAISE EXCEPTION 'inbox_check_changed' USING ERRCODE='40001';END IF;
  IF phase='verified' THEN
   collection:=private.burimunsi_observation_reconcile_verified_status();
   IF rev IS NULL OR rev IS DISTINCT FROM collection->>'revision' OR collection->'hasPending' IS DISTINCT FROM 'false'::jsonb
    OR collection->'hasUnmatchedCanonical' IS DISTINCT FROM 'false'::jsonb OR (collection->>'recordedCount')::integer IS DISTINCT FROM candidates
    OR active.page_items<>candidates OR missing<>0 OR pending<>0 THEN RAISE EXCEPTION 'inbox_check_changed' USING ERRCODE='40001';END IF;
   -- The handset traverses rows by ascending SMS provider _id. The first
   -- traversal ordinal resolves equal timestamps without exporting those IDs.
   WITH checked AS MATERIALIZED (
    SELECT i.source_key,i.phone_at,i.scan_order,private._burimunsi_inbox_outcome(i.source_id,cid) AS outcome
    FROM private.burimunsi_inbox_check_items i WHERE i.collection_id=cid AND i.installation_id=device
   ) SELECT count(*),count(*) FILTER(WHERE outcome IS NULL OR outcome NOT IN('parsed','duplicate')),
    (SELECT source_key FROM checked ORDER BY phone_at DESC,scan_order DESC LIMIT 1),
    (SELECT source_key FROM checked WHERE outcome IN('parsed','duplicate') ORDER BY phone_at DESC,scan_order DESC LIMIT 1)
   INTO actual,unresolved,phone_head,parsed_head FROM checked;
   IF actual<>candidates OR unresolved<>0 OR phone IS DISTINCT FROM phone_head OR parsed IS DISTINCT FROM parsed_head THEN
    RAISE EXCEPTION 'inbox_check_changed' USING ERRCODE='40001';END IF;
  END IF;
  IF active.state='checking' THEN UPDATE private.burimunsi_inbox_checks SET state=phase,checked_at=stamp,report=p
   WHERE collection_id=cid AND installation_id=device;END IF;
 END IF;
 final_value:=jsonb_build_object('groupId',cid,'runId',run,'state',phase);
 PERFORM set_config('burimunsi.inbox_frame',coalesce(prior_inbox,''),true);
 PERFORM set_config('burimunsi.observation_frame',coalesce(prior_observation,''),true);
 RETURN final_value;
END;$fn$;

CREATE FUNCTION private.burimunsi_observation_admin_inbox_check(p_collection text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE checked private.burimunsi_inbox_checks%ROWTYPE;device uuid;eligible bigint;server_changed boolean:=false;
 prior_group text:=current_setting('burimunsi.collection_id',true);
 prior_native text:=current_setting('burimunsi.native_receipt_frame',true);
 final_value jsonb;
 prior_inbox text:=current_setting('burimunsi.inbox_frame',true);
 prior_pin text:=current_setting('burimunsi.pin_frame',true);
 prior_observation text:=current_setting('burimunsi.observation_frame',true);
BEGIN
 PERFORM set_config('burimunsi.inbox_frame','1',true);
 PERFORM set_config('burimunsi.pin_frame','1',true);
 PERFORM set_config('burimunsi.observation_frame','1',true);
 PERFORM private.burimunsi_observation_admin_scope(p_collection,false);
 PERFORM set_config('burimunsi.collection_id',p_collection,true);
 PERFORM set_config('burimunsi.native_receipt_frame','1',true);
 -- Where a paired gateway exists, use its installation. In an unpaired
 -- standalone scope, a single active receiver grant must identify the handset.
 SELECT count(*),min(g.installation_id::text)::uuid INTO eligible,device FROM private.burimunsi_device_grants g
 JOIN private.burimunsi_scopes scope ON scope.collection_id=g.collection_id
 WHERE g.collection_id=p_collection AND g.active AND g.profile='internal_receiver' AND
 (scope.active_binding_id IS NULL OR EXISTS(SELECT 1 FROM app.momo_gateway_credentials k JOIN app.momo_gateway_bindings b ON b.id=k.binding_id
   WHERE k.binding_id=scope.active_binding_id AND k.revoked_at IS NULL AND b.receiving_account_id=scope.receiving_account_id
    AND b.status='active' AND k.installation_id=g.installation_id::text));
 IF eligible=1 THEN
  SELECT x.* INTO checked FROM private.burimunsi_inbox_checks x
   JOIN private.burimunsi_observation_consents c ON c.collection_id=x.collection_id AND c.installation_id=x.installation_id
    AND c.account_id=x.account_id AND c.grant_id=x.grant_id AND c.grant_version=x.grant_version AND c.generation=x.consent_generation AND c.enabled
   JOIN private.burimunsi_device_grants g ON g.id=x.grant_id AND g.version=x.grant_version AND g.active AND g.installation_id=x.installation_id
   JOIN private.burimunsi_accounts a ON a.id=x.account_id AND a.collection_id=x.collection_id AND a.active AND NOT a.removed AND a.role='admin'
   JOIN private.burimunsi_device_accounts da ON da.account_id=a.id AND da.grant_id=g.id AND da.collection_id=x.collection_id
  WHERE x.collection_id=p_collection AND x.installation_id=device;
 END IF;
 IF checked.state='verified' THEN
  -- The offline phone cannot announce a new sweep. Suppress an old green
  -- result as soon as an admission, missing object or parser change is known.
  WITH sources AS (
   SELECT source_id FROM private.burimunsi_observation_requests WHERE collection_id=p_collection
   UNION SELECT source_id FROM private.burimunsi_unresolved_observations WHERE collection_id=p_collection
   UNION SELECT source_id FROM private.burimunsi_native_receipt_origins WHERE collection_id=p_collection
   UNION SELECT source_id FROM private.burimunsi_auto_sms_jobs WHERE collection_id=p_collection
   UNION SELECT source_id FROM private.collect_imported_native_history WHERE collection_id=p_collection
   UNION SELECT source_id FROM private.burimunsi_sms_source_scopes WHERE collection_id=p_collection
   UNION SELECT cap.raw_sms_id FROM private.burimunsi_scopes s
    JOIN app.momo_gateway_bindings b ON b.id=s.active_binding_id AND b.receiving_account_id=s.receiving_account_id
    JOIN app.momo_gateway_credentials k ON k.binding_id=b.id JOIN app.momo_gateway_captures cap ON cap.credential_id=k.id
    WHERE s.collection_id=p_collection
   UNION SELECT ts.raw_sms_id FROM private.burimunsi_transaction_scopes x
    JOIN app.momo_transaction_sources ts ON ts.transaction_id=x.transaction_id WHERE x.collection_id=p_collection
  ), items AS MATERIALIZED (SELECT source_id FROM private.burimunsi_inbox_check_items
    WHERE collection_id=p_collection AND installation_id=device)
  SELECT EXISTS(SELECT source_id FROM sources EXCEPT SELECT source_id FROM items)
   OR EXISTS(SELECT 1 FROM items i WHERE coalesce(private._burimunsi_inbox_outcome(i.source_id,p_collection),'unknown') NOT IN('parsed','duplicate'))
   OR EXISTS(SELECT 1 FROM private.burimunsi_unresolved_observations o WHERE o.collection_id=p_collection
    AND NOT private.burimunsi_observation_storage_matches(o.object_key,
     jsonb_build_object('ownerId',o.principal_user_id,'purpose','sms_receipt','entityId',o.source_id),o.object_sha256))
   INTO server_changed;
 END IF;
 final_value:=jsonb_build_object('state',coalesce(checked.state,'unknown'),'checkedAt',checked.checked_at,
  'candidateCount',checked.report->'candidateCount','missingCount',checked.report->'missingCount','pendingCount',checked.report->'pendingCount',
  'headsMatch',CASE WHEN checked.state IS NULL OR checked.state='checking' THEN NULL
   WHEN checked.state='verified' AND (checked.report->>'candidateCount')::int=0 THEN true
   WHEN checked.report->>'phoneLatestKey' IS NULL THEN NULL
   ELSE (checked.report->>'phoneLatestKey') IS NOT DISTINCT FROM (checked.report->>'parsedLatestKey') END);
 IF server_changed THEN
  final_value:=jsonb_build_object('state','incomplete','checkedAt',checked.checked_at,'candidateCount',NULL,'missingCount',NULL,'pendingCount',NULL,'headsMatch',NULL);
 END IF;
 PERFORM set_config('burimunsi.collection_id',coalesce(prior_group,''),true);
 PERFORM set_config('burimunsi.native_receipt_frame',coalesce(prior_native,''),true);
 PERFORM set_config('burimunsi.inbox_frame',coalesce(prior_inbox,''),true);
 PERFORM set_config('burimunsi.pin_frame',coalesce(prior_pin,''),true);
 PERFORM set_config('burimunsi.observation_frame',coalesce(prior_observation,''),true);
 RETURN final_value;
END;$fn$;
REVOKE ALL ON FUNCTION private._burimunsi_observation_automatable(text),private._burimunsi_inbox_outcome(text,text),
 private._burimunsi_inbox_gateway(text,text,uuid),private.burimunsi_observation_gateway_lookup(uuid,text),
 private.burimunsi_observation_held_matches(text,uuid,text,text,bigint),
 private.burimunsi_observation_held_prepare(text,text,text,uuid,text,text,text,text,bigint),
 private.burimunsi_observation_reconcile_verified_status(),private.burimunsi_observation_inbox_page(uuid,jsonb),
 private.burimunsi_observation_inbox_check(jsonb),private.burimunsi_observation_admin_inbox_check(text)
 FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;
GRANT EXECUTE ON FUNCTION private.burimunsi_observation_held_matches(text,uuid,text,text,bigint),private.burimunsi_observation_gateway_lookup(uuid,text),
 private.burimunsi_observation_held_prepare(text,text,text,uuid,text,text,text,text,bigint),
 private.burimunsi_observation_reconcile_verified_status(),private.burimunsi_observation_inbox_page(uuid,jsonb),
 private.burimunsi_observation_inbox_check(jsonb),private.burimunsi_observation_admin_inbox_check(text) TO collect_runtime;

-- Include the source marker, current check and replaceable page metadata in
-- the existing privacy inventory. No SMS body is stored in these relations.
DO $inventory$
DECLARE classes jsonb;body text;definition text;anchor text:='''managed:storage_iceberg''';
BEGIN
 SELECT jsonb_agg(jsonb_build_object('name','private:'||name,'relation','private.'||name,
  'scope','unmapped_private','purpose',purpose,'known_links',links,'blocked',true) ORDER BY name) INTO classes FROM (VALUES
  ('burimunsi_held_observation_sources','Prevent automatic processing of an admitted held receipt','source_id links the immutable observation request'),
  ('burimunsi_inbox_checks','Last scoped handset reconciliation and timestamp','collection_id, account_id and installation_id identify the receiver'),
  ('burimunsi_inbox_check_items','Current sweep page evidence, replaced at the next scan','collection_id, installation_id and source_id link the checked receipt')
 ) v(name,purpose,links);
 SELECT p.prosrc,pg_get_functiondef(p.oid) INTO STRICT body,definition FROM pg_proc p
  WHERE p.oid='private._retention_manifest_catalog_v2()'::regprocedure AND pg_get_userbyid(p.proowner)='postgres';
 IF strpos(body,'private:burimunsi_inbox_checks')>0 OR length(definition)-length(replace(definition,body,''))<>length(body) THEN
  RAISE EXCEPTION 'inbox_retention_catalog_changed' USING ERRCODE='55000';END IF;
 EXECUTE replace(definition,body,format('SELECT jsonb_set(base,''{private_classes}'',(base->''private_classes'')||%L::jsonb) FROM (%s) prior(base)',classes::text,rtrim(body,E'; \t\r\n')));
 SELECT p.prosrc,pg_get_functiondef(p.oid) INTO STRICT body,definition FROM pg_proc p
  WHERE p.oid='private.retention_capture_inventory_v2(uuid,text,bigint,text,integer)'::regprocedure AND pg_get_userbyid(p.proowner)='postgres';
 IF length(body)-length(replace(body,anchor,''))<>length(anchor) OR length(definition)-length(replace(definition,body,''))<>length(body) THEN
  RAISE EXCEPTION 'inbox_retention_inventory_changed' USING ERRCODE='55000';END IF;
 EXECUTE replace(definition,body,replace(body,anchor,'''private:burimunsi_held_observation_sources'',''private:burimunsi_inbox_checks'',''private:burimunsi_inbox_check_items'','||anchor));
END;$inventory$;
COMMIT;
