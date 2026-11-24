-- Synthetic data for an owned Socket-only PostgreSQL 17 archive fixture.
-- Run only after the managed chain and the browser passcode migration are installed.
DO $fixture_target$
BEGIN
  IF inet_server_addr() IS NOT NULL
    OR current_database() !~ '^collect_archive_[0-9a-f]{24}_test$'
    OR current_setting('cluster_name') <> 'collect_archive_next_fixture'
    OR current_setting('server_version_num')::integer / 10000 <> 17
    OR session_user <> 'postgres' OR current_user <> 'postgres'
    OR EXISTS (SELECT 1 FROM app.collections)
    OR EXISTS (SELECT 1 FROM app.admin_users)
    OR EXISTS (SELECT 1 FROM auth.sessions) THEN
    RAISE EXCEPTION 'owned_browser_passcode_fixture_required';
  END IF;
END;
$fixture_target$;

BEGIN;
SELECT private.collect_fence_release_v3(gen_random_uuid(), epoch, source_sha256)
FROM private.collect_fence_control WHERE singleton;

UPDATE auth.users SET email_confirmed_at = now() WHERE email = 'synthetic@example.invalid';
-- The archive seed uses a placeholder. Canonical person allocation expects six digits.
UPDATE app.users SET public_id='989999' WHERE id='synthetic-primary' AND public_id='synthetic-public';
INSERT INTO private.collect_owner_identity(operation_id,admin_user_id,principal_user_id,owner_email,approval_reference)
VALUES(gen_random_uuid(),'browser-fixture-owner','synthetic-primary','synthetic@example.invalid','synthetic-browser-owner');
INSERT INTO app.admin_users(id,email,role,status,display_name,password_hash,created_at,updated_at)
VALUES('browser-fixture-owner','synthetic@example.invalid','owner','active','Synthetic Administrator','fixture-identity',1,1);
INSERT INTO app.admin_principal_links(admin_user_id,user_id,approved_by,approved_at)
VALUES('browser-fixture-owner','synthetic-primary','browser-fixture-owner','2026-01-01');
INSERT INTO app.users(id,public_id,created_at,updated_at)
VALUES('browser-fixture-staff','812345','2026-01-01','2026-01-01');
INSERT INTO app.collections(id,slug,creator_user_id,title,collection_type,created_at,updated_at)
VALUES('browser-fixture-group','browser-fixture-group','synthetic-primary','Synthetic browser group','community','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
INSERT INTO app.memberships(id,collection_id,user_id,role,active,joined_at)
VALUES(gen_random_uuid()::text,'browser-fixture-group','synthetic-primary','owner',1,'2026-01-01');
INSERT INTO app.momo_receiving_accounts(id,provider,public_code,recipient_name,receiver_hash,timezone,created_at)
VALUES('browser-fixture-wallet','mtn_momo','112233','Synthetic receiver',repeat('c',64),'Africa/Kigali','2026-01-01');
SELECT set_config('burimunsi.collection_id','browser-fixture-group',true);
INSERT INTO private.burimunsi_scopes(collection_id,receiving_account_id,created_at)
VALUES('browser-fixture-group','browser-fixture-wallet',1);
INSERT INTO private.burimunsi_operator_approvals(collection_id,principal_user_id,admin_user_id,phone,role,capabilities,active,version,approved_by,created_at,updated_at)
VALUES('browser-fixture-group','synthetic-primary','browser-fixture-owner','+250780000031','admin',
  ARRAY['records.read','members.enroll','sms.read','gateway.manage','staff.manage'],TRUE,1,'synthetic-primary',1,1);
INSERT INTO private.burimunsi_accounts(id,collection_id,principal_user_id,phone,name,role,capabilities,pin_hash,active,created_at,updated_at)
VALUES
  ('20000000-0000-4000-8000-000000000001','browser-fixture-group','synthetic-primary','+250780000031','Synthetic Administrator',
   'admin',ARRAY['records.read','members.enroll','sms.read','gateway.manage','staff.manage'],'{"algorithm":"synthetic-credential-record"}',true,1,1),
  ('20000000-0000-4000-8000-000000000002','browser-fixture-group','browser-fixture-staff','+250780000032','Synthetic Staff',
   'staff',ARRAY['records.read'],'{"algorithm":"synthetic-staff-record"}',false,1,1);
INSERT INTO private.burimunsi_native_staff_delegations(collection_id,principal_user_id,parent_account_id,capability_ceiling,
  created_request_id,creation_fingerprint,created_at)
VALUES('browser-fixture-group','browser-fixture-staff','20000000-0000-4000-8000-000000000001',ARRAY['records.read'],
  gen_random_uuid(),repeat('a',64),1);
UPDATE private.burimunsi_accounts SET active = true, version = 2, credential_version = 2 WHERE role = 'staff';
SELECT set_config('burimunsi.collection_id','',true);

DO $exercise$
DECLARE
  group_id constant text := 'browser-fixture-group';
  browser_origin constant text := 'https://burimunsi-admin.ikanisa.com';
  admin_phone constant text := '+250780000031';
  staff_phone constant text := '+250780000032';
  native_admin constant uuid := '20000000-0000-4000-8000-000000000001';
  native_staff constant uuid := '20000000-0000-4000-8000-000000000002';
  session_id constant uuid := '30000000-0000-4000-8000-000000000001';
  public_id constant uuid := '40000000-0000-4000-8000-000000000001';
  admin_admission uuid := gen_random_uuid();
  collect_admission uuid := gen_random_uuid();
  budget_id uuid := gen_random_uuid();
  cookie_hash text := repeat('b',64);
  authority_source text;
  authority_epoch text;
  candidate jsonb;
  account jsonb;
  replacement jsonb;
BEGIN
  SELECT source_sha256,epoch::text INTO authority_source,authority_epoch FROM private.collect_fence_control WHERE singleton;
  PERFORM set_config('role','collect_runtime',true);
  PERFORM set_config('collect.edge_verified','true',true);
  PERFORM set_config('request.jwt.claims','{}',true);
  PERFORM private.collect_fence_register(admin_admission,authority_source,'http_admin');
  PERFORM private.collect_fence_register(collect_admission,authority_source,'http_collect');
  PERFORM set_config('collect.fence_admission_id',collect_admission::text,true);
  PERFORM set_config('collect.fence_epoch',authority_epoch,true);
  PERFORM set_config('collect.fence_source_sha256',authority_source,true);
  BEGIN
    PERFORM private.burimunsi_browser_pin_candidate(group_id,admin_phone,encode(sha256(convert_to(admin_phone,'UTF8')),'hex'),
      budget_id,repeat('d',64),floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
    RAISE EXCEPTION 'candidate_allowed_through_wrong_lane';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM set_config('collect.fence_admission_id',admin_admission::text,true);
  BEGIN
    EXECUTE 'SELECT * FROM private.burimunsi_browser_pin_sessions';
    RAISE EXCEPTION 'browser_witness_directly_visible';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  candidate := private.burimunsi_browser_pin_candidate(group_id,staff_phone,encode(sha256(convert_to(staff_phone,'UTF8')),'hex'),
    budget_id,repeat('d',64),floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
  IF candidate IS DISTINCT FROM '{"allowed":true,"account":null}'::jsonb
    OR private.burimunsi_browser_pin_issue(group_id,native_staff,2,2,cookie_hash,session_id,public_id,browser_origin) THEN
    RAISE EXCEPTION 'staff_received_browser_authority';
  END IF;

  candidate := private.burimunsi_browser_pin_candidate(group_id,admin_phone,encode(sha256(convert_to(admin_phone,'UTF8')),'hex'),
    budget_id,repeat('d',64),floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
  IF candidate->>'allowed' IS DISTINCT FROM 'true' OR candidate->'account'->>'id' IS DISTINCT FROM native_admin::text THEN
    RAISE EXCEPTION 'canonical_admin_not_found';
  END IF;
  IF private.burimunsi_browser_pin_issue(group_id,native_admin,2,1,cookie_hash,session_id,public_id,browser_origin)
    OR private.burimunsi_browser_pin_issue(group_id,native_admin,1,1,cookie_hash,session_id,public_id,'https://platform-admin.collect.ikanisa.com')
    OR private.burimunsi_browser_pin_issue(group_id,native_admin,1,1,cookie_hash,session_id,public_id,browser_origin) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'browser_issue_contract_failed';
  END IF;
  account := private.burimunsi_browser_pin_session(group_id,cookie_hash,browser_origin);
  IF account->>'sessionId' IS DISTINCT FROM session_id::text OR account->>'publicId' IS DISTINCT FROM public_id::text
    OR account->>'principalId' IS DISTINCT FROM 'synthetic-primary' OR NOT (account->'permissions' ? 'payments.read')
    OR private.burimunsi_browser_pin_session(group_id,cookie_hash,'https://platform-admin.collect.ikanisa.com') IS NOT NULL THEN
    RAISE EXCEPTION 'browser_cookie_projection_mismatch';
  END IF;
  BEGIN
    PERFORM private.burimunsi_browser_pin_set_context(group_id,repeat('e',64),browser_origin);
    RAISE EXCEPTION 'missing_cookie_context_accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  PERFORM private.burimunsi_browser_pin_set_context(group_id,cookie_hash,browser_origin);
  IF api.current_principal_id() IS DISTINCT FROM 'synthetic-primary'
    OR api.current_session_id() IS DISTINCT FROM session_id::text
    OR private.assert_actor('payments.read',group_id,'owner',1,NULL) IS DISTINCT FROM 'synthetic-primary'
    OR private.burimunsi_browser_pin_is_fresh(300) IS DISTINCT FROM true
    OR private.burimunsi_browser_pin_is_fresh(0) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'canonical_browser_actor_not_verified';
  END IF;
  BEGIN
    PERFORM private.assert_actor('payments.read','wrong-group','owner',1,NULL);
    RAISE EXCEPTION 'browser_out_of_scope_actor_accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  IF jsonb_array_length(private.burimunsi_observation_admin_collections()) <> 1
    OR private.burimunsi_admin_transaction_visibility('synthetic-unmatched') IS DISTINCT FROM '{"kind":"managed","groupId":null}'::jsonb THEN
    RAISE EXCEPTION 'browser_observation_authority_unavailable';
  END IF;
  PERFORM set_config('burimunsi.collection_id',group_id,true);
  IF private.burimunsi_operator_directory('browser-fixture-owner',cookie_hash,browser_origin,public_id::text,group_id)->>'configured'
    IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'browser_owner_authority_unavailable';
  END IF;
  PERFORM set_config('burimunsi.collection_id','',true);

  INSERT INTO app.mutation_guards(id,user_id,session_id,now_seconds,collection_id,required_group_role,permission,fresh_seconds,minimum_assurance)
  VALUES(gen_random_uuid()::text,'synthetic-primary',session_id::text,app.unixepoch(),group_id,'owner','payments.read',300,2);
  -- Cross the strict one-second freshness boundary without modifying the witness.
  PERFORM pg_sleep(2.1);
  BEGIN
    PERFORM private.assert_actor('payments.read',group_id,'owner',1,1);
    RAISE EXCEPTION 'stale_passcode_proof_accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'recent_passcode_required' THEN RAISE; END IF;
  END;
  IF private.burimunsi_browser_pin_verify(group_id,cookie_hash,browser_origin,native_admin,1,1) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'same_session_passcode_verification_failed';
  END IF;
  replacement := private.burimunsi_browser_pin_session(group_id,cookie_hash,browser_origin);
  IF replacement->>'proofId' IS NOT DISTINCT FROM account->>'proofId'
    OR replacement->>'sessionId' IS DISTINCT FROM session_id::text
    OR replacement->>'expiresAt' IS DISTINCT FROM account->>'expiresAt'
    OR private.burimunsi_browser_pin_is_fresh(1) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'same_session_passcode_proof_not_rotated';
  END IF;

  PERFORM set_config('role','none',true);
  IF EXISTS (SELECT 1 FROM auth.sessions) OR EXISTS (SELECT 1 FROM private.bff_sessions)
    OR EXISTS (SELECT 1 FROM private.admin_sensitive_email_proofs)
    OR NOT EXISTS (SELECT 1 FROM app.auth_sessions WHERE id = session_id::text AND mfa_at IS NULL AND assurance_level = 1) THEN
    RAISE EXCEPTION 'browser_created_managed_proof';
  END IF;
  PERFORM set_config('burimunsi.collection_id',group_id,true);
  UPDATE private.burimunsi_accounts SET pin_hash = '{"algorithm":"synthetic-rotated-record"}',
    version = version + 1, credential_version = credential_version + 1, updated_at = 2 WHERE id = native_admin;
  PERFORM set_config('burimunsi.collection_id','',true);
  PERFORM set_config('role','collect_runtime',true);
  IF private.burimunsi_browser_pin_session(group_id,cookie_hash,browser_origin) IS NOT NULL OR api.current_session_id() IS NOT NULL THEN
    RAISE EXCEPTION 'superseded_native_pin_left_browser_signed_in';
  END IF;
  PERFORM private.burimunsi_browser_pin_logout(group_id,cookie_hash,browser_origin);
  PERFORM private.burimunsi_browser_pin_logout(group_id,cookie_hash,browser_origin);
  PERFORM set_config('role','none',true);
  IF EXISTS(SELECT 1 FROM app.admin_sessions WHERE token_hash=cookie_hash)
    OR NOT EXISTS(SELECT 1 FROM app.auth_sessions WHERE id=session_id::text AND revoked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'browser_logout_not_durably_revoked';
  END IF;
  PERFORM set_config('role','collect_runtime',true);
  PERFORM private.collect_fence_close(admin_admission,authority_epoch::bigint,authority_source,'settled','completed',0,0);
  PERFORM private.collect_fence_close(collect_admission,authority_epoch::bigint,authority_source,'settled','completed',0,0);
  PERFORM set_config('role','none',true);
END;
$exercise$;
ROLLBACK;
