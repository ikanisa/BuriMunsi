-- Run after the guarded synthetic seed from burimunsi-browser-passcode.sql.
DO $test$
DECLARE
  group_id text:='browser-fixture-group'; origin text:='https://burimunsi-admin.ikanisa.com';
  initial_admin uuid:='20000000-0000-4000-8000-000000000001'; initial_staff uuid:='20000000-0000-4000-8000-000000000002';
  owner_cookie text:=repeat('b',64); staff_cookie text:=repeat('c',64); peer_cookie text:=repeat('d',64);
  admission uuid:=gen_random_uuid(); req uuid:=gen_random_uuid(); profile_src text; ep bigint;
  actor jsonb; directory jsonb; created jsonb; change jsonb; credential jsonb; command jsonb; peer uuid;
BEGIN
  IF inet_server_addr() IS NOT NULL OR current_database() !~ '^collect_archive_[0-9a-f]{24}_test$' OR
     current_setting('cluster_name')<>'collect_archive_next_fixture' OR session_user<>'postgres' THEN
    RAISE EXCEPTION 'owned_browser_passcode_fixture_required'; END IF;
  SELECT source_sha256,epoch INTO profile_src,ep FROM private.collect_fence_control WHERE singleton;
  PERFORM set_config('role','collect_runtime',true);
  PERFORM set_config('collect.edge_verified','true',true);
  PERFORM set_config('request.jwt.claims','{}',true);
  PERFORM private.collect_fence_register(admission,profile_src,'http_admin');
  PERFORM set_config('collect.fence_admission_id',admission::text,true);
  PERFORM set_config('collect.fence_epoch',ep::text,true);
  PERFORM set_config('collect.fence_source_sha256',profile_src,true);
  IF NOT private.burimunsi_browser_pin_issue(group_id,initial_staff,2,2,staff_cookie,gen_random_uuid(),gen_random_uuid(),origin) THEN
    RAISE EXCEPTION 'existing_staff_phone_login_failed'; END IF;
  actor:=private.burimunsi_browser_pin_session(group_id,staff_cookie,origin);
  IF actor->>'operatorRole' IS DISTINCT FROM 'staff' OR actor->>'accountId' IS DISTINCT FROM initial_staff::text OR actor->>'email' IS NOT NULL OR
      actor->'permissions' ? 'admin_users.manage' THEN RAISE EXCEPTION 'staff_role_projection_wrong'; END IF;
  PERFORM private.burimunsi_browser_pin_set_context(group_id,staff_cookie,origin);
  BEGIN
    PERFORM private.burimunsi_browser_team(group_id); RAISE EXCEPTION 'staff_team_access';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM private.burimunsi_browser_team_write(group_id,req,'{"action":"create"}',NULL); RAISE EXCEPTION 'staff_team_write';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('burimunsi.browser_pin_cookie','',true);
  IF NOT private.burimunsi_browser_pin_issue(group_id,initial_admin,1,1,owner_cookie,gen_random_uuid(),gen_random_uuid(),origin) THEN
    RAISE EXCEPTION 'historic_admin_login_failed'; END IF;
  actor:=private.burimunsi_browser_pin_session(group_id,owner_cookie,origin);
  IF actor->>'operatorRole' IS DISTINCT FROM 'admin' OR actor->>'storageRole' IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'admin_role_projection_wrong'; END IF;
  PERFORM private.burimunsi_browser_pin_set_context(group_id,owner_cookie,origin);
  directory:=private.burimunsi_browser_team(group_id);
  IF NOT (directory->>'canManage')::boolean OR jsonb_array_length(directory->'members')<>2 OR
      directory->'permissionsByRole' ? 'owner' THEN RAISE EXCEPTION 'team_directory_wrong'; END IF;
  BEGIN
    PERFORM private.burimunsi_browser_team_write(group_id,gen_random_uuid(),jsonb_build_object('action','access','id',initial_admin,'expectedVersion',1,'active',false),NULL);
    RAISE EXCEPTION 'last_admin_disabled';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'burimunsi_last_admin' THEN RAISE; END IF; END;

  command:=jsonb_build_object('action','create','phone','+250780000054','displayName','Synthetic peer','role','admin');
  credential:=jsonb_build_object('algorithm','pbkdf2-sha256+hmac-v1','hash',repeat('7',64));
  created:=private.burimunsi_browser_team_write(group_id,req,command,credential);
  peer:=(created->>'id')::uuid;
  IF NOT (created->>'applied')::boolean OR private.burimunsi_browser_team_write(group_id,req,command,credential) IS DISTINCT FROM created THEN
    RAISE EXCEPTION 'account_creation_replay_failed'; END IF;
  BEGIN
    PERFORM private.burimunsi_browser_team_write(group_id,req,command||'{"role":"staff"}',credential);
    RAISE EXCEPTION 'reuse_changed_command';
  EXCEPTION WHEN serialization_failure THEN NULL; END;
  PERFORM set_config('burimunsi.browser_pin_cookie','',true);
  IF NOT private.burimunsi_browser_pin_issue(group_id,peer,1,1,peer_cookie,gen_random_uuid(),gen_random_uuid(),origin) THEN
    RAISE EXCEPTION 'peer_phone_login_failed'; END IF;
  PERFORM private.burimunsi_browser_pin_set_context(group_id,peer_cookie,origin);
  directory:=private.burimunsi_browser_team(group_id);
  IF directory->>'currentAccountId' IS DISTINCT FROM peer::text OR
     NOT (directory->>'canManage')::boolean THEN RAISE EXCEPTION 'peer_team_authority_failed'; END IF;
  actor:=private.burimunsi_browser_pin_session(group_id,peer_cookie,origin);
  IF private.assert_actor('admin_users.manage',NULL,NULL,2,300) IS DISTINCT FROM actor->>'principalId' OR
     NOT (actor->'permissions' ? 'overview.read') OR private.assert_actor('overview.read',NULL,NULL,1,NULL) IS DISTINCT FROM actor->>'principalId' THEN
    RAISE EXCEPTION 'peer_guarded_workflow_denied'; END IF;
  IF private.burimunsi_browser_pin_change(group_id,peer_cookie,origin,initial_admin,1,1,credential) THEN RAISE EXCEPTION 'cross_account_passcode_change'; END IF;
  change:=private.burimunsi_browser_team_write(group_id,gen_random_uuid(),jsonb_build_object('action','access','id',initial_admin,'expectedVersion',1,'active',true,'role','staff'),NULL);
  IF (change->>'version')::bigint<>2 OR private.burimunsi_browser_pin_session(group_id,owner_cookie,origin) IS NOT NULL THEN RAISE EXCEPTION 'role_reduction_kept_cookie'; END IF;
  change:=private.burimunsi_browser_team_write(group_id,gen_random_uuid(),jsonb_build_object('action','access','id',initial_admin,'expectedVersion',2,'active',false),NULL);
  IF private.burimunsi_browser_pin_issue(group_id,initial_admin,3,3,repeat('a',64),gen_random_uuid(),gen_random_uuid(),origin) THEN
    RAISE EXCEPTION 'disabled_account_signed_in'; END IF;
  change:=private.burimunsi_browser_team_write(group_id,gen_random_uuid(),jsonb_build_object('action','access','id',initial_admin,'expectedVersion',3,'active',true,'role','admin'),NULL);
  IF (change->>'version')::bigint<>4 THEN RAISE EXCEPTION 'account_restore_failed'; END IF;
  IF NOT private.burimunsi_browser_pin_change(group_id,peer_cookie,origin,peer,1,1,credential) OR
      private.burimunsi_browser_pin_session(group_id,peer_cookie,origin) IS NOT NULL THEN
    RAISE EXCEPTION 'personal_change_kept_old_cookie'; END IF;
  IF NOT private.burimunsi_browser_pin_issue(group_id,peer,2,2,repeat('9',64),gen_random_uuid(),gen_random_uuid(),origin) THEN
    RAISE EXCEPTION 'peer_reauthentication_failed'; END IF;
END;
$test$;
