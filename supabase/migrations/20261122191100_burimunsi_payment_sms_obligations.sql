-- Record each BuriMunsi posting obligation even if no worker runs before its deadline.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $preflight$
BEGIN
  PERFORM private._collect_fence_require_operator();
  IF NOT EXISTS (SELECT 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced') THEN
    RAISE EXCEPTION 'payment_sms_obligation_requires_fence' USING ERRCODE='55000';
  END IF;
END;$preflight$;

CREATE TABLE private.burimunsi_payment_sms_obligations (
  payment_id text PRIMARY KEY,
  ledger_entry_id text NOT NULL UNIQUE,
  collection_id text NOT NULL,
  posted_at timestamptz NOT NULL,
  inbox_received_at timestamptz, inbox_group_name text,
  disposition text NOT NULL CHECK (disposition IN ('eligible','historical','preferences_disabled',
    'unverified_destination','reversed','ineligible','authority_changed','before_activation','prior_posting')),
  authorization_sha256 text CHECK (authorization_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (disposition <> 'eligible' OR authorization_sha256 IS NOT NULL)
);
CREATE INDEX burimunsi_payment_sms_obligation_due
  ON private.burimunsi_payment_sms_obligations(collection_id,posted_at,ledger_entry_id) WHERE disposition='eligible';

-- Old postings retain their original delivery evidence. A historical snapshot cannot
-- establish that the current contact/consent was in effect when the credit committed.
DO $adopt$
DECLARE owning_group text; old_group text:=current_setting('burimunsi.collection_id',true);
BEGIN
 FOR owning_group IN SELECT id FROM app.collections LOOP
  PERFORM set_config('burimunsi.collection_id',owning_group,true);
INSERT INTO private.burimunsi_payment_sms_obligations(payment_id,ledger_entry_id,collection_id,posted_at,disposition)
SELECT DISTINCT p.id,s.ledger_entry_id,p.collection_id,s.posted_at::timestamptz,'prior_posting'
FROM app.contribution_posting_snapshots s JOIN app.payments p ON p.id=s.payment_id
JOIN app.momo_financial_links f ON f.payment_id=p.id
JOIN private.burimunsi_transaction_scopes x ON x.transaction_id=f.transaction_id AND x.collection_id=p.collection_id
WHERE p.collection_id=owning_group AND x.native_source_id IS NOT NULL AND x.policy_version='native.auto.v1' AND pg_input_is_valid(s.posted_at,'timestamptz');
 END LOOP;
 PERFORM set_config('burimunsi.collection_id',coalesce(old_group,''),true);
END;$adopt$;

ALTER TABLE private.burimunsi_payment_sms_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.burimunsi_payment_sms_obligations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.burimunsi_payment_sms_obligations FROM PUBLIC, anon, authenticated, service_role, collect_importer, collect_runtime;
CREATE POLICY payment_sms_obligations_frame ON private.burimunsi_payment_sms_obligations TO postgres
USING (current_setting('role',true)='collect_runtime' AND current_setting('collect.edge_verified',true)='true'
  AND current_setting('burimunsi.payment_sms_frame',true)='1')
WITH CHECK (current_setting('role',true)='collect_runtime' AND current_setting('collect.edge_verified',true)='true'
  AND current_setting('burimunsi.payment_sms_frame',true)='1');
CREATE TRIGGER collect_fence_statement_v1 BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
  ON private.burimunsi_payment_sms_obligations FOR EACH STATEMENT EXECUTE FUNCTION private._collect_fence_statement();
ALTER TABLE private.burimunsi_payment_sms_obligations ENABLE ALWAYS TRIGGER collect_fence_statement_v1;

-- Compare the complete immutable posting, receiver and authorization without copying
-- the destination or current balance into the waiting queue. Compare posted_at separately.
CREATE FUNCTION private._burimunsi_sms_authority_digest(p_source jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
  SELECT encode(sha256(convert_to((p_source - ARRAY['destination','posted_at'])::text,'UTF8')),'hex')
$$;

-- Keyed receiver observations use catch_up for ordinary incoming SMS too.
-- The original phone timestamp comes from the decrypted, verified object in
-- the canonical posting transaction. On later reads use its retained witness.
CREATE FUNCTION private._burimunsi_payer_inbox_time(p_group text,p_source text,p_payment text,p_transaction text,
 p_paid timestamptz,p_enabled timestamptz) RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE witness jsonb; phone_at timestamptz; object_sha text; first_seen bigint;
 old_observation text:=current_setting('burimunsi.observation_frame',true);
 old_native text:=current_setting('burimunsi.native_receipt_frame',true);
BEGIN
 SELECT inbox_received_at INTO phone_at FROM private.burimunsi_payment_sms_obligations WHERE payment_id=p_payment AND collection_id=p_group;
 IF phone_at IS NULL THEN
  witness:=nullif(current_setting('burimunsi.payer_inbox_witness',true),'')::jsonb;
  IF witness->>'source' IS DISTINCT FROM p_source OR ((witness->>'object') ~ '^[0-9a-f]{64}$') IS NOT TRUE
     OR pg_input_is_valid(witness->>'phoneAt','timestamptz') IS NOT TRUE THEN RETURN NULL; END IF;
  phone_at:=(witness->>'phoneAt')::timestamptz; object_sha:=witness->>'object';
 END IF;
 IF p_paid IS NULL OR NOT isfinite(phone_at) OR phone_at<p_enabled OR p_paid<p_enabled
    OR abs(extract(epoch FROM phone_at-p_paid))>300 THEN RETURN NULL; END IF;
 PERFORM set_config('burimunsi.observation_frame','1',true);
 PERFORM set_config('burimunsi.native_receipt_frame','1',true);
 SELECT q.created_at INTO first_seen FROM private.burimunsi_observation_requests q
 JOIN private.burimunsi_unresolved_observations o ON o.source_id=q.source_id AND o.collection_id=q.collection_id
   AND o.request_id=q.request_id AND o.fingerprint=q.fingerprint AND o.body_sha256=q.source_key_body_sha256
 JOIN private.burimunsi_native_receipt_origins n ON n.source_id=o.source_id AND n.collection_id=o.collection_id
   AND n.request_id=o.request_id AND n.fingerprint=o.fingerprint AND n.body_sha256=o.body_sha256 AND n.object_sha256=o.object_sha256
 JOIN private.burimunsi_auto_sms_jobs j ON j.source_id=n.source_id AND j.collection_id=n.collection_id
   AND j.source_fingerprint=n.fingerprint AND j.transaction_id=p_transaction AND j.state='completed' AND j.relation='accepted'
   AND j.posting_facts->>'source_mode'='catch_up' AND j.posting_facts->>'payment_outcome'='successful'
 WHERE q.collection_id=p_group AND q.source_id=p_source AND q.source_key IS NOT NULL AND q.source_key_content_sha256 IS NOT NULL
   AND (object_sha IS NULL OR n.object_sha256=object_sha) AND private._burimunsi_observation_automatable(p_source)
   AND NOT private.collect_imported_native_source(p_source);
 PERFORM set_config('burimunsi.observation_frame',coalesce(old_observation,''),true);
 PERFORM set_config('burimunsi.native_receipt_frame',coalesce(old_native,''),true);
 IF first_seen IS NULL OR to_timestamp(first_seen/1000.0)<p_enabled OR phone_at>to_timestamp(first_seen/1000.0)+interval '5 seconds'
 THEN RETURN NULL; END IF;
 RETURN phone_at;
END;$fn$;
REVOKE ALL ON FUNCTION private._burimunsi_payer_inbox_time(text,text,text,text,timestamptz,timestamptz)
 FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;

-- The short dispatch deadline runs from the first authorization, independently
-- of a worker outage. Imported historical transactions have no send authority.
CREATE OR REPLACE FUNCTION private._burimunsi_payment_sms_sources(
 p_collection_id text,p_enabled_at timestamptz,p_now timestamptz,p_payment_id text DEFAULT NULL
) RETURNS TABLE(event_id text,payment_id text,ledger_entry_id text,recipient_user_id text,
 destination text,destination_sha256 text,authorization_revision bigint,amount_rwf bigint,
 member_balance_rwf bigint,group_name text,posted_at timestamptz)
 LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $fn$
 SELECT ev.id,p.id,l.id,u.id,contact.destination,contact.destination_hash,a.consent_revision,p.amount_minor,
  s.member_balance_after_minor,ev.data_json::jsonb->>'group_name',clock.posted_at
 FROM app.payments p
 JOIN app.collections c ON c.id=p.collection_id AND c.status='active'
 JOIN app.users u ON u.id=p.member_id AND u.access_status='active' AND u.member_type<>'operator'
 JOIN app.memberships m ON m.collection_id=c.id AND m.user_id=u.id AND m.active=1
 JOIN app.ledger_entries l ON l.payment_id=p.id AND l.collection_id=c.id AND l.member_id=u.id
  AND l.kind='contribution' AND l.amount_minor=p.amount_minor AND l.currency='RWF' AND l.evidence_id=p.evidence_id
 JOIN app.contribution_posting_snapshots s ON s.payment_id=p.id AND s.ledger_entry_id=l.id AND s.posted_at=l.posted_at
 JOIN app.momo_financial_links f ON f.payment_id=p.id AND f.beneficiary_member_id=u.id AND f.historical_existing=0
 JOIN app.momo_transactions t ON t.id=f.transaction_id AND t.mode IN ('live','historical') AND t.event_kind='incoming_receipt'
  AND t.allocation_state='linked' AND t.has_conflict=0 AND t.currency='RWF' AND t.amount_minor=p.amount_minor
  AND t.transaction_time_source='sms_body_and_provider_profile'
 JOIN private.burimunsi_transaction_scopes x ON x.transaction_id=t.id AND x.collection_id=c.id
  AND x.receiving_account_id=t.receiving_account_id AND x.native_source_id IS NOT NULL AND x.policy_version='native.auto.v1'
 LEFT JOIN app.assisted_sms_authorizations a ON a.collection_id=c.id AND a.recipient_user_id=u.id
 LEFT JOIN app.notification_preferences pref ON pref.user_id=u.id
 CROSS JOIN LATERAL (SELECT private._burimunsi_payment_sms_phone(t.payer_identifier) AS destination) payer
 CROSS JOIN LATERAL (SELECT payer.destination,encode(sha256(convert_to(payer.destination,'UTF8')),'hex') AS destination_hash) contact
 CROSS JOIN LATERAL (SELECT
  CASE WHEN pg_input_is_valid(s.posted_at,'timestamptz') THEN s.posted_at::timestamptz END AS posted_at,
  CASE WHEN pg_input_is_valid(t.transaction_at,'timestamptz') THEN t.transaction_at::timestamptz END AS paid_at) clock
 JOIN LATERAL (
  (SELECT n.id,n.data_json FROM app.notification_events n WHERE t.mode='live' AND n.user_id=u.id AND n.event_type='contribution'
   AND n.data_json::jsonb->>'payment_id'=p.id AND n.data_json::jsonb->>'collection_id'=c.id
   AND n.data_json::jsonb->>'amount_rwf'=p.amount_minor::text
   AND n.data_json::jsonb->>'member_balance_after_contribution_rwf'=s.member_balance_after_minor::text
   AND n.data_json::jsonb->>'posted_at'=s.posted_at
   AND n.data_json::jsonb->>'balance_basis'='after_this_contribution'
   AND length(n.data_json::jsonb->>'group_name') BETWEEN 1 AND 160
   AND n.data_json::jsonb->>'group_name' !~ '[[:cntrl:]]'
  ORDER BY n.created_at,n.id LIMIT 1)
  UNION ALL
  SELECT 'buri-inbox:'||l.id,jsonb_build_object('group_name',g.title)::text
  FROM (SELECT coalesce((SELECT o.inbox_group_name FROM private.burimunsi_payment_sms_obligations o
    WHERE o.payment_id=p.id),c.title) AS title) g
  WHERE t.mode='historical' AND length(g.title) BETWEEN 1 AND 160 AND g.title !~ '[[:cntrl:]]'
    AND private._burimunsi_payer_inbox_time(c.id,x.native_source_id,p.id,t.id,clock.paid_at,p_enabled_at) IS NOT NULL
 ) ev ON true
 WHERE c.id=p_collection_id AND (p_payment_id IS NULL OR p.id=p_payment_id)
  AND p.status IN ('confirmed','reconciled') AND p.rail='rwanda_momo' AND p.currency='RWF' AND p.amount_minor>0
  AND clock.posted_at BETWEEN p_enabled_at AND p_now
  AND clock.paid_at BETWEEN p_enabled_at AND clock.posted_at
  AND contact.destination=private._burimunsi_payment_sms_phone(u.momo_number)
  AND (a.recipient_user_id IS NULL OR a.enabled=1 AND a.destination_sha256=contact.destination_hash
   AND (a.phone_verification_challenge_id IS NULL OR private.managed_phone_binding(u.id,a.phone_verification_challenge_id,contact.destination)))
  AND coalesce(pref.payment_updates,1)=1
  AND NOT EXISTS(SELECT 1 FROM app.ledger_entries reversed WHERE reversed.reverses_entry_id=l.id)
  AND NOT EXISTS(SELECT 1 FROM app.momo_transactions reversal WHERE reversal.event_kind='reversal'
    AND reversal.original_transaction_id=t.provider_transaction_id
    AND reversal.receiving_account_id=t.receiving_account_id)
  AND NOT EXISTS(SELECT 1 FROM app.privacy_retention_barriers b WHERE b.subject_id=u.id)
$fn$;

CREATE FUNCTION private._burimunsi_record_payment_sms() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  posting record; source record; reason text; signature text; posted timestamptz; owning_group text; inbox_at timestamptz; group_title text;
  old_group text:=current_setting('burimunsi.collection_id',true);
  native_frame text:=current_setting('burimunsi.native_receipt_frame',true);
  sms_frame text:=current_setting('burimunsi.payment_sms_frame',true);
BEGIN
  PERFORM set_config('burimunsi.native_receipt_frame','1',true);
  SELECT collection_id INTO owning_group FROM app.payments WHERE id=NEW.payment_id;
  PERFORM set_config('burimunsi.collection_id',coalesce(owning_group,''),true);
  SELECT p.id,p.collection_id,p.member_id,p.status,pref.payment_updates,t.mode,t.payer_identifier,u.momo_number,
    f.historical_existing, t.id AS transaction_id,x.native_source_id,
    CASE WHEN pg_input_is_valid(t.transaction_at,'timestamptz') THEN t.transaction_at::timestamptz END AS paid_at INTO posting
  FROM app.payments p JOIN app.ledger_entries l ON l.id=NEW.ledger_entry_id AND l.payment_id=p.id AND l.kind='contribution'
  JOIN app.momo_financial_links f ON f.payment_id=p.id AND f.beneficiary_member_id=p.member_id
  JOIN app.momo_transactions t ON t.id=f.transaction_id
  JOIN private.burimunsi_transaction_scopes x ON x.transaction_id=t.id AND x.collection_id=p.collection_id
    AND x.receiving_account_id=t.receiving_account_id AND x.native_source_id IS NOT NULL AND x.policy_version='native.auto.v1'
  JOIN app.users u ON u.id=p.member_id LEFT JOIN app.notification_preferences pref ON pref.user_id=p.member_id
  WHERE p.id=NEW.payment_id;
  IF FOUND THEN
    posted:=NEW.posted_at::timestamptz;
    PERFORM set_config('burimunsi.payment_sms_frame','1',true);
    IF posting.mode='historical' THEN
      inbox_at:=private._burimunsi_payer_inbox_time(posting.collection_id,posting.native_source_id,posting.id,posting.transaction_id,posting.paid_at,'-infinity');
    END IF;
    SELECT * INTO source FROM private._burimunsi_payment_sms_sources(posting.collection_id,'-infinity',posted,posting.id);
    IF FOUND THEN
      signature:=private._burimunsi_sms_authority_digest(to_jsonb(source));
      reason:='eligible';
      IF inbox_at IS NOT NULL THEN group_title:=source.group_name; END IF;
    ELSIF (posting.mode IS DISTINCT FROM 'live' AND inbox_at IS NULL) OR posting.historical_existing<>0 THEN reason:='historical';
    ELSIF posting.payment_updates=0 THEN reason:='preferences_disabled';
    ELSIF private._burimunsi_payment_sms_phone(posting.payer_identifier) IS NULL OR
        private._burimunsi_payment_sms_phone(posting.payer_identifier) IS DISTINCT FROM private._burimunsi_payment_sms_phone(posting.momo_number)
      THEN reason:='unverified_destination';
    ELSIF posting.status='reversed' OR EXISTS(SELECT 1 FROM app.ledger_entries WHERE reverses_entry_id=NEW.ledger_entry_id) THEN reason:='reversed';
    ELSE reason:='ineligible';
    END IF;
    INSERT INTO private.burimunsi_payment_sms_obligations(payment_id,ledger_entry_id,collection_id,posted_at,disposition,authorization_sha256,inbox_received_at,inbox_group_name)
      VALUES(posting.id,NEW.ledger_entry_id,posting.collection_id,posted,reason,signature,inbox_at,group_title);
  END IF;
  PERFORM set_config('burimunsi.native_receipt_frame',coalesce(native_frame,''),true);
  PERFORM set_config('burimunsi.payment_sms_frame',coalesce(sms_frame,''),true);
  PERFORM set_config('burimunsi.collection_id',coalesce(old_group,''),true);
  RETURN NULL;
END;$$;
REVOKE ALL ON FUNCTION private._burimunsi_record_payment_sms(),private._burimunsi_sms_authority_digest(jsonb)
FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;
-- The posting event and its original balance are available after all statements of
-- the canonical credit transaction. Rollback drops both credit and obligation.
CREATE CONSTRAINT TRIGGER burimunsi_record_payment_sms AFTER INSERT ON app.contribution_posting_snapshots
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private._burimunsi_record_payment_sms();
ALTER TABLE app.contribution_posting_snapshots ENABLE ALWAYS TRIGGER burimunsi_record_payment_sms;

ALTER TABLE private.burimunsi_payment_sms_deliveries ADD COLUMN last_claimed_at timestamptz,
  ADD COLUMN last_claimed_phase text CHECK(last_claimed_phase IN ('send','inspect')),
  ADD COLUMN gateway_hint_state text, ADD COLUMN gateway_hint_at timestamptz,
  ADD COLUMN claim_request_id uuid, ADD COLUMN claim_admission_id uuid;
CREATE UNIQUE INDEX burimunsi_payer_active_request ON private.burimunsi_payment_sms_deliveries(claim_request_id) WHERE claim_request_id IS NOT NULL;

-- A body commitment is the exclusive irreversible authority to contact the gateway.
-- Only new, expired, still-unarmed send leases may be reclaimed. Prior attempts
-- keep their original rules, and an armed attempt is forever GET-only.
CREATE FUNCTION private._burimunsi_payer_unarmed(d private.burimunsi_payment_sms_deliveries,p_now timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $fn$
 SELECT coalesce(d.state='sending' AND d.claim_phase='send' AND d.last_claimed_phase='send' AND d.claim_token IS NOT NULL
  AND d.lease_until<=p_now AND d.body_sha256 IS NULL AND d.provider_state IS NULL AND d.evidence_sha256 IS NULL
  AND d.inspect_count=0 AND d.gateway_hint_state IS NULL,false)
$fn$;
REVOKE ALL ON FUNCTION private._burimunsi_payer_unarmed(private.burimunsi_payment_sms_deliveries,timestamptz)
 FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;

CREATE OR REPLACE FUNCTION private._burimunsi_payment_sms_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'payment_sms_retained' USING ERRCODE='42501';END IF;
 IF ROW(OLD.attempt_id,OLD.collection_id,OLD.payment_id,OLD.ledger_entry_id,OLD.event_id,OLD.recipient_user_id,
   OLD.destination_sha256,OLD.authorization_revision,OLD.amount_rwf,OLD.member_balance_rwf,OLD.group_name,
   OLD.posted_at,OLD.enabled_at,OLD.application_id,OLD.message_id,OLD.idempotency_key)
  IS DISTINCT FROM
  ROW(NEW.attempt_id,NEW.collection_id,NEW.payment_id,NEW.ledger_entry_id,NEW.event_id,NEW.recipient_user_id,
   NEW.destination_sha256,NEW.authorization_revision,NEW.amount_rwf,NEW.member_balance_rwf,NEW.group_name,
   NEW.posted_at,NEW.enabled_at,NEW.application_id,NEW.message_id,NEW.idempotency_key)
  OR (OLD.not_after IS DISTINCT FROM NEW.not_after AND NOT coalesce((
    private._burimunsi_payer_unarmed(OLD,clock_timestamp()) AND NEW.state='sending' AND NEW.body_sha256 IS NULL
    AND NEW.claim_phase='send' AND NEW.last_claimed_phase='send' AND NEW.claim_token IS NOT NULL AND NEW.claim_token<>OLD.claim_token
    AND NEW.last_claimed_at>=OLD.lease_until AND NEW.not_after=NEW.last_claimed_at+interval '5 minutes'
    AND NEW.lease_until=NEW.last_claimed_at+interval '45 seconds' AND NEW.not_after>clock_timestamp()
    AND NEW.not_after<=clock_timestamp()+interval '5 minutes'),false))
  OR (OLD.body_sha256 IS NOT NULL AND OLD.body_sha256 IS DISTINCT FROM NEW.body_sha256)
  OR (OLD.claim_phase IS DISTINCT FROM 'send' AND NEW.claim_phase='send') THEN
  RAISE EXCEPTION 'payment_sms_identity_changed' USING ERRCODE='42501';END IF;
 RETURN NEW;
END;$fn$;
-- A gateway state only accelerates the existing original-ID GET. It cannot
-- mark the payer receipt sent or delivered. The HTTPS adapter verifies that
-- evidence against the full immutable attempt, destination digest and parts.
CREATE POLICY burimunsi_payment_receipt_hint ON collect_sms.messages FOR SELECT TO postgres
USING (current_setting('role',true)='collect_runtime' AND current_setting('collect.edge_verified',true)='true'
  AND current_setting('burimunsi.payment_sms_frame',true)='1' AND kind='receipt'
  AND idempotency_key LIKE 'buri-receipt:%');
CREATE INDEX burimunsi_payment_sms_last_claim ON private.burimunsi_payment_sms_deliveries
  (collection_id,application_id,last_claimed_at DESC) WHERE last_claimed_at IS NOT NULL;

CREATE OR REPLACE FUNCTION private.burimunsi_claim_payment_sms(
  p_collection_id text,p_enabled_at timestamptz,p_application_id text,p_limit integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  due private.burimunsi_payment_sms_obligations%ROWTYPE; entry private.burimunsi_payment_sms_deliveries%ROWTYPE;
  last_phase text; status_id uuid; hint_state text; recorded_body text; source record; k text; at timestamptz;
  request_id uuid:=nullif(current_setting('burimunsi.payer_claim_request',true),'')::uuid;
  admission uuid:=nullif(current_setting('collect.fence_admission_id',true),'')::uuid;
BEGIN
  PERFORM private.burimunsi_auto_jobs_guard();
  IF p_collection_id IS NULL OR p_collection_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    OR p_application_id IS NULL OR p_application_id !~ '^app_[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    OR p_enabled_at IS NULL OR NOT isfinite(p_enabled_at) OR p_limit IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'payment_sms_claim_invalid' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('burimunsi.payment_sms_frame','1',true);
  PERFORM set_config('burimunsi.native_receipt_frame','1',true);
  PERFORM set_config('burimunsi.collection_id',p_collection_id,true);
  PERFORM pg_advisory_xact_lock(734636924058501::bigint);
  at:=clock_timestamp();
  IF p_enabled_at>at THEN RETURN '[]'::jsonb; END IF;
  UPDATE private.burimunsi_payment_sms_deliveries SET state='suppressed',claim_token=NULL,claim_phase=NULL,lease_until=NULL
  WHERE attempt_id IN(SELECT attempt_id FROM private.burimunsi_payment_sms_deliveries d
    WHERE collection_id=p_collection_id AND application_id=p_application_id AND state='sending'
      AND body_sha256 IS NULL AND lease_until<=at AND NOT private._burimunsi_payer_unarmed(d,at)
    ORDER BY lease_until,attempt_id LIMIT 10);

  SELECT d.attempt_id,m.state INTO status_id,hint_state FROM private.burimunsi_payment_sms_deliveries d
  LEFT JOIN collect_sms.messages m ON m.message_id=d.message_id AND m.application_id=d.application_id
    AND m.idempotency_key=d.idempotency_key AND m.kind='receipt'
  WHERE d.collection_id=p_collection_id AND d.application_id=p_application_id AND d.body_sha256 IS NOT NULL
    AND (d.lease_until IS NULL OR d.lease_until<=at) AND d.state IN ('sending','accepted','unknown')
    AND d.provider_state IS DISTINCT FROM 'delivered'
    AND ((m.state IS NOT NULL AND m.state IS DISTINCT FROM d.provider_state AND m.state IS DISTINCT FROM d.gateway_hint_state
          AND (d.provider_state IS NULL OR d.provider_state NOT IN ('failed','cancelled','expired','delivery_unconfirmed') OR m.state='delivered'))
      OR (d.next_inspect_at<=at AND d.inspect_count<12 AND
          (d.not_after+interval '24 hours'>at OR d.gateway_hint_at+interval '24 hours'>at)
          AND (d.provider_state IS NULL OR d.provider_state IN ('accepted','assigned','phone_accepted','queued','handoff_started','sent','partial','outcome_unknown')
               OR m.state='delivered')))
  ORDER BY d.next_inspect_at,d.attempt_id LIMIT 1 FOR UPDATE OF d SKIP LOCKED;
  SELECT d.last_claimed_phase INTO last_phase FROM private.burimunsi_payment_sms_deliveries d
    WHERE d.collection_id=p_collection_id AND d.application_id=p_application_id AND d.last_claimed_at IS NOT NULL
    ORDER BY d.last_claimed_at DESC,d.attempt_id LIMIT 1;

  -- When both queues have work, alternate from the last durable claim, even
  -- across process restarts. Inspections use only the original gateway ID.
  IF status_id IS NULL OR last_phase='inspect' THEN
    FOR due IN SELECT o.* FROM private.burimunsi_payment_sms_obligations o
      LEFT JOIN private.burimunsi_payment_sms_deliveries d ON d.payment_id=o.payment_id
      WHERE o.collection_id=p_collection_id AND o.disposition='eligible' AND (d.payment_id IS NULL OR
        d.collection_id=p_collection_id AND d.application_id=p_application_id AND private._burimunsi_payer_unarmed(d,at))
      ORDER BY o.posted_at,o.ledger_entry_id LIMIT 32 FOR UPDATE OF o SKIP LOCKED LOOP
      SELECT * INTO source FROM private._burimunsi_payment_sms_sources(p_collection_id,p_enabled_at,at,due.payment_id);
      IF NOT FOUND OR source.posted_at IS DISTINCT FROM due.posted_at
        OR private._burimunsi_sms_authority_digest(to_jsonb(source)) IS DISTINCT FROM due.authorization_sha256 THEN
        UPDATE private.burimunsi_payment_sms_obligations SET disposition=CASE
          WHEN due.posted_at<p_enabled_at OR EXISTS (
            SELECT FROM private._burimunsi_payment_sms_sources(p_collection_id,'-infinity',at,due.payment_id) s
            WHERE s.posted_at=due.posted_at AND private._burimunsi_sms_authority_digest(to_jsonb(s))=due.authorization_sha256)
            THEN 'before_activation'
          WHEN EXISTS(SELECT FROM app.ledger_entries WHERE reverses_entry_id=due.ledger_entry_id) THEN 'reversed'
          ELSE 'authority_changed' END WHERE payment_id=due.payment_id;
        UPDATE private.burimunsi_payment_sms_deliveries d SET state='suppressed',claim_token=NULL,claim_phase=NULL,lease_until=NULL
          WHERE d.payment_id=due.payment_id AND private._burimunsi_payer_unarmed(d,at);
        CONTINUE;
      END IF;
      SELECT * INTO entry FROM private.burimunsi_payment_sms_deliveries WHERE payment_id=due.payment_id FOR UPDATE;
      IF FOUND THEN
        IF NOT private._burimunsi_payer_unarmed(entry,at) THEN CONTINUE; END IF;
        IF ROW(entry.collection_id,entry.application_id,entry.ledger_entry_id,entry.event_id,entry.recipient_user_id,entry.destination_sha256,
          entry.authorization_revision,entry.amount_rwf,entry.member_balance_rwf,entry.group_name,entry.posted_at)
          IS DISTINCT FROM ROW(p_collection_id,p_application_id,source.ledger_entry_id,source.event_id,source.recipient_user_id,source.destination_sha256,
          source.authorization_revision,source.amount_rwf,source.member_balance_rwf,source.group_name,source.posted_at) THEN
          UPDATE private.burimunsi_payment_sms_deliveries SET state='unknown',claim_token=NULL,claim_phase=NULL,lease_until=NULL
            WHERE attempt_id=entry.attempt_id;
          CONTINUE;
        END IF;
        -- Even contradictory gateway evidence on an unarmed lease rules out POST.
        -- Preserve its body commitment for comparison by the original-ID GET.
        SELECT encode(sha256(convert_to(m.text,'UTF8')),'hex') INTO recorded_body FROM collect_sms.messages m
          WHERE m.message_id=entry.message_id AND m.application_id=entry.application_id AND m.kind='receipt' AND m.idempotency_key=entry.idempotency_key;
        IF FOUND THEN
          UPDATE private.burimunsi_payment_sms_deliveries SET state='unknown',body_sha256=recorded_body,claim_token=NULL,
            claim_phase=NULL,lease_until=NULL,next_inspect_at=at WHERE attempt_id=entry.attempt_id;
          CONTINUE;
        END IF;
        UPDATE private.burimunsi_payment_sms_deliveries SET claim_token=gen_random_uuid(),last_claimed_at=at,
          lease_until=at+interval '45 seconds',next_inspect_at=at+interval '45 seconds', not_after=at+interval '5 minutes',
          claim_request_id=request_id,claim_admission_id=admission WHERE attempt_id=entry.attempt_id RETURNING * INTO entry;
        RETURN jsonb_build_array(private._burimunsi_payment_sms_claim_json(entry,source.destination));
      END IF;
      k:='buri-receipt:'||source.ledger_entry_id;
      INSERT INTO private.burimunsi_payment_sms_deliveries(collection_id,payment_id,ledger_entry_id,event_id,recipient_user_id,
        destination_sha256,authorization_revision,amount_rwf,member_balance_rwf,group_name,posted_at,enabled_at,
        application_id,message_id,idempotency_key,not_after,claim_token,claim_phase,lease_until,next_inspect_at,last_claimed_at,last_claimed_phase,claim_request_id,claim_admission_id)
      VALUES(p_collection_id,source.payment_id,source.ledger_entry_id,source.event_id,source.recipient_user_id,source.destination_sha256,
        source.authorization_revision,source.amount_rwf,source.member_balance_rwf,source.group_name,source.posted_at,p_enabled_at,
        p_application_id,p_application_id||':'||k,k,at+interval '5 minutes',gen_random_uuid(),'send',
        at+interval '45 seconds',at+interval '45 seconds',at,'send',request_id,admission) RETURNING * INTO entry;
      RETURN jsonb_build_array(private._burimunsi_payment_sms_claim_json(entry,source.destination));
    END LOOP;
  END IF;
  IF status_id IS NULL THEN RETURN '[]'::jsonb; END IF;
  UPDATE private.burimunsi_payment_sms_deliveries d SET claim_token=gen_random_uuid(),claim_phase='inspect',
    lease_until=at+interval '45 seconds',next_inspect_at=at+interval '2 seconds',
    gateway_hint_at=CASE WHEN hint_state IS NOT NULL AND hint_state IS DISTINCT FROM d.gateway_hint_state THEN at ELSE d.gateway_hint_at END,
    gateway_hint_state=coalesce(hint_state,d.gateway_hint_state),
    inspect_count=CASE WHEN hint_state IS NOT NULL AND hint_state IS DISTINCT FROM d.gateway_hint_state THEN 1 ELSE least(12,d.inspect_count+1) END,
    last_claimed_at=at,last_claimed_phase='inspect',claim_request_id=request_id,claim_admission_id=admission WHERE d.attempt_id=status_id RETURNING * INTO entry;
  RETURN jsonb_build_array(private._burimunsi_payment_sms_claim_json(entry,NULL));
END;$$;
-- Recover an ambiguous database response without issuing another claim or POST.
-- Both the opaque request and the original active fenced admission must match.
CREATE FUNCTION private.burimunsi_resume_payment_sms(p_group text,p_enabled timestamptz,p_app text,p_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE d private.burimunsi_payment_sms_deliveries%ROWTYPE; s record; at timestamptz; admission uuid;
BEGIN
 PERFORM private.burimunsi_auto_jobs_guard();
 admission:=nullif(current_setting('collect.fence_admission_id',true),'')::uuid;
 IF p_request IS NULL OR admission IS NULL THEN RAISE EXCEPTION 'payment_sms_resume_admission_required' USING ERRCODE='42501'; END IF;
 PERFORM set_config('burimunsi.payment_sms_frame','1',true);
 PERFORM set_config('burimunsi.native_receipt_frame','1',true);
 PERFORM set_config('burimunsi.collection_id',p_group,true);
 PERFORM pg_advisory_xact_lock(734636924058501::bigint);
 at:=clock_timestamp();
 SELECT * INTO d FROM private.burimunsi_payment_sms_deliveries WHERE claim_request_id=p_request AND claim_admission_id=admission
   AND collection_id=p_group AND application_id=p_app AND claim_token IS NOT NULL AND lease_until>at FOR SHARE;
 IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;
 IF d.claim_phase='inspect' AND d.body_sha256 IS NOT NULL THEN RETURN jsonb_build_array(private._burimunsi_payment_sms_claim_json(d,NULL)); END IF;
 IF d.claim_phase<>'send' OR d.body_sha256 IS NOT NULL OR d.state<>'sending' OR d.not_after<=at OR d.provider_state IS NOT NULL
  OR d.evidence_sha256 IS NOT NULL OR EXISTS(SELECT FROM collect_sms.messages m WHERE m.message_id=d.message_id AND m.application_id=d.application_id
    AND m.kind='receipt' AND m.idempotency_key=d.idempotency_key) THEN RETURN '[]'::jsonb; END IF;
 SELECT * INTO s FROM private._burimunsi_payment_sms_sources(p_group,p_enabled,at,d.payment_id);
 IF NOT FOUND OR ROW(d.event_id,d.ledger_entry_id,d.recipient_user_id,d.destination_sha256,d.authorization_revision,d.amount_rwf,d.member_balance_rwf,d.group_name,d.posted_at)
    IS DISTINCT FROM ROW(s.event_id,s.ledger_entry_id,s.recipient_user_id,s.destination_sha256,s.authorization_revision,s.amount_rwf,s.member_balance_rwf,s.group_name,s.posted_at)
 THEN RETURN '[]'::jsonb; END IF;
 RETURN jsonb_build_array(private._burimunsi_payment_sms_claim_json(d,s.destination));
END;$fn$;

CREATE FUNCTION private.burimunsi_claim_payment_sms_v2(p_group text,p_enabled timestamptz,p_app text,p_limit integer,p_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE prior text:=current_setting('burimunsi.payer_claim_request',true); result jsonb;
BEGIN
 IF p_request IS NULL THEN RAISE EXCEPTION 'payment_sms_request_required' USING ERRCODE='22023'; END IF;
 PERFORM set_config('burimunsi.payer_claim_request',p_request::text,true);
 result:=private.burimunsi_claim_payment_sms(p_group,p_enabled,p_app,p_limit);
 PERFORM set_config('burimunsi.payer_claim_request',coalesce(prior,''),true);
 RETURN result;
END;$fn$;
REVOKE ALL ON FUNCTION private.burimunsi_resume_payment_sms(text,timestamptz,text,uuid),private.burimunsi_claim_payment_sms_v2(text,timestamptz,text,integer,uuid)
 FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;
GRANT EXECUTE ON FUNCTION private.burimunsi_resume_payment_sms(text,timestamptz,text,uuid),private.burimunsi_claim_payment_sms_v2(text,timestamptz,text,integer,uuid) TO collect_runtime;

-- With no durable gateway hint, spread the bounded original-ID inspections
-- across longer outages. Each newly observed gateway state wakes another GET.
DO $inspect_backoff$
DECLARE body text; def text; anchor text:=$old$next_inspect_at=clock_timestamp()+interval '1 minute'$old$;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid) INTO STRICT body,def FROM pg_proc WHERE
  oid='private.burimunsi_finish_payment_sms(text,uuid,uuid,text,text,text)'::regprocedure;
 IF length(body)-length(replace(body,anchor,''))<>length(anchor) THEN RAISE EXCEPTION 'payment_sms_finish_contract_changed'; END IF;
 EXECUTE replace(def,body,replace(body,anchor,
   'next_inspect_at=clock_timestamp()+make_interval(secs=>least(300,2*(1 << least(d.inspect_count,8))))'));
END;$inspect_backoff$;

CREATE OR REPLACE FUNCTION private.burimunsi_payment_sms_readiness(p_collection_id text,p_enabled_at timestamptz,p_application_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE at timestamptz:=clock_timestamp();
BEGIN
  PERFORM private.burimunsi_auto_jobs_guard();
  PERFORM set_config('burimunsi.payment_sms_frame','1',true);
  PERFORM set_config('burimunsi.native_receipt_frame','1',true);
  PERFORM set_config('burimunsi.collection_id',p_collection_id,true);
  RETURN jsonb_build_object('contract_version',1,'eligible_count',(
    SELECT count(*) FROM private.burimunsi_payment_sms_obligations o
    CROSS JOIN LATERAL private._burimunsi_payment_sms_sources(p_collection_id,p_enabled_at,at,o.payment_id) s
    WHERE o.collection_id=p_collection_id AND o.disposition='eligible'
      AND o.posted_at=s.posted_at AND o.authorization_sha256=private._burimunsi_sms_authority_digest(to_jsonb(s))
      AND NOT EXISTS(SELECT FROM private.burimunsi_payment_sms_deliveries d WHERE d.payment_id=o.payment_id
        AND NOT (d.collection_id=p_collection_id AND d.application_id=p_application_id AND private._burimunsi_payer_unarmed(d,at)))),
    'unresolved_count',(SELECT count(*) FROM private.burimunsi_payment_sms_deliveries d WHERE d.collection_id=p_collection_id
      AND d.application_id=p_application_id AND NOT private._burimunsi_payer_unarmed(d,at) AND (d.state IN ('sending','unknown') OR d.state='accepted'
        AND d.provider_state IN ('accepted','assigned','phone_accepted','queued','handoff_started','sent','partial','outcome_unknown'))));
END;$$;

CREATE FUNCTION private._burimunsi_payer_outcomes(p_groups text[],p_payments text[] DEFAULT NULL)
RETURNS TABLE(payment_id text,posted_at timestamptz,lane text,reason text)
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  WITH obligations AS (
    SELECT * FROM private.burimunsi_payment_sms_obligations
    WHERE collection_id=ANY(p_groups) AND (p_payments IS NULL OR payment_id=ANY(p_payments))
  ), attempts AS (
    SELECT * FROM private.burimunsi_payment_sms_deliveries
    WHERE collection_id=ANY(p_groups) AND (p_payments IS NULL OR payment_id=ANY(p_payments))
  )
  SELECT coalesce(d.payment_id,o.payment_id),coalesce(d.posted_at,o.posted_at),
    CASE WHEN d.payment_id IS NULL THEN CASE
      WHEN o.disposition='prior_posting' AND o.posted_at+interval '5 minutes'<=statement_timestamp() THEN 'expired'
      WHEN o.disposition='eligible' THEN 'pending' ELSE 'suppressed' END
      WHEN d.state='suppressed' THEN 'suppressed'
      WHEN d.state='sending' AND d.body_sha256 IS NULL AND (d.lease_until>statement_timestamp() OR private._burimunsi_payer_unarmed(d,statement_timestamp())) THEN 'pending'
      WHEN d.body_sha256 IS NULL OR d.evidence_sha256 IS NULL THEN 'unknown'
      WHEN d.provider_state IN ('accepted','assigned','phone_accepted','queued','handoff_started') THEN 'gateway_accepted'
      WHEN d.provider_state IN ('sent','delivered','expired') THEN d.provider_state
      WHEN d.provider_state IN ('failed','cancelled') THEN 'failed' ELSE 'unknown' END,
    CASE WHEN d.payment_id IS NULL THEN NULLIF(o.disposition,'eligible')
      WHEN d.state='suppressed' THEN 'claim_suppressed' WHEN d.provider_state IN ('failed','expired','cancelled') THEN 'gateway_'||d.provider_state
      WHEN d.state='unknown' OR d.provider_state IN ('partial','outcome_unknown','delivery_unconfirmed') THEN 'gateway_unconfirmed' END
  FROM obligations o FULL JOIN attempts d USING(payment_id)
$$;
REVOKE ALL ON FUNCTION private._burimunsi_payer_outcomes(text[],text[]) FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;

CREATE FUNCTION private.burimunsi_admin_observation_outcomes(p_collection text,p_sources text[],p_financial boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor jsonb; result jsonb;
  native_frame text:=current_setting('burimunsi.native_receipt_frame',true);
  sms_frame text:=current_setting('burimunsi.payment_sms_frame',true);
BEGIN
  actor:=private.burimunsi_observation_admin_scope(p_collection,false);
  IF p_sources IS NULL OR cardinality(p_sources)>100 OR array_position(p_sources,NULL) IS NOT NULL OR p_financial IS NULL THEN
    RAISE EXCEPTION 'invalid_observation_sources' USING ERRCODE='22023';
  END IF;
  IF p_financial AND private.assert_actor('payments.read',NULL,NULL,1,NULL) IS DISTINCT FROM actor->>'principalId' THEN
    RAISE EXCEPTION 'payment_read_required' USING ERRCODE='42501';
  END IF;
  PERFORM set_config('burimunsi.native_receipt_frame','1',true);
  PERFORM set_config('burimunsi.payment_sms_frame','1',true);
  WITH facts AS MATERIALIZED (
    SELECT ids.source_id,j.state,j.relation,j.posting_failure_count,j.posting_next_attempt_at,t.has_conflict,t.event_kind,
      CASE WHEN j.source_id IS NULL THEN private._burimunsi_inbox_outcome(ids.source_id,p_collection) END AS inbox_outcome,
      p.id AS payment_id,p.payment_reference::text, p.status, l.id AS ledger_id, s.payment_id AS snapshot,
      EXISTS(SELECT FROM app.ledger_entries r WHERE r.reverses_entry_id=l.id) AS reversed
    FROM unnest(p_sources) ids(source_id)
    LEFT JOIN private.burimunsi_auto_sms_jobs j ON j.source_id=ids.source_id AND j.collection_id=p_collection
    LEFT JOIN app.momo_transactions t ON t.id=j.transaction_id
    LEFT JOIN app.momo_financial_links f ON f.transaction_id=t.id
    LEFT JOIN app.payments p ON p.id=f.payment_id AND p.collection_id=p_collection AND p.member_id=f.beneficiary_member_id
    LEFT JOIN app.ledger_entries l ON l.payment_id=p.id AND l.collection_id=p.collection_id AND l.member_id=p.member_id
      AND l.kind='contribution' AND l.amount_minor=p.amount_minor AND l.currency=p.currency AND l.evidence_id=p.evidence_id
    LEFT JOIN app.contribution_posting_snapshots s ON s.ledger_entry_id=l.id AND s.payment_id=p.id AND s.posted_at=l.posted_at
  ), outcomes AS (
    SELECT * FROM private._burimunsi_payer_outcomes(ARRAY[p_collection],ARRAY(SELECT payment_id FROM facts WHERE p_financial AND payment_id IS NOT NULL))
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('sourceId',f.source_id,'processing',CASE
    WHEN f.inbox_outcome='needs_review' THEN 'held' WHEN f.inbox_outcome='historical' THEN 'historical'
    WHEN f.state='failed' OR f.relation='conflict' OR f.has_conflict<>0 THEN 'blocked'
    WHEN f.relation='duplicate' THEN 'duplicate' WHEN f.state='security_message' THEN 'excluded'
    WHEN f.state='retry' OR f.posting_failure_count>0 THEN 'retrying'
    WHEN f.reversed OR f.status='reversed' THEN 'reversed'
    WHEN f.status IN ('confirmed','reconciled') AND f.snapshot IS NOT NULL THEN 'posted'
    WHEN f.state='completed' AND f.event_kind<>'incoming_receipt' THEN 'non_payment'
    WHEN f.state='completed' AND f.posting_next_attempt_at>0 THEN 'unmatched'
    ELSE 'pending' END,'paymentReference',CASE WHEN p_financial AND f.snapshot IS NOT NULL THEN f.payment_reference END,
    'payerStatus',o.lane,'payerReason',o.reason)),'[]'::jsonb)
  INTO result FROM facts f LEFT JOIN outcomes o ON o.payment_id=f.payment_id;
  PERFORM set_config('burimunsi.native_receipt_frame',coalesce(native_frame,''),true);
  PERFORM set_config('burimunsi.payment_sms_frame',coalesce(sms_frame,''),true);
  RETURN result;
END;$$;
REVOKE ALL ON FUNCTION private.burimunsi_admin_observation_outcomes(text,text[],boolean)
FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;
GRANT EXECUTE ON FUNCTION private.burimunsi_admin_observation_outcomes(text,text[],boolean) TO collect_runtime;

-- Keep the old health signature and response intact for already-deployed Admin
-- clients. Both versions derive groups from the same live collection approvals.
CREATE POLICY burimunsi_admin_receipt_heartbeat ON collect_sms.devices FOR SELECT TO postgres
USING (current_setting('role',true)='collect_runtime' AND current_setting('collect.edge_verified',true)='true'
  AND current_setting('burimunsi.payment_sms_frame',true)='1' AND ready=1 AND revoked_at IS NULL AND allowed_kinds::jsonb ? 'receipt');

CREATE FUNCTION private.burimunsi_admin_sms_operations() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  actor record; groups text[]; result jsonb; group_id text;
  pin_frame text:=current_setting('burimunsi.pin_frame',true);
  sms_frame text:=current_setting('burimunsi.payment_sms_frame',true);
BEGIN
  PERFORM private._collect_fence_require_runtime();
  IF nullif(current_setting('burimunsi.browser_pin_cookie',true),'') IS NOT NULL THEN
    group_id:=private.burimunsi_browser_pin_context()->>'collectionId';
    IF group_id IS NULL THEN RAISE EXCEPTION 'admin_scope_required' USING ERRCODE='42501'; END IF;
    PERFORM private.burimunsi_browser_pin_assert_actor('system_health.read',group_id,'admin',1,NULL);
    PERFORM private.burimunsi_browser_pin_assert_actor('sms.read',group_id,'admin',1,NULL);
    groups:=ARRAY[group_id];
  ELSE
    SELECT * INTO actor FROM private.burimunsi_managed_admin_snapshot();
    IF NOT FOUND OR actor.surface<>'admin' OR private.assert_actor('system_health.read',NULL,NULL,1,NULL) IS DISTINCT FROM actor.principal_user_id THEN
      RAISE EXCEPTION 'admin_health_required' USING ERRCODE='42501';
    END IF;
    IF NOT EXISTS (SELECT FROM app.admin_grants g JOIN app.admin_account_role_capabilities c ON c.permission=g.permission
      WHERE g.user_id=actor.principal_user_id AND c.role=actor.shared_role AND g.permission='sms.read' FOR SHARE OF g,c) THEN RETURN NULL; END IF;
    PERFORM set_config('burimunsi.pin_frame','1',true);
    SELECT array_agg(a.collection_id) INTO groups FROM private.burimunsi_operator_approvals a
    WHERE a.admin_user_id=actor.admin_id AND a.principal_user_id=actor.principal_user_id AND a.active
      AND ARRAY['records.read','sms.read']::text[] <@ a.capabilities
      AND private.burimunsi_pin_root_snapshot(a.collection_id,a.principal_user_id,a.phone,a.role,a.capabilities) IS NOT NULL;
    PERFORM set_config('burimunsi.pin_frame',coalesce(pin_frame,''),true);
    IF groups IS NULL THEN RETURN NULL; END IF;
  END IF;
  PERFORM set_config('burimunsi.payment_sms_frame','1',true);
  WITH outcomes AS MATERIALIZED (SELECT * FROM private._burimunsi_payer_outcomes(groups)),
  confirmed AS (SELECT d.observed_at,d.response_sha256 FROM collect_ops.jobs_dispatches d
    JOIN private.collect_managed_job_tickets t ON t.dispatch_id=d.id AND t.completed_at IS NOT NULL AND t.response_sha256=d.response_sha256
    WHERE d.kind='scheduled' AND d.state='confirmed' AND d.response_sha256 ~ '^[a-f0-9]{64}$' AND d.observed_at IS NOT NULL
    ORDER BY d.observed_at DESC LIMIT 1),
  scheduler AS (SELECT j.active,CASE j.schedule WHEN '1 second' THEN 1 WHEN '* * * * *' THEN 60 END AS interval_seconds
    FROM collect_ops.jobs_config c JOIN cron.job j ON j.jobid=c.cron_job_id WHERE c.singleton AND j.jobname='collect-jobs-maintenance-v1'
    AND j.command='SELECT collect_ops.tick_jobs();' AND j.database=current_database()),
  gateway AS (SELECT max(CASE WHEN pg_input_is_valid(last_seen_at,'timestamptz') THEN last_seen_at::timestamptz END) AS last_seen_at
    FROM collect_sms.devices WHERE revoked_at IS NULL AND ready=1 AND allowed_kinds::jsonb ? 'receipt')
  SELECT jsonb_build_object(
    'payer',(SELECT jsonb_build_object('pending',count(*) FILTER(WHERE lane='pending'),'gateway_accepted',count(*) FILTER(WHERE lane='gateway_accepted'),
      'sent',count(*) FILTER(WHERE lane='sent'),'delivered',count(*) FILTER(WHERE lane='delivered'),'failed',count(*) FILTER(WHERE lane='failed'),
      'unknown',count(*) FILTER(WHERE lane='unknown'),'suppressed',count(*) FILTER(WHERE lane='suppressed'),'expired',count(*) FILTER(WHERE lane='expired')) FROM outcomes),
    'oldest_pending_seconds',(SELECT greatest(0,floor(extract(epoch FROM statement_timestamp()-min(posted_at)))::bigint)
      FROM outcomes WHERE lane='pending' HAVING count(*)>0),
    'reasons',coalesce((SELECT jsonb_object_agg(reason,n) FROM (SELECT reason,count(*) AS n FROM outcomes WHERE reason IS NOT NULL GROUP BY reason) reasons),'{}'::jsonb),
    'scheduler_enabled',(SELECT enabled FROM collect_ops.jobs_config WHERE singleton),
    'cron_active',EXISTS(SELECT FROM scheduler WHERE active AND interval_seconds IS NOT NULL),
    'cron_interval_seconds',(SELECT interval_seconds FROM scheduler),
    'unresolved_dispatches',(SELECT count(*) FROM collect_ops.jobs_dispatches WHERE state IN ('awaiting','unconfirmed')),
    'gateway_heartbeat',(SELECT CASE WHEN last_seen_at IS NULL THEN 'not_recorded'
      WHEN last_seen_at BETWEEN statement_timestamp()-interval '90 seconds' AND statement_timestamp()+interval '5 seconds' THEN 'recent' ELSE 'stale' END FROM gateway),
    'last_confirmed_at',(SELECT to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM confirmed),
    'last_confirmed_sha256',(SELECT response_sha256 FROM confirmed),
    'gateway_last_seen_at',(SELECT to_char(last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM gateway)
  ) INTO result;
  PERFORM set_config('burimunsi.payment_sms_frame',coalesce(sms_frame,''),true);
  RETURN result;
END;$$;
REVOKE ALL ON FUNCTION private.burimunsi_admin_sms_operations() FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;
GRANT EXECUTE ON FUNCTION private.burimunsi_admin_sms_operations() TO collect_runtime;

-- Managed Admins retain their independent collection grants. The standalone
-- owner uses their real browser grant and active membership in the bound group.
DO $browser$
DECLARE item record; def text; body text;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('private.burimunsi_observation_admin_scope(text,boolean)', $old$ PERFORM set_config('burimunsi.pin_frame','1',true);$old$, $new$
 IF nullif(current_setting('burimunsi.browser_pin_cookie',true),'') IS NOT NULL THEN
   PERFORM private.burimunsi_browser_pin_assert_actor('sms.read',p_collection,'admin',1,NULL);
   RETURN a || jsonb_build_object('collectionId',p_collection,'label',(SELECT title FROM app.collections WHERE id=p_collection));
 END IF;
$new$),
    ('private.burimunsi_observation_admin_collections()', $old$ PERFORM set_config('burimunsi.pin_frame','1',true);$old$, $new$
 IF nullif(current_setting('burimunsi.browser_pin_cookie',true),'') IS NOT NULL THEN
   v:=private.burimunsi_browser_pin_context();
   IF v->>'collectionId' IS NULL THEN RAISE EXCEPTION 'admin_scope_required' USING ERRCODE='42501'; END IF;
   PERFORM private.burimunsi_browser_pin_assert_actor('sms.read',v->>'collectionId','admin',1,NULL);
   RETURN (SELECT jsonb_build_array(jsonb_build_object('collectionId',id,'label',title)) FROM app.collections WHERE id=v->>'collectionId');
 END IF;
$new$)
  ) s(signature,anchor,addition) LOOP
    SELECT pg_get_functiondef(p.oid),p.prosrc INTO STRICT def,body FROM pg_proc p WHERE p.oid=item.signature::regprocedure;
    IF length(body)-length(replace(body,item.anchor,''))<>length(item.anchor) THEN RAISE EXCEPTION 'observation_admin_scope_changed'; END IF;
    EXECUTE replace(def,body,replace(body,item.anchor,item.addition||item.anchor));
  END LOOP;
END;$browser$;

-- The legacy health response contains the parser backlog. Preserve its shape
-- while admitting the same current standalone collection as the native list.
DO $health_scope$
DECLARE body text; def text; start_at text:=' SELECT array_agg(a.collection_id) INTO groups';
  finish_at text:=' PERFORM set_config(''burimunsi.pin_frame'',coalesce(old_pin,''''),true);';
BEGIN
  SELECT prosrc,pg_get_functiondef(oid) INTO STRICT body,def FROM pg_proc WHERE oid='private.burimunsi_admin_sms_health()'::regprocedure;
  IF length(body)-length(replace(body,start_at,''))<>length(start_at) OR strpos(body,finish_at)<=strpos(body,start_at) THEN
    RAISE EXCEPTION 'payer_sms_health_scope_changed';
  END IF;
  body:=overlay(body placing $scope$
 IF nullif(current_setting('burimunsi.browser_pin_cookie',true),'') IS NOT NULL THEN
   groups:=ARRAY[private.burimunsi_browser_pin_context()->>'collectionId'];
   IF groups[1] IS NULL THEN RAISE EXCEPTION 'admin_scope_required' USING ERRCODE='42501'; END IF;
   PERFORM private.burimunsi_browser_pin_assert_actor('sms.read',groups[1],'admin',1,NULL);
 ELSE
$scope$ || substring(body FROM strpos(body,start_at) FOR strpos(body,finish_at)-strpos(body,start_at)) || E' END IF;\n'
    FROM strpos(body,start_at) FOR strpos(body,finish_at)-strpos(body,start_at));
  EXECUTE replace(def,(SELECT prosrc FROM pg_proc WHERE oid='private.burimunsi_admin_sms_health()'::regprocedure),body);
END;$health_scope$;

-- Register the metadata-only obligation beside the protected dispatch journal.
DO $inventory$
DECLARE body text; def text; entry jsonb; anchor text:='''private:burimunsi_payment_sms_deliveries'',';
BEGIN
  SELECT prosrc,pg_get_functiondef(oid) INTO STRICT body,def FROM pg_proc WHERE oid='private._retention_manifest_catalog_v2()'::regprocedure;
  entry:=jsonb_build_object('name','private:burimunsi_payment_sms_obligations','relation','private.burimunsi_payment_sms_obligations',
    'scope','unmapped_private','purpose','Canonical payment-to-receipt obligation and original authority commitment',
    'known_links','Payment and ledger entry identify the same scoped contribution; no recipient address is stored','blocked',true);
  EXECUTE replace(def,body,format('SELECT jsonb_set(base,''{private_classes}'',(base->''private_classes'')||%L::jsonb) FROM (%s) prior(base)',jsonb_build_array(entry)::text,body));
  SELECT prosrc,pg_get_functiondef(oid) INTO STRICT body,def FROM pg_proc WHERE oid='private.retention_capture_inventory_v2(uuid,text,bigint,text,integer)'::regprocedure;
  IF length(body)-length(replace(body,anchor,''))<>length(anchor) THEN RAISE EXCEPTION 'payment_sms_retention_inventory_changed'; END IF;
  EXECUTE replace(def,body,replace(body,anchor,anchor||'''private:burimunsi_payment_sms_obligations'','));
END;$inventory$;
COMMIT;
