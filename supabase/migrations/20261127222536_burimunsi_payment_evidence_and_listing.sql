BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';

DO $preflight$
BEGIN
  PERFORM private._collect_fence_require_operator();
  PERFORM pg_advisory_xact_lock(7346371,1);
  PERFORM pg_advisory_xact_lock(7346371,2);
  IF session_user<>'postgres' OR current_user<>'postgres'
    OR NOT EXISTS (SELECT FROM private.collect_fence_control WHERE singleton AND mode='fenced' FOR UPDATE)
    OR EXISTS (SELECT FROM collect_ops.jobs_config c JOIN cron.job j ON j.jobid=c.cron_job_id WHERE c.singleton AND (c.enabled OR j.active))
    OR EXISTS (SELECT FROM collect_ops.jobs_dispatches WHERE state IN ('awaiting','unconfirmed')) THEN
    RAISE EXCEPTION 'payment_evidence_requires_drained_release' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_proc WHERE oid=to_regprocedure('private._burimunsi_allocation_contact(text,text)')
    AND proowner='postgres'::regrole AND NOT prosecdef AND provolatile='s'
    AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='3245a932d43d8455b5067946f7c090617ce34901e041a7a7557193ea3220c2d6') THEN
    RAISE EXCEPTION 'payment_evidence_predecessor_changed' USING ERRCODE='55000';
  END IF;
END $preflight$;

-- A single durable hold protects the original payment even if raw evidence
-- later expires. It has no automatic release or alternate allocation state.
CREATE TABLE burimunsi.payment_evidence_holds (
  payment_id text PRIMARY KEY REFERENCES burimunsi.payments(id) ON DELETE CASCADE,
  collection_id text NOT NULL REFERENCES private.burimunsi_scopes(collection_id)
);
REVOKE ALL ON burimunsi.payment_evidence_holds FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_sms_runtime,collect_importer;

-- Temporary SELECT policies are visible only within this fenced transaction.
-- Preserve retained native and pre-standalone disputes across the migration.
CREATE POLICY burimunsi_hold_backfill ON burimunsi.payments FOR SELECT TO postgres
  USING (session_user='postgres' AND current_user='postgres');
CREATE POLICY burimunsi_hold_backfill ON private.burimunsi_auto_sms_jobs FOR SELECT TO postgres
  USING (session_user='postgres' AND current_user='postgres');
INSERT INTO burimunsi.payment_evidence_holds(payment_id,collection_id)
SELECT p.id,p.collection_id FROM burimunsi.payments p
WHERE EXISTS (SELECT FROM private.burimunsi_auto_sms_jobs j
  WHERE j.collection_id=p.collection_id AND j.receiving_account_id=p.receiving_account_id
    AND (j.payment_id=p.id OR j.transaction_id=p.id) AND j.state='completed' AND j.relation='conflict')
OR EXISTS (SELECT FROM app.momo_transactions t WHERE t.id=p.id AND t.receiving_account_id=p.receiving_account_id
  AND (t.has_conflict<>0 OR EXISTS (SELECT FROM app.momo_transaction_sources x WHERE x.transaction_id=t.id AND x.relation='conflict')));
DROP POLICY burimunsi_hold_backfill ON private.burimunsi_auto_sms_jobs;
DROP POLICY burimunsi_hold_backfill ON burimunsi.payments;

ALTER TABLE burimunsi.payment_evidence_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE burimunsi.payment_evidence_holds FORCE ROW LEVEL SECURITY;
GRANT SELECT ON burimunsi.payment_evidence_holds TO collect_runtime;
CREATE POLICY burimunsi_hold_read ON burimunsi.payment_evidence_holds FOR SELECT TO postgres,collect_runtime
  USING (current_setting('role',true)='collect_runtime' AND current_setting('collect.edge_verified',true)='true'
    AND collection_id=nullif(current_setting('burimunsi.collection_id',true),''));
CREATE POLICY burimunsi_hold_record ON burimunsi.payment_evidence_holds FOR INSERT TO postgres
  WITH CHECK (current_setting('role',true)='collect_runtime' AND current_setting('collect.edge_verified',true)='true'
    AND current_setting('burimunsi.payment_record_frame',true)='1'
    AND collection_id=nullif(current_setting('burimunsi.collection_id',true),''));
CREATE TRIGGER collect_fence_statement_v1 BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON burimunsi.payment_evidence_holds
  FOR EACH STATEMENT EXECUTE FUNCTION private._collect_fence_statement();
ALTER TABLE burimunsi.payment_evidence_holds ENABLE ALWAYS TRIGGER collect_fence_statement_v1;

CREATE FUNCTION private._burimunsi_hold_conflicting_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $hold$
BEGIN
  IF TG_RELID<>'private.burimunsi_auto_sms_jobs'::regclass OR NEW.collection_id IS DISTINCT FROM current_setting('burimunsi.collection_id',true)
    OR current_setting('burimunsi.payment_record_frame',true) IS DISTINCT FROM '1'
    OR NOT EXISTS (SELECT FROM burimunsi.payments p WHERE p.id=NEW.payment_id AND p.collection_id=NEW.collection_id
      AND p.receiving_account_id=NEW.receiving_account_id) THEN
    RAISE EXCEPTION 'payment_conflict_scope_required' USING ERRCODE='42501';
  END IF;
  INSERT INTO burimunsi.payment_evidence_holds(payment_id,collection_id) VALUES(NEW.payment_id,NEW.collection_id)
    ON CONFLICT(payment_id) DO NOTHING;
  RETURN NULL;
END $hold$;
REVOKE ALL ON FUNCTION private._burimunsi_hold_conflicting_payment() FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_sms_runtime,collect_importer;
CREATE TRIGGER burimunsi_hold_conflicting_payment AFTER INSERT OR UPDATE OF state,relation,payment_id ON private.burimunsi_auto_sms_jobs
  FOR EACH ROW WHEN (NEW.state='completed' AND NEW.relation='conflict' AND NEW.payment_id IS NOT NULL)
  EXECUTE FUNCTION private._burimunsi_hold_conflicting_payment();
ALTER TABLE private.burimunsi_auto_sms_jobs ENABLE ALWAYS TRIGGER burimunsi_hold_conflicting_payment;

CREATE FUNCTION private._burimunsi_guard_payment_allocation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
BEGIN
  IF TG_RELID<>'burimunsi.payments'::regclass OR current_setting('role',true) IS DISTINCT FROM 'collect_runtime'
    OR current_setting('collect.edge_verified',true) IS DISTINCT FROM 'true'
    OR NEW.collection_id IS DISTINCT FROM current_setting('burimunsi.collection_id',true) THEN
    RAISE EXCEPTION 'allocation_scope_required' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT FROM burimunsi.payment_evidence_holds h WHERE h.payment_id=NEW.id AND h.collection_id=NEW.collection_id) THEN
    RAISE EXCEPTION 'payment_evidence_conflict' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION private._burimunsi_guard_payment_allocation() FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_sms_runtime,collect_importer;
CREATE TRIGGER burimunsi_guard_payment_allocation BEFORE UPDATE OF member_id ON burimunsi.payments
  FOR EACH ROW WHEN (OLD.member_id IS NULL AND NEW.member_id IS NOT NULL)
  EXECUTE FUNCTION private._burimunsi_guard_payment_allocation();
ALTER TABLE burimunsi.payments ENABLE ALWAYS TRIGGER burimunsi_guard_payment_allocation;

-- Claim and final send preparation call this same private predicate under the
-- parser/assignment mutation lock. An armed request keeps its provider identity.
CREATE OR REPLACE FUNCTION private._burimunsi_allocation_contact(p_group text,p_payment text)
RETURNS TABLE(destination text,amount_rwf bigint,reference text,reason text)
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $fn$
  SELECT contact.phone,p.amount_rwf,p.provider_reference,
    CASE WHEN EXISTS (SELECT FROM burimunsi.payment_evidence_holds h WHERE h.payment_id=p.id AND h.collection_id=p.collection_id)
      THEN 'payment_evidence_conflict'
    WHEN contact.phone IS NULL OR NOT EXISTS(
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

-- English case/accent insensitive, natural numeric order matches Admin table sorting.
CREATE COLLATION burimunsi.payment_analysis_order (provider=icu,locale='en-u-kn-true-ks-level1',deterministic=false);

-- Match the existing Web filter's NFKD, Unicode Mark removal and English case
-- folding. PostgreSQL regular expressions use POSIX classes. The ranges below
-- are the Unicode 17.0 Mark category, encoded in code-point order.
CREATE FUNCTION burimunsi.payment_search_text(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $fold$
  SELECT lower(regexp_replace(normalize(value,NFKD) COLLATE "C",
    '[' ||
    U&'\0300-\036f\0483-\0489\0591-\05bd\05bf\05c1-\05c2\05c4-\05c5\05c7\0610-\061a\064b-\065f\0670\06d6-\06dc\06df-\06e4' ||
    U&'\06e7-\06e8\06ea-\06ed\0711\0730-\074a\07a6-\07b0\07eb-\07f3\07fd\0816-\0819\081b-\0823\0825-\0827\0829-\082d\0859-\085b' ||
    U&'\0897-\089f\08ca-\08e1\08e3-\0903\093a-\093c\093e-\094f\0951-\0957\0962-\0963\0981-\0983\09bc\09be-\09c4\09c7-\09c8\09cb-\09cd' ||
    U&'\09d7\09e2-\09e3\09fe\0a01-\0a03\0a3c\0a3e-\0a42\0a47-\0a48\0a4b-\0a4d\0a51\0a70-\0a71\0a75\0a81-\0a83' ||
    U&'\0abc\0abe-\0ac5\0ac7-\0ac9\0acb-\0acd\0ae2-\0ae3\0afa-\0aff\0b01-\0b03\0b3c\0b3e-\0b44\0b47-\0b48\0b4b-\0b4d\0b55-\0b57' ||
    U&'\0b62-\0b63\0b82\0bbe-\0bc2\0bc6-\0bc8\0bca-\0bcd\0bd7\0c00-\0c04\0c3c\0c3e-\0c44\0c46-\0c48\0c4a-\0c4d\0c55-\0c56' ||
    U&'\0c62-\0c63\0c81-\0c83\0cbc\0cbe-\0cc4\0cc6-\0cc8\0cca-\0ccd\0cd5-\0cd6\0ce2-\0ce3\0cf3\0d00-\0d03\0d3b-\0d3c\0d3e-\0d44' ||
    U&'\0d46-\0d48\0d4a-\0d4d\0d57\0d62-\0d63\0d81-\0d83\0dca\0dcf-\0dd4\0dd6\0dd8-\0ddf\0df2-\0df3\0e31\0e34-\0e3a' ||
    U&'\0e47-\0e4e\0eb1\0eb4-\0ebc\0ec8-\0ece\0f18-\0f19\0f35\0f37\0f39\0f3e-\0f3f\0f71-\0f84\0f86-\0f87\0f8d-\0f97' ||
    U&'\0f99-\0fbc\0fc6\102b-\103e\1056-\1059\105e-\1060\1062-\1064\1067-\106d\1071-\1074\1082-\108d\108f\109a-\109d\135d-\135f' ||
    U&'\1712-\1715\1732-\1734\1752-\1753\1772-\1773\17b4-\17d3\17dd\180b-\180d\180f\1885-\1886\18a9\1920-\192b\1930-\193b' ||
    U&'\1a17-\1a1b\1a55-\1a5e\1a60-\1a7c\1a7f\1ab0-\1add\1ae0-\1aeb\1b00-\1b04\1b34-\1b44\1b6b-\1b73\1b80-\1b82\1ba1-\1bad\1be6-\1bf3' ||
    U&'\1c24-\1c37\1cd0-\1cd2\1cd4-\1ce8\1ced\1cf4\1cf7-\1cf9\1dc0-\1dff\20d0-\20f0\2cef-\2cf1\2d7f\2de0-\2dff\302a-\302f' ||
    U&'\3099-\309a\a66f-\a672\a674-\a67d\a69e-\a69f\a6f0-\a6f1\a802\a806\a80b\a823-\a827\a82c\a880-\a881\a8b4-\a8c5' ||
    U&'\a8e0-\a8f1\a8ff\a926-\a92d\a947-\a953\a980-\a983\a9b3-\a9c0\a9e5\aa29-\aa36\aa43\aa4c-\aa4d\aa7b-\aa7d\aab0' ||
    U&'\aab2-\aab4\aab7-\aab8\aabe-\aabf\aac1\aaeb-\aaef\aaf5-\aaf6\abe3-\abea\abec-\abed\fb1e\fe00-\fe0f\fe20-\fe2f\+0101fd' ||
    U&'\+0102e0\+010376-\+01037a\+010a01-\+010a03\+010a05-\+010a06\+010a0c-\+010a0f\+010a38-\+010a3a\+010a3f\+010ae5-\+010ae6\+010d24-\+010d27\+010d69-\+010d6d\+010eab-\+010eac\+010efa-\+010eff' ||
    U&'\+010f46-\+010f50\+010f82-\+010f85\+011000-\+011002\+011038-\+011046\+011070\+011073-\+011074\+01107f-\+011082\+0110b0-\+0110ba\+0110c2\+011100-\+011102\+011127-\+011134\+011145-\+011146' ||
    U&'\+011173\+011180-\+011182\+0111b3-\+0111c0\+0111c9-\+0111cc\+0111ce-\+0111cf\+01122c-\+011237\+01123e\+011241\+0112df-\+0112ea\+011300-\+011303\+01133b-\+01133c\+01133e-\+011344' ||
    U&'\+011347-\+011348\+01134b-\+01134d\+011357\+011362-\+011363\+011366-\+01136c\+011370-\+011374\+0113b8-\+0113c0\+0113c2\+0113c5\+0113c7-\+0113ca\+0113cc-\+0113d0\+0113d2' ||
    U&'\+0113e1-\+0113e2\+011435-\+011446\+01145e\+0114b0-\+0114c3\+0115af-\+0115b5\+0115b8-\+0115c0\+0115dc-\+0115dd\+011630-\+011640\+0116ab-\+0116b7\+01171d-\+01172b\+01182c-\+01183a\+011930-\+011935' ||
    U&'\+011937-\+011938\+01193b-\+01193e\+011940\+011942-\+011943\+0119d1-\+0119d7\+0119da-\+0119e0\+0119e4\+011a01-\+011a0a\+011a33-\+011a39\+011a3b-\+011a3e\+011a47\+011a51-\+011a5b' ||
    U&'\+011a8a-\+011a99\+011b60-\+011b67\+011c2f-\+011c36\+011c38-\+011c3f\+011c92-\+011ca7\+011ca9-\+011cb6\+011d31-\+011d36\+011d3a\+011d3c-\+011d3d\+011d3f-\+011d45\+011d47\+011d8a-\+011d8e' ||
    U&'\+011d90-\+011d91\+011d93-\+011d97\+011ef3-\+011ef6\+011f00-\+011f01\+011f03\+011f34-\+011f3a\+011f3e-\+011f42\+011f5a\+013440\+013447-\+013455\+01611e-\+01612f\+016af0-\+016af4' ||
    U&'\+016b30-\+016b36\+016f4f\+016f51-\+016f87\+016f8f-\+016f92\+016fe4\+016ff0-\+016ff1\+01bc9d-\+01bc9e\+01cf00-\+01cf2d\+01cf30-\+01cf46\+01d165-\+01d169\+01d16d-\+01d172\+01d17b-\+01d182' ||
    U&'\+01d185-\+01d18b\+01d1aa-\+01d1ad\+01d242-\+01d244\+01da00-\+01da36\+01da3b-\+01da6c\+01da75\+01da84\+01da9b-\+01da9f\+01daa1-\+01daaf\+01e000-\+01e006\+01e008-\+01e018\+01e01b-\+01e021' ||
    U&'\+01e023-\+01e024\+01e026-\+01e02a\+01e08f\+01e130-\+01e136\+01e2ae\+01e2ec-\+01e2ef\+01e4ec-\+01e4ef\+01e5ee-\+01e5ef\+01e6e3\+01e6e6\+01e6ee-\+01e6ef\+01e6f5' ||
    U&'\+01e8d0-\+01e8d6\+01e944-\+01e94a\+0e0100-\+0e01ef' || ']','','g') COLLATE pg_catalog."en-US-x-icu") COLLATE "C"
$fold$;
REVOKE ALL ON FUNCTION burimunsi.payment_search_text(text) FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_sms_runtime;
GRANT EXECUTE ON FUNCTION burimunsi.payment_search_text(text) TO collect_runtime;

COMMIT;
