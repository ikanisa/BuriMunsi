-- BuriMunsi's internal account directory. Shared group memberships, financial
-- records and existing passcode hashes are independent of operator roles.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

DO $install$
BEGIN
  PERFORM private._collect_fence_require_operator();
  IF session_user <> 'postgres' OR current_user <> 'postgres' OR
      NOT EXISTS (SELECT 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced') THEN
    RAISE EXCEPTION 'burimunsi_operator_accounts_require_fence' USING ERRCODE='55000';
  END IF;
END;
$install$;

ALTER TABLE app.admin_users ADD COLUMN burimunsi_phone_only boolean NOT NULL DEFAULT false;
ALTER TABLE app.admin_users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE app.admin_users DROP CONSTRAINT admin_users_check1;
ALTER TABLE app.admin_users ADD CONSTRAINT admin_users_identity_method CHECK (
  (burimunsi_phone_only AND email IS NULL AND password_hash IS NULL AND role IN ('admin','staff') AND status <> 'invited') OR
  (NOT burimunsi_phone_only AND email IS NOT NULL AND (status <> 'active' OR password_hash IS NOT NULL))
);
ALTER TABLE private.burimunsi_operator_approvals ADD COLUMN identity_source text NOT NULL DEFAULT 'shared'
  CHECK (identity_source IN ('shared','phone','native_staff'));
DROP INDEX private.burimunsi_one_admin;

-- Synthetic history pins are immutable. Apply each narrow replacement to the
-- actual predecessor, retaining its existing signature, OID, ownership and ACL.
CREATE FUNCTION pg_temp.buri_replace_bound_body(target regprocedure, before_text text, after_text text)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE body text; definition text;
BEGIN
  SELECT prosrc, pg_get_functiondef(oid) INTO STRICT body, definition FROM pg_proc WHERE oid=target;
  IF before_text='' OR length(body)-length(replace(body,before_text,'')) <> length(before_text) THEN
    RAISE EXCEPTION 'burimunsi_operator_predecessor_changed: %',target;
  END IF;
  EXECUTE replace(definition,body,replace(body,before_text,after_text));
END;
$fn$;

-- Legacy delegation remains current after a phone-only web profile is linked.
-- Existing Android session witnesses keep the same byte-for-byte authority JSON.
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_pin_authority_snapshot(text,text,text,text,text[])',
  'NOT EXISTS(SELECT 1 FROM app.admin_principal_links l WHERE l.user_id=u.id)',
  'NOT EXISTS(SELECT 1 FROM app.admin_principal_links l JOIN app.admin_users w ON w.id=l.admin_user_id WHERE l.user_id=u.id AND NOT w.burimunsi_phone_only)');

ALTER FUNCTION private.burimunsi_pin_root_snapshot(text,text,text,text,text[]) RENAME TO burimunsi_shared_pin_root_snapshot;
CREATE FUNCTION private.burimunsi_pin_root_snapshot(p_collection text,p_principal text,p_phone text,p_role text,p_capabilities text[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE approval private.burimunsi_operator_approvals%ROWTYPE; result jsonb;
BEGIN
  SELECT * INTO approval FROM private.burimunsi_operator_approvals
    WHERE collection_id=p_collection AND principal_user_id=p_principal;
  IF NOT FOUND OR approval.identity_source='shared' THEN
    RETURN private.burimunsi_shared_pin_root_snapshot(p_collection,p_principal,p_phone,p_role,p_capabilities);
  END IF;
  IF approval.identity_source='native_staff' THEN RETURN NULL; END IF;
  IF NOT approval.active OR approval.phone IS DISTINCT FROM p_phone OR approval.role IS DISTINCT FROM p_role OR
      p_capabilities IS NULL OR NOT ('records.read'=ANY(p_capabilities)) OR NOT(p_capabilities <@ approval.capabilities) THEN RETURN NULL; END IF;
  SELECT jsonb_build_object('kind','phone_account','approvalVersion',approval.version,'adminId',w.id,
    'adminVersion',w.auth_version,'principalRevision',u.revision,'sharedRole',p_role) INTO result
    FROM app.users u JOIN app.admin_principal_links l ON l.user_id=u.id
    JOIN app.admin_users w ON w.id=l.admin_user_id AND w.id=approval.admin_user_id
    JOIN app.collections c ON c.id=p_collection AND c.status='active'
    WHERE u.id=p_principal AND u.access_status='active' AND w.status='active' AND (
      (w.burimunsi_phone_only AND w.role=p_role) OR
      (NOT w.burimunsi_phone_only AND EXISTS (
        SELECT 1 FROM private.auth_principal_links p JOIN auth.users actual ON actual.id=p.auth_user_id
        WHERE p.user_id=u.id AND actual.email_confirmed_at IS NOT NULL AND lower(actual.email)=lower(w.email)
          AND actual.deleted_at IS NULL AND (actual.banned_until IS NULL OR actual.banned_until<=statement_timestamp())
      )));
  RETURN result;
END;
$fn$;
REVOKE ALL ON FUNCTION private.burimunsi_pin_root_snapshot(text,text,text,text,text[]) FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;

-- Scope changes are issued only by an authenticated, explicitly authorized
-- internal Admin. The ordinary owner and shared-provider role remain protected.
CREATE OR REPLACE FUNCTION private.burimunsi_operator_approval_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$
BEGIN
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF (NEW.collection_id,NEW.principal_user_id,NEW.admin_user_id,NEW.created_at,NEW.lock_anchor) IS DISTINCT FROM
     (OLD.collection_id,OLD.principal_user_id,OLD.admin_user_id,OLD.created_at,OLD.lock_anchor) OR
     NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'burimunsi_approval_identity_immutable' USING ERRCODE='23514';
  END IF;
  IF (NEW.role,NEW.identity_source) IS DISTINCT FROM (OLD.role,OLD.identity_source) AND
      (NEW.identity_source <> 'phone' OR current_setting('burimunsi.team_subject',true) IS DISTINCT FROM NEW.principal_user_id OR
       (private.burimunsi_browser_pin_context()->>'operatorRole') IS DISTINCT FROM 'admin') THEN
    RAISE EXCEPTION 'burimunsi_approval_identity_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE FUNCTION private.burimunsi_browser_operator(p_group text,p_phone text,p_account uuid,p_lock boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE result jsonb; frame text:=current_setting('burimunsi.pin_frame',true);
BEGIN
  IF (p_phone IS NULL)=(p_account IS NULL) THEN RETURN NULL; END IF;
  PERFORM set_config('burimunsi.pin_frame','1',true);
  IF p_lock AND current_setting('transaction_read_only')='off' THEN
    PERFORM 1 FROM private.burimunsi_accounts a JOIN private.burimunsi_scopes s ON s.collection_id=a.collection_id
      JOIN app.collections c ON c.id=s.collection_id JOIN app.admin_principal_links l ON l.user_id=a.principal_user_id
      JOIN app.admin_users w ON w.id=l.admin_user_id JOIN app.users u ON u.id=l.user_id
      WHERE a.collection_id=p_group AND (a.phone=p_phone OR a.id=p_account)
      FOR SHARE OF a,s,c,l,w,u;
    PERFORM 1 FROM private.burimunsi_operator_approvals o JOIN private.burimunsi_accounts a
      ON a.collection_id=o.collection_id AND a.principal_user_id=o.principal_user_id
      WHERE a.collection_id=p_group AND (a.phone=p_phone OR a.id=p_account) FOR SHARE OF o;
    PERFORM 1 FROM private.auth_principal_links p JOIN auth.users m ON m.id=p.auth_user_id
      JOIN private.burimunsi_accounts a ON a.principal_user_id=p.user_id
      WHERE a.collection_id=p_group AND (a.phone=p_phone OR a.id=p_account) FOR SHARE OF p,m;
  END IF;
  SELECT jsonb_build_object('id',a.id,'groupId',a.collection_id,'principalUserId',a.principal_user_id,
    'phone',a.phone,'name',a.name,'role',a.role,'storageRole',w.role,'pinHash',a.pin_hash,
    'version',a.version,'credentialVersion',a.credential_version,'adminId',w.id,
    'authVersion',w.auth_version,'email',w.email,'authority',proof.value) INTO result
    FROM private.burimunsi_accounts a JOIN private.burimunsi_scopes s ON s.collection_id=a.collection_id
    JOIN app.collections c ON c.id=s.collection_id AND c.status='active'
    JOIN app.admin_principal_links l ON l.user_id=a.principal_user_id
    JOIN app.admin_users w ON w.id=l.admin_user_id AND w.status='active'
    JOIN app.users u ON u.id=a.principal_user_id AND u.access_status='active'
    JOIN private.burimunsi_operator_approvals o ON o.collection_id=a.collection_id AND o.principal_user_id=u.id
      AND o.admin_user_id=w.id AND o.active AND (o.identity_source='native_staff' OR (o.phone=a.phone AND o.role=a.role))
    CROSS JOIN LATERAL (SELECT private.burimunsi_pin_authority_snapshot(a.collection_id,u.id,a.phone,a.role,a.capabilities) AS value) proof
    WHERE a.collection_id=p_group AND (a.phone=p_phone OR a.id=p_account) AND a.active AND NOT a.removed
      AND proof.value IS NOT NULL AND (o.identity_source <> 'native_staff' OR a.role='staff' AND w.burimunsi_phone_only)
      AND (w.role<>'owner' OR private.collect_owner_is(w.id,u.id,w.email))
      AND NOT EXISTS(SELECT 1 FROM app.privacy_retention_barriers x WHERE x.subject_id=u.id);
  PERFORM set_config('burimunsi.pin_frame',coalesce(frame,''),true);
  RETURN result;
END;
$fn$;
REVOKE ALL ON FUNCTION private.burimunsi_browser_operator(text,text,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;

SELECT pg_temp.buri_replace_bound_body('private.burimunsi_browser_pin_candidate(text,text,text,uuid,text,bigint)',
  'private.burimunsi_browser_pin_owner(p_group, p_phone, false)','private.burimunsi_browser_operator(p_group,p_phone,NULL,false)');
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_browser_pin_issue(text,uuid,bigint,bigint,text,uuid,uuid,text)',
  'private.burimunsi_browser_pin_owner(p_group, NULL, true)','private.burimunsi_browser_operator(p_group,NULL,p_account,true)');
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_browser_pin_session(text,text,text)',
  'private.burimunsi_browser_pin_owner(p_group, NULL, can_lock)','private.burimunsi_browser_operator(p_group,NULL,witness.account_id,can_lock)');
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_browser_pin_session(text,text,text)',
  'jsonb_agg(g.permission ORDER BY g.permission)','jsonb_agg(DISTINCT g.permission ORDER BY g.permission)');
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_browser_pin_session(text,text,text)',
  $$c.role = 'owner' AND c.permission <> 'auth.mfa.enroll'$$,
  $$((account->>'role'='admin' AND c.role IN ('owner','admin')) OR (account->>'role'='staff' AND c.role='staff')) AND c.permission <> 'auth.mfa.enroll'$$);
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_browser_pin_session(text,text,text)',
  $$'accountId', witness.account_id,$$, $$'operatorRole',account->>'role','storageRole',account->>'storageRole','accountId', witness.account_id,$$);

-- Validate the issuer arguments before any previously delegated web profile is
-- attached. A rejected origin, malformed cookie or absent version writes zero rows.
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_browser_pin_issue(text,uuid,bigint,bigint,text,uuid,uuid,text)',
  'account jsonb := private.burimunsi_browser_operator(p_group,NULL,p_account,true);','account jsonb;');
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_browser_pin_issue(text,uuid,bigint,bigint,text,uuid,uuid,text)',
  $$    OR account->>'id' IS DISTINCT FROM p_account::text$$,
  $$    THEN RETURN false; END IF;
  account:=private.burimunsi_browser_operator(p_group,NULL,p_account,true);
  IF account->>'id' IS DISTINCT FROM p_account::text$$);

-- Keep the existing projected principal, native authority, current group, live
-- per-principal grant and original cookie binding at every protected operation.
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_browser_pin_assert_actor(text,text,text,bigint,bigint)',
  $$AND c.role = 'owner' AND c.permission <> 'auth.mfa.enroll'$$,
  $$AND ((actor->>'operatorRole'='admin' AND c.role IN ('admin','owner')) OR (actor->>'operatorRole'='staff' AND c.role='staff')) AND c.permission <> 'auth.mfa.enroll'$$);
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_browser_pin_assert_actor(text,text,text,bigint,bigint)',
  $$IF (p_min_aal > 1 OR p_fresh_seconds IS NOT NULL)
    AND NOT private.burimunsi_browser_pin_is_fresh(least(coalesce(p_fresh_seconds, 300), 300)) THEN
    RAISE EXCEPTION 'recent_passcode_required' USING ERRCODE = '42501';
  END IF;$$,
  $$IF coalesce(p_min_aal,1)>2 OR p_fresh_seconds IS NOT NULL AND p_fresh_seconds<1 THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501';
  END IF;$$);
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_browser_pin_owner_actor(text,text,text,text)',
  'IF actor IS NULL OR', $$IF actor IS NULL OR actor->>'operatorRole' IS DISTINCT FROM 'admin' OR$$);
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_admin_snapshot()',
  $$current_setting('transaction_read_only'), 'owner'::text$$,$$current_setting('transaction_read_only'), actor->>'operatorRole'$$);

SELECT pg_temp.buri_replace_bound_body('private.burimunsi_observation_admin_actor(boolean)',
  $$PERFORM private.burimunsi_browser_pin_assert_actor('sms.read', NULL, NULL, 1, NULL);$$,
  $$IF a.shared_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
   PERFORM private.burimunsi_browser_pin_assert_actor('sms.read', NULL, NULL, 1, NULL);$$);
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_observation_admin_actor(boolean)',
  $$'sessionId', a.principal_session_id, 'role', 'owner'$$,$$'sessionId', a.principal_session_id, 'role', a.shared_role$$);

-- Shared-mode worker authorizations keep their original owner attestation.
-- A grant originating in a dedicated browser must retain its original, current
-- scoped Admin. The original approved session stays part of the grant lineage.
CREATE FUNCTION private.burimunsi_grant_admin(p_collection text,p_admin text,p_principal text,p_session text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE w private.burimunsi_browser_pin_sessions%ROWTYPE;
BEGIN
  SELECT * INTO w FROM private.burimunsi_browser_pin_sessions
    WHERE session_id=p_session AND admin_id=p_admin AND principal_id=p_principal AND collection_id=p_collection;
  IF NOT FOUND THEN RETURN private.collect_owner_is(p_admin,p_principal,private.collect_owner_email()); END IF;
  RETURN EXISTS(SELECT 1 FROM private.burimunsi_accounts a
    JOIN app.admin_principal_links l ON l.user_id=a.principal_user_id AND l.admin_user_id=p_admin
    JOIN app.admin_users administrator ON administrator.id=l.admin_user_id AND administrator.status='active'
    JOIN private.burimunsi_operator_approvals o ON o.collection_id=a.collection_id AND o.principal_user_id=a.principal_user_id
      AND o.admin_user_id=p_admin AND o.role='admin' AND o.active
    WHERE a.collection_id=p_collection AND a.id=w.account_id AND a.principal_user_id=p_principal
      AND a.role='admin' AND a.active AND NOT a.removed AND private.burimunsi_pin_root_snapshot(
        a.collection_id,a.principal_user_id,a.phone,a.role,a.capabilities) IS NOT NULL);
END;
$fn$;
REVOKE ALL ON FUNCTION private.burimunsi_grant_admin(text,text,text,text) FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;
SELECT pg_temp.buri_replace_bound_body('private._burimunsi_native_grant_actor(text,text,text,text)',
  $$NOT private.collect_owner_is(p_actor,a->>'principalId',private.collect_owner_email())$$,
  $$NOT (CASE WHEN nullif(current_setting('burimunsi.browser_pin_cookie',true),'') IS NOT NULL THEN
    private.burimunsi_browser_pin_context()->>'operatorRole'='admin' AND private.burimunsi_browser_pin_context()->>'adminId'=p_actor
    ELSE private.collect_owner_is(p_actor,a->>'principalId',private.collect_owner_email()) END)$$);
SELECT pg_temp.buri_replace_bound_body('private._burimunsi_native_work_authority(uuid)',
  $$private.collect_owner_is(w.approved_admin_id,w.approved_principal_id,a.email)$$,
  $$private.burimunsi_grant_admin(w.collection_id,w.approved_admin_id,w.approved_principal_id,w.approval_session_id::text)$$);

CREATE FUNCTION private.burimunsi_phone_profile(p_group text,p_principal text,p_name text,p_phone text,p_role text,p_caps text[],
  p_actor text,p_source text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE web_id text:=gen_random_uuid()::text; at_seconds bigint:=floor(extract(epoch FROM clock_timestamp()))::bigint;
BEGIN
  IF p_source NOT IN ('phone','native_staff') OR p_role NOT IN ('admin','staff') OR p_principal IS NULL OR
      EXISTS(SELECT 1 FROM app.admin_principal_links WHERE user_id=p_principal) OR
      EXISTS(SELECT 1 FROM private.burimunsi_operator_approvals WHERE collection_id=p_group AND principal_user_id=p_principal) THEN
    RAISE EXCEPTION 'burimunsi_identity_conflict' USING ERRCODE='23505';
  END IF;
  INSERT INTO app.admin_users(id,burimunsi_phone_only,role,status,display_name,created_at,accepted_at,updated_at)
    VALUES(web_id,true,p_role,'active',p_name,at_seconds,at_seconds,at_seconds);
  INSERT INTO app.admin_principal_links(admin_user_id,user_id,approved_by,approved_at)
    VALUES(web_id,p_principal,p_actor,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  INSERT INTO private.burimunsi_operator_approvals(collection_id,principal_user_id,admin_user_id,phone,role,capabilities,
    active,version,approved_by,created_at,updated_at,identity_source)
    VALUES(p_group,p_principal,web_id,p_phone,p_role,p_caps,true,1,p_actor,at_seconds*1000,at_seconds*1000,p_source);
  RETURN web_id;
END;
$fn$;
REVOKE ALL ON FUNCTION private.burimunsi_phone_profile(text,text,text,text,text,text[],text,text)
  FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;

-- Only an already-authorized native Staff account with an actual retained
-- delegation is eligible. Neither a member's payment phone nor a contact book
-- entry receives a login. Linking the web profile leaves the PIN and native
-- credential/session versions intact.
CREATE FUNCTION private.burimunsi_project_native_staff(p_group text,p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE target private.burimunsi_accounts%ROWTYPE; parent text;
BEGIN
  SELECT * INTO target FROM private.burimunsi_accounts
    WHERE collection_id=p_group AND id=p_id AND role='staff' AND NOT removed FOR SHARE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM app.admin_principal_links WHERE user_id=target.principal_user_id) OR
      private.burimunsi_pin_authority_snapshot(p_group,target.principal_user_id,target.phone,target.role,target.capabilities) IS NULL THEN RETURN; END IF;
  SELECT a.principal_user_id INTO parent FROM private.burimunsi_native_staff_delegations d
    JOIN private.burimunsi_accounts a ON a.collection_id=d.collection_id AND a.id=d.parent_account_id
    WHERE d.collection_id=p_group AND d.principal_user_id=target.principal_user_id AND d.active
      AND a.active AND NOT a.removed AND a.role='admin';
  IF parent IS NULL THEN RETURN; END IF;
  PERFORM private.burimunsi_phone_profile(p_group,target.principal_user_id,target.name,target.phone,'staff',target.capabilities,parent,'native_staff');
END;
$fn$;
REVOKE ALL ON FUNCTION private.burimunsi_project_native_staff(text,uuid)
  FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;

-- Resolve a previously delegated native-only Staff credential. Profile linking
-- occurs only after the Edge has verified the original four digits, or as part
-- of a current Admin's explicit access command. The migration performs no
-- account, credential or grant backfill.
CREATE FUNCTION private.burimunsi_browser_login_account(p_group text,p_phone text,p_id uuid,p_credential bigint,p_version bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE existing jsonb; target private.burimunsi_accounts%ROWTYPE; frame text:=current_setting('burimunsi.pin_frame',true);
BEGIN
  existing:=private.burimunsi_browser_operator(p_group,p_phone,p_id,p_id IS NOT NULL);
  IF existing IS NOT NULL THEN RETURN existing; END IF;
  PERFORM set_config('burimunsi.pin_frame','1',true);
  SELECT a.* INTO target FROM private.burimunsi_accounts a JOIN private.burimunsi_native_staff_delegations d
    ON d.collection_id=a.collection_id AND d.principal_user_id=a.principal_user_id AND d.active
    JOIN app.users u ON u.id=a.principal_user_id AND u.access_status='active'
    JOIN app.collections c ON c.id=a.collection_id AND c.status='active'
    WHERE a.collection_id=p_group AND (a.phone=p_phone OR a.id=p_id) AND a.role='staff' AND a.active AND NOT a.removed
      AND NOT EXISTS(SELECT 1 FROM app.admin_principal_links l WHERE l.user_id=u.id)
      AND NOT EXISTS(SELECT 1 FROM app.privacy_retention_barriers b WHERE b.subject_id=u.id)
      AND private.burimunsi_pin_authority_snapshot(a.collection_id,u.id,a.phone,a.role,a.capabilities) IS NOT NULL;
  IF FOUND THEN
    IF p_id IS NULL THEN
      existing:=jsonb_build_object('id',target.id,'groupId',target.collection_id,'principalUserId',target.principal_user_id,
        'phone',target.phone,'name',target.name,'role',target.role,'pinHash',target.pin_hash,
        'version',target.version,'credentialVersion',target.credential_version);
    ELSIF target.credential_version=p_credential AND target.version=p_version THEN
      PERFORM set_config('burimunsi.collection_id',p_group,true);
      PERFORM private.burimunsi_project_native_staff(p_group,target.id);
      existing:=private.burimunsi_browser_operator(p_group,NULL,target.id,true);
    END IF;
  END IF;
  PERFORM set_config('burimunsi.pin_frame',coalesce(frame,''),true);
  RETURN existing;
END;
$fn$;
REVOKE ALL ON FUNCTION private.burimunsi_browser_login_account(text,text,uuid,bigint,bigint)
  FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_browser_pin_candidate(text,text,text,uuid,text,bigint)',
  'private.burimunsi_browser_operator(p_group,p_phone,NULL,false)','private.burimunsi_browser_login_account(p_group,p_phone,NULL,NULL,NULL)');
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_browser_pin_issue(text,uuid,bigint,bigint,text,uuid,uuid,text)',
  'private.burimunsi_browser_operator(p_group,NULL,p_account,true)','private.burimunsi_browser_login_account(p_group,NULL,p_account,p_credential_version,p_account_version)');

CREATE FUNCTION private.burimunsi_browser_team(p_group text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE actor jsonb:=private.burimunsi_browser_pin_context(); members jsonb; capabilities jsonb;
BEGIN
  IF actor IS NULL OR actor->>'collectionId' IS DISTINCT FROM p_group OR actor->>'operatorRole'<>'admin' OR
      NOT(actor->'permissions' ? 'admin_users.read') THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'; END IF;
  PERFORM set_config('burimunsi.collection_id',p_group,true);
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'displayName',a.name,'phone',a.phone,'role',a.role,
    'active',a.active,'version',a.version) ORDER BY a.name,a.id),'[]'::jsonb) INTO members
    FROM private.burimunsi_accounts a WHERE a.collection_id=p_group AND NOT a.removed;
  SELECT jsonb_build_object(
    'admin',coalesce(jsonb_agg(DISTINCT permission ORDER BY permission) FILTER(WHERE role IN ('admin','owner')),'[]'::jsonb),
    'staff',coalesce(jsonb_agg(DISTINCT permission ORDER BY permission) FILTER(WHERE role='staff'),'[]'::jsonb))
    INTO capabilities FROM app.admin_account_role_capabilities WHERE permission<>'auth.mfa.enroll';
  RETURN jsonb_build_object('contractVersion',1,'currentAccountId',actor->>'accountId',
    'canManage',actor->'permissions' ? 'admin_users.manage','permissionsByRole',capabilities,'members',members);
END;
$fn$;

CREATE FUNCTION private.burimunsi_revoke_browser_sessions(p_group text,p_account uuid,p_cookie text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
BEGIN
  -- A concurrent sign-in can commit after the revoker's transaction started.
  -- Record the actual revocation time, then let the usual cookie trigger finish.
  UPDATE app.auth_sessions a SET revoked_at=greatest(a.created_at,floor(extract(epoch FROM clock_timestamp()))::bigint),
    revocation_reason='admin_cookie_session_ended'
    FROM private.burimunsi_browser_pin_sessions b
    WHERE b.collection_id=p_group AND b.account_id=p_account AND (p_cookie IS NULL OR b.cookie_hash=p_cookie)
      AND a.id=b.session_id AND a.user_id=b.principal_id AND a.surface='admin' AND a.revoked_at IS NULL;
  DELETE FROM app.admin_sessions s USING private.burimunsi_browser_pin_sessions b
    WHERE s.token_hash=b.cookie_hash AND s.auth_session_id=b.session_id AND b.collection_id=p_group AND b.account_id=p_account
      AND (p_cookie IS NULL OR b.cookie_hash=p_cookie);
END;
$fn$;
REVOKE ALL ON FUNCTION private.burimunsi_revoke_browser_sessions(text,uuid,text) FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_browser_pin_logout(text,text,text)',
  '  -- This exact deletion invokes the existing final revocation trigger',
  $sql$  PERFORM private.burimunsi_revoke_browser_sessions(p_group,b.account_id,p_cookie_hash)
    FROM private.burimunsi_browser_pin_sessions b WHERE b.cookie_hash=p_cookie_hash AND b.collection_id=p_group AND b.origin=p_origin AND b.profile_sha256=profile_hash;
  -- This exact deletion invokes the existing final revocation trigger$sql$);

CREATE FUNCTION private.burimunsi_browser_pin_change(p_group text,p_cookie text,p_origin text,p_account uuid,
  p_credential bigint,p_version bigint,p_hash jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE actor jsonb; now_ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
  PERFORM private.burimunsi_browser_pin_request(p_group,true);
  PERFORM pg_advisory_xact_lock(734636924058501::bigint);
  actor:=private.burimunsi_browser_pin_session(p_group,p_cookie,p_origin);
  IF actor IS NULL OR actor->>'accountId' IS DISTINCT FROM p_account::text OR
      actor->>'credentialVersion' IS DISTINCT FROM p_credential::text OR actor->>'accountVersion' IS DISTINCT FROM p_version::text OR
      p_hash->>'algorithm' IS DISTINCT FROM 'pbkdf2-sha256+hmac-v1' OR coalesce(p_hash->>'hash','') !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  PERFORM set_config('burimunsi.collection_id',p_group,true);
  UPDATE private.burimunsi_accounts SET pin_hash=p_hash,version=version+1,credential_version=credential_version+1,updated_at=now_ms
    WHERE id=p_account AND collection_id=p_group AND active AND NOT removed AND version=p_version AND credential_version=p_credential;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE private.burimunsi_sessions SET revoked=true WHERE collection_id=p_group AND account_id=p_account AND NOT revoked;
  PERFORM private.burimunsi_revoke_browser_sessions(p_group,p_account);
  INSERT INTO private.burimunsi_audit(id,collection_id,actor_id,action,entity_id,at_ms)
    VALUES(gen_random_uuid(),p_group,p_account,'burimunsi.passcode.changed',p_account::text,now_ms);
  RETURN true;
END;
$fn$;

SELECT pg_temp.buri_replace_bound_body('private._burimunsi_native_work_authority(uuid)',
  $$a.id=w.approved_admin_id AND a.role='owner'$$,$$a.id=w.approved_admin_id$$);
SELECT pg_temp.buri_replace_bound_body('private._burimunsi_native_work_authority(uuid)',
  $$rc.role=a.role AND rc.permission='payments.reconcile'$$,
  $$rc.role=CASE WHEN EXISTS(SELECT 1 FROM private.burimunsi_browser_pin_sessions b WHERE b.session_id=w.approval_session_id::text AND b.admin_id=a.id) THEN 'owner' ELSE a.role END AND rc.permission='payments.reconcile'$$);

-- Standalone native operations use the same active phone/device session from
-- sign-in until expiry. Independent device, capability and AAL limits remain.
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_pin_assert_actor(text,text,text,bigint,bigint)',
  'p_fresh_seconds<1 OR actor.created_at<now_ms-p_fresh_seconds*1000','p_fresh_seconds<1');
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_pin_resolve_staff(text,uuid,text,text,text,text[],uuid)',
  ' OR actor.created_at<at_ms-300000','');
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_pin_account_actor()',
  ' OR actor.created_at<floor(extract(epoch FROM clock_timestamp())*1000)::bigint-300000','');
SELECT pg_temp.buri_replace_bound_body('private.burimunsi_admin_sms_health()',
  'c.role=actor.shared_role AND g.permission=',
  $$(c.role=actor.shared_role OR (nullif(current_setting('burimunsi.browser_pin_cookie',true),'') IS NOT NULL AND actor.shared_role='admin' AND c.role='owner')) AND g.permission=$$);

CREATE FUNCTION private.burimunsi_browser_team_write(p_group text,p_request uuid,p_cmd jsonb,p_hash jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE
  actor jsonb; acting_id uuid; action text:=p_cmd->>'action'; target private.burimunsi_accounts%ROWTYPE;
  approval private.burimunsi_operator_approvals%ROWTYPE; prior private.burimunsi_command_receipts%ROWTYPE;
  response jsonb; fingerprint text; at_ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  target_id uuid; principal text; web_id text; caps text[]; desired_role text:=p_cmd->>'role'; desired_active boolean;
  next_version bigint; public_id_text text; role_changed boolean:=false;
  qualified_administrators integer;
BEGIN
  PERFORM private.burimunsi_browser_pin_request(p_group,true);
  PERFORM pg_advisory_xact_lock(734636924058501::bigint);
  actor:=private.burimunsi_browser_pin_context();
  IF actor IS NULL OR actor->>'collectionId' IS DISTINCT FROM p_group OR actor->>'operatorRole' IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501';
  END IF;
  PERFORM private.burimunsi_browser_pin_assert_actor('admin_users.manage',NULL,NULL,1,NULL);
  PERFORM set_config('burimunsi.collection_id',p_group,true);
  acting_id:=(actor->>'accountId')::uuid;
  IF p_request IS NULL OR action IS NULL OR action NOT IN ('create','access') THEN
    RAISE EXCEPTION 'burimunsi_invalid_account' USING ERRCODE='22023'; END IF;
  fingerprint:=encode(sha256(convert_to(p_cmd::text,'UTF8')),'hex');
  SELECT * INTO prior FROM private.burimunsi_command_receipts WHERE collection_id=p_group AND actor_id=acting_id AND request_id=p_request;
  IF FOUND THEN
    IF prior.operation IS DISTINCT FROM 'burimunsi.team.'||action OR prior.fingerprint IS DISTINCT FROM fingerprint THEN
      RAISE EXCEPTION 'burimunsi_account_request_changed' USING ERRCODE='40001'; END IF;
    RETURN prior.response;
  END IF;

  IF action='create' THEN
    IF p_cmd-ARRAY['action','displayName','phone','role']<>'{}'::jsonb OR NOT(p_cmd ?& ARRAY['action','displayName','phone','role'])
        OR desired_role NOT IN ('admin','staff') OR desired_role IS NULL OR coalesce(p_cmd->>'phone','') !~ '^\+2507[2389][0-9]{7}$'
        OR length(btrim(coalesce(p_cmd->>'displayName',''))) NOT BETWEEN 2 AND 100 OR p_cmd->>'displayName' ~ '[[:cntrl:]]'
        OR p_hash->>'algorithm' IS DISTINCT FROM 'pbkdf2-sha256+hmac-v1' OR coalesce(p_hash->>'hash','') !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'burimunsi_invalid_account' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT 1 FROM app.users WHERE phone=p_cmd->>'phone') OR
        EXISTS(SELECT 1 FROM private.burimunsi_accounts WHERE collection_id=p_group AND phone=p_cmd->>'phone') THEN
      RAISE EXCEPTION 'burimunsi_phone_exists' USING ERRCODE='23505'; END IF;
    SELECT lpad(min(candidate)::text,6,'0') INTO public_id_text FROM (
      SELECT 0::bigint candidate UNION ALL SELECT u.public_id::bigint+1 FROM app.users u WHERE u.public_id<'999999'
    ) candidates WHERE candidate<1000000 AND NOT EXISTS(SELECT 1 FROM app.users u WHERE u.public_id=lpad(candidate::text,6,'0'));
    IF public_id_text IS NULL THEN RAISE EXCEPTION 'public_id_exhausted' USING ERRCODE='54000'; END IF;
    principal:=gen_random_uuid()::text; target_id:=gen_random_uuid(); next_version:=1;
    SELECT CASE desired_role WHEN 'admin' THEN a.capabilities ELSE ARRAY['records.read'] END INTO STRICT caps
      FROM private.burimunsi_accounts a WHERE a.id=acting_id AND a.collection_id=p_group AND a.active AND NOT a.removed;
    INSERT INTO app.users(id,phone,full_name,public_id,member_type,created_at,updated_at)
      VALUES(principal,p_cmd->>'phone',p_cmd->>'displayName',public_id_text,'operator',
      to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    web_id:=private.burimunsi_phone_profile(p_group,principal,p_cmd->>'displayName',p_cmd->>'phone',desired_role,caps,actor->>'principalId','phone');
    INSERT INTO private.burimunsi_accounts(id,collection_id,principal_user_id,phone,name,role,capabilities,pin_hash,created_at,updated_at)
      VALUES(target_id,p_group,principal,p_cmd->>'phone',p_cmd->>'displayName',desired_role,caps,p_hash,at_ms,at_ms);
    role_changed:=true;
  ELSE
    IF p_hash IS NOT NULL OR p_cmd-ARRAY['action','id','expectedVersion','active','role']<>'{}'::jsonb OR
       NOT(p_cmd ?& ARRAY['action','id','expectedVersion','active']) OR jsonb_typeof(p_cmd->'active') IS DISTINCT FROM 'boolean' OR
       (p_cmd?'role' AND (desired_role IS NULL OR desired_role NOT IN ('admin','staff'))) OR
       coalesce(p_cmd->>'expectedVersion','') !~ '^[1-9][0-9]{0,15}$' THEN
      RAISE EXCEPTION 'burimunsi_invalid_account' USING ERRCODE='22023'; END IF;
    target_id:=(p_cmd->>'id')::uuid; desired_active:=(p_cmd->>'active')::boolean;
    SELECT * INTO target FROM private.burimunsi_accounts WHERE collection_id=p_group AND id=target_id AND NOT removed FOR UPDATE;
    IF NOT FOUND OR target.version IS DISTINCT FROM (p_cmd->>'expectedVersion')::bigint THEN
      RAISE EXCEPTION 'burimunsi_account_changed' USING ERRCODE='40001'; END IF;
    desired_role:=coalesce(desired_role,target.role); role_changed:=desired_role<>target.role;
    IF target.role='admin' AND target.active AND (NOT desired_active OR desired_role<>'admin') THEN
      SELECT count(*) INTO qualified_administrators FROM private.burimunsi_accounts other
        WHERE other.collection_id=p_group AND other.id<>target_id AND other.role='admin' AND other.active AND NOT other.removed
          AND private.burimunsi_browser_operator(p_group,NULL,other.id,false) IS NOT NULL AND EXISTS(
            SELECT 1 FROM app.admin_grants g WHERE g.user_id=other.principal_user_id AND g.permission='admin_users.manage');
      IF qualified_administrators=0 THEN RAISE EXCEPTION 'burimunsi_last_admin' USING ERRCODE='P0001'; END IF;
      IF target.id=acting_id THEN RAISE EXCEPTION 'burimunsi_own_access' USING ERRCODE='P0001'; END IF;
    END IF;
    principal:=target.principal_user_id;
    IF desired_active=target.active AND NOT role_changed THEN next_version:=target.version;
    ELSE
      PERFORM private.burimunsi_project_native_staff(p_group,target.id);
      SELECT * INTO approval FROM private.burimunsi_operator_approvals WHERE collection_id=p_group AND principal_user_id=principal FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'burimunsi_account_changed' USING ERRCODE='40001'; END IF;
      web_id:=approval.admin_user_id;
      SELECT CASE WHEN NOT role_changed THEN target.capabilities WHEN desired_role='admin' THEN a.capabilities ELSE ARRAY['records.read'] END INTO STRICT caps
        FROM private.burimunsi_accounts a WHERE a.id=acting_id AND a.collection_id=p_group AND a.active AND NOT a.removed;
      PERFORM private.burimunsi_revoke_browser_sessions(p_group,target_id);
      IF role_changed THEN
        PERFORM set_config('burimunsi.team_subject',principal,true);
        UPDATE private.burimunsi_operator_approvals SET role=desired_role,capabilities=caps,identity_source='phone',
          version=version+1,updated_at=at_ms WHERE collection_id=p_group AND principal_user_id=principal;
        UPDATE app.admin_users SET role=desired_role,auth_version=auth_version+1,updated_at=at_ms/1000
          WHERE id=web_id AND burimunsi_phone_only AND role<>desired_role;
      END IF;
      UPDATE private.burimunsi_accounts SET role=desired_role,capabilities=caps,active=desired_active,
        version=version+1,credential_version=credential_version+1,updated_at=at_ms
        WHERE id=target_id AND collection_id=p_group RETURNING version INTO next_version;
      UPDATE private.burimunsi_sessions SET revoked=true WHERE collection_id=p_group AND account_id=target_id AND NOT revoked;
    END IF;
  END IF;
  IF role_changed THEN
    -- Shared link triggers provision default role grants. Dedicated profiles
    -- cannot delegate permissions above the authenticated administrator's ceiling.
    IF EXISTS(SELECT 1 FROM app.admin_users w WHERE w.id=web_id AND w.burimunsi_phone_only) THEN
      DELETE FROM app.admin_grants WHERE user_id=principal AND granted_by='admin-account:'||web_id
        AND NOT(actor->'permissions' ? permission);
    END IF;
    DELETE FROM app.admin_grants WHERE user_id=principal AND granted_by='burimunsi-role:'||web_id;
    IF desired_role='admin' THEN
      -- Preserve explicitly granted capabilities. A newly appointed peer can
      -- receive only the authenticated administrator's grantable role permissions.
      INSERT INTO app.admin_grants(user_id,permission,granted_by,granted_at)
      SELECT DISTINCT principal,c.permission,'burimunsi-role:'||web_id,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        FROM app.admin_account_role_capabilities c WHERE c.role IN ('admin','owner') AND c.permission<>'auth.mfa.enroll'
          AND actor->'permissions' ? c.permission ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  response:=jsonb_build_object('applied',true,'id',target_id,'version',next_version);
  INSERT INTO private.burimunsi_command_receipts(collection_id,actor_id,request_id,session_id,operation,fingerprint,response,created_at)
    VALUES(p_group,acting_id,p_request,(actor->>'sessionId')::uuid,'burimunsi.team.'||action,fingerprint,response,at_ms);
  INSERT INTO private.burimunsi_audit(id,collection_id,actor_id,action,entity_id,request_id,at_ms)
    VALUES(gen_random_uuid(),p_group,acting_id,'burimunsi.team.'||action,target_id::text,p_request,at_ms);
  RETURN response;
END;
$fn$;
REVOKE ALL ON FUNCTION private.burimunsi_browser_team(text),private.burimunsi_browser_team_write(text,uuid,jsonb,jsonb),
  private.burimunsi_browser_pin_change(text,text,text,uuid,bigint,bigint,jsonb) FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;
GRANT EXECUTE ON FUNCTION private.burimunsi_browser_team(text),private.burimunsi_browser_team_write(text,uuid,jsonb,jsonb),
  private.burimunsi_browser_pin_change(text,text,text,uuid,bigint,bigint,jsonb) TO collect_runtime;
COMMIT;
