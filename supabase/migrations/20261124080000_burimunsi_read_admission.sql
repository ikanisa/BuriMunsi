-- Give the payment worker room to run when several staff open screens together.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $preflight$
BEGIN
 PERFORM private._collect_fence_require_operator();
 IF NOT EXISTS (SELECT 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced') THEN
  RAISE EXCEPTION 'burimunsi_read_admission_requires_fence';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='private.collect_fence_register(uuid,text,text)'::regprocedure
   AND proowner='postgres'::regrole AND prosecdef
   AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='e04a55ef6e7be755db96115e15baf77a632e41b968ac5b80f7634f179e1814cf') THEN
  RAISE EXCEPTION 'burimunsi_read_admission_predecessor_changed';
 END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION private.collect_fence_register(p_id uuid,p_source text,p_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE c private.collect_fence_control%ROWTYPE; resources jsonb;
BEGIN
 PERFORM private._collect_fence_require_runtime();
 PERFORM private._collect_fence_require_rc(true);
 IF p_id IS NULL OR p_source IS NULL OR p_source !~ '^[a-f0-9]{64}$' OR p_kind IS NULL OR p_kind NOT IN('http_collect','http_admin','jobs') THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='collect_fence_invalid_admission';END IF;
 PERFORM pg_advisory_xact_lock_shared(7346371,1);
 SELECT * INTO c FROM private.collect_fence_control WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='collect_fence_unavailable';END IF;
 IF c.mode<>'open' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='collect_fence_closed';END IF;
 IF c.source_sha256<>p_source OR EXISTS(SELECT 1 FROM private.collect_fence_admissions WHERE admission_id=p_id) THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='collect_fence_conflict';END IF;
 -- The control-row lock serializes all supported registrations, so concurrent
 -- requests cannot overshoot either bound. No deletion/TTL is used to make room.
 resources:=private._collect_fence_resources();
 -- A burst of standalone screen reads leaves one slot for the receipt worker.
 -- All registrations share the control-row lock and the original hard limit.
 IF p_kind IN ('http_admin','http_collect') AND current_setting('burimunsi.read_admission',true)='1'
    AND (resources->>'activeAndUnresolvedAdmissions')::integer >= (resources->>'activeWorkLimit')::integer-1 THEN
  RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='burimunsi_read_capacity';
 END IF;
 IF resources->'capacityBlocked'='true'::jsonb THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='collect_fence_capacity';END IF;
 INSERT INTO private.collect_fence_admissions(admission_id,epoch,source_sha256,kind,state) VALUES(p_id,c.epoch,p_source,p_kind,'active');
 RETURN jsonb_build_object('contractVersion',1,'admissionId',p_id,'epoch',c.epoch,'sourceSha256',p_source,'state','active','mode','open','kind',p_kind);
END;$fn$;

COMMIT;
