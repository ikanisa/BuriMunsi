-- List reads can prove the same actor once per snapshot. Keep the existing
-- per-receipt disclosure decision and the same sanitized projection fields.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;

DO $install$
BEGIN
  PERFORM private._collect_fence_require_operator();
  IF session_user <> 'postgres' OR current_user <> 'postgres'
    OR NOT EXISTS (SELECT 1 FROM private.collect_fence_control WHERE singleton AND mode = 'fenced') THEN
    RAISE EXCEPTION 'burimunsi_batch_projection_requires_fence' USING ERRCODE = '55000';
  END IF;
END;
$install$;

CREATE FUNCTION private.burimunsi_auto_projection_batch(p_collection text, p_sources text[])
RETURNS TABLE(source_id text, value jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  actor record;
  receipt record;
  check_reveal boolean;
  can_reveal boolean;
  old_frame text := current_setting('burimunsi.native_receipt_frame', true);
BEGIN
  PERFORM private._collect_fence_require_runtime();
  IF cardinality(p_sources) = 0 THEN RETURN; END IF;
  SELECT * INTO actor FROM private.burimunsi_pin_context();
  IF NOT FOUND OR actor.collection_id IS DISTINCT FROM p_collection
    OR ('records.read' = ANY(actor.capabilities)) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'burimunsi_auto_denied' USING ERRCODE = '42501';
  END IF;
  IF p_sources IS NULL OR cardinality(p_sources) > 100001 THEN
    RAISE EXCEPTION 'burimunsi_auto_projection_limit' USING ERRCODE = '54000';
  END IF;
  PERFORM private.burimunsi_pin_assert_actor(NULL, actor.collection_id, NULL, 1, NULL);
  check_reveal := actor.role = 'admin' AND actor.profile = 'internal_receiver'
    AND 'sms.read' = ANY(actor.capabilities) AND 'gateway.manage' = ANY(actor.capabilities);

  PERFORM set_config('burimunsi.native_receipt_frame', '1', true);
  FOR receipt IN
    SELECT job.source_id, job.payment_outcome, job.posting_facts
    FROM private.burimunsi_auto_sms_jobs job
    WHERE job.collection_id = actor.collection_id AND job.state = 'completed'
      AND job.source_id = ANY(p_sources)
  LOOP
    can_reveal := false;
    IF check_reveal THEN
      PERFORM set_config('burimunsi.native_receipt_frame', coalesce(old_frame, ''), true);
      BEGIN
        can_reveal := private.burimunsi_observation_own(receipt.source_id, true) IS NOT NULL;
      EXCEPTION WHEN insufficient_privilege THEN
        can_reveal := false;
      END;
      PERFORM set_config('burimunsi.native_receipt_frame', '1', true);
    END IF;
    source_id := receipt.source_id;
    value := jsonb_build_object('sourceId', source_id,
      'outcome', coalesce(receipt.posting_facts->>'payment_outcome', receipt.payment_outcome),
      'canReveal', can_reveal, 'facts', receipt.posting_facts);
    RETURN NEXT;
  END LOOP;
  PERFORM set_config('burimunsi.native_receipt_frame', coalesce(old_frame, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('burimunsi.native_receipt_frame', coalesce(old_frame, ''), true);
  RAISE;
END;
$fn$;

REVOKE ALL ON FUNCTION private.burimunsi_auto_projection_batch(text, text[])
  FROM PUBLIC, anon, authenticated, service_role, collect_importer, collect_runtime;
GRANT EXECUTE ON FUNCTION private.burimunsi_auto_projection_batch(text, text[]) TO collect_runtime;
COMMIT;
