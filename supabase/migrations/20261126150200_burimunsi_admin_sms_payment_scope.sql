-- Scope standalone Admin SMS payment metadata to the current browser proof.
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
  IF NOT FOUND OR to_regprocedure('private._burimunsi_assert_browser_sms_payments_read(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'burimunsi_admin_sms_payment_scope_install_precondition' USING ERRCODE='55000';
  END IF;
END;
$preflight$;

-- Both call sites already require the current SMS Admin approval for this
-- collection. Check the browser collection and its live personal Payments
-- grant separately, since standalone operators use a scoped operator account.
CREATE FUNCTION private._burimunsi_assert_browser_sms_payments_read(p_collection text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $guard$
DECLARE
  actor jsonb:=private.burimunsi_browser_pin_context();
  principal text:=actor->>'principalId';
BEGIN
  IF p_collection IS NULL OR actor->>'collectionId' IS DISTINCT FROM p_collection
     OR actor->>'operatorRole' IS DISTINCT FROM 'admin' OR principal IS NULL
     OR private.burimunsi_browser_pin_assert_actor('payments.read',NULL,NULL,1,NULL) IS DISTINCT FROM principal THEN
    RAISE EXCEPTION 'burimunsi_observation_admin_denied' USING ERRCODE='42501';
  END IF;
END;
$guard$;
REVOKE ALL ON FUNCTION private._burimunsi_assert_browser_sms_payments_read(text)
  FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer,collect_sms_runtime;

DO $patch$
DECLARE
  target record;
  body text;
  definition text;
  prior text:=$call$PERFORM private.burimunsi_browser_pin_assert_actor('payments.read',p_collection,'admin',1,NULL);$call$;
  scoped text:=$call$PERFORM private._burimunsi_assert_browser_sms_payments_read(p_collection);$call$;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('private.burimunsi_admin_payment_observation_outcomes(text,text[],boolean)',
     '77d65c374468509c39cb9814265fbc336bf445fc2e996e7c51cb837a7e3630d4'),
    ('private.burimunsi_payment_sms_evidence_rows(text,text,text)',
     '3f45e3b78ff83ca2e544ded68879d9f171e2b5d899e07cda717794091bd3decb')
  ) AS predecessor(signature,body_sha256)
  LOOP
    SELECT p.prosrc,pg_get_functiondef(p.oid) INTO STRICT body,definition FROM pg_proc p
      WHERE p.oid=to_regprocedure(target.signature) AND p.prosecdef AND p.proowner='postgres'::regrole;
    IF encode(sha256(convert_to(body,'UTF8')),'hex') IS DISTINCT FROM target.body_sha256
       OR length(body)-length(replace(body,prior,''))<>length(prior)
       OR length(definition)-length(replace(definition,body,''))<>length(body) THEN
      RAISE EXCEPTION 'burimunsi_admin_sms_payment_scope_predecessor_changed: %',target.signature USING ERRCODE='55000';
    END IF;
    EXECUTE replace(definition,body,replace(body,prior,scoped));
  END LOOP;
END;
$patch$;

COMMIT;
