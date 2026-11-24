BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $preflight$
BEGIN
  PERFORM private._collect_fence_require_operator();
  PERFORM pg_advisory_xact_lock(7346371,1);
  PERFORM pg_advisory_xact_lock(7346371,2);
  IF session_user<>'postgres' OR current_user<>'postgres'
    OR NOT EXISTS (SELECT FROM private.collect_fence_control WHERE singleton AND mode='fenced' FOR UPDATE)
    OR EXISTS (SELECT FROM collect_ops.jobs_config c JOIN cron.job j ON j.jobid=c.cron_job_id
      WHERE c.singleton AND (c.enabled OR j.active))
    OR EXISTS (SELECT FROM collect_ops.jobs_dispatches WHERE state IN ('awaiting','unconfirmed')) THEN
    RAISE EXCEPTION 'allocation_sms_requires_drained_release' USING ERRCODE='55000';
  END IF;
END $preflight$;

-- Only the first committed assignment creates a receipt. Existing assignments
-- are intentionally left as they were. The mobile and web writers share this trigger.
CREATE TABLE private.burimunsi_allocation_receipts (
  payment_id text PRIMARY KEY REFERENCES burimunsi.payments(id),
  collection_id text NOT NULL,
  attempt_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  allocated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN
    ('pending','gateway_accepted','sent','delivered','failed','unknown','suppressed','expired')),
  reason text,
  application_id text, destination_sha256 text CHECK(destination_sha256 ~ '^[a-f0-9]{64}$'),
  body_sha256 text CHECK(body_sha256 ~ '^[a-f0-9]{64}$'),
  send_before timestamptz, provider_state text, gateway_hint text, evidence_sha256 text CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  claim_token uuid, claim_request uuid, claim_admission uuid, lease_until timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(), inspections integer NOT NULL DEFAULT 0,
  CHECK ((claim_token IS NULL)=(lease_until IS NULL) AND (claim_token IS NULL)=(claim_request IS NULL)
    AND (claim_token IS NULL)=(claim_admission IS NULL)),
  CHECK (body_sha256 IS NULL OR (application_id IS NOT NULL AND destination_sha256 IS NOT NULL))
);
CREATE INDEX burimunsi_allocation_receipts_due ON private.burimunsi_allocation_receipts(collection_id,next_check_at)
  WHERE status IN ('pending','gateway_accepted','sent','unknown');
ALTER TABLE private.burimunsi_allocation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.burimunsi_allocation_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.burimunsi_allocation_receipts FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime,collect_sms_runtime;
CREATE POLICY burimunsi_allocation_receipts_frame ON private.burimunsi_allocation_receipts TO postgres
  USING (current_setting('role',true)='collect_runtime' AND current_setting('collect.edge_verified',true)='true'
    AND collection_id=nullif(current_setting('burimunsi.collection_id',true),''))
  WITH CHECK (current_setting('role',true)='collect_runtime' AND current_setting('collect.edge_verified',true)='true'
    AND collection_id=nullif(current_setting('burimunsi.collection_id',true),''));
CREATE TRIGGER collect_fence_statement_v1 BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON private.burimunsi_allocation_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION private._collect_fence_statement();
ALTER TABLE private.burimunsi_allocation_receipts ENABLE ALWAYS TRIGGER collect_fence_statement_v1;

CREATE FUNCTION private._burimunsi_allocation_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
BEGIN
  IF TG_RELID <> 'burimunsi.payments'::regclass OR current_setting('role',true) IS DISTINCT FROM 'collect_runtime'
    OR current_setting('collect.edge_verified',true) IS DISTINCT FROM 'true'
    OR NEW.collection_id IS DISTINCT FROM current_setting('burimunsi.collection_id',true) THEN
    RAISE EXCEPTION 'allocation_receipt_scope_required' USING ERRCODE='42501';
  END IF;
  INSERT INTO private.burimunsi_allocation_receipts(payment_id,collection_id) VALUES(NEW.id,NEW.collection_id)
    ON CONFLICT(payment_id) DO NOTHING;
  RETURN NULL;
END $fn$;
CREATE TRIGGER burimunsi_incoming_payment_allocated AFTER UPDATE OF member_id ON burimunsi.payments
  FOR EACH ROW WHEN (OLD.member_id IS NULL AND NEW.member_id IS NOT NULL AND NEW.direction='incoming')
  EXECUTE FUNCTION private._burimunsi_allocation_receipt();
ALTER TABLE burimunsi.payments ENABLE ALWAYS TRIGGER burimunsi_incoming_payment_allocated;

-- A destination must be in the payer evidence from the original successful
-- incoming SMS. The assigned member's own telephone is never a substitute.
CREATE FUNCTION private._burimunsi_allocation_contact(p_group text,p_payment text)
RETURNS TABLE(destination text,amount_rwf bigint,reference text,reason text)
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $fn$
  SELECT contact.phone,p.amount_rwf,p.provider_reference,
    CASE WHEN contact.phone IS NULL OR NOT EXISTS(
      SELECT FROM app.sms_receipts s JOIN app.momo_parse_attempts a ON a.raw_sms_id=s.id
        AND a.source_body_sha256=s.body_sha256 AND a.outcome='accepted'
      WHERE s.id=p.sms_source_id AND a.output_json::jsonb->>'event_kind'='incoming_receipt'
        AND private._burimunsi_payment_sms_phone(a.output_json::jsonb->>'payer_identifier_raw')=contact.phone
        AND strpos(a.output_json::jsonb#>>'{evidence,payer}',a.output_json::jsonb->>'payer_identifier_raw')>0
    ) THEN 'unverified_destination'
    WHEN EXISTS(SELECT FROM app.users u LEFT JOIN app.notification_preferences n ON n.user_id=u.id
      LEFT JOIN app.assisted_sms_authorizations auth ON auth.recipient_user_id=u.id AND auth.collection_id=p_group
      WHERE private._burimunsi_payment_sms_phone(u.momo_number)=contact.phone
        AND (n.payment_updates=0 OR auth.enabled=0 OR (auth.recipient_user_id IS NOT NULL AND
          (auth.destination_sha256 IS DISTINCT FROM encode(sha256(convert_to(contact.phone,'UTF8')),'hex')
           OR (auth.phone_verification_challenge_id IS NOT NULL
             AND private.managed_phone_binding(u.id,auth.phone_verification_challenge_id,contact.phone) IS DISTINCT FROM true)))
          OR EXISTS(SELECT FROM app.privacy_retention_barriers b WHERE b.subject_id=u.id))) THEN 'preferences_disabled'
    END
  FROM burimunsi.payments p
  CROSS JOIN LATERAL (SELECT private._burimunsi_payment_sms_phone(p.counterparty_identifier) AS phone) contact
  WHERE p.collection_id=p_group AND p.id=p_payment AND p.member_id IS NOT NULL AND p.direction='incoming'
$fn$;

CREATE FUNCTION private._burimunsi_due_allocation_receipts(p_group text,p_app text,p_at timestamptz)
RETURNS TABLE(payment_id text) LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $due$
  SELECT d.payment_id FROM private.burimunsi_allocation_receipts d
    LEFT JOIN collect_sms.messages m ON d.body_sha256 IS NOT NULL AND m.application_id=p_app AND m.kind='receipt'
      AND m.message_id=p_app||':allocation:'||d.attempt_id::text AND m.idempotency_key='allocation:'||d.attempt_id::text
    WHERE d.collection_id=p_group AND (d.application_id IS NULL OR d.application_id=p_app)
      AND (d.lease_until IS NULL OR d.lease_until<=p_at) AND (
       (d.status IN ('pending','gateway_accepted','sent','unknown') AND d.next_check_at<=p_at
        AND (d.body_sha256 IS NULL OR (d.inspections<12 AND d.send_before+interval '24 hours'>p_at)))
       OR (m.state IS NOT NULL AND m.state IS DISTINCT FROM d.gateway_hint AND m.state IS DISTINCT FROM d.provider_state
         AND d.status<>'delivered' AND (d.status NOT IN ('failed','expired') OR m.state='delivered')))
    ORDER BY d.next_check_at,d.allocated_at,d.payment_id LIMIT 32
$due$;
REVOKE ALL ON FUNCTION private._burimunsi_due_allocation_receipts(text,text,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer,collect_sms_runtime;

-- Claim metadata becomes externally usable only after a separate, one-use prepare.
-- An armed receipt always resumes with GET on the original gateway identity.
CREATE FUNCTION private.burimunsi_claim_allocation_sms(p_group text,p_enabled timestamptz,p_app text,p_request uuid,p_resume boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE
  r private.burimunsi_allocation_receipts%ROWTYPE; contact record;
  at timestamptz:=clock_timestamp(); admission uuid; current_work private.collect_fence_admissions%ROWTYPE;
  phase text; key text; result jsonb;
  previous_group text:=current_setting('burimunsi.collection_id',true);
  previous_inbox text:=current_setting('burimunsi.inbox_frame',true);
  previous_sms text:=current_setting('burimunsi.payment_sms_frame',true);
BEGIN
  PERFORM private._collect_fence_require_runtime();
  admission:=nullif(current_setting('collect.fence_admission_id',true),'')::uuid;
  IF p_request IS NULL OR admission IS NULL OR p_group IS NULL OR p_group !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    OR p_app IS NULL OR p_app !~ '^app_[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    OR p_enabled IS NULL OR NOT isfinite(p_enabled) OR p_resume IS NULL THEN
    RAISE EXCEPTION 'invalid_allocation_receipt_claim' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('burimunsi.collection_id',p_group,true),set_config('burimunsi.inbox_frame','1',true),
    set_config('burimunsi.payment_sms_frame','1',true);
  current_work:=private._collect_fence_admission(admission,nullif(current_setting('collect.fence_epoch',true),'')::bigint,
    current_setting('collect.fence_source_sha256',true));
  IF current_work.kind IS DISTINCT FROM 'jobs' THEN RAISE EXCEPTION 'burimunsi_auto_jobs_required' USING ERRCODE='42501'; END IF;
  PERFORM private.collect_fence_assert_write(current_work.admission_id,current_work.epoch,current_work.source_sha256);
  <<claim>>
  BEGIN
    IF NOT p_resume AND NOT EXISTS (SELECT FROM private._burimunsi_due_allocation_receipts(p_group,p_app,at)) THEN
      result:='[]'::jsonb; EXIT claim;
    END IF;
    -- Positive or uncertain work retains the full original writer guard. A second
    -- read after the lock handles another worker or an allocation committing first.
    PERFORM private.burimunsi_auto_jobs_guard();
    IF p_resume THEN
      SELECT * INTO r FROM private.burimunsi_allocation_receipts
      WHERE collection_id=p_group AND application_id=p_app AND claim_request=p_request AND claim_admission=admission
        AND lease_until>at FOR SHARE;
    ELSE
      SELECT d.* INTO r FROM private._burimunsi_due_allocation_receipts(p_group,p_app,clock_timestamp()) due
      JOIN private.burimunsi_allocation_receipts d USING(payment_id)
      ORDER BY d.next_check_at,d.allocated_at,d.payment_id LIMIT 1 FOR UPDATE OF d SKIP LOCKED;
    END IF;
    IF NOT FOUND THEN result:='[]'::jsonb; EXIT claim; END IF;
    phase:=CASE WHEN r.body_sha256 IS NULL THEN 'send' ELSE 'inspect' END;
    SELECT * INTO contact FROM private._burimunsi_allocation_contact(p_group,r.payment_id);
    IF phase='send' AND (NOT FOUND OR contact.reason IS NOT NULL OR r.allocated_at<p_enabled) THEN
      UPDATE private.burimunsi_allocation_receipts SET status='suppressed',
        reason=CASE WHEN r.allocated_at<p_enabled THEN 'before_activation' ELSE coalesce(contact.reason,'authority_changed') END,
        claim_token=NULL,claim_request=NULL,claim_admission=NULL,lease_until=NULL WHERE payment_id=r.payment_id;
      result:='[]'::jsonb; EXIT claim;
    END IF;
    IF NOT p_resume THEN
      -- Multiple assignments can commit in one transaction and share a single wake.
      IF EXISTS (SELECT FROM private.burimunsi_allocation_receipts d WHERE d.collection_id=p_group AND d.status='pending'
        AND d.payment_id<>r.payment_id AND (d.lease_until IS NULL OR d.lease_until<=at)) THEN
        INSERT INTO private.burimunsi_sms_wakes(event_xid) VALUES(pg_current_xact_id()) ON CONFLICT DO NOTHING;
      END IF;
      UPDATE private.burimunsi_allocation_receipts SET application_id=p_app,claim_token=gen_random_uuid(),
        claim_request=p_request,claim_admission=admission,lease_until=at+interval '45 seconds',
        send_before=CASE WHEN r.body_sha256 IS NULL AND (r.send_before IS NULL OR r.send_before<=at) THEN at+interval '24 hours' ELSE r.send_before END,
        destination_sha256=coalesce(r.destination_sha256,encode(sha256(convert_to(contact.destination,'UTF8')),'hex')),
        gateway_hint=coalesce((SELECT m.state FROM collect_sms.messages m WHERE m.application_id=p_app AND m.kind='receipt'
          AND m.message_id=p_app||':allocation:'||r.attempt_id::text AND m.idempotency_key='allocation:'||r.attempt_id::text),gateway_hint),
        inspections=inspections+CASE WHEN phase='inspect' THEN 1 ELSE 0 END
      WHERE payment_id=r.payment_id RETURNING * INTO r;
    END IF;
    key:='allocation:'||r.attempt_id::text;
    result:=jsonb_build_array(jsonb_build_object('attempt_id',r.attempt_id,'claim_token',r.claim_token,'phase',phase,
      'collection_id',p_group,'application_id',p_app,'message_id',p_app||':'||key,'idempotency_key',key,
      'destination',CASE WHEN phase='send' THEN contact.destination END,'destination_sha256',r.destination_sha256,
      'amount_rwf',contact.amount_rwf,'reference',contact.reference,'body_sha256',r.body_sha256,
      'not_after',to_char((r.send_before) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  END claim;
  PERFORM set_config('burimunsi.collection_id',coalesce(previous_group,''),true),
    set_config('burimunsi.inbox_frame',coalesce(previous_inbox,''),true),
    set_config('burimunsi.payment_sms_frame',coalesce(previous_sms,''),true);
  RETURN result;
END $fn$;


CREATE FUNCTION private.burimunsi_prepare_allocation_sms(p_group text,p_attempt uuid,p_token uuid,p_hash text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE r private.burimunsi_allocation_receipts%ROWTYPE; contact record; result text;
  previous_group text:=current_setting('burimunsi.collection_id',true);
  previous_inbox text:=current_setting('burimunsi.inbox_frame',true);
BEGIN
  PERFORM private.burimunsi_auto_jobs_guard();
  IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid_receipt_body'; END IF;
  PERFORM set_config('burimunsi.collection_id',p_group,true),set_config('burimunsi.inbox_frame','1',true);
  -- The jobs guard serializes the contact recheck with opt-out and allocation
  -- writers. The transaction ends before the gateway receives an HTTP call.
  <<prepare>>
  BEGIN
    SELECT * INTO r FROM private.burimunsi_allocation_receipts WHERE collection_id=p_group AND attempt_id=p_attempt
      AND claim_token=p_token AND claim_admission=nullif(current_setting('collect.fence_admission_id',true),'')::uuid
      AND body_sha256 IS NULL AND status='pending' AND lease_until>clock_timestamp() AND send_before>clock_timestamp() FOR UPDATE;
    IF NOT FOUND THEN result:='held'; EXIT prepare; END IF;
    SELECT * INTO contact FROM private._burimunsi_allocation_contact(p_group,r.payment_id);
    IF NOT FOUND OR contact.reason IS NOT NULL OR r.destination_sha256 IS DISTINCT FROM encode(sha256(convert_to(contact.destination,'UTF8')),'hex') THEN
      UPDATE private.burimunsi_allocation_receipts SET status='suppressed',reason=coalesce(contact.reason,'authority_changed'),
        claim_token=NULL,claim_request=NULL,claim_admission=NULL,lease_until=NULL WHERE payment_id=r.payment_id;
      result:='suppressed'; EXIT prepare;
    END IF;
    UPDATE private.burimunsi_allocation_receipts SET body_sha256=p_hash,status='unknown',reason='gateway_unconfirmed'
      WHERE payment_id=r.payment_id;
    result:='prepared';
  END prepare;
  PERFORM set_config('burimunsi.collection_id',coalesce(previous_group,''),true),
    set_config('burimunsi.inbox_frame',coalesce(previous_inbox,''),true);
  RETURN result;
END $fn$;

CREATE FUNCTION private.burimunsi_finish_allocation_sms(p_group text,p_attempt uuid,p_token uuid,p_state text,p_provider text,p_evidence text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE lane text; why text; saved boolean; previous_group text:=current_setting('burimunsi.collection_id',true);
BEGIN
  PERFORM private.burimunsi_auto_jobs_guard();
  IF p_state IS NULL OR p_state NOT IN ('accepted','suppressed','unknown') THEN RETURN false; END IF;
  IF p_state='accepted' THEN
    IF p_evidence IS NULL OR p_evidence !~ '^[a-f0-9]{64}$' OR p_provider IS NULL OR
      p_provider NOT IN ('accepted','assigned','phone_accepted','queued','handoff_started','sent','delivered',
        'delivery_unconfirmed','partial','outcome_unknown','expired','cancelled','failed') THEN RETURN false; END IF;
    lane:=CASE WHEN p_provider IN ('accepted','assigned','phone_accepted','queued','handoff_started') THEN 'gateway_accepted'
      WHEN p_provider IN ('sent','delivered','expired') THEN p_provider
      WHEN p_provider IN ('cancelled','failed') THEN 'failed' ELSE 'unknown' END;
    why:=CASE WHEN p_provider IN ('cancelled','failed','expired') THEN 'gateway_'||p_provider
      WHEN lane='unknown' THEN 'gateway_unconfirmed' END;
  ELSE
    IF p_evidence IS NOT NULL OR p_provider IS NOT NULL THEN RETURN false; END IF;
    lane:=p_state;
    why:=CASE WHEN lane='suppressed' THEN 'claim_suppressed' ELSE 'gateway_unconfirmed' END;
  END IF;
  PERFORM set_config('burimunsi.collection_id',p_group,true);
  UPDATE private.burimunsi_allocation_receipts SET
    status=CASE WHEN p_state='unknown' AND evidence_sha256 IS NOT NULL THEN status ELSE lane END,
    reason=CASE WHEN p_state='unknown' AND evidence_sha256 IS NOT NULL THEN reason ELSE why END,
    provider_state=coalesce(p_provider,provider_state),evidence_sha256=coalesce(p_evidence,evidence_sha256),
    claim_token=NULL,claim_request=NULL,claim_admission=NULL,lease_until=NULL,
    next_check_at=clock_timestamp()+ make_interval(secs=>least(300, power(2,least(inspections,9))::integer))
  WHERE collection_id=p_group AND attempt_id=p_attempt AND claim_token=p_token
    AND claim_admission=nullif(current_setting('collect.fence_admission_id',true),'')::uuid
    AND ((p_state='suppressed' AND body_sha256 IS NULL) OR (p_state<>'suppressed' AND body_sha256 IS NOT NULL));
  saved:=FOUND;
  PERFORM set_config('burimunsi.collection_id',coalesce(previous_group,''),true);
  RETURN saved;
END $fn$;

-- Preserve the current Admin projection, including its collection and page
-- checks. Requesting payer outcomes additionally requires Payments read access.
CREATE FUNCTION private.burimunsi_admin_payment_observation_outcomes(p_collection text,p_sources text[],p_payer boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE base jsonb; result jsonb;
  previous_group text:=current_setting('burimunsi.collection_id',true);
  previous_frame text:=current_setting('burimunsi.native_receipt_frame',true);
BEGIN
  base:=private.burimunsi_admin_payment_observation_outcomes(p_collection,p_sources);
  IF NOT coalesce(p_payer,false) THEN RETURN base; END IF;
  IF nullif(current_setting('burimunsi.browser_pin_cookie',true),'') IS NOT NULL THEN
    PERFORM private.burimunsi_browser_pin_assert_actor('payments.read',p_collection,'admin',1,NULL);
  ELSE
    PERFORM private.assert_actor('payments.read',NULL,NULL,1,NULL);
  END IF;
  PERFORM set_config('burimunsi.collection_id',p_collection,true),set_config('burimunsi.native_receipt_frame','1',true);
  SELECT coalesce(jsonb_agg(i.item||jsonb_build_object('payerStatus',r.status,'payerReason',r.reason)
    ORDER BY i.ord),'[]'::jsonb) INTO result
  FROM jsonb_array_elements(base) WITH ORDINALITY i(item,ord)
  LEFT JOIN private.burimunsi_auto_sms_jobs j ON j.source_id=i.item->>'sourceId' AND j.collection_id=p_collection
    AND j.relation IN ('accepted','duplicate')
  LEFT JOIN private.burimunsi_allocation_receipts r ON r.collection_id=p_collection AND r.payment_id=coalesce(j.payment_id,j.transaction_id);
  PERFORM set_config('burimunsi.collection_id',coalesce(previous_group,''),true),
    set_config('burimunsi.native_receipt_frame',coalesce(previous_frame,''),true);
  RETURN result;
END $fn$;

REVOKE ALL ON FUNCTION private._burimunsi_allocation_receipt(),private._burimunsi_allocation_contact(text,text),
  private.burimunsi_claim_allocation_sms(text,timestamptz,text,uuid,boolean),private.burimunsi_prepare_allocation_sms(text,uuid,uuid,text),
  private.burimunsi_finish_allocation_sms(text,uuid,uuid,text,text,text),private.burimunsi_admin_payment_observation_outcomes(text,text[],boolean)
  FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer,collect_sms_runtime;
GRANT EXECUTE ON FUNCTION private.burimunsi_claim_allocation_sms(text,timestamptz,text,uuid,boolean),
  private.burimunsi_prepare_allocation_sms(text,uuid,uuid,text),private.burimunsi_finish_allocation_sms(text,uuid,uuid,text,text,text),
  private.burimunsi_admin_payment_observation_outcomes(text,text[],boolean) TO collect_runtime;

-- Publish a committed allocation immediately through the existing signed
-- dispatcher. A lost response, exhausted lease or carrier update also wakes the
-- original attempt. The existing single-flight, one-second fallback is retained.
DO $wake$
DECLARE body text; definition text; anchor text:='  IF TG_NAME=''burimunsi_wake_payer_retry'' THEN';
  tables text:='''private.burimunsi_auto_sms_jobs''::regclass,''private.burimunsi_payment_sms_deliveries''::regclass)';
  branch text:=$change$
  IF TG_NAME='burimunsi_wake_allocation_check' THEN
    IF NEW.status NOT IN ('pending','gateway_accepted','sent','unknown') OR
      (NEW.body_sha256 IS NOT NULL AND NEW.inspections>=12 AND NEW.lease_until IS NULL) THEN RETURN NULL; END IF;
    due:=greatest(NEW.next_check_at,NEW.lease_until);
  ELSIF TG_NAME='burimunsi_wake_payer_retry' THEN$change$;
BEGIN
  SELECT prosrc,pg_get_functiondef(oid) INTO STRICT body,definition FROM pg_proc
    WHERE oid='private._burimunsi_wake_sms_worker()'::regprocedure AND prosecdef AND proowner='postgres'::regrole;
  IF length(body)-length(replace(body,tables,''))<>length(tables) OR
     length(body)-length(replace(body,anchor,''))<>length(anchor) THEN RAISE EXCEPTION 'allocation_sms_wake_preimage_changed'; END IF;
  EXECUTE replace(definition,body,replace(replace(body,tables,substr(tables,1,length(tables)-1)||
    ',''private.burimunsi_allocation_receipts''::regclass)'),anchor,ltrim(branch,chr(10))));
END $wake$;
CREATE CONSTRAINT TRIGGER burimunsi_wake_allocation AFTER INSERT ON private.burimunsi_allocation_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private._burimunsi_wake_sms_worker();
CREATE CONSTRAINT TRIGGER burimunsi_wake_allocation_check AFTER UPDATE ON private.burimunsi_allocation_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((OLD.lease_until,OLD.next_check_at) IS DISTINCT FROM (NEW.lease_until,NEW.next_check_at))
  EXECUTE FUNCTION private._burimunsi_wake_sms_worker();
CREATE CONSTRAINT TRIGGER burimunsi_wake_allocation_gateway AFTER UPDATE ON collect_sms.messages
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind='receipt' AND NEW.idempotency_key LIKE 'allocation:%'
    AND OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION private._burimunsi_wake_sms_worker();
CREATE TRIGGER burimunsi_live_allocation_receipt AFTER INSERT ON private.burimunsi_allocation_receipts
  FOR EACH ROW EXECUTE FUNCTION private._burimunsi_admin_live_change();
CREATE TRIGGER burimunsi_live_allocation_progress AFTER UPDATE OF status,reason ON private.burimunsi_allocation_receipts
  FOR EACH ROW WHEN ((OLD.status,OLD.reason) IS DISTINCT FROM (NEW.status,NEW.reason)) EXECUTE FUNCTION private._burimunsi_admin_live_change();
COMMIT;
