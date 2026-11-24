-- Receipt metadata and phone lease renewal can run together. Account, consent,
-- payment and deployment changes still exclude renewal through their write locks.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $install$
DECLARE
  routine regprocedure := 'private.burimunsi_pin_renew_session(text,uuid,text,text,text,bigint)'::regprocedure;
  body text;
  definition text;
  before_guard constant text := ' PERFORM private.burimunsi_setup_fence();';
  after_guard constant text := $guard$ DECLARE
  aid text:=current_setting('collect.fence_admission_id',true);
  ep text:=current_setting('collect.fence_epoch',true);
  src text:=current_setting('collect.fence_source_sha256',true);
 BEGIN
  PERFORM private._collect_fence_require_runtime();
  IF aid IS NULL OR aid !~ '^[a-f0-9-]{36}$' OR ep IS NULL OR ep !~ '^[1-9][0-9]{0,15}$'
     OR src IS NULL OR src !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'burimunsi_setup_unavailable' USING ERRCODE='55000';
  END IF;
  PERFORM private.collect_fence_assert_write(aid::uuid,ep::bigint,src);
  PERFORM pg_advisory_xact_lock_shared(734636924058501::bigint);
 END;$guard$;
  after_proof constant text := ' IF NOT FOUND OR candidate.collection_id IS DISTINCT FROM p_collection THEN RETURN;END IF;';
BEGIN
  PERFORM private._collect_fence_require_operator();
  PERFORM pg_advisory_xact_lock(7346371,1);
  PERFORM pg_advisory_xact_lock(7346371,2);
  PERFORM 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced' FOR UPDATE;
  IF NOT FOUND OR session_user<>'postgres' OR current_user<>'postgres' THEN
    RAISE EXCEPTION 'burimunsi_renewal_requires_fenced_install' USING ERRCODE='55000';
  END IF;

  SELECT p.prosrc,pg_get_functiondef(p.oid) INTO STRICT body,definition
    FROM pg_proc p WHERE p.oid=routine AND p.prosecdef AND pg_get_userbyid(p.proowner)='postgres';
  IF encode(sha256(convert_to(body,'UTF8')),'hex')<>'88ef12ed349f68f2f1ebd9d08af2e089f1f4d599a1d5d8ca73a058ca22b273c6'
     OR strpos(body,before_guard)=0 OR strpos(body,after_proof)=0 THEN
    RAISE EXCEPTION 'burimunsi_renewal_predecessor_changed' USING ERRCODE='55000';
  END IF;

  -- Protect simultaneous renewals and the existing Admin consent binding on the
  -- same verified installation. Hold that lock through the final authority check.
  definition := replace(definition,before_guard,after_guard);
  definition := replace(definition,after_proof,after_proof || E'\n' ||
    ' PERFORM pg_advisory_xact_lock(hashtextextended(candidate.installation_id::text,7346381));');
  EXECUTE definition;
END;
$install$;
COMMIT;
