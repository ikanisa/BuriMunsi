BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $install$
BEGIN
  PERFORM private._collect_fence_require_operator();
  PERFORM pg_advisory_xact_lock(7346371,1);
  PERFORM pg_advisory_xact_lock(7346371,2);
  PERFORM 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced' FOR UPDATE;
  IF NOT FOUND OR session_user<>'postgres' OR current_user<>'postgres' THEN
    RAISE EXCEPTION 'burimunsi_idle_jobs_requires_fence' USING ERRCODE='55000';
  END IF;
END;
$install$;

-- A scheduled worker with no possible work can finish alongside an unrelated
-- reconciliation. Every possible receipt still enters the original serialized
-- selector and its full current source, grant, custody and posting checks.
CREATE FUNCTION private.burimunsi_native_job_candidates(p_lane text,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $fn$
DECLARE
  admission private.collect_fence_admissions%ROWTYPE;
  old_observation text:=current_setting('burimunsi.observation_frame',true);
  old_receipt text:=current_setting('burimunsi.native_receipt_frame',true);
  possible boolean;
BEGIN
  PERFORM private._collect_fence_require_runtime();
  admission:=private._collect_fence_admission(nullif(current_setting('collect.fence_admission_id',true),'')::uuid,
    nullif(current_setting('collect.fence_epoch',true),'')::bigint,current_setting('collect.fence_source_sha256',true));
  IF admission.kind IS DISTINCT FROM 'jobs' THEN
    RAISE EXCEPTION 'burimunsi_auto_jobs_required' USING ERRCODE='42501';
  END IF;
  PERFORM private.collect_fence_assert_write(admission.admission_id,admission.epoch,admission.source_sha256);

  IF p_lane='parse' AND p_limit=1 THEN
    PERFORM set_config('burimunsi.observation_frame','1',true),set_config('burimunsi.native_receipt_frame','1',true);
    SELECT EXISTS (
      SELECT 1 FROM private.burimunsi_unresolved_observations o
      LEFT JOIN private.burimunsi_auto_sms_jobs j ON j.source_id=o.source_id
      WHERE NOT private.collect_imported_native_source(o.source_id)
        AND (j.source_id IS NULL
          OR (j.state='processing' AND j.lease_until<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
          OR (j.state='retry' AND j.next_attempt_at<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint))
        AND private._burimunsi_observation_automatable(o.source_id)
    ) INTO possible;
    PERFORM set_config('burimunsi.observation_frame',coalesce(old_observation,''),true),
      set_config('burimunsi.native_receipt_frame',coalesce(old_receipt,''),true);
    IF possible THEN RETURN private.burimunsi_auto_collections(p_limit); END IF;
  ELSIF p_lane='post' AND p_limit BETWEEN 1 AND 4 THEN
    PERFORM set_config('burimunsi.native_receipt_frame','1',true);
    SELECT EXISTS (
      SELECT 1 FROM private.burimunsi_auto_sms_jobs j
      JOIN app.momo_transactions t ON t.id=j.transaction_id
      WHERE j.state='completed' AND j.relation='accepted'
        AND NOT private.collect_imported_native_source(j.source_id)
        AND NOT private.collect_imported_native_transaction(j.transaction_id)
        AND j.posting_next_attempt_at<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
        AND t.event_kind IN ('incoming_receipt','outgoing','unknown') AND t.has_conflict=0
        AND (j.posting_facts IS NULL OR (j.posting_facts->>'event_kind'='incoming_receipt'
          AND t.allocation_state IN ('unallocated','not_applicable')))
        AND NOT EXISTS (SELECT 1 FROM app.momo_financial_links l WHERE l.transaction_id=j.transaction_id)
    ) INTO possible;
    PERFORM set_config('burimunsi.native_receipt_frame',coalesce(old_receipt,''),true);
    IF possible THEN RETURN private.burimunsi_native_sms_post_candidates(p_limit); END IF;
  ELSE
    RAISE EXCEPTION 'burimunsi_jobs_invalid_selection' USING ERRCODE='22023';
  END IF;
  RETURN '[]'::jsonb;
END;
$fn$;
REVOKE ALL ON FUNCTION private.burimunsi_native_job_candidates(text,integer)
  FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;
GRANT EXECUTE ON FUNCTION private.burimunsi_native_job_candidates(text,integer) TO collect_runtime;
COMMIT;
