-- Run on the socket-only PG17 phone operator fixture after the SMS migrations and the read-scope correction.
BEGIN;

DO $fixture$
BEGIN
  IF inet_server_addr() IS NOT NULL OR current_database() !~ '^collect_archive_[0-9a-f]{24}_test$'
    OR current_setting('cluster_name')<>'collect_archive_next_fixture' OR current_setting('server_version_num')::int/10000<>17
    OR current_user<>'postgres' OR session_user<>'postgres'
    OR NOT EXISTS(SELECT 1 FROM app.collections WHERE id='browser-fixture-group') THEN
    RAISE EXCEPTION 'owned_phone_sms_fixture_required';
  END IF;
END;
$fixture$;

CREATE FUNCTION pg_temp.assert_sms_hidden(lane text,group_id text) RETURNS void LANGUAGE plpgsql AS $check$
DECLARE sample jsonb;
BEGIN
  BEGIN
    CASE lane
      WHEN 'health' THEN sample:=private.burimunsi_admin_sms_health();
      WHEN 'operations' THEN sample:=private.burimunsi_admin_sms_operations();
      WHEN 'groups' THEN sample:=private.burimunsi_observation_admin_collections();
      WHEN 'page' THEN sample:=private.burimunsi_observation_admin_page(group_id,1,0);
      ELSE RAISE EXCEPTION 'unknown_fixture_lane';
    END CASE;
  EXCEPTION WHEN insufficient_privilege THEN RETURN;
  END;
  IF sample IS NOT NULL AND NOT (lane='groups' AND sample='[]'::jsonb) THEN
    RAISE EXCEPTION 'unauthorized_sms_projection_was_visible: %',lane;
  END IF;
END;
$check$;

DO $cases$
DECLARE
  group_id constant text:='browser-fixture-group';
  origin constant text:='https://burimunsi-admin.ikanisa.com';
  creator constant uuid:='20000000-0000-4000-8000-000000000001';
  staff constant uuid:='20000000-0000-4000-8000-000000000002';
  owner_cookie text:=encode(sha256(gen_random_uuid()::text::bytea),'hex');
  peer_cookie text:=encode(sha256(gen_random_uuid()::text::bytea),'hex');
  staff_cookie text:=encode(sha256(gen_random_uuid()::text::bytea),'hex');
  admitted uuid:=gen_random_uuid(); source text; epoch bigint; peer_id uuid; peer_principal text;
  peer jsonb; sample jsonb; lane text; removed_grant text;
  all_lanes constant text[]:=ARRAY['health','operations','groups','page'];
BEGIN
  SELECT f.source_sha256,f.epoch INTO STRICT source,epoch FROM private.collect_fence_control f WHERE singleton AND mode='open';
  PERFORM set_config('role','collect_runtime',true);
  PERFORM set_config('collect.edge_verified','true',true);
  PERFORM set_config('request.jwt.claims','{}',true);
  PERFORM private.collect_fence_register(admitted,source,'http_admin');
  PERFORM set_config('collect.fence_admission_id',admitted::text,true);
  PERFORM set_config('collect.fence_source_sha256',source,true);
  PERFORM set_config('collect.fence_epoch',epoch::text,true);

  IF private.burimunsi_browser_pin_issue(group_id,creator,1,1,owner_cookie,gen_random_uuid(),gen_random_uuid(),origin) IS NOT TRUE THEN
    RAISE EXCEPTION 'synthetic_admin_signin_failed';
  END IF;
  PERFORM private.burimunsi_browser_pin_set_context(group_id,owner_cookie,origin);
  peer:=private.burimunsi_browser_team_write(group_id,gen_random_uuid(),
    jsonb_build_object('action','create','phone','+250780000065','displayName','Synthetic SMS administrator','role','admin'),
    jsonb_build_object('algorithm','pbkdf2-sha256+hmac-v1','hash',repeat('6',64)));
  peer_id:=(peer->>'id')::uuid;
  PERFORM set_config('burimunsi.browser_pin_cookie','',true);
  IF private.burimunsi_browser_pin_issue(group_id,peer_id,1,1,peer_cookie,gen_random_uuid(),gen_random_uuid(),origin) IS NOT TRUE THEN
    RAISE EXCEPTION 'synthetic_phone_admin_signin_failed';
  END IF;
  PERFORM private.burimunsi_browser_pin_set_context(group_id,peer_cookie,origin);
  peer:=private.burimunsi_browser_pin_session(group_id,peer_cookie,origin);
  peer_principal:=peer->>'principalId';
  IF peer->>'operatorRole' IS DISTINCT FROM 'admin' OR peer->>'collectionId' IS DISTINCT FROM group_id
    OR (peer->'permissions' ?& ARRAY['sms.read','system_health.read']) IS NOT TRUE THEN
    RAISE EXCEPTION 'phone_admin_grants_missing_from_fixture';
  END IF;
  PERFORM set_config('role','postgres',true);
  IF EXISTS(SELECT 1 FROM app.memberships m WHERE m.user_id=peer_principal AND m.active=1) THEN
    RAISE EXCEPTION 'fixture_phone_admin_must_have_no_business_membership';
  END IF;
  PERFORM set_config('role','collect_runtime',true);

  sample:=private.burimunsi_admin_sms_health();
  IF (sample->'burimunsi_sms' ?& ARRAY['pending','retrying','blocked','unmatched','posted','oldest_pending_seconds']) IS NOT TRUE
    OR (sample->'burimunsi_payer_sms' ?& ARRAY['pending','gateway_accepted','sent','delivered','failed','unknown','suppressed']) IS NOT TRUE THEN
    RAISE EXCEPTION 'phone_sms_queue_projection_missing';
  END IF;
  sample:=private.burimunsi_admin_sms_operations();
  IF (sample ?& ARRAY['scheduler_enabled','cron_active','oldest_pending_seconds','reasons','payer']) IS NOT TRUE
    OR (sample->'payer' ? 'expired') IS NOT TRUE THEN RAISE EXCEPTION 'phone_sms_operational_projection_missing'; END IF;
  sample:=private.burimunsi_observation_admin_collections();
  IF jsonb_array_length(sample) IS DISTINCT FROM 1 OR sample->0->>'collectionId' IS DISTINCT FROM group_id THEN
    RAISE EXCEPTION 'phone_sms_collection_scope_changed';
  END IF;
  sample:=private.burimunsi_observation_admin_page(group_id,1,0);
  IF sample->>'collectionId' IS DISTINCT FROM group_id THEN RAISE EXCEPTION 'phone_sms_own_page_missing'; END IF;
  PERFORM pg_temp.assert_sms_hidden('page','other-fixture-group');

  -- Each subtransaction rolls its synthetic grant change back independently.
  FOREACH removed_grant IN ARRAY ARRAY['sms.read','system_health.read'] LOOP
    BEGIN
      PERFORM set_config('role','postgres',true);
      DELETE FROM app.admin_grants g WHERE g.user_id=peer_principal AND g.permission=removed_grant;
      IF NOT FOUND THEN RAISE EXCEPTION 'fixture_grant_not_revoked'; END IF;
      PERFORM set_config('role','collect_runtime',true);
      PERFORM pg_temp.assert_sms_hidden('health',group_id);
      PERFORM pg_temp.assert_sms_hidden('operations',group_id);
      IF removed_grant='sms.read' THEN
        PERFORM pg_temp.assert_sms_hidden('groups',group_id);
        PERFORM pg_temp.assert_sms_hidden('page',group_id);
      END IF;
      RAISE EXCEPTION USING ERRCODE='PZ001',MESSAGE='restore_fixture_grant';
    EXCEPTION WHEN SQLSTATE 'PZ001' THEN NULL; END;
  END LOOP;

  PERFORM set_config('burimunsi.browser_pin_cookie','',true);
  IF private.burimunsi_browser_pin_issue(group_id,staff,2,2,staff_cookie,gen_random_uuid(),gen_random_uuid(),origin) IS NOT TRUE THEN
    RAISE EXCEPTION 'synthetic_staff_signin_failed';
  END IF;
  PERFORM private.burimunsi_browser_pin_set_context(group_id,staff_cookie,origin);
  FOREACH lane IN ARRAY all_lanes LOOP PERFORM pg_temp.assert_sms_hidden(lane,group_id); END LOOP;

  PERFORM set_config('burimunsi.browser_pin_cookie','',true);
  PERFORM private.burimunsi_browser_pin_set_context(group_id,owner_cookie,origin);
  PERFORM private.burimunsi_browser_team_write(group_id,gen_random_uuid(),
    jsonb_build_object('action','access','id',peer_id,'expectedVersion',1,'active',false),NULL);
  IF private.burimunsi_browser_pin_session(group_id,peer_cookie,origin) IS NOT NULL THEN RAISE EXCEPTION 'disabled_phone_cookie_accepted'; END IF;
  -- Reuse the original, now-revoked cookie against every read projection.
  PERFORM set_config('burimunsi.browser_pin_cookie',peer_cookie,true);
  FOREACH lane IN ARRAY all_lanes LOOP PERFORM pg_temp.assert_sms_hidden(lane,group_id); END LOOP;
END;
$cases$;

ROLLBACK;
