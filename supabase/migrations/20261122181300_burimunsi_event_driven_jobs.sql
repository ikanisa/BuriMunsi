BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $preflight$
BEGIN
  PERFORM private._collect_fence_require_operator();
  IF NOT EXISTS (SELECT 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced')
     OR NOT EXISTS (SELECT 1 FROM collect_ops.jobs_config c JOIN cron.job j ON j.jobid=c.cron_job_id
       WHERE c.singleton AND NOT c.enabled AND NOT j.active AND j.schedule='* * * * *'
         AND j.jobname='collect-jobs-maintenance-v1' AND j.command='SELECT collect_ops.tick_jobs();')
     OR EXISTS (SELECT 1 FROM collect_ops.jobs_dispatches WHERE state IN ('awaiting','unconfirmed')) THEN
    RAISE EXCEPTION 'burimunsi_fast_jobs_requires_drained_release';
  END IF;
END $preflight$;

-- One opaque wake per transaction. The financial and inbox data stay in the
-- source journals. An aborted transaction publishes neither the wake nor HTTP.
CREATE TABLE private.burimunsi_sms_wakes (
  event_xid xid8 NOT NULL,
  wake_class smallint NOT NULL DEFAULT 0 CHECK(wake_class IN (0,1)),
  due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(event_xid,wake_class)
);
CREATE INDEX burimunsi_sms_wakes_due ON private.burimunsi_sms_wakes(due_at,event_xid,wake_class);
ALTER TABLE private.burimunsi_sms_wakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.burimunsi_sms_wakes FORCE ROW LEVEL SECURITY;
CREATE POLICY burimunsi_sms_wakes_owner ON private.burimunsi_sms_wakes TO postgres USING (true) WITH CHECK (true);
REVOKE ALL ON private.burimunsi_sms_wakes FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer,collect_sms_runtime;

-- pg_net queues and numeric request IDs change across a server restart.
-- Retain the transport gap and resolve only an original, source-bound settled
-- Edge completion or a ticket whose claim window expired without a claim.
CREATE FUNCTION private._burimunsi_settle_lost_sms_transport() RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE original record; active_epoch text:=collect_ops.native_jobs_epoch(); result text; proof text; wait_for_original boolean:=false;
BEGIN
  PERFORM private._collect_fence_require_operator();
  IF active_epoch IS NULL THEN RETURN false;END IF;
  FOR original IN
    SELECT d.id,d.native_epoch,t.source_sha256,t.claimed_at,t.admission_id,t.completed_at,t.response_sha256,t.expires_at,
      a.state AS admission_state,a.reason AS admission_reason,a.uncertain_dispatches
    FROM collect_ops.jobs_dispatches d
    JOIN private.collect_managed_job_tickets t ON t.dispatch_id=d.id AND t.payload->>'dispatch_id'=d.id::text
    JOIN private.collect_fence_control f ON f.singleton AND f.mode='open' AND f.source_sha256=t.source_sha256
    LEFT JOIN private.collect_fence_admissions a ON a.admission_id=t.admission_id AND a.epoch=f.epoch
      AND a.source_sha256=t.source_sha256 AND a.kind='jobs'
    WHERE d.kind='scheduled' AND d.state='awaiting' AND d.native_epoch<>active_epoch
    ORDER BY d.created_at LIMIT 20 FOR UPDATE OF d,t
  LOOP
    result:=NULL;
    IF original.claimed_at IS NOT NULL AND original.completed_at>=original.claimed_at
      AND original.response_sha256 ~ '^[a-f0-9]{64}$' AND original.admission_state='settled'
      AND original.admission_reason='completed' AND original.uncertain_dispatches=0 THEN
      result:='transport_lost_edge_completed';
    ELSIF original.claimed_at IS NULL AND original.admission_id IS NULL AND original.completed_at IS NULL
      AND original.expires_at<=clock_timestamp() THEN
      result:='transport_lost_ticket_expired_unclaimed';
    ELSIF original.expires_at>clock_timestamp() AND (original.claimed_at IS NULL OR original.admission_state='active') THEN
      wait_for_original:=true;
    END IF;
    IF result IS NOT NULL THEN
      proof:=encode(sha256(convert_to(jsonb_build_array(result,original.id,original.native_epoch,
        active_epoch,original.source_sha256,original.admission_id,original.expires_at,original.claimed_at,
        original.completed_at,original.response_sha256)::text,'UTF8')),'hex');
      INSERT INTO private.collect_fence_scheduler_lifecycle(dispatch_id,native_epoch,evidence_sha256,review_operation_id)
        VALUES(original.id,original.native_epoch,proof,original.id) ON CONFLICT(dispatch_id) DO NOTHING;
      IF NOT EXISTS(SELECT 1 FROM private.collect_fence_scheduler_lifecycle
        WHERE dispatch_id=original.id AND native_epoch=original.native_epoch AND evidence_sha256=proof) THEN CONTINUE; END IF;
      UPDATE collect_ops.jobs_dispatches SET state='reviewed_unknown',reason=result,http_status=NULL,
        response_sha256=original.response_sha256,maintenance_purged=NULL,observed_at=clock_timestamp(),
        resolution_evidence_sha256=proof
      WHERE id=original.id AND state='awaiting';
    END IF;
  END LOOP;
  RETURN wait_for_original;
END;$fn$;
REVOKE ALL ON FUNCTION private._burimunsi_settle_lost_sms_transport() FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer,collect_sms_runtime;

-- Reuse the already qualified HMAC, Vault key, quota, native transport,
-- duplicate-slot and original-response checks. Only the bounded table trigger
-- below can request a signal dispatch. The ordinary operator entry is retained.
DO $update_dispatch$
DECLARE original text; candidate text; at_guard text; with_guard text;
BEGIN
  SELECT prosrc INTO STRICT original FROM pg_proc WHERE oid='collect_ops.dispatch_jobs(text,uuid)'::regprocedure
    AND proowner='postgres'::regrole AND NOT prosecdef AND proacl::text='{postgres=X/postgres}';
  IF encode(sha256(convert_to(original,'UTF8')),'hex')<>'00e49b5d9603cd8564555252cc62b23d667fd9f611c558c46459e4b7580d9f72' THEN
    RAISE EXCEPTION 'burimunsi_fast_dispatch_preimage_changed';
  END IF;
  at_guard:='PERFORM private.collect_fence_assert_write(NULL,NULL,NULL);';
  with_guard:=$body$
  IF signal THEN
    IF pg_trigger_depth()<1 OR current_setting('burimunsi.sms_wake_frame',true) IS DISTINCT FROM '1'
      OR current_setting('role',true) IS DISTINCT FROM 'collect_runtime' THEN
      RAISE EXCEPTION 'invalid_internal_wake' USING ERRCODE='42501';
    END IF;
    bound_source:=nullif(current_setting('collect.fence_source_sha256',true),'');
    PERFORM private.collect_fence_assert_write(nullif(current_setting('collect.fence_admission_id',true),'')::uuid,
      nullif(current_setting('collect.fence_epoch',true),'')::bigint,bound_source);
    p_kind:='scheduled';
  ELSE
    PERFORM private.collect_fence_assert_write(NULL,NULL,NULL);
    bound_source:=private.collect_fence_owner_status()->>'sourceSha256';
  END IF;$body$;
  candidate:=replace(original,'DECLARE c collect_ops.jobs_config%ROWTYPE;',
    'DECLARE signal boolean:=p_kind=''signal''; bound_source text; c collect_ops.jobs_config%ROWTYPE;');
  candidate:=replace(candidate,'private.collect_fence_owner_status()->>''sourceSha256''','bound_source');
  candidate:=replace(candidate,at_guard,with_guard);
  candidate:=replace(candidate,'PERFORM collect_ops.reconcile_jobs();',
    'IF NOT signal THEN IF private._burimunsi_settle_lost_sms_transport() THEN RETURN jsonb_build_object(''state'',''awaiting_original''); END IF; PERFORM collect_ops.reconcile_jobs(); END IF;');
  candidate:=replace(candidate,'to_timestamp(floor(extract(epoch FROM clock_timestamp())/60)*60)',
    'date_trunc(''second'',clock_timestamp())');
  IF strpos(candidate,'DECLARE signal boolean')=0 OR strpos(candidate,with_guard)=0
    OR strpos(candidate,'IF NOT signal THEN IF private._burimunsi_settle_lost_sms_transport() THEN RETURN jsonb_build_object(''state'',''awaiting_original''); END IF; PERFORM collect_ops.reconcile_jobs(); END IF;')=0
    OR strpos(candidate,'date_trunc(''second'',clock_timestamp())')=0
    OR strpos(candidate,'/60)*60')>0 THEN RAISE EXCEPTION 'burimunsi_fast_dispatch_source_changed'; END IF;
  EXECUTE format('CREATE FUNCTION private._burimunsi_dispatch_sms_job(p_kind text,p_dispatch_id uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS %L',candidate);
  SELECT prosrc INTO STRICT original FROM pg_proc WHERE oid='collect_ops.activate_jobs(text)'::regprocedure;
  IF encode(sha256(convert_to(original,'UTF8')),'hex')<>'18fb407a536fa422aa539a15b161c75af638a295159f020eebc5af1692c188d3'
    THEN RAISE EXCEPTION 'burimunsi_fast_activate_preimage_changed'; END IF;
  candidate:=replace(original,'schedule=''* * * * *''','schedule=''1 second''');
  IF candidate=original THEN RAISE EXCEPTION 'burimunsi_fast_activate_source_changed'; END IF;
  EXECUTE format('CREATE OR REPLACE FUNCTION collect_ops.activate_jobs(p_evidence_sha256 text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS %L',candidate);
END $update_dispatch$;

REVOKE ALL ON FUNCTION private._burimunsi_dispatch_sms_job(text,uuid) FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer,collect_sms_runtime;

CREATE OR REPLACE FUNCTION collect_ops.dispatch_jobs(p_kind text,p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
 -- collect_fence_sql2_write_guard_v1
 PERFORM private.collect_fence_assert_write(NULL,NULL,NULL);
 IF p_kind IS NULL OR p_kind NOT IN ('probe','scheduled') THEN RAISE EXCEPTION 'invalid_operator_dispatch' USING ERRCODE='42501';END IF;
 RETURN private._burimunsi_dispatch_sms_job(p_kind,p_dispatch_id);
END;$fn$;

CREATE FUNCTION private._burimunsi_wake_sms_worker() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $function$
DECLARE event_id xid8:=pg_current_xact_id(); result jsonb; dispatch_id uuid; due timestamptz;
  prior_frame text:=current_setting('burimunsi.sms_wake_frame',true);
BEGIN
  IF TG_RELID NOT IN ('private.burimunsi_unresolved_observations'::regclass,'app.sms_receipts'::regclass,
    'private.burimunsi_payment_sms_obligations'::regclass,'collect_sms.messages'::regclass,
    'private.burimunsi_auto_sms_jobs'::regclass,'private.burimunsi_payment_sms_deliveries'::regclass) THEN
    RAISE EXCEPTION 'invalid_sms_wake_source'; END IF;
  IF TG_NAME='burimunsi_wake_payer_retry' THEN
    IF NEW.state='sending' AND NEW.body_sha256 IS NULL AND NEW.last_claimed_phase='send' AND NEW.lease_until IS NOT NULL THEN
      -- The database claim can outlive its worker before a carrier request is armed.
      due:=NEW.lease_until;
    ELSE
      IF NEW.body_sha256 IS NULL OR NEW.state NOT IN('sending','accepted','unknown') OR NEW.inspect_count>=12
        OR NEW.provider_state IN('delivered','failed','cancelled','expired','delivery_unconfirmed') THEN RETURN NULL; END IF;
      due:=greatest(NEW.next_inspect_at,NEW.lease_until);
    END IF;
  ELSIF TG_NAME='burimunsi_wake_native_retry' THEN
    SELECT min(to_timestamp(at_ms/1000.0)) INTO due FROM unnest(ARRAY[NEW.next_attempt_at,NEW.posting_next_attempt_at]) at_ms
      WHERE at_ms>extract(epoch FROM clock_timestamp())*1000;
    IF due IS NULL THEN RETURN NULL;END IF;
  END IF;
  IF due IS NOT NULL AND due>clock_timestamp() THEN
    INSERT INTO private.burimunsi_sms_wakes(event_xid,wake_class,due_at) VALUES(event_id,1,due)
    ON CONFLICT(event_xid,wake_class) DO UPDATE SET due_at=least(burimunsi_sms_wakes.due_at,excluded.due_at);
    RETURN NULL;
  END IF;
  INSERT INTO private.burimunsi_sms_wakes(event_xid) VALUES(event_id) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- The secondary gateway role has a separate admission. Its durable event is
  -- collected by the next local one-second tick. No job privilege is delegated.
  IF current_setting('role',true) IS DISTINCT FROM 'collect_runtime'
    OR current_setting('collect.edge_verified',true) IS DISTINCT FROM 'true'
    OR NOT EXISTS (SELECT 1 FROM collect_ops.jobs_config WHERE singleton AND enabled)
    OR EXISTS (SELECT 1 FROM collect_ops.jobs_dispatches WHERE state IN ('awaiting','unconfirmed'))
    OR NOT pg_try_advisory_xact_lock(hashtextextended('collect.scheduler.rrlduytparvsjfmegalh',0))
    THEN RETURN NULL; END IF;
  BEGIN
    PERFORM set_config('burimunsi.sms_wake_frame','1',true);
    dispatch_id:=gen_random_uuid();
    result:=private._burimunsi_dispatch_sms_job('signal',dispatch_id);
    PERFORM set_config('burimunsi.sms_wake_frame',coalesce(prior_frame,''),true);
    IF result->>'state'='awaiting' AND (result->>'dispatch_id')::uuid=dispatch_id
       AND NOT coalesce((result->>'replayed')::boolean,false) THEN
      DELETE FROM private.burimunsi_sms_wakes WHERE event_xid=event_id AND wake_class=0;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- The business commit and queued wake survive a temporary dispatch failure.
    PERFORM set_config('burimunsi.sms_wake_frame',coalesce(prior_frame,''),true);
  END;
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION private._burimunsi_wake_sms_worker() FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer,collect_sms_runtime;

CREATE CONSTRAINT TRIGGER burimunsi_wake_observation AFTER INSERT ON private.burimunsi_unresolved_observations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private._burimunsi_wake_sms_worker();
CREATE CONSTRAINT TRIGGER burimunsi_wake_gateway_receipt AFTER INSERT ON app.sms_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private._burimunsi_wake_sms_worker();
CREATE CONSTRAINT TRIGGER burimunsi_wake_payer_obligation AFTER INSERT ON private.burimunsi_payment_sms_obligations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.disposition='eligible') EXECUTE FUNCTION private._burimunsi_wake_sms_worker();
CREATE CONSTRAINT TRIGGER burimunsi_wake_payment_stage AFTER UPDATE ON private.burimunsi_auto_sms_jobs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((OLD.state,OLD.phase) IS DISTINCT FROM (NEW.state,NEW.phase))
  EXECUTE FUNCTION private._burimunsi_wake_sms_worker();
CREATE CONSTRAINT TRIGGER burimunsi_wake_delivery_event AFTER UPDATE ON collect_sms.messages
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind='receipt' AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION private._burimunsi_wake_sms_worker();
CREATE CONSTRAINT TRIGGER burimunsi_wake_payer_retry AFTER INSERT OR UPDATE ON private.burimunsi_payment_sms_deliveries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private._burimunsi_wake_sms_worker();
CREATE CONSTRAINT TRIGGER burimunsi_wake_native_retry AFTER UPDATE ON private.burimunsi_auto_sms_jobs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((OLD.next_attempt_at,OLD.posting_next_attempt_at) IS DISTINCT FROM (NEW.next_attempt_at,NEW.posting_next_attempt_at))
  EXECUTE FUNCTION private._burimunsi_wake_sms_worker();

CREATE OR REPLACE FUNCTION collect_ops.tick_jobs() RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE wake_id xid8; wake_class_id smallint; result jsonb; dispatch_id uuid; last_slot timestamptz; heartbeat boolean; c collect_ops.jobs_config%ROWTYPE;
BEGIN
 -- collect_fence_sql2_write_guard_v1
 PERFORM private.collect_fence_assert_write(NULL,NULL,NULL);
  -- An idle tick only checks the write fence and indexed work records. Full maintenance keeps a one-minute
  -- heartbeat while actual payments can use every second or the commit wake.
  SELECT slot INTO last_slot FROM collect_ops.jobs_dispatches WHERE slot IS NOT NULL ORDER BY slot DESC LIMIT 1;
  heartbeat:=last_slot IS NULL OR last_slot<=clock_timestamp()-interval '60 seconds';
  IF NOT heartbeat AND NOT EXISTS (SELECT 1 FROM private.burimunsi_sms_wakes WHERE due_at<=statement_timestamp())
    AND NOT EXISTS (SELECT 1 FROM collect_ops.jobs_dispatches WHERE state='awaiting') THEN
    RETURN jsonb_build_object('state','idle');
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('collect.scheduler.rrlduytparvsjfmegalh',0)) THEN
    RETURN jsonb_build_object('state','busy');
  END IF;
  SELECT * INTO STRICT c FROM collect_ops.jobs_config WHERE singleton;
  IF NOT c.enabled THEN RETURN jsonb_build_object('state','disabled'); END IF;
  IF EXISTS (SELECT 1 FROM collect_ops.jobs_dispatches WHERE state='awaiting') THEN
    IF private._burimunsi_settle_lost_sms_transport() THEN RETURN jsonb_build_object('state','awaiting_original');END IF;
    PERFORM collect_ops.reconcile_jobs();
  END IF;
  IF EXISTS (SELECT 1 FROM collect_ops.jobs_dispatches WHERE state IN ('awaiting','unconfirmed')) THEN
    RETURN jsonb_build_object('state','awaiting_confirmation');
  END IF;
  SELECT event_xid,wake_class INTO wake_id,wake_class_id FROM private.burimunsi_sms_wakes WHERE due_at<=statement_timestamp()
   ORDER BY due_at,event_xid,wake_class LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF wake_id IS NULL AND NOT heartbeat THEN RETURN jsonb_build_object('state','idle'); END IF;
  IF heartbeat THEN
    DELETE FROM collect_ops.jobs_dispatches WHERE id IN (SELECT id FROM collect_ops.jobs_dispatches
      WHERE state IN ('confirmed','reviewed_unknown','rejected') AND id IS DISTINCT FROM c.last_probe_id
        AND created_at<clock_timestamp()-interval '30 days' AND created_at<date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      ORDER BY created_at LIMIT 500);
    DELETE FROM cron.job_run_details WHERE runid IN (SELECT runid FROM cron.job_run_details
      WHERE jobid=c.cron_job_id AND (end_time<clock_timestamp()-interval '7 days' OR
        (status='succeeded' AND end_time<clock_timestamp()-interval '24 hours'))
      ORDER BY end_time LIMIT 500);
  END IF;
  dispatch_id:=gen_random_uuid();
  result:=collect_ops.dispatch_jobs('scheduled',dispatch_id);
  IF wake_id IS NOT NULL AND result->>'state'='awaiting' AND (result->>'dispatch_id')::uuid=dispatch_id
     AND NOT coalesce((result->>'replayed')::boolean,false) THEN
    DELETE FROM private.burimunsi_sms_wakes WHERE event_xid=wake_id AND wake_class=wake_class_id;
  END IF;
  RETURN result;
END $function$;

-- Wakes carry only transaction identity and due time. Keep the operational
-- class visible to the existing retention inventory while outstanding.
DO $inventory$
DECLARE body text; definition text; entry jsonb;
  anchor text:='''private:burimunsi_payment_sms_deliveries'',';
BEGIN
  SELECT prosrc,pg_get_functiondef(oid) INTO STRICT body,definition FROM pg_proc
    WHERE oid='private._retention_manifest_catalog_v2()'::regprocedure AND proowner='postgres'::regrole;
  entry:=jsonb_build_object('name','private:burimunsi_sms_wakes','relation','private.burimunsi_sms_wakes',
    'scope','unmapped_private','purpose','Transient work notification cleared after signed dispatch',
    'known_links','Transaction ID and due time only','blocked',true);
  EXECUTE replace(definition,body,format('SELECT jsonb_set(base,''{private_classes}'',(base->''private_classes'')||%L::jsonb) FROM (%s) prior(base)',
    jsonb_build_array(entry)::text,rtrim(body,E'; \t\r\n')));
  SELECT prosrc,pg_get_functiondef(oid) INTO STRICT body,definition FROM pg_proc
    WHERE oid='private.retention_capture_inventory_v2(uuid,text,bigint,text,integer)'::regprocedure AND proowner='postgres'::regrole;
  IF length(body)-length(replace(body,anchor,''))<>length(anchor) THEN RAISE EXCEPTION 'sms_wake_retention_inventory_changed';END IF;
  EXECUTE replace(definition,body,replace(body,anchor,'''private:burimunsi_sms_wakes'','||anchor));
END;$inventory$;

DO $cadence$
DECLARE c collect_ops.jobs_config%ROWTYPE;
BEGIN
  SELECT * INTO STRICT c FROM collect_ops.jobs_config WHERE singleton FOR UPDATE;
  PERFORM cron.alter_job(c.cron_job_id,schedule:='1 second',active:=false);
END $cadence$;
COMMIT;
