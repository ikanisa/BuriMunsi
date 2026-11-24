-- Exact, metadata-only reader for a source resolved by the scoped Payments API.
-- Apply while fenced with its reviewed source/history guard, then qualify
-- function grants and immutable source/worker identity before reopening. An
-- older HTTP build ignores this additive routine. Roll back HTTP first; never
-- remove the routine under a new HTTP build (it is intended to fail closed).
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $preflight$
BEGIN
 PERFORM private._collect_fence_require_operator();
 PERFORM pg_catalog.pg_advisory_xact_lock(7346371,1);
 PERFORM pg_catalog.pg_advisory_xact_lock(7346371,2);
 PERFORM 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced' FOR UPDATE;
 IF NOT FOUND OR current_user<>'postgres' OR session_user<>'postgres'
  OR to_regclass('burimunsi.payments') IS NULL
  OR to_regprocedure('private.burimunsi_observation_admin_scope(text,boolean)') IS NULL
  OR to_regprocedure('private.burimunsi_browser_pin_assert_actor(text,text,text,bigint,bigint)') IS NULL
  OR to_regprocedure('private.burimunsi_admin_payment_observation_outcomes(text,text[],boolean)') IS NULL
  THEN
  RAISE EXCEPTION 'burimunsi_payment_sms_evidence_install_precondition' USING ERRCODE='55000';END IF;
END;$preflight$;

CREATE FUNCTION private.burimunsi_payment_sms_evidence_rows(p_collection text,p_payment text,p_source text)
RETURNS TABLE(request_id uuid,source_id text,admitted_at bigint,retention_state text,body_sha256 text,
 owner_user_id text,object_key text,object_sha256 text,fingerprint text,key_id text,source_fingerprint text)
LANGUAGE plpgsql SECURITY DEFINER ROWS 1 SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE a jsonb:=private.burimunsi_observation_admin_scope(p_collection,false);
 old_frame text:=current_setting('burimunsi.observation_frame',true);
 old_inbox text:=current_setting('burimunsi.inbox_frame',true);
BEGIN
 IF p_payment IS NULL OR p_payment !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
  OR p_source IS NULL OR p_source !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
  RAISE EXCEPTION 'burimunsi_observation_admin_invalid' USING ERRCODE='22023';END IF;
 PERFORM private.burimunsi_browser_pin_assert_actor('payments.read',p_collection,'admin',1,NULL);
 IF p_collection IS DISTINCT FROM current_setting('burimunsi.collection_id',true) THEN
  RAISE EXCEPTION 'burimunsi_observation_admin_denied' USING ERRCODE='42501';END IF;
 PERFORM set_config('burimunsi.observation_frame','1',true),set_config('burimunsi.inbox_frame','1',true);
 RETURN QUERY
 SELECT r.request_id,r.source_id,r.created_at,
  CASE WHEN x.source_id IS NOT NULL AND i.object_key IS NOT NULL AND m.object_key IS NOT NULL AND v.object_key IS NOT NULL
    AND i.state='committed' AND NOT i.delete_tombstone AND NOT i.upload_unresolved AND i.active_attempt IS NULL
    AND i.operation_id=m.operation_id AND i.fingerprint=m.fingerprint AND i.sha256=m.sha256 AND i.size=m.size
    AND i.scope=m.scope AND i.http_metadata=m.http_metadata AND i.custom_metadata=m.custom_metadata
    AND i.scope=jsonb_build_object('ownerId',r.principal_user_id,'purpose','sms_receipt','entityId',r.source_id)
    AND v.scope=i.scope AND v.plaintext_sha256=x.object_sha256 AND v.sealed_body IS NULL AND v.cleared_at IS NOT NULL
    AND v.aad='sms:'||r.source_id||':'||x.object_sha256 AND v.key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND i.http_metadata=jsonb_build_object('contentType','application/octet-stream')
    AND i.custom_metadata=jsonb_build_object('sha256',x.object_sha256,'key_id',v.key_id,'source_fingerprint',v.source_fingerprint)
    AND i.custom_metadata->>'sha256'=x.object_sha256 AND i.custom_metadata->>'source_fingerprint'=v.source_fingerprint
    AND NOT EXISTS(SELECT 1 FROM private.storage_delete_intents d WHERE d.object_key=x.object_key)
   THEN 'retained' ELSE 'unresolved' END,
  CASE WHEN x.source_id IS NOT NULL AND i.object_key IS NOT NULL AND m.object_key IS NOT NULL AND v.object_key IS NOT NULL
    AND i.state='committed' AND NOT i.delete_tombstone AND NOT i.upload_unresolved AND i.active_attempt IS NULL
    AND i.operation_id=m.operation_id AND i.fingerprint=m.fingerprint AND i.sha256=m.sha256 AND i.size=m.size
    AND i.scope=m.scope AND i.http_metadata=m.http_metadata AND i.custom_metadata=m.custom_metadata
    AND i.scope=jsonb_build_object('ownerId',r.principal_user_id,'purpose','sms_receipt','entityId',r.source_id)
    AND v.scope=i.scope AND v.plaintext_sha256=x.object_sha256 AND v.sealed_body IS NULL AND v.cleared_at IS NOT NULL
    AND v.aad='sms:'||r.source_id||':'||x.object_sha256 AND v.key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND i.http_metadata=jsonb_build_object('contentType','application/octet-stream')
    AND i.custom_metadata=jsonb_build_object('sha256',x.object_sha256,'key_id',v.key_id,'source_fingerprint',v.source_fingerprint)
    AND i.custom_metadata->>'sha256'=x.object_sha256 AND i.custom_metadata->>'source_fingerprint'=v.source_fingerprint
    AND NOT EXISTS(SELECT 1 FROM private.storage_delete_intents d WHERE d.object_key=x.object_key)
   THEN x.body_sha256 ELSE NULL END,
  r.principal_user_id,x.object_key,x.object_sha256,r.fingerprint,v.key_id,v.source_fingerprint
 FROM private.burimunsi_observation_requests r
 LEFT JOIN private.burimunsi_unresolved_observations x ON x.source_id=r.source_id AND x.collection_id=r.collection_id
  AND x.account_id=r.account_id AND x.principal_user_id=r.principal_user_id AND x.installation_id=r.installation_id
  AND x.grant_id=r.grant_id AND x.grant_version=r.grant_version AND x.request_id=r.request_id AND x.fingerprint=r.fingerprint
  -- A successful exact retry may use a renewed native session or refreshed
  -- consent/profile; these are validated by the commit guard, not equated to
  -- the earlier pre-admission snapshot.
 LEFT JOIN private.storage_put_intents i ON i.object_key=x.object_key
 LEFT JOIN private.storage_objects m ON m.object_key=x.object_key
 LEFT JOIN private.storage_payload_reservations v ON v.object_key=x.object_key
 WHERE r.source_id=p_source AND r.collection_id=p_collection
   AND EXISTS (SELECT FROM burimunsi.payments p
     WHERE p.id=p_payment AND p.collection_id=p_collection AND p.sms_source_id=r.source_id);
 PERFORM set_config('burimunsi.observation_frame',coalesce(old_frame,''),true),
  set_config('burimunsi.inbox_frame',coalesce(old_inbox,''),true);
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('burimunsi.observation_frame',coalesce(old_frame,''),true),
  set_config('burimunsi.inbox_frame',coalesce(old_inbox,''),true);
 RAISE;
END;$fn$;

REVOKE ALL ON FUNCTION private.burimunsi_payment_sms_evidence_rows(text,text,text)
 FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;
GRANT EXECUTE ON FUNCTION private.burimunsi_payment_sms_evidence_rows(text,text,text) TO collect_runtime;
COMMIT;
