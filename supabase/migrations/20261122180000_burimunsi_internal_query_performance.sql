-- Reduce protected payment read work before constructing the displayed rows.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;

DO $install$
BEGIN
  PERFORM private._collect_fence_require_operator();
  IF session_user <> 'postgres' OR current_user <> 'postgres'
    OR NOT EXISTS (SELECT 1 FROM private.collect_fence_control WHERE singleton AND mode = 'fenced') THEN
    RAISE EXCEPTION 'burimunsi_query_performance_requires_fence' USING ERRCODE = '55000';
  END IF;
END;
$install$;

CREATE FUNCTION private.burimunsi_home_payment_times(p_collection text, p_sources text[])
RETURNS TABLE(source_id text, transaction_at text, transaction_timezone text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  actor record;
  old_frame text := current_setting('burimunsi.native_receipt_frame', true);
BEGIN
  PERFORM private._collect_fence_require_runtime();
  IF cardinality(p_sources) = 0 THEN RETURN; END IF;
  SELECT * INTO actor FROM private.burimunsi_pin_context();
  IF NOT FOUND OR actor.collection_id IS DISTINCT FROM p_collection
    OR ('records.read' = ANY(actor.capabilities)) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'burimunsi_auto_denied' USING ERRCODE = '42501';
  END IF;
  PERFORM private.burimunsi_pin_assert_actor(NULL, actor.collection_id, NULL, 1, NULL);

  -- These are the same ordering fields as the complete projection. Only the
  -- three chosen receipts subsequently need its per-receipt disclosure check.
  PERFORM set_config('burimunsi.native_receipt_frame', '1', true);
  RETURN QUERY SELECT job.source_id, job.posting_facts->>'transaction_at',
    job.posting_facts->>'transaction_timezone'
  FROM private.burimunsi_auto_sms_jobs job
  WHERE job.collection_id = actor.collection_id AND job.state = 'completed'
    AND job.source_id = ANY(p_sources);
  PERFORM set_config('burimunsi.native_receipt_frame', coalesce(old_frame, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('burimunsi.native_receipt_frame', coalesce(old_frame, ''), true);
  RAISE;
END;
$fn$;
REVOKE ALL ON FUNCTION private.burimunsi_home_payment_times(text, text[])
  FROM PUBLIC, anon, authenticated, service_role, collect_importer, collect_runtime;
GRANT EXECUTE ON FUNCTION private.burimunsi_home_payment_times(text, text[]) TO collect_runtime;

CREATE FUNCTION private.burimunsi_admin_transaction_facts(p_transaction text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  visibility jsonb;
  facts jsonb;
  old_frame text := current_setting('burimunsi.native_receipt_frame', true);
BEGIN
  -- The original routine verifies the current browser actor and source scope.
  visibility := private.burimunsi_admin_transaction_visibility(p_transaction);
  IF visibility->>'kind' = 'visible' THEN
    PERFORM set_config('burimunsi.native_receipt_frame', '1', true);
    SELECT job.posting_facts INTO facts FROM private.burimunsi_auto_sms_jobs job
    WHERE job.transaction_id = p_transaction AND job.collection_id = visibility->>'groupId'
      AND job.state = 'completed' AND job.relation = 'accepted';
    PERFORM set_config('burimunsi.native_receipt_frame', coalesce(old_frame, ''), true);
  END IF;
  RETURN jsonb_build_object('scope', visibility, 'facts', facts);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('burimunsi.native_receipt_frame', coalesce(old_frame, ''), true);
  RAISE;
END;
$fn$;
REVOKE ALL ON FUNCTION private.burimunsi_admin_transaction_facts(text)
  FROM PUBLIC, anon, authenticated, service_role, collect_importer, collect_runtime;
GRANT EXECUTE ON FUNCTION private.burimunsi_admin_transaction_facts(text) TO collect_runtime;


-- Shared application admission and scheduler read paths.
-- Reconcile the same capped work and stopped-executor counts with one set join.
-- UNION prevents two matching retirement proofs from duplicating an admission.
DO $preimage$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='private._collect_fence_resources()'::regprocedure AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='ee8b5496996c36233d2b8c110dbc1a72678adf49536dff81672e03b9bd4d1aae') OR
    NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='private._collect_stopped_matches(uuid,bigint,text,text)'::regprocedure AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='fcb16100b0f973fdc57ed30634696830b807e5204ed8dbac7f74f30de2d98d5c') OR
    NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='private.burimunsi_native_sms_post_candidates(integer)'::regprocedure AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='9e1a2a348a06f270afb65055c58edc7e88181385adac3dd24991384b86fe0adc') THEN
  RAISE EXCEPTION 'burimunsi_performance_preimage_changed';
 END IF;
END;
$preimage$;

CREATE OR REPLACE FUNCTION private._collect_fence_resources() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE total_count bigint;archived_count bigint;working_count bigint;active_count bigint;raw_active bigint;
 operation_count bigint;proof_count bigint;stopped_count bigint;
BEGIN
 SELECT t.retained_total,t.archived_total,w.working_count,w.raw_active,w.active_count,w.stopped_count
 INTO STRICT total_count,archived_count,working_count,raw_active,active_count,stopped_count
 FROM private.collect_fence_admission_totals t CROSS JOIN LATERAL(
 SELECT count(*) AS working_count,
  count(*) FILTER (WHERE a.state IN ('active','unresolved')) AS raw_active,
  count(*) FILTER (WHERE a.state IN ('active','unresolved') AND stopped.admission_id IS NULL) AS active_count,
  count(stopped.admission_id) AS stopped_count
 FROM private.collect_fence_working_admissions w
 JOIN private.collect_fence_admissions a USING(admission_id)
 LEFT JOIN (
   SELECT admission_id,epoch,source_sha256,kind FROM private.collect_fence_stopped_admissions WHERE project_ref='rrlduytparvsjfmegalh'
   UNION
   SELECT admission_id,epoch,source_sha256,kind FROM private.collect_fence_local_stopped_admissions WHERE project_ref='rrlduytparvsjfmegalh'
   UNION
   SELECT admission_id,epoch,source_sha256,kind FROM private.collect_managed_executor_retirements
 ) stopped ON (stopped.admission_id,stopped.epoch,stopped.source_sha256,stopped.kind) = (a.admission_id,a.epoch,a.source_sha256,a.kind)) w WHERE t.singleton;
 IF total_count-archived_count<>working_count THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='collect_archive_index_conflict';END IF;
 SELECT (SELECT count(*) FROM private.collect_fence_operations)+(SELECT count(*) FROM private.collect_fence_source_upgrades) INTO operation_count;
 SELECT count(*) INTO proof_count FROM private.collect_fence_scheduler_lifecycle;
 RETURN jsonb_build_object('admissionBudgetVersion',4,'retainedAdmissionLimit',NULL,'workingAdmissionLimit',100000,'activeWorkLimit',8,
  'operationReceiptLimit',10000,'schedulerLifecycleProofLimit',10000,
  'retainedAdmissions',total_count,'archivedAdmissions',archived_count,'workingAdmissions',working_count,
  'activeAndUnresolvedAdmissions',active_count,'rawActiveAndUnresolvedAdmissions',raw_active,
  'stoppedLocalAdmissions',stopped_count,'retainedUnquantifiedUnknownObligations',stopped_count,
  'stoppedLifecycleProofs',private._collect_stopped_proof_total(),'stoppedProofLimit',10000,
  'operationReceipts',operation_count,'schedulerLifecycleProofs',proof_count,
  'settledRetentionEnabled',true,'archiveMode','immutable_in_place','originalRowsDeleted',false,
  'operationReceiptSaturated',operation_count>=10000,
  'capacityBlocked',working_count>=100000 OR active_count>=8 OR operation_count>=9998 OR proof_count>=10000);
END;$fn$;

-- Claim up to four already parsed postings. Financial custody, replay checks,
-- retry delays and ledger writes still run independently for every receipt.
CREATE OR REPLACE FUNCTION private.burimunsi_native_sms_post_candidates(p_limit integer) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE answer jsonb;old_frame text:=current_setting('burimunsi.native_receipt_frame',true);
BEGIN
 PERFORM private.burimunsi_auto_jobs_guard();
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 4 THEN RAISE EXCEPTION 'native_sms_posting_invalid' USING ERRCODE='22023';END IF;
 PERFORM set_config('burimunsi.native_receipt_frame','1',true);
 SELECT coalesce(jsonb_agg((jsonb_build_object('groupId',collection_id,'sourceId',source_id)
   || CASE WHEN p_limit>1 THEN jsonb_build_object('needsFacts',needs_facts) ELSE '{}'::jsonb END)
   ORDER BY due,created_at,source_id),'[]'::jsonb)
 INTO answer FROM (
  SELECT j.collection_id,j.source_id,j.posting_next_attempt_at AS due,j.created_at,j.posting_facts IS NULL AS needs_facts
  FROM private.burimunsi_auto_sms_jobs j JOIN app.momo_transactions t ON t.id=j.transaction_id
  WHERE NOT private.collect_imported_native_source(j.source_id)
   AND NOT private.collect_imported_native_transaction(j.transaction_id)
   AND j.state='completed' AND j.relation='accepted'
   AND t.event_kind IN ('incoming_receipt','outgoing','unknown') AND t.has_conflict=0
   AND (j.posting_facts IS NULL OR (j.posting_facts->>'event_kind'='incoming_receipt'
       AND t.allocation_state IN ('unallocated','not_applicable')))
   AND j.posting_next_attempt_at<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
   AND NOT EXISTS(SELECT 1 FROM app.momo_financial_links f WHERE f.transaction_id=t.id)
  ORDER BY j.posting_next_attempt_at,j.created_at,j.source_id LIMIT p_limit
 ) q;
 PERFORM set_config('burimunsi.native_receipt_frame',coalesce(old_frame,''),true);RETURN answer;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('burimunsi.native_receipt_frame',coalesce(old_frame,''),true);RAISE;
END;$fn$;

-- Directory projection has no writes. Keep its coordination with approved
-- mutations but let independent directory readers hold the shared lock together.
DO $directory$
DECLARE
  source_body text;
  definition text;
  lock_sql constant text := 'PERFORM pg_advisory_xact_lock(734636924058501::bigint);';
BEGIN
  SELECT p.prosrc,pg_get_functiondef(p.oid) INTO STRICT source_body,definition
  FROM pg_proc p
  WHERE p.oid='private.burimunsi_operator_directory(text,text,text,text,text,uuid)'::regprocedure
    AND p.prosecdef AND pg_get_userbyid(p.proowner)='postgres';
  IF length(source_body)-length(replace(source_body,lock_sql,''))<>length(lock_sql)
    OR strpos(source_body,'private.burimunsi_browser_pin_owner_actor(p_actor,p_cookie,p_origin,p_public)')=0
    OR length(definition)-length(replace(definition,source_body,''))<>length(source_body) THEN
    RAISE EXCEPTION 'burimunsi_operator_directory_preimage_changed';
  END IF;
  EXECUTE replace(definition,source_body,replace(source_body,lock_sql,
    'PERFORM pg_advisory_xact_lock_shared(734636924058501::bigint);'));
END;
$directory$;

-- Reconciliation must recognize exactly the largest locally qualified posting batch.
DO $scheduler$
DECLARE def text;
BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='collect_ops.reconcile_jobs()'::regprocedure) IS DISTINCT FROM '9bb836da08ef8f9bccd63e0c85d6ed7b900c2957b9a7805102d8f5260b2905ef' THEN
   RAISE EXCEPTION 'burimunsi_scheduler_reconcile_preimage_changed';
 END IF;
 def:=pg_get_functiondef('collect_ops.reconcile_jobs()'::regprocedure);
 EXECUTE replace(def,$before$payload->'native_sms_ledger'->'processed' IN('0'::jsonb,'1'::jsonb)$before$,$after$payload->'native_sms_ledger'->'processed' IN('0'::jsonb,'1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb)$after$);
END;
$scheduler$;

COMMIT;
