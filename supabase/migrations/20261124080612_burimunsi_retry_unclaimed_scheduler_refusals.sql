-- An HTTP capacity refusal before the signed job claim has no business effects.
-- Serialize that refusal with a concurrent claim on the original dispatch row.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '8s';

DO $migration$
DECLARE
  body text;
  definition text;
  claim_anchor text := 'UPDATE private.collect_managed_job_tickets t SET claimed_at=clock_timestamp(),admission_id=v_admission';
  parse_anchor text := 'IF r.content IS NOT NULL THEN BEGIN payload:=r.content::jsonb;EXCEPTION WHEN OTHERS THEN payload:=NULL;END;END IF;';
BEGIN
  PERFORM private._collect_fence_require_operator();
  IF NOT EXISTS (
    SELECT 1 FROM private.collect_fence_control f
    JOIN collect_ops.jobs_config c USING (singleton) JOIN cron.job j ON j.jobid=c.cron_job_id
    WHERE f.singleton AND f.mode='fenced' AND f.project_ref='rrlduytparvsjfmegalh'
      AND NOT c.enabled AND NOT j.active AND j.schedule='1 second'
  ) OR EXISTS (SELECT 1 FROM collect_ops.jobs_dispatches WHERE state IN ('awaiting','unconfirmed')) THEN
    RAISE EXCEPTION 'unclaimed_job_refusal_requires_drained_scheduler' USING ERRCODE='55000';
  END IF;
  SELECT prosrc,pg_get_functiondef(oid) INTO STRICT body,definition FROM pg_proc
    WHERE oid='private.collect_managed_job_claim(uuid,text,jsonb,text)'::regprocedure
      AND proowner='postgres'::regrole AND prosecdef
      AND proconfig=ARRAY['search_path=pg_catalog, pg_temp']
      AND proacl::text='{postgres=X/postgres,collect_runtime=X/postgres}';
  IF encode(sha256(convert_to(body,'UTF8')),'hex')<>'13ce1596e112128f08727dd6e5594ad1e82c8630e00166a2b336a04e4df3fe76'
     OR strpos(body,claim_anchor)=0 THEN RAISE EXCEPTION 'managed_job_claim_preimage_changed'; END IF;
  EXECUTE replace(definition,body,replace(body,claim_anchor,$lock$PERFORM 1 FROM collect_ops.jobs_dispatches d
  WHERE d.id=p_dispatch AND d.state='awaiting' AND d.net_request_id IS NOT NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 $lock$ || claim_anchor));

  SELECT prosrc,pg_get_functiondef(oid) INTO STRICT body,definition FROM pg_proc
    WHERE oid='collect_ops.reconcile_jobs()'::regprocedure AND proowner='postgres'::regrole
      AND NOT prosecdef AND proconfig=ARRAY['search_path=pg_catalog'] AND proacl::text='{postgres=X/postgres}';
  IF encode(sha256(convert_to(body,'UTF8')),'hex')<>'7178d8d2dad63f00f2503c160280d222da80869f156063419f2b3e21d6ae1554'
     OR strpos(body,parse_anchor)=0 THEN RAISE EXCEPTION 'managed_jobs_reconcile_preimage_changed'; END IF;
  EXECUTE replace(definition,body,replace(body,parse_anchor,parse_anchor || $refusal$
   -- The enclosing loop holds the same dispatch FOR UPDATE as the signed claim.
   -- A winning claim forces normal uncertainty handling. A winning refusal
   -- closes this ticket before any late worker can start work.
   IF d.kind='scheduled' AND r.status_code=503 AND r.timed_out IS FALSE AND NOT r.failed
     AND payload->>'code'='application_fence_unavailable'
     AND NOT EXISTS (SELECT 1 FROM net.http_request_queue WHERE id=d.net_request_id)
     AND EXISTS (SELECT 1 FROM private.collect_managed_job_tickets t
       JOIN private.collect_fence_control f ON f.singleton AND f.mode='open' AND f.source_sha256=t.source_sha256
       WHERE t.dispatch_id=d.id AND t.payload->>'dispatch_id'=d.id::text AND t.claimed_at IS NULL
         AND t.admission_id IS NULL AND t.completed_at IS NULL AND t.response_sha256 IS NULL AND t.native_provider_calls=0)
   THEN
    DECLARE
      previous record;
      retry_seconds integer := 1;
      reply_hash text := encode(sha256(convert_to(r.content,'UTF8')),'hex');
    BEGIN
      FOR previous IN SELECT reason FROM collect_ops.jobs_dispatches
        WHERE slot<d.slot ORDER BY slot DESC LIMIT 5 LOOP
        EXIT WHEN previous.reason IS DISTINCT FROM 'admission_refused_before_claim';
        retry_seconds:=retry_seconds*2;
      END LOOP;
      UPDATE collect_ops.jobs_dispatches SET state='rejected',reason='admission_refused_before_claim',
        http_status=503,maintenance_purged=NULL,response_sha256=reply_hash,observed_at=clock_timestamp(),
        resolution_evidence_sha256=encode(sha256(convert_to(jsonb_build_array(
          'collect.unclaimed-fence-refusal.v1',d.id,d.native_epoch,d.net_request_id,reply_hash,503,0)::text,'UTF8')),'hex')
        WHERE id=d.id;
      INSERT INTO private.burimunsi_sms_wakes(event_xid,wake_class,due_at)
      VALUES(pg_current_xact_id(),1,clock_timestamp()+make_interval(secs=>retry_seconds))
      ON CONFLICT(event_xid,wake_class) DO UPDATE SET due_at=least(burimunsi_sms_wakes.due_at,excluded.due_at);
      observed:=observed+1;
      CONTINUE;
    END;
   END IF;$refusal$));
END;
$migration$;
COMMIT;
