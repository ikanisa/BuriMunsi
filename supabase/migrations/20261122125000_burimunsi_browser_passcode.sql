-- First-party passcode authentication for the dedicated BuriMunsi browser.
-- app.auth_sessions retains audit lineage. GoTrue sessions and managed BFF
-- credentials remain a separate authority and are never fabricated here.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $install$
BEGIN
  PERFORM private._collect_fence_require_operator();
  IF session_user <> 'postgres' OR current_user <> 'postgres'
    OR NOT EXISTS (SELECT 1 FROM private.collect_fence_control WHERE singleton AND mode = 'fenced') THEN
    RAISE EXCEPTION 'burimunsi_browser_pin_requires_fence' USING ERRCODE = '55000';
  END IF;
END
$install$;

CREATE TABLE private.burimunsi_browser_pin_sessions (
  session_id text PRIMARY KEY REFERENCES app.auth_sessions(id) DEFERRABLE INITIALLY DEFERRED,
  cookie_hash text NOT NULL UNIQUE CHECK (cookie_hash ~ '^[a-f0-9]{64}$'),
  public_id uuid NOT NULL UNIQUE,
  collection_id text NOT NULL REFERENCES app.collections(id),
  origin text NOT NULL CHECK (origin = 'https://burimunsi-admin.ikanisa.com'),
  profile_sha256 text NOT NULL CHECK (profile_sha256 ~ '^[a-f0-9]{64}$'),
  account_id uuid NOT NULL,
  FOREIGN KEY (account_id, collection_id) REFERENCES private.burimunsi_accounts(id, collection_id),
  account_version bigint NOT NULL CHECK (account_version > 0),
  credential_version bigint NOT NULL CHECK (credential_version > 0),
  admin_id text NOT NULL REFERENCES app.admin_users(id),
  principal_id text NOT NULL REFERENCES app.users(id),
  authority jsonb NOT NULL CHECK (jsonb_typeof(authority) = 'object'),
  issued_at bigint NOT NULL,
  expires_at bigint NOT NULL CHECK (expires_at = issued_at + 1800),
  verified_at bigint NOT NULL CHECK (verified_at >= issued_at AND verified_at < expires_at),
  proof_id uuid NOT NULL UNIQUE
);
ALTER TABLE private.burimunsi_browser_pin_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.burimunsi_browser_pin_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY burimunsi_browser_pin_sessions_owner ON private.burimunsi_browser_pin_sessions TO postgres USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE private.burimunsi_browser_pin_sessions FROM PUBLIC, anon, authenticated, service_role, collect_runtime, collect_importer;
CREATE TRIGGER collect_fence_statement_v1 BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON private.burimunsi_browser_pin_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION private._collect_fence_statement();
ALTER TABLE private.burimunsi_browser_pin_sessions ENABLE ALWAYS TRIGGER collect_fence_statement_v1;

CREATE FUNCTION private.burimunsi_browser_pin_request(p_group text, p_write boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  admission private.collect_fence_admissions%ROWTYPE;
  aid text := current_setting('collect.fence_admission_id', true);
  ep text := current_setting('collect.fence_epoch', true);
  src text := current_setting('collect.fence_source_sha256', true);
  profile_hash text;
BEGIN
  PERFORM private._collect_fence_require_runtime();
  IF p_group IS NULL OR p_group !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    OR coalesce(aid, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR coalesce(ep, '') !~ '^[1-9][0-9]{0,15}$'
    OR coalesce(src, '') !~ '^[a-f0-9]{64}$'
    OR coalesce(private.request_claims(), '{}'::jsonb) <> '{}'::jsonb
    OR coalesce(nullif(current_setting('burimunsi.pin_token', true), ''),
                nullif(current_setting('burimunsi.pin_installation', true), ''),
                nullif(current_setting('burimunsi.pin_device', true), ''),
                nullif(current_setting('burimunsi.pin_profile', true), '')) IS NOT NULL THEN
    RAISE EXCEPTION 'burimunsi_browser_pin_denied' USING ERRCODE = '42501';
  END IF;
  admission := private._collect_fence_admission(aid::uuid, ep::bigint, src);
  IF admission.kind IS DISTINCT FROM 'http_admin' THEN
    RAISE EXCEPTION 'burimunsi_browser_pin_denied' USING ERRCODE = '42501';
  END IF;
  IF p_write THEN
    PERFORM private.burimunsi_setup_fence();
  END IF;
  SELECT d.profile_sha256 INTO profile_hash FROM private.collect_deployment_identity d WHERE d.singleton;
  IF profile_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM app.collections c WHERE c.id = p_group AND c.status = 'active'
    ) OR EXISTS (SELECT 1 FROM app.collections c WHERE c.id <> p_group) THEN
    RAISE EXCEPTION 'burimunsi_browser_pin_scope_denied' USING ERRCODE = '42501';
  END IF;
  RETURN profile_hash;
END;
$fn$;

-- Role, owner binding, current native credential, and active scope all have to
-- agree. The historical managed identity is read locally as linked authority.
CREATE FUNCTION private.burimunsi_browser_pin_owner(p_group text, p_phone text, p_lock boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  previous_frame text := current_setting('burimunsi.pin_frame', true);
  owner_account jsonb;
BEGIN
  PERFORM set_config('burimunsi.pin_frame', '1', true);
  IF p_lock AND current_setting('transaction_read_only') = 'off' THEN
    PERFORM 1
      FROM private.burimunsi_accounts a
      JOIN private.burimunsi_scopes s ON s.collection_id = a.collection_id
      JOIN private.burimunsi_operator_approvals o ON o.collection_id = a.collection_id
        AND o.principal_user_id = a.principal_user_id AND o.phone = a.phone AND o.active AND o.role = 'admin'
      JOIN private.collect_owner_identity b ON b.singleton AND b.principal_user_id = a.principal_user_id AND b.admin_user_id = o.admin_user_id
      JOIN app.admin_users w ON w.id = b.admin_user_id
      JOIN app.admin_principal_links l ON l.admin_user_id = w.id AND l.user_id = a.principal_user_id
      JOIN app.users u ON u.id = l.user_id
      JOIN app.collections c ON c.id = s.collection_id
      JOIN private.auth_principal_links p ON p.user_id = u.id
      JOIN auth.users actual ON actual.id = p.auth_user_id
      WHERE a.collection_id = p_group AND a.active AND NOT a.removed AND a.role = 'admin'
      FOR SHARE OF a, s, o, w, l, u, c, p, actual;
  END IF;
  SELECT CASE WHEN count(*) = 1 THEN jsonb_agg(candidate.value)->0 END
    INTO owner_account FROM (
      SELECT jsonb_build_object(
        'id', a.id, 'groupId', a.collection_id, 'principalUserId', a.principal_user_id,
        'phone', a.phone, 'name', a.name, 'role', a.role, 'pinHash', a.pin_hash,
        'version', a.version, 'credentialVersion', a.credential_version,
        'adminId', b.admin_user_id, 'authVersion', w.auth_version, 'email', w.email,
        'authority', proof.value
      ) AS value
      FROM private.burimunsi_accounts a
      JOIN private.burimunsi_scopes s ON s.collection_id = a.collection_id
      JOIN private.collect_owner_identity b ON b.singleton AND b.principal_user_id = a.principal_user_id
      JOIN app.admin_users w ON w.id = b.admin_user_id AND w.email = b.owner_email
      CROSS JOIN LATERAL (
        SELECT private.burimunsi_pin_root_snapshot(a.collection_id, a.principal_user_id, a.phone, a.role, a.capabilities) AS value
      ) proof
      WHERE a.collection_id = p_group AND (p_phone IS NULL OR a.phone = p_phone)
        AND a.active AND NOT a.removed AND a.role = 'admin'
        AND private.collect_owner_is(w.id, a.principal_user_id, w.email)
        AND proof.value->>'adminId' = b.admin_user_id
        AND proof.value->>'kind' = 'shared_approval'
        AND NOT EXISTS (SELECT 1 FROM app.privacy_retention_barriers x WHERE x.subject_id = a.principal_user_id)
    ) candidate;
  PERFORM set_config('burimunsi.pin_frame', coalesce(previous_frame, ''), true);
  RETURN owner_account;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('burimunsi.pin_frame', coalesce(previous_frame, ''), true);
  RAISE;
END;
$fn$;

CREATE FUNCTION private.burimunsi_browser_pin_candidate(
  p_group text, p_phone text, p_phone_hash text, p_budget_id uuid, p_network_hash text, p_now_ms bigint
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  account jsonb;
BEGIN
  PERFORM private.burimunsi_browser_pin_request(p_group, true);
  IF p_phone IS NULL OR p_phone !~ '^\+2507[2389][0-9]{7}$'
    OR p_phone_hash IS DISTINCT FROM encode(sha256(convert_to(p_phone, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'burimunsi_browser_pin_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT private.burimunsi_pin_login_budget(p_phone_hash, p_budget_id, p_network_hash, p_now_ms) THEN
    RETURN jsonb_build_object('allowed', false, 'account', NULL);
  END IF;
  account := private.burimunsi_browser_pin_owner(p_group, p_phone, false);
  RETURN jsonb_build_object('allowed', true, 'account', account - 'authority' - 'adminId' - 'authVersion' - 'email');
END;
$fn$;

CREATE FUNCTION private.burimunsi_browser_pin_issue(
  p_group text, p_account uuid, p_credential_version bigint, p_account_version bigint,
  p_cookie_hash text, p_session_id uuid, p_public_id uuid, p_origin text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  profile_hash text := private.burimunsi_browser_pin_request(p_group, true);
  account jsonb := private.burimunsi_browser_pin_owner(p_group, NULL, true);
  at_seconds bigint := floor(extract(epoch FROM clock_timestamp()))::bigint;
BEGIN
  IF p_origin IS DISTINCT FROM 'https://burimunsi-admin.ikanisa.com'
    OR p_account IS NULL OR p_credential_version IS NULL OR p_account_version IS NULL
    OR coalesce(p_cookie_hash, '') !~ '^[a-f0-9]{64}$' OR p_session_id IS NULL OR p_public_id IS NULL
    OR account->>'id' IS DISTINCT FROM p_account::text
    OR account->>'credentialVersion' IS DISTINCT FROM p_credential_version::text
    OR account->>'version' IS DISTINCT FROM p_account_version::text THEN
    RETURN false;
  END IF;

  INSERT INTO private.burimunsi_browser_pin_sessions (
    session_id, cookie_hash, public_id, collection_id, origin, profile_sha256,
    account_id, account_version, credential_version, admin_id, principal_id, authority,
    issued_at, expires_at, verified_at, proof_id
  ) VALUES (
    p_session_id::text, p_cookie_hash, p_public_id, p_group, p_origin, profile_hash,
    p_account, p_account_version, p_credential_version, account->>'adminId', account->>'principalUserId', account->'authority',
    at_seconds, at_seconds + 1800, at_seconds, gen_random_uuid()
  );
  INSERT INTO app.auth_sessions (id, user_id, surface, auth_at, created_at, expires_at)
    VALUES (p_session_id::text, account->>'principalUserId', 'admin', at_seconds, at_seconds, at_seconds + 1800);
  INSERT INTO app.admin_sessions (token_hash, public_id, user_id, auth_version, auth_session_id, origin, created_at, expires_at)
    VALUES (p_cookie_hash, p_public_id::text, account->>'adminId', (account->>'authVersion')::bigint,
      p_session_id::text, p_origin, at_seconds, at_seconds + 1800);
  INSERT INTO app.admin_account_audit (id, actor_id, subject_id, action, occurred_at)
    VALUES (gen_random_uuid()::text, account->>'adminId', account->>'adminId', 'burimunsi_browser_pin_signed_in', at_seconds);
  RETURN true;
END;
$fn$;

CREATE FUNCTION private.burimunsi_browser_pin_session(p_group text, p_cookie_hash text, p_origin text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  profile_hash text := private.burimunsi_browser_pin_request(p_group, false);
  can_lock boolean := current_setting('transaction_read_only') = 'off';
  account jsonb;
  witness private.burimunsi_browser_pin_sessions%ROWTYPE;
  allowed_permissions jsonb;
BEGIN
  IF p_origin IS DISTINCT FROM 'https://burimunsi-admin.ikanisa.com' OR coalesce(p_cookie_hash, '') !~ '^[a-f0-9]{64}$' THEN
    RETURN NULL;
  END IF;
  IF can_lock THEN
    PERFORM 1 FROM private.burimunsi_browser_pin_sessions b
      JOIN app.admin_sessions a ON a.token_hash = b.cookie_hash
      JOIN app.auth_sessions s ON s.id = b.session_id
      WHERE b.cookie_hash = p_cookie_hash AND b.collection_id = p_group AND b.origin = p_origin
      FOR SHARE OF b, a, s;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  SELECT b.* INTO witness FROM private.burimunsi_browser_pin_sessions b
    JOIN app.admin_sessions a ON a.token_hash = b.cookie_hash AND a.public_id = b.public_id::text
      AND a.auth_session_id = b.session_id AND a.user_id = b.admin_id AND a.origin = b.origin
      AND a.created_at = b.issued_at AND a.expires_at = b.expires_at AND a.issued_assurance_level = 1
    JOIN app.auth_sessions s ON s.id = b.session_id AND s.user_id = b.principal_id AND s.surface = 'admin'
      AND s.created_at = b.issued_at AND s.auth_at = b.issued_at AND s.expires_at = b.expires_at
      AND s.revoked_at IS NULL AND s.assurance_level = 1
    WHERE b.cookie_hash = p_cookie_hash AND b.collection_id = p_group AND b.origin = p_origin
      AND b.profile_sha256 = profile_hash AND b.expires_at > floor(extract(epoch FROM clock_timestamp()))::bigint;
  IF NOT FOUND THEN RETURN NULL; END IF;

  account := private.burimunsi_browser_pin_owner(p_group, NULL, can_lock);
  IF account->>'id' IS DISTINCT FROM witness.account_id::text
    OR account->>'adminId' IS DISTINCT FROM witness.admin_id
    OR account->>'principalUserId' IS DISTINCT FROM witness.principal_id
    OR account->>'version' IS DISTINCT FROM witness.account_version::text
    OR account->>'credentialVersion' IS DISTINCT FROM witness.credential_version::text
    OR account->'authority' IS DISTINCT FROM witness.authority
    OR NOT EXISTS (SELECT 1 FROM app.admin_sessions a
      WHERE a.token_hash = p_cookie_hash AND a.auth_version = (account->>'authVersion')::bigint) THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(jsonb_agg(g.permission ORDER BY g.permission), '[]'::jsonb) INTO allowed_permissions
    FROM app.admin_grants g JOIN app.admin_account_role_capabilities c ON c.permission = g.permission
    WHERE g.user_id = witness.principal_id AND c.role = 'owner' AND c.permission <> 'auth.mfa.enroll';
  RETURN jsonb_build_object(
    'adminId', witness.admin_id, 'principalId', witness.principal_id, 'sessionId', witness.session_id,
    'publicId', witness.public_id, 'collectionId', witness.collection_id, 'phone', account->>'phone', 'name', account->>'name',
    'accountId', witness.account_id, 'accountVersion', witness.account_version, 'credentialVersion', witness.credential_version,
    'verifiedAt', witness.verified_at, 'expiresAt', witness.expires_at, 'proofId', witness.proof_id,
    'authVersion', (account->>'authVersion')::bigint, 'email', account->>'email', 'permissions', allowed_permissions
  );
END;
$fn$;

CREATE FUNCTION private.burimunsi_browser_pin_verify(
  p_group text, p_cookie_hash text, p_origin text, p_account uuid, p_credential_version bigint, p_account_version bigint
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  live_session jsonb;
  at_seconds bigint;
BEGIN
  PERFORM private.burimunsi_browser_pin_request(p_group, true);
  live_session := private.burimunsi_browser_pin_session(p_group, p_cookie_hash, p_origin);
  IF live_session IS NULL OR p_account IS NULL OR p_credential_version IS NULL OR p_account_version IS NULL
    OR live_session->>'accountId' IS DISTINCT FROM p_account::text
    OR live_session->>'credentialVersion' IS DISTINCT FROM p_credential_version::text
    OR live_session->>'accountVersion' IS DISTINCT FROM p_account_version::text THEN
    RETURN false;
  END IF;
  at_seconds := floor(extract(epoch FROM clock_timestamp()))::bigint;
  UPDATE private.burimunsi_browser_pin_sessions
    SET verified_at = at_seconds, proof_id = gen_random_uuid()
    WHERE session_id = live_session->>'sessionId' AND at_seconds >= verified_at AND at_seconds < expires_at;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO app.admin_account_audit (id, actor_id, subject_id, action, occurred_at)
    VALUES (gen_random_uuid()::text, live_session->>'adminId', live_session->>'adminId', 'burimunsi_browser_pin_reverified', at_seconds);
  RETURN true;
END;
$fn$;

CREATE FUNCTION private.burimunsi_browser_pin_logout(p_group text, p_cookie_hash text, p_origin text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  profile_hash text := private.burimunsi_browser_pin_request(p_group, true);
BEGIN
  IF p_origin IS DISTINCT FROM 'https://burimunsi-admin.ikanisa.com' OR coalesce(p_cookie_hash, '') !~ '^[a-f0-9]{64}$' THEN
    RETURN false;
  END IF;
  -- This exact deletion invokes the existing final revocation trigger on the
  -- local app.auth_sessions row. No provider logout or credential is needed.
  DELETE FROM app.admin_sessions a USING private.burimunsi_browser_pin_sessions b
    WHERE b.cookie_hash = p_cookie_hash AND b.collection_id = p_group AND b.origin = p_origin
      AND b.profile_sha256 = profile_hash AND a.token_hash = b.cookie_hash AND a.auth_session_id = b.session_id
      AND a.public_id = b.public_id::text AND a.origin = b.origin AND a.user_id = b.admin_id;
  RETURN true;
END;
$fn$;

CREATE FUNCTION private.burimunsi_browser_pin_set_context(p_group text, p_cookie_hash text, p_origin text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF private.burimunsi_browser_pin_session(p_group, p_cookie_hash, p_origin) IS NULL THEN
    RAISE EXCEPTION 'session_changed' USING ERRCODE = '42501';
  END IF;
  IF nullif(current_setting('burimunsi.browser_pin_cookie', true), '') IS NOT NULL AND (
    current_setting('burimunsi.browser_pin_cookie', true) IS DISTINCT FROM p_cookie_hash
      OR current_setting('burimunsi.browser_pin_group', true) IS DISTINCT FROM p_group
      OR current_setting('burimunsi.browser_pin_origin', true) IS DISTINCT FROM p_origin
  ) THEN
    RAISE EXCEPTION 'burimunsi_browser_pin_context_changed' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('burimunsi.browser_pin_cookie', p_cookie_hash, true);
  PERFORM set_config('burimunsi.browser_pin_group', p_group, true);
  PERFORM set_config('burimunsi.browser_pin_origin', p_origin, true);
  RETURN true;
END;
$fn$;

CREATE FUNCTION private.burimunsi_browser_pin_context()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF nullif(current_setting('burimunsi.browser_pin_cookie', true), '') IS NULL THEN RETURN NULL; END IF;
  RETURN private.burimunsi_browser_pin_session(
    current_setting('burimunsi.browser_pin_group', true), current_setting('burimunsi.browser_pin_cookie', true),
    current_setting('burimunsi.browser_pin_origin', true)
  );
END;
$fn$;

CREATE FUNCTION private.burimunsi_browser_pin_is_fresh(p_max_age bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  actor jsonb := private.burimunsi_browser_pin_context();
  at_seconds bigint := floor(extract(epoch FROM clock_timestamp()))::bigint;
BEGIN
  RETURN coalesce(
    p_max_age BETWEEN 1 AND 300 AND (actor->>'verifiedAt')::bigint BETWEEN at_seconds - p_max_age AND at_seconds,
    false
  );
END;
$fn$;

CREATE FUNCTION private.burimunsi_browser_pin_assert_actor(
  p_permission text, p_group text, p_group_role text, p_min_aal bigint, p_fresh_seconds bigint
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  actor jsonb := private.burimunsi_browser_pin_context();
  principal text := actor->>'principalId';
BEGIN
  IF principal IS NULL THEN RAISE EXCEPTION 'session_changed' USING ERRCODE = '42501'; END IF;
  IF p_group IS NOT NULL AND (p_group <> actor->>'collectionId' OR NOT EXISTS (
    SELECT 1 FROM app.memberships m JOIN app.collections c ON c.id = m.collection_id
      WHERE m.user_id = principal AND m.collection_id = p_group AND m.active = 1 AND c.status = 'active'
      AND (p_group_role IS NULL OR m.role = p_group_role OR (p_group_role = 'admin' AND m.role = 'owner'))
  )) THEN
    RAISE EXCEPTION 'group_access_denied' USING ERRCODE = '42501';
  END IF;
  IF p_permission IS NOT NULL THEN
    PERFORM 1 FROM app.admin_grants g JOIN app.admin_account_role_capabilities c ON c.permission = g.permission
      WHERE g.user_id = principal AND g.permission = p_permission AND c.role = 'owner' AND c.permission <> 'auth.mfa.enroll'
      FOR SHARE OF g, c;
    IF NOT FOUND THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501'; END IF;
  END IF;
  -- Existing Admin operation thresholds request a recent proof of intent.
  -- The local proof satisfies that requirement without claiming MFA or email.
  IF (p_min_aal > 1 OR p_fresh_seconds IS NOT NULL)
    AND NOT private.burimunsi_browser_pin_is_fresh(least(coalesce(p_fresh_seconds, 300), 300)) THEN
    RAISE EXCEPTION 'recent_passcode_required' USING ERRCODE = '42501';
  END IF;
  RETURN principal;
END;
$fn$;

CREATE FUNCTION private.burimunsi_browser_pin_owner_actor(p_actor text, p_cookie text, p_origin text, p_public text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  actor jsonb;
BEGIN
  IF nullif(current_setting('burimunsi.browser_pin_cookie', true), '') IS NULL THEN
    RETURN private.admin_invitation_actor(p_actor, p_cookie, p_origin, p_public);
  END IF;
  actor := private.burimunsi_browser_pin_context();
  IF actor IS NULL OR actor->>'adminId' IS DISTINCT FROM p_actor OR actor->>'publicId' IS DISTINCT FROM p_public
    OR current_setting('burimunsi.browser_pin_cookie', true) IS DISTINCT FROM p_cookie
    OR current_setting('burimunsi.browser_pin_origin', true) IS DISTINCT FROM p_origin THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;
  PERFORM private.burimunsi_browser_pin_assert_actor('admin_users.manage', NULL, NULL, 1, 300);
  RETURN (actor->>'sessionId')::uuid;
END;
$fn$;

CREATE FUNCTION private.burimunsi_admin_snapshot() RETURNS TABLE (
  principal_user_id text, principal_session_id text, now_ms text, session_user_id text, surface text,
  expires_at bigint, revoked_at bigint, admin_id text, cookie_hash text, origin text, public_session_id text,
  transaction_read_only text, shared_role text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  actor jsonb;
BEGIN
  IF nullif(current_setting('burimunsi.browser_pin_cookie', true), '') IS NULL THEN
    RETURN QUERY SELECT * FROM private.burimunsi_managed_admin_snapshot();
    RETURN;
  END IF;
  actor := private.burimunsi_browser_pin_context();
  IF actor IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT actor->>'principalId', actor->>'sessionId',
    floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text, actor->>'principalId',
    'admin'::text, (actor->>'expiresAt')::bigint, NULL::bigint, actor->>'adminId',
    current_setting('burimunsi.browser_pin_cookie', true), current_setting('burimunsi.browser_pin_origin', true),
    actor->>'publicId', current_setting('transaction_read_only'), 'owner'::text;
END;
$fn$;

-- The witness is a protected operational copy. Existence of a catalog entry
-- does not authorize erasure or prove absence of historical credentials.
DO $inventory$
DECLARE
  catalog_body text;
  catalog_definition text;
  class_entry jsonb := jsonb_build_object(
    'name', 'private:burimunsi_browser_pin_sessions',
    'relation', 'private.burimunsi_browser_pin_sessions',
    'scope', 'unmapped_private',
    'purpose', 'Browser passcode session and retained verification provenance; inspection only, effects blocked',
    'known_links', 'principal_id names the canonical administrator; session_id links the retained domain auth projection',
    'blocked', true
  );
BEGIN
  SELECT p.prosrc, pg_get_functiondef(p.oid) INTO STRICT catalog_body, catalog_definition
    FROM pg_proc p WHERE p.oid = 'private._retention_manifest_catalog_v2()'::regprocedure
      AND p.prokind = 'f' AND p.prorettype = 'jsonb'::regtype AND NOT p.proretset
      AND pg_get_userbyid(p.proowner) = 'postgres';
  IF length(catalog_definition) - length(replace(catalog_definition, catalog_body, '')) <> length(catalog_body) THEN
    RAISE EXCEPTION 'burimunsi_browser_pin_catalog_predecessor_changed' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(catalog_definition, catalog_body,
    format('SELECT jsonb_set(base,''{private_classes}'',(base->''private_classes'')||%L::jsonb) FROM (%s) prior(base)',
      jsonb_build_array(class_entry)::text, catalog_body));
END;
$inventory$;

-- Preserve each managed/native predecessor definition and its OID, ACL, and
-- remaining body. Refuse an unexpected predecessor instead of guessing where
-- its guard runs.
DO $bridges$
DECLARE
  patch record;
  definition text;
  source_body text;
  next_body text;
BEGIN
  FOR patch IN SELECT * FROM (VALUES
    ('private.trg_managed_auth_projection()', E'BEGIN\n -- Access can always be irreversibly removed after provider logout.', $inject$BEGIN
 IF TG_OP = 'INSERT' AND EXISTS (
   SELECT 1 FROM private.burimunsi_browser_pin_sessions b
     WHERE b.session_id = NEW.id AND b.principal_id = NEW.user_id AND b.issued_at = NEW.auth_at
       AND b.issued_at = NEW.created_at AND b.expires_at = NEW.expires_at
       AND NEW.surface = 'admin' AND NEW.assurance_level = 1
       AND NEW.revoked_at IS NULL AND NEW.mfa_at IS NULL AND NEW.mfa_factor_id IS NULL
 ) THEN
   PERFORM private.burimunsi_browser_pin_request(
     (SELECT b.collection_id FROM private.burimunsi_browser_pin_sessions b WHERE b.session_id = NEW.id), true
   );
   RETURN NEW;
 END IF;
 -- Access can always be irreversibly removed after provider logout.$inject$),
    ('api.current_principal_id()', E'BEGIN\n IF coalesce(nullif(current_setting(''burimunsi.pin_token'',true),', $inject$BEGIN
 IF nullif(current_setting('burimunsi.browser_pin_cookie', true), '') IS NOT NULL THEN
   RETURN private.burimunsi_browser_pin_context()->>'principalId';
 END IF;
 IF coalesce(nullif(current_setting('burimunsi.pin_token',true),$inject$),
    ('api.current_session_id()', E'BEGIN\n IF coalesce(nullif(current_setting(''burimunsi.pin_token'',true),', $inject$BEGIN
 IF nullif(current_setting('burimunsi.browser_pin_cookie', true), '') IS NOT NULL THEN
   RETURN private.burimunsi_browser_pin_session_id();
 END IF;
 IF coalesce(nullif(current_setting('burimunsi.pin_token',true),$inject$),
    ('private.assert_actor(text,text,text,bigint,bigint)', E'BEGIN\n IF coalesce(nullif(current_setting(''burimunsi.pin_token'',true),', $inject$BEGIN
 IF nullif(current_setting('burimunsi.browser_pin_cookie', true), '') IS NOT NULL THEN
   RETURN private.burimunsi_browser_pin_assert_actor(p_permission, p_collection_id, p_group_role, p_min_aal, p_fresh_seconds);
 END IF;
 IF coalesce(nullif(current_setting('burimunsi.pin_token',true),$inject$),
    ('private.burimunsi_observation_admin_actor(boolean)', E' PERFORM private._collect_fence_require_runtime();\n IF p_sensitive IS NULL OR', $inject$ PERFORM private._collect_fence_require_runtime();
 IF nullif(current_setting('burimunsi.browser_pin_cookie', true), '') IS NOT NULL THEN
   IF p_sensitive IS NULL THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501'; END IF;
   SELECT * INTO a FROM private.burimunsi_admin_snapshot();
   PERFORM private.burimunsi_browser_pin_assert_actor('sms.read', NULL, NULL, 1, NULL);
   IF p_sensitive THEN
     PERFORM private.burimunsi_browser_pin_assert_actor('sms.reveal', NULL, NULL, 1, 300);
   END IF;
   RETURN jsonb_build_object('adminId', a.admin_id, 'principalId', a.principal_user_id,
     'sessionId', a.principal_session_id, 'role', 'owner');
 END IF;
 IF p_sensitive IS NULL OR$inject$),
    ('private.burimunsi_admin_sms_health()', 'private.burimunsi_managed_admin_snapshot()', 'private.burimunsi_admin_snapshot()'),
    ('private.burimunsi_admin_transaction_visibility(text)', 'private.burimunsi_managed_admin_snapshot()', 'private.burimunsi_admin_snapshot()'),
    ('private.burimunsi_operator_approve(text,text,text,text,text,uuid,text,text,text,text[],boolean,bigint)', 'private.admin_invitation_actor(', 'private.burimunsi_browser_pin_owner_actor('),
    ('private.burimunsi_operator_directory(text,text,text,text,text,uuid)', 'private.admin_invitation_actor(', 'private.burimunsi_browser_pin_owner_actor('),
    ('private.burimunsi_operator_approve_v2(text,text,text,text,text,uuid,text,text,text,text[],boolean,bigint,text)', 'private.admin_invitation_actor(', 'private.burimunsi_browser_pin_owner_actor('),
    ('private.burimunsi_provisioning_directory(text,text,text,text,text)', 'private.admin_invitation_actor(', 'private.burimunsi_browser_pin_owner_actor('),
    ('private.burimunsi_provisioning_lookup(text,text,text,text,text,uuid)', 'private.admin_invitation_actor(', 'private.burimunsi_browser_pin_owner_actor('),
    ('private.burimunsi_provisioning_cancel(text,text,text,text,text,uuid)', 'private.admin_invitation_actor(', 'private.burimunsi_browser_pin_owner_actor('),
    ('private.burimunsi_provisioning_apply(text,text,text,text,text,jsonb,text,text)', 'private.admin_invitation_actor(', 'private.burimunsi_browser_pin_owner_actor('),
    ('private.burimunsi_provisioning_delivery(text,text,text,text,text,uuid,uuid,text,bigint)', 'private.admin_invitation_actor(', 'private.burimunsi_browser_pin_owner_actor('),
    ('private.burimunsi_setup_actor(text,text,text,text)', 'private.admin_invitation_actor(', 'private.burimunsi_browser_pin_owner_actor('),
    ('private.retention_capture_inventory_v2(uuid,text,bigint,text,integer)',
      $anchor$'managed:storage_iceberg'$anchor$,
      $anchor$'private:burimunsi_browser_pin_sessions','managed:storage_iceberg'$anchor$)
  ) AS x(signature, before, after) LOOP
    SELECT p.prosrc, pg_get_functiondef(p.oid) INTO STRICT source_body, definition FROM pg_proc p
      WHERE p.oid = to_regprocedure(patch.signature);
    next_body := replace(source_body, patch.before, patch.after);
    IF next_body = source_body OR length(source_body) - length(replace(source_body, patch.before, '')) <> length(patch.before)
      OR length(definition) - length(replace(definition, source_body, '')) <> length(source_body) THEN
      RAISE EXCEPTION 'burimunsi_browser_pin_predecessor_changed: %', patch.signature USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(definition, source_body, next_body);
  END LOOP;
END;
$bridges$;

-- api.current_session_id is SECURITY INVOKER. Its narrow helper only returns
-- the session ID after full context validation, without exposing the witness.
CREATE FUNCTION private.burimunsi_browser_pin_session_id()
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fn$ SELECT private.burimunsi_browser_pin_context()->>'sessionId' $fn$;

REVOKE ALL ON FUNCTION private.burimunsi_browser_pin_request(text,boolean),
  private.burimunsi_browser_pin_owner(text,text,boolean), private.burimunsi_browser_pin_context(),
  private.burimunsi_browser_pin_assert_actor(text,text,text,bigint,bigint),
  private.burimunsi_browser_pin_owner_actor(text,text,text,text), private.burimunsi_admin_snapshot()
  FROM PUBLIC, anon, authenticated, service_role, collect_runtime, collect_importer;
REVOKE ALL ON FUNCTION private.burimunsi_browser_pin_candidate(text,text,text,uuid,text,bigint),
  private.burimunsi_browser_pin_issue(text,uuid,bigint,bigint,text,uuid,uuid,text),
  private.burimunsi_browser_pin_session(text,text,text), private.burimunsi_browser_pin_verify(text,text,text,uuid,bigint,bigint),
  private.burimunsi_browser_pin_logout(text,text,text), private.burimunsi_browser_pin_set_context(text,text,text),
  private.burimunsi_browser_pin_is_fresh(bigint), private.burimunsi_browser_pin_session_id()
  FROM PUBLIC, anon, authenticated, service_role, collect_runtime, collect_importer;
GRANT EXECUTE ON FUNCTION private.burimunsi_browser_pin_candidate(text,text,text,uuid,text,bigint),
  private.burimunsi_browser_pin_issue(text,uuid,bigint,bigint,text,uuid,uuid,text),
  private.burimunsi_browser_pin_session(text,text,text), private.burimunsi_browser_pin_verify(text,text,text,uuid,bigint,bigint),
  private.burimunsi_browser_pin_logout(text,text,text), private.burimunsi_browser_pin_set_context(text,text,text),
  private.burimunsi_browser_pin_is_fresh(bigint), private.burimunsi_browser_pin_session_id() TO collect_runtime;

COMMIT;
