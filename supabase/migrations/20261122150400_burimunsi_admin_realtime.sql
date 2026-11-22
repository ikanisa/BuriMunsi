-- A standalone Admin has an HttpOnly BFF cookie. Its short-lived private
-- Realtime channel carries one invalidation bit. Rows are fetched with the
-- original authenticated BFF session. Realtime keeps join rights cached, so
-- every publication independently verifies current authority again.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';
DO $check$
BEGIN
 PERFORM private._collect_fence_require_operator();
 IF NOT EXISTS(SELECT 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced')
  OR to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NULL OR to_regprocedure('realtime.topic()') IS NULL
  OR NOT has_table_privilege('anon','realtime.messages','SELECT') OR NOT has_schema_privilege('anon','realtime','USAGE')
  OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('realtime.send(jsonb,text,text,boolean)')
    AND p.prosecdef AND has_function_privilege('anon',p.oid,'EXECUTE'))
  OR NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='realtime.messages'::regclass AND polname='collect_member_no_anonymous_v1'
    AND NOT polpermissive AND polcmd='*' AND polroles=ARRAY['anon'::regrole::oid]
    AND pg_get_expr(polqual,polrelid)='false' AND pg_get_expr(polwithcheck,polrelid)='false')
 THEN RAISE EXCEPTION 'admin_live_predecessor_changed' USING ERRCODE='55000';END IF;
 PERFORM set_config('burimunsi.admin_live_member_preimage',private._collect_member_realtime_metadata_sha(),true);
END;$check$;

CREATE TABLE private.burimunsi_admin_live_channels(
 collection_id text NOT NULL REFERENCES app.collections(id),
 session_id text NOT NULL,public_session_id text NOT NULL,principal_id text NOT NULL,admin_id text NOT NULL,
 authority_kind text NOT NULL CHECK(authority_kind IN('browser_pin','managed')),
 topic text NOT NULL UNIQUE CHECK(topic ~ '^buri:ops:[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL,PRIMARY KEY(collection_id,session_id)
);
CREATE INDEX burimunsi_admin_live_expiry ON private.burimunsi_admin_live_channels(expires_at);
ALTER TABLE private.burimunsi_admin_live_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.burimunsi_admin_live_channels FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.burimunsi_admin_live_channels FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;
CREATE POLICY admin_live_owner ON private.burimunsi_admin_live_channels TO postgres
 USING(current_setting('burimunsi.admin_live_frame',true)='1') WITH CHECK(current_setting('burimunsi.admin_live_frame',true)='1');
CREATE TRIGGER collect_fence_statement_v1 BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON private.burimunsi_admin_live_channels
 FOR EACH STATEMENT EXECUTE FUNCTION private._collect_fence_statement();
ALTER TABLE private.burimunsi_admin_live_channels ENABLE ALWAYS TRIGGER collect_fence_statement_v1;

-- Subscribe and publish use the SAME retained session, current permission,
-- collection scope and credential generation. A channel token alone grants
-- no reads from financial, device, payer, session or operator tables.
CREATE FUNCTION private._burimunsi_admin_live_authorized(ch private.burimunsi_admin_live_channels) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE now_sec bigint:=floor(extract(epoch FROM clock_timestamp()))::bigint;
 live record; browser private.burimunsi_browser_pin_sessions%ROWTYPE;allowed boolean;
 old_pin text:=current_setting('burimunsi.pin_frame',true);old_group text:=current_setting('burimunsi.collection_id',true);
BEGIN
 IF ch.expires_at IS NULL OR ch.expires_at<=clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM private.collect_fence_control WHERE singleton AND mode='open') THEN RETURN false;END IF;
 PERFORM set_config('burimunsi.collection_id',ch.collection_id,true);PERFORM set_config('burimunsi.pin_frame','1',true);
 SELECT s.id AS sid,s.created_at,s.auth_at,s.assurance_level,s.mfa_at,s.mfa_factor_id,c.token_hash,c.origin,c.created_at AS cookie_created_at,
  c.expires_at AS cookie_expires_at,s.expires_at AS session_expires_at,c.issued_assurance_level,ad.auth_version,ad.role,ad.email
 INTO live FROM app.auth_sessions s JOIN app.users u ON u.id=s.user_id AND u.access_status='active'
 JOIN app.admin_principal_links l ON l.user_id=u.id AND l.admin_user_id=ch.admin_id
 JOIN app.admin_users ad ON ad.id=l.admin_user_id AND ad.status='active' AND ad.role IN('admin','owner')
 JOIN app.admin_sessions c ON c.auth_session_id=s.id AND c.user_id=ad.id AND c.auth_version=ad.auth_version AND c.public_id=ch.public_session_id
 JOIN app.collections g ON g.id=ch.collection_id AND g.status='active'
 JOIN app.admin_grants perm ON perm.user_id=u.id AND perm.permission='sms.read'
 JOIN app.admin_account_role_capabilities role_cap ON role_cap.role=ad.role AND role_cap.permission=perm.permission
 WHERE s.id=ch.session_id AND s.user_id=ch.principal_id AND s.surface='admin' AND s.revoked_at IS NULL
  AND least(s.expires_at,c.expires_at)>now_sec AND c.issued_assurance_level=s.assurance_level
  AND c.issued_mfa_at IS NOT DISTINCT FROM s.mfa_at AND c.issued_mfa_factor_id IS NOT DISTINCT FROM s.mfa_factor_id
  AND NOT EXISTS(SELECT 1 FROM app.privacy_retention_barriers p WHERE p.subject_id=u.id);
 IF NOT FOUND THEN allowed:=false;
 ELSIF ch.authority_kind='browser_pin' THEN
  SELECT b.* INTO browser FROM private.burimunsi_browser_pin_sessions b JOIN private.collect_deployment_identity d ON d.singleton AND d.profile_sha256=b.profile_sha256
   WHERE b.session_id=ch.session_id AND b.collection_id=ch.collection_id AND b.principal_id=ch.principal_id AND b.admin_id=ch.admin_id
    AND b.public_id::text=ch.public_session_id AND b.cookie_hash=live.token_hash AND b.origin=live.origin
    AND b.origin='https://burimunsi-admin.ikanisa.com' AND b.issued_at=live.created_at AND b.issued_at=live.auth_at
    AND b.issued_at=live.cookie_created_at AND b.expires_at=live.cookie_expires_at AND b.expires_at=live.session_expires_at
    AND b.expires_at>now_sec AND live.assurance_level=1 AND live.role='owner'
    AND NOT EXISTS(SELECT 1 FROM app.collections g WHERE g.id<>ch.collection_id)
    AND EXISTS(SELECT 1 FROM app.memberships m WHERE m.collection_id=b.collection_id AND m.user_id=b.principal_id AND m.active=1 AND m.role IN('owner','admin'));
  IF FOUND THEN
   -- The issuer already verified the cookie and PIN. The WebSocket has
   -- neither credential and cannot enter the HTTP-only owner binding RPC.
   -- Compare the exact protected binding, native credential generation and
   -- independently recomputed approval without manufacturing an Edge actor.
   allowed:=EXISTS(SELECT 1 FROM private.burimunsi_accounts a JOIN private.burimunsi_scopes s ON s.collection_id=a.collection_id
    JOIN private.collect_owner_identity id ON id.singleton AND id.principal_user_id=a.principal_user_id
      AND id.admin_user_id=ch.admin_id AND id.owner_email=live.email
    CROSS JOIN LATERAL (SELECT private.burimunsi_pin_root_snapshot(a.collection_id,a.principal_user_id,a.phone,a.role,a.capabilities) AS authority) root
    WHERE a.id=browser.account_id AND a.collection_id=ch.collection_id AND a.principal_user_id=ch.principal_id
      AND a.version=browser.account_version AND a.credential_version=browser.credential_version
      AND a.active AND NOT a.removed AND a.role='admin'
      AND root.authority->>'kind'='shared_approval' AND root.authority->>'adminId'=ch.admin_id AND root.authority=browser.authority);
  END IF;
 ELSE
  allowed:=EXISTS(SELECT 1 FROM private.bff_sessions b JOIN private.auth_principal_links p ON p.auth_user_id=b.auth_user_id AND p.user_id=ch.principal_id
   JOIN auth.sessions z ON z.id=b.auth_session_id AND z.user_id=b.auth_user_id
   JOIN auth.users au ON au.id=z.user_id AND au.deleted_at IS NULL AND au.is_anonymous IS NOT TRUE
   WHERE b.token_hash=live.token_hash AND b.auth_session_id::text=ch.session_id AND b.refresh_lease IS NULL
    AND au.email_confirmed_at IS NOT NULL AND lower(au.email)=lower(live.email) AND (au.banned_until IS NULL OR au.banned_until<=statement_timestamp())
    AND (z.not_after IS NULL OR z.not_after>statement_timestamp())
    AND (live.assurance_level=1 OR (to_jsonb(z)->>'aal'='aal2' AND EXISTS(SELECT 1 FROM private.managed_mfa_proofs proof
     JOIN auth.mfa_factors factor ON factor.id=proof.factor_id AND factor.user_id=proof.user_id AND factor.status::text='verified'
     WHERE proof.session_id=z.id AND proof.user_id=z.user_id AND proof.factor_id::text=live.mfa_factor_id AND proof.verified_at_epoch=live.mfa_at
      AND (to_jsonb(z)->>'factor_id' IS NULL OR to_jsonb(z)->>'factor_id'=proof.factor_id::text)))))
   AND EXISTS(SELECT 1 FROM private.burimunsi_operator_approvals approval
    WHERE approval.collection_id=ch.collection_id AND approval.principal_user_id=ch.principal_id AND approval.admin_user_id=ch.admin_id
     AND approval.active AND approval.role='admin' AND 'sms.read'=ANY(approval.capabilities)
     AND private.burimunsi_pin_root_snapshot(ch.collection_id,ch.principal_id,approval.phone,approval.role,approval.capabilities) IS NOT NULL);
 END IF;
 PERFORM set_config('burimunsi.pin_frame',coalesce(old_pin,''),true);PERFORM set_config('burimunsi.collection_id',coalesce(old_group,''),true);
 RETURN coalesce(allowed,false);
END;$fn$;
REVOKE ALL ON FUNCTION private._burimunsi_admin_live_authorized(private.burimunsi_admin_live_channels)
 FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;

CREATE FUNCTION private.burimunsi_admin_live_issue(p_group text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE scope jsonb;groups jsonb;actor jsonb;managed record;kind text;public_id text;deadline timestamptz;group_id text:=p_group;
 ch private.burimunsi_admin_live_channels%ROWTYPE;previous text:=current_setting('burimunsi.admin_live_frame',true);
BEGIN
 PERFORM private._collect_fence_require_runtime();
 IF group_id IS NULL THEN
  groups:=private.burimunsi_observation_admin_collections();
  IF jsonb_typeof(groups) IS DISTINCT FROM 'array' OR jsonb_array_length(groups)<>1 THEN
   RAISE EXCEPTION 'live_collection_required' USING ERRCODE='22023';END IF;
  group_id:=groups->0->>'collectionId';
 END IF;
 scope:=private.burimunsi_observation_admin_scope(group_id,false);
 IF private.assert_actor('sms.read',NULL,NULL,1,NULL) IS DISTINCT FROM scope->>'principalId'
   OR scope->>'collectionId' IS DISTINCT FROM group_id THEN RAISE insufficient_privilege;END IF;
 IF nullif(current_setting('burimunsi.browser_pin_cookie',true),'') IS NOT NULL THEN
  actor:=private.burimunsi_browser_pin_context();kind:='browser_pin';public_id:=actor->>'publicId';
  deadline:=to_timestamp((actor->>'expiresAt')::bigint);
  IF actor->>'collectionId' IS DISTINCT FROM group_id OR actor->>'sessionId' IS DISTINCT FROM scope->>'sessionId' THEN RAISE insufficient_privilege;END IF;
 ELSE
  SELECT * INTO STRICT managed FROM private.burimunsi_managed_admin_snapshot();kind:='managed';public_id:=managed.public_session_id;
  deadline:=to_timestamp(managed.expires_at);
  IF managed.principal_session_id IS DISTINCT FROM scope->>'sessionId' OR managed.principal_user_id IS DISTINCT FROM scope->>'principalId' THEN
   RAISE insufficient_privilege;END IF;
 END IF;
 IF deadline IS NULL OR deadline<=clock_timestamp() OR public_id IS NULL OR scope->>'sessionId' IS NULL THEN RAISE insufficient_privilege;END IF;
 PERFORM set_config('burimunsi.admin_live_frame','1',true);
 -- The indexed purge runs on new subscriptions. Sessions can share one live
 -- channel across tabs. A renewed cookie/session must receive a new topic.
 DELETE FROM private.burimunsi_admin_live_channels WHERE expires_at<=clock_timestamp();
 INSERT INTO private.burimunsi_admin_live_channels(collection_id,session_id,public_session_id,principal_id,admin_id,authority_kind,topic,expires_at)
 VALUES(group_id,scope->>'sessionId',public_id,scope->>'principalId',scope->>'adminId',kind,
   'buri:ops:'||encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex'),
   least(deadline,clock_timestamp()+interval '5 minutes'))
 ON CONFLICT(collection_id,session_id) DO UPDATE SET
  public_session_id=excluded.public_session_id,principal_id=excluded.principal_id,admin_id=excluded.admin_id,authority_kind=excluded.authority_kind,
  topic=CASE WHEN burimunsi_admin_live_channels.expires_at>clock_timestamp()+interval '30 seconds'
    AND burimunsi_admin_live_channels.public_session_id=excluded.public_session_id AND burimunsi_admin_live_channels.authority_kind=excluded.authority_kind
   THEN burimunsi_admin_live_channels.topic ELSE excluded.topic END,
  expires_at=CASE WHEN burimunsi_admin_live_channels.expires_at>clock_timestamp()+interval '30 seconds'
    AND burimunsi_admin_live_channels.public_session_id=excluded.public_session_id AND burimunsi_admin_live_channels.authority_kind=excluded.authority_kind
   THEN least(burimunsi_admin_live_channels.expires_at,excluded.expires_at) ELSE excluded.expires_at END RETURNING * INTO ch;
 IF NOT private._burimunsi_admin_live_authorized(ch) THEN RAISE insufficient_privilege;END IF;
 PERFORM set_config('burimunsi.admin_live_frame',coalesce(previous,''),true);
 RETURN jsonb_build_object('topic',ch.topic,'expiresAt',to_char(ch.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END;$fn$;
REVOKE ALL ON FUNCTION private.burimunsi_admin_live_issue(text) FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;
GRANT EXECUTE ON FUNCTION private.burimunsi_admin_live_issue(text) TO collect_runtime;

CREATE FUNCTION private.burimunsi_admin_live_join(p_topic text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE ch private.burimunsi_admin_live_channels%ROWTYPE;allowed boolean;
 previous text:=current_setting('burimunsi.admin_live_frame',true);
BEGIN
 IF p_topic IS NULL OR octet_length(p_topic)<>73 OR p_topic !~ '^buri:ops:[a-f0-9]{64}$'
   OR p_topic IS DISTINCT FROM realtime.topic() THEN RETURN false;END IF;
 PERFORM set_config('burimunsi.admin_live_frame','1',true);
 SELECT * INTO ch FROM private.burimunsi_admin_live_channels WHERE topic=p_topic AND expires_at>clock_timestamp();
 allowed:=FOUND AND private._burimunsi_admin_live_authorized(ch);
 PERFORM set_config('burimunsi.admin_live_frame',coalesce(previous,''),true);RETURN coalesce(allowed,false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END;$fn$;
REVOKE ALL ON FUNCTION private.burimunsi_admin_live_join(text) FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;
GRANT EXECUTE ON FUNCTION private.burimunsi_admin_live_join(text) TO anon;
-- Existing authenticated member policies and every anonymous write stay
-- separately restrictive. Predicates never grant access to other topics.
ALTER POLICY collect_member_no_anonymous_v1 ON realtime.messages
 USING(extension='broadcast' AND topic=(SELECT realtime.topic()) AND private.burimunsi_admin_live_join((SELECT realtime.topic())))
 WITH CHECK(false);
CREATE POLICY burimunsi_admin_live_receive_v1 ON realtime.messages FOR SELECT TO anon
 USING(extension='broadcast' AND topic=(SELECT realtime.topic()) AND private.burimunsi_admin_live_join((SELECT realtime.topic())));
CREATE POLICY burimunsi_admin_live_no_update_v1 ON realtime.messages AS RESTRICTIVE FOR UPDATE TO anon USING(false) WITH CHECK(false);
CREATE POLICY burimunsi_admin_live_no_delete_v1 ON realtime.messages AS RESTRICTIVE FOR DELETE TO anon USING(false);
CREATE POLICY burimunsi_admin_live_server_v1 ON realtime.messages FOR INSERT TO postgres
 WITH CHECK(current_setting('role',true)='collect_runtime' AND current_setting('collect.edge_verified',true)='true'
  AND current_setting('burimunsi.admin_live_frame',true)='1' AND topic=(SELECT realtime.topic())
  AND topic ~ '^buri:ops:[a-f0-9]{64}$' AND extension='broadcast' AND private
  AND event='operations_changed' AND (payload='{"changed":true}'::jsonb
    OR payload=jsonb_build_object('changed',true,'id',id::text)));

-- The original member authority pins the entire Realtime catalog, including
-- anonymous policy definitions. Preserve its immutable historical control,
-- prior activation, and every existing authenticated policy. Only the exact
-- reviewed before/after catalog pair can satisfy the prior pin. An already
-- stale or subsequently changed catalog still fails closed.
DO $member_pin$
DECLARE before_hash text:=current_setting('burimunsi.admin_live_member_preimage');
 after_hash text:=private._collect_member_realtime_metadata_sha(); item regprocedure;src text;definition text;replacement text;
 needle text:='c.policy_sha256';
BEGIN
 IF before_hash IS NULL OR after_hash IS NULL OR before_hash!~'^[a-f0-9]{64}$' OR after_hash!~'^[a-f0-9]{64}$'
   OR before_hash=after_hash THEN RAISE EXCEPTION 'admin_live_member_catalog_changed' USING ERRCODE='55000';END IF;
 replacement:=format('(CASE WHEN c.policy_sha256=%L THEN %L ELSE c.policy_sha256 END)',before_hash,after_hash);
 FOREACH item IN ARRAY ARRAY['private.collect_member_realtime_join(text)'::regprocedure,
  'private.collect_member_realtime_configure(boolean,text,text,text)'::regprocedure,
  'private.collect_member_realtime_publish()'::regprocedure] LOOP
  SELECT prosrc,pg_get_functiondef(oid) INTO STRICT src,definition FROM pg_proc WHERE oid=item AND proowner='postgres'::regrole AND prosecdef;
  IF length(src)-length(replace(src,needle,''))<>length(needle) OR length(definition)-length(replace(definition,src,''))<>length(src) THEN
   RAISE EXCEPTION 'admin_live_member_guard_changed' USING ERRCODE='55000';END IF;
  EXECUTE replace(definition,src,replace(src,needle,replacement));
 END LOOP;
END;$member_pin$;

CREATE FUNCTION private._burimunsi_admin_live_publish(p_group text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE ch private.burimunsi_admin_live_channels%ROWTYPE;seen jsonb;previous text:=current_setting('burimunsi.admin_live_frame',true);
 prior_topic text:=current_setting('realtime.topic',true);
BEGIN
 IF p_group IS NULL OR current_setting('role',true) IS DISTINCT FROM 'collect_runtime'
   OR current_setting('collect.edge_verified',true) IS DISTINCT FROM 'true' THEN RETURN;END IF;
 seen:=coalesce(nullif(current_setting('burimunsi.admin_live_sent',true),'')::jsonb,'{}'::jsonb);
 IF seen?p_group THEN RETURN;END IF;
 PERFORM set_config('burimunsi.admin_live_frame','1',true);
 FOR ch IN SELECT * FROM private.burimunsi_admin_live_channels WHERE collection_id=p_group AND expires_at>clock_timestamp() LOOP
  BEGIN
   IF private._burimunsi_admin_live_authorized(ch) THEN
    -- The platform can add its own transport UUID. No business identifier
    -- or session credential is passed to the supported Broadcast helper.
    PERFORM realtime.send('{"changed":true}'::jsonb,'operations_changed',ch.topic,true);
   END IF;
  EXCEPTION WHEN OTHERS OR query_canceled OR assert_failure THEN
   -- Realtime is an invalidation hint. The scoped HTTP reconciliation reads
   -- the saved state even when the broadcaster or partition is unavailable.
   RAISE WARNING 'burimunsi_admin_live_delivery_unavailable';
  END;
 END LOOP;
 PERFORM set_config('realtime.topic',coalesce(prior_topic,''),true);
 PERFORM set_config('burimunsi.admin_live_sent',(seen||jsonb_build_object(p_group,true))::text,true);
 PERFORM set_config('burimunsi.admin_live_frame',coalesce(previous,''),true);
END;$fn$;

CREATE FUNCTION private._burimunsi_admin_live_change() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE group_id text;
BEGIN
 IF TG_TABLE_NAME='contribution_posting_snapshots' THEN
  SELECT p.collection_id INTO group_id FROM app.payments p WHERE p.id=NEW.payment_id;
 ELSE group_id:=NEW.collection_id;END IF;
 PERFORM private._burimunsi_admin_live_publish(group_id);
 RETURN NULL;
EXCEPTION WHEN OTHERS OR query_canceled OR assert_failure THEN RAISE WARNING 'burimunsi_admin_live_unavailable';RETURN NULL;
END;$fn$;
REVOKE ALL ON FUNCTION private._burimunsi_admin_live_publish(text),private._burimunsi_admin_live_change()
 FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;
CREATE TRIGGER burimunsi_live_observation AFTER INSERT ON private.burimunsi_unresolved_observations FOR EACH ROW EXECUTE FUNCTION private._burimunsi_admin_live_change();
CREATE TRIGGER burimunsi_live_capture AFTER INSERT ON private.burimunsi_sms_source_scopes FOR EACH ROW EXECUTE FUNCTION private._burimunsi_admin_live_change();
CREATE TRIGGER burimunsi_live_transaction AFTER INSERT ON private.burimunsi_transaction_scopes FOR EACH ROW EXECUTE FUNCTION private._burimunsi_admin_live_change();
CREATE TRIGGER burimunsi_live_processing AFTER UPDATE OF state ON private.burimunsi_auto_sms_jobs FOR EACH ROW WHEN(OLD.state IS DISTINCT FROM NEW.state)
 EXECUTE FUNCTION private._burimunsi_admin_live_change();
CREATE TRIGGER burimunsi_live_credit AFTER INSERT ON app.contribution_posting_snapshots FOR EACH ROW EXECUTE FUNCTION private._burimunsi_admin_live_change();
CREATE TRIGGER burimunsi_live_delivery AFTER UPDATE OF state,provider_state ON private.burimunsi_payment_sms_deliveries
 FOR EACH ROW WHEN(OLD.state IS DISTINCT FROM NEW.state OR OLD.provider_state IS DISTINCT FROM NEW.provider_state) EXECUTE FUNCTION private._burimunsi_admin_live_change();
CREATE TRIGGER burimunsi_live_inbox AFTER UPDATE OF state ON private.burimunsi_inbox_checks FOR EACH ROW WHEN(OLD.state IS DISTINCT FROM NEW.state)
 EXECUTE FUNCTION private._burimunsi_admin_live_change();

-- The scheduler prunes its dispatch journal once per full maintenance
-- heartbeat. Idle one-second wake checks and ordinary ticket inserts skip
-- this path. A current subscription remains bounded even if maintenance stops.
CREATE FUNCTION private._burimunsi_admin_live_prune() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE previous text:=current_setting('burimunsi.admin_live_frame',true);
BEGIN
 PERFORM set_config('burimunsi.admin_live_frame','1',true);
 IF EXISTS(SELECT 1 FROM private.burimunsi_admin_live_channels WHERE expires_at<=statement_timestamp()) THEN
  DELETE FROM private.burimunsi_admin_live_channels WHERE expires_at<=statement_timestamp();
 END IF;
 PERFORM set_config('burimunsi.admin_live_frame',coalesce(previous,''),true);RETURN NULL;
EXCEPTION WHEN OTHERS OR query_canceled OR assert_failure THEN RETURN NULL;
END;$fn$;
REVOKE ALL ON FUNCTION private._burimunsi_admin_live_prune() FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;
CREATE TRIGGER burimunsi_live_expiry AFTER DELETE ON collect_ops.jobs_dispatches FOR EACH STATEMENT EXECUTE FUNCTION private._burimunsi_admin_live_prune();
DO $inventory$
DECLARE body text;definition text;anchor text:='''managed:storage_iceberg''';entry jsonb;
BEGIN
 entry:=jsonb_build_array(jsonb_build_object('name','private:burimunsi_admin_live_channels','relation','private.burimunsi_admin_live_channels',
  'scope','unmapped_private','purpose','Short-lived Admin change subscription','known_links','principal_id and session_id of the authorized subscriber','blocked',true));
 SELECT prosrc,pg_get_functiondef(oid) INTO STRICT body,definition FROM pg_proc WHERE oid='private._retention_manifest_catalog_v2()'::regprocedure;
 IF length(definition)-length(replace(definition,body,''))<>length(body) OR position('private:burimunsi_admin_live_channels' IN body)>0 THEN
  RAISE EXCEPTION 'admin_live_retention_catalog_changed' USING ERRCODE='55000';END IF;
 EXECUTE replace(definition,body,format('SELECT jsonb_set(base,''{private_classes}'',(base->''private_classes'')||%L::jsonb) FROM (%s) prior(base)',
  entry::text,rtrim(body,E'; \t\r\n')));
 SELECT prosrc,pg_get_functiondef(oid) INTO STRICT body,definition FROM pg_proc WHERE oid='private.retention_capture_inventory_v2(uuid,text,bigint,text,integer)'::regprocedure;
 IF length(body)-length(replace(body,anchor,''))<>length(anchor) THEN RAISE EXCEPTION 'admin_live_retention_inventory_changed' USING ERRCODE='55000';END IF;
 EXECUTE replace(definition,body,replace(body,anchor,'''private:burimunsi_admin_live_channels'','||anchor));
END;$inventory$;
COMMIT;
