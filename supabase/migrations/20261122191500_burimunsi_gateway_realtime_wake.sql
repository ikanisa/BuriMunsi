-- A random, expiring receiver capability can only prompt the established
-- OpenSMS device pull. All assignment, permit, SMS and delivery work stays
-- with the existing gateway. Cached subscriptions are rechecked at publish.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';
DO $pre$
BEGIN
 PERFORM private._collect_fence_require_operator();
 IF NOT EXISTS(SELECT FROM private.collect_fence_control WHERE singleton AND mode='fenced')
  OR to_regprocedure('private.burimunsi_admin_live_join(text)') IS NULL
  OR to_regprocedure('collect_sms.work_assert_write(uuid,bigint,text)') IS NULL
  OR NOT EXISTS(SELECT FROM pg_policy WHERE polrelid='realtime.messages'::regclass
   AND polname='collect_member_no_anonymous_v1' AND NOT polpermissive AND polroles=ARRAY['anon'::regrole::oid]
   AND polcmd='*' AND pg_get_expr(polwithcheck,polrelid)='false'
   AND position('burimunsi_admin_live_join' IN pg_get_expr(polqual,polrelid))>0)
 THEN RAISE EXCEPTION 'gateway_wake_predecessor_changed' USING ERRCODE='55000';END IF;
 PERFORM set_config('burimunsi.gateway_wake_preimage',private._collect_member_realtime_metadata_sha(),true);
END;$pre$;

-- One row per already-provisioned handset. The capability is independent of
-- its identity and credentials and is never returned through a gateway list.
CREATE TABLE private.burimunsi_gateway_wake_channels(
 installation_id text PRIMARY KEY REFERENCES collect_sms.devices(installation_id),
 collection_id text NOT NULL REFERENCES private.burimunsi_scopes(collection_id),
 application_id text NOT NULL REFERENCES collect_sms.applications(application_id),
 credential_binding text NOT NULL CHECK(credential_binding ~ '^[0-9a-f]{64}$'),
 topic text NOT NULL UNIQUE CHECK(topic ~ '^buri:gw:[0-9a-f]{64}$'),expires_at timestamptz NOT NULL
);
ALTER TABLE private.burimunsi_gateway_wake_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.burimunsi_gateway_wake_channels FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.burimunsi_gateway_wake_channels FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_sms_runtime,collect_importer;
CREATE POLICY gateway_wake_private ON private.burimunsi_gateway_wake_channels TO postgres
 USING(current_setting('burimunsi.gateway_wake_frame',true)='1') WITH CHECK(current_setting('burimunsi.gateway_wake_frame',true)='1');
CREATE TRIGGER collect_fence_statement_v1 BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON private.burimunsi_gateway_wake_channels
 FOR EACH STATEMENT EXECUTE FUNCTION collect_sms.serialize_gateway_write();
ALTER TABLE private.burimunsi_gateway_wake_channels ENABLE ALWAYS TRIGGER collect_fence_statement_v1;
CREATE POLICY burimunsi_wake_device ON collect_sms.devices FOR SELECT TO postgres USING(current_setting('burimunsi.gateway_wake_frame',true)='1');
CREATE POLICY burimunsi_wake_application ON collect_sms.applications FOR SELECT TO postgres USING(current_setting('burimunsi.gateway_wake_frame',true)='1');
CREATE POLICY burimunsi_wake_scope ON private.burimunsi_scopes FOR SELECT TO postgres USING(current_setting('burimunsi.gateway_wake_frame',true)='1');
CREATE POLICY burimunsi_wake_delivery ON private.burimunsi_payment_sms_deliveries FOR SELECT TO postgres
 USING(current_setting('burimunsi.gateway_wake_frame',true)='1' AND current_setting('role',true)='collect_sms_runtime'
  AND current_setting('collect.sms_verified',true)='true');

CREATE FUNCTION private._burimunsi_gateway_wake_allowed(p_device text,p_binding text,p_group text,p_app text) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
 SELECT EXISTS(SELECT FROM collect_sms.devices d JOIN collect_sms.applications a ON a.application_id=p_app
  JOIN private.burimunsi_scopes s ON s.collection_id=p_group AND s.enabled
  WHERE d.installation_id=p_device AND d.ready=1 AND d.revoked_at IS NULL AND a.revoked_at IS NULL
  AND d.allowed_kinds::jsonb ? 'receipt' AND a.allowed_kinds::jsonb ? 'receipt'
  AND p_binding=encode(sha256(convert_to('burimunsi:gateway-wake:v1:'||d.token_hash,'UTF8')),'hex')
  -- OpenSMS offers an unassigned receipt to any ready receipt device. Refuse
  -- an ambiguous sender installation for this product-only notification.
  AND NOT EXISTS(SELECT FROM collect_sms.devices other WHERE other.installation_id<>d.installation_id
   AND other.ready=1 AND other.revoked_at IS NULL AND other.allowed_kinds::jsonb ? 'receipt')
  AND EXISTS(SELECT FROM private.collect_fence_control WHERE singleton AND mode='open'));
$f$;
REVOKE ALL ON FUNCTION private._burimunsi_gateway_wake_allowed(text,text,text,text)
 FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_sms_runtime,collect_importer;

CREATE FUNCTION collect_sms.burimunsi_gateway_wake_channel(p_device text,p_hash text,p_group text,p_app text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE prior text:=current_setting('burimunsi.gateway_wake_frame',true);ch private.burimunsi_gateway_wake_channels%ROWTYPE;
 binding text;result jsonb;
BEGIN
 PERFORM collect_sms.work_assert_write(nullif(current_setting('collect.fence_admission_id',true),'')::uuid,
  nullif(current_setting('collect.fence_epoch',true),'')::bigint,nullif(current_setting('collect.fence_source_sha256',true),''));
 IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR p_device IS NULL OR p_group IS NULL OR p_app IS NULL THEN RETURN NULL;END IF;
 binding:=encode(sha256(convert_to('burimunsi:gateway-wake:v1:'||p_hash,'UTF8')),'hex');
 PERFORM set_config('burimunsi.gateway_wake_frame','1',true);
 IF private._burimunsi_gateway_wake_allowed(p_device,binding,p_group,p_app) THEN
  SELECT * INTO ch FROM private.burimunsi_gateway_wake_channels WHERE installation_id=p_device FOR UPDATE;
  IF NOT FOUND OR (ch.credential_binding,ch.collection_id,ch.application_id) IS DISTINCT FROM (binding,p_group,p_app)
    OR ch.expires_at<=clock_timestamp()+interval '20 seconds' THEN
   INSERT INTO private.burimunsi_gateway_wake_channels AS old(installation_id,collection_id,application_id,credential_binding,topic,expires_at)
    VALUES(p_device,p_group,p_app,binding,'buri:gw:'||encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex'),
     clock_timestamp()+interval '5 minutes')
    ON CONFLICT(installation_id) DO UPDATE SET collection_id=excluded.collection_id,application_id=excluded.application_id,
     credential_binding=excluded.credential_binding,topic=excluded.topic,expires_at=excluded.expires_at RETURNING * INTO ch;
  END IF;
  result:=jsonb_build_object('topic',ch.topic,'expiresAt',to_char(ch.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 END IF;
 PERFORM set_config('burimunsi.gateway_wake_frame',coalesce(prior,''),true);RETURN result;
END;$f$;
REVOKE ALL ON FUNCTION collect_sms.burimunsi_gateway_wake_channel(text,text,text,text) FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;
GRANT EXECUTE ON FUNCTION collect_sms.burimunsi_gateway_wake_channel(text,text,text,text) TO collect_sms_runtime;

CREATE FUNCTION private.burimunsi_gateway_wake_join(p_topic text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pg_temp AS $f$
DECLARE prior text:=current_setting('burimunsi.gateway_wake_frame',true);ch private.burimunsi_gateway_wake_channels%ROWTYPE;allowed boolean;
BEGIN
 IF p_topic IS NULL OR octet_length(p_topic)<>72 OR p_topic !~ '^buri:gw:[0-9a-f]{64}$' OR p_topic IS DISTINCT FROM realtime.topic() THEN RETURN false;END IF;
 PERFORM set_config('burimunsi.gateway_wake_frame','1',true);
 SELECT * INTO ch FROM private.burimunsi_gateway_wake_channels WHERE topic=p_topic AND expires_at>clock_timestamp();
 allowed:=FOUND AND private._burimunsi_gateway_wake_allowed(ch.installation_id,ch.credential_binding,ch.collection_id,ch.application_id);
 PERFORM set_config('burimunsi.gateway_wake_frame',coalesce(prior,''),true);RETURN coalesce(allowed,false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END;$f$;
REVOKE ALL ON FUNCTION private.burimunsi_gateway_wake_join(text) FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_sms_runtime,collect_importer;
GRANT EXECUTE ON FUNCTION private.burimunsi_gateway_wake_join(text) TO anon;
ALTER POLICY collect_member_no_anonymous_v1 ON realtime.messages
 USING(extension='broadcast' AND topic=(SELECT realtime.topic()) AND
  (private.burimunsi_admin_live_join((SELECT realtime.topic())) OR private.burimunsi_gateway_wake_join((SELECT realtime.topic()))))
 WITH CHECK(false);
CREATE POLICY burimunsi_gateway_wake_receive_v1 ON realtime.messages FOR SELECT TO anon
 USING(extension='broadcast' AND topic=(SELECT realtime.topic()) AND private.burimunsi_gateway_wake_join((SELECT realtime.topic())));
CREATE POLICY burimunsi_gateway_wake_publish_v1 ON realtime.messages FOR INSERT TO postgres
 WITH CHECK(current_setting('role',true)='collect_sms_runtime' AND current_setting('collect.sms_verified',true)='true'
  AND current_setting('burimunsi.gateway_wake_frame',true)='1' AND topic=(SELECT realtime.topic())
  AND topic ~ '^buri:gw:[0-9a-f]{64}$' AND extension='broadcast' AND private AND event='gateway_sync'
  AND (payload='{"changed":true}'::jsonb OR payload=jsonb_build_object('changed',true,'id',id::text)));

-- Migrate only the single runtime-verified previous member metadata alias.
-- Keep a previously invalid pin invalid and preserve the independently
-- restricted Admin and authenticated member joins.
DO $pin$
DECLARE before_hash text:=current_setting('burimunsi.gateway_wake_preimage');after_hash text:=private._collect_member_realtime_metadata_sha();
 item regprocedure;src text;definition text;parts text[];needle text;replacement text;
BEGIN
 IF before_hash=after_hash OR before_hash!~'^[0-9a-f]{64}$' OR after_hash!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'gateway_wake_catalog_changed';END IF;
 FOREACH item IN ARRAY ARRAY['private.collect_member_realtime_join(text)'::regprocedure,
  'private.collect_member_realtime_configure(boolean,text,text,text)'::regprocedure,'private.collect_member_realtime_publish()'::regprocedure] LOOP
  SELECT prosrc,pg_get_functiondef(oid) INTO STRICT src,definition FROM pg_proc WHERE oid=item AND proowner='postgres'::regrole AND prosecdef;
  parts:=regexp_match(src,'(\(CASE WHEN c\.policy_sha256=''[0-9a-f]{64}'' THEN ''([0-9a-f]{64})'' ELSE c\.policy_sha256 END\))');
  needle:=parts[1];
  IF parts IS NULL OR parts[2]<>before_hash OR length(src)-length(replace(src,needle,''))<>length(needle)
    OR length(definition)-length(replace(definition,src,''))<>length(src) THEN RAISE EXCEPTION 'gateway_wake_member_preimage_changed';END IF;
  replacement:=format('(CASE WHEN %s=%L THEN %L ELSE c.policy_sha256 END)',needle,before_hash,after_hash);
  EXECUTE replace(definition,src,replace(src,needle,replacement));
 END LOOP;
END;$pin$;

CREATE FUNCTION private._burimunsi_gateway_wake_message() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pg_temp AS $f$
DECLARE prior text:=current_setting('burimunsi.gateway_wake_frame',true);prior_topic text:=current_setting('realtime.topic',true);
 ch private.burimunsi_gateway_wake_channels%ROWTYPE;
BEGIN
 IF NEW.kind<>'receipt' OR current_setting('role',true) IS DISTINCT FROM 'collect_sms_runtime'
   OR current_setting('collect.sms_verified',true) IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;
 PERFORM set_config('burimunsi.gateway_wake_frame','1',true);
 -- Match all original identifiers and both committed content hashes. Other
 -- communications and other applications never publish.
 SELECT w.* INTO ch FROM private.burimunsi_gateway_wake_channels w JOIN private.burimunsi_payment_sms_deliveries d
   ON d.application_id=w.application_id AND d.collection_id=w.collection_id
  WHERE d.message_id=NEW.message_id AND d.application_id=NEW.application_id AND d.idempotency_key=NEW.idempotency_key
   AND d.body_sha256=encode(sha256(convert_to(NEW.text,'UTF8')),'hex')
   AND d.destination_sha256=encode(sha256(convert_to(NEW.to_number,'UTF8')),'hex') AND w.expires_at>clock_timestamp()
   AND (NEW.owner_installation_id IS NULL OR w.installation_id=NEW.owner_installation_id)
   AND private._burimunsi_gateway_wake_allowed(w.installation_id,w.credential_binding,w.collection_id,w.application_id);
 IF FOUND THEN PERFORM realtime.send('{"changed":true}'::jsonb,'gateway_sync',ch.topic,true);END IF;
 PERFORM set_config('burimunsi.gateway_wake_frame',coalesce(prior,''),true);
 PERFORM set_config('realtime.topic',coalesce(prior_topic,''),true);RETURN NULL;
EXCEPTION WHEN OTHERS OR query_canceled OR assert_failure THEN RAISE WARNING 'burimunsi_gateway_wake_unavailable';RETURN NULL;
END;$f$;
REVOKE ALL ON FUNCTION private._burimunsi_gateway_wake_message() FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_sms_runtime,collect_importer;
CREATE TRIGGER burimunsi_wake_original_receipt AFTER INSERT ON collect_sms.messages FOR EACH ROW
 WHEN(NEW.kind='receipt' AND NEW.state='accepted' AND NEW.cancel_requested=0) EXECUTE FUNCTION private._burimunsi_gateway_wake_message();
CREATE TRIGGER burimunsi_wake_receipt_cancellation AFTER UPDATE OF cancel_requested ON collect_sms.messages FOR EACH ROW
 WHEN(NEW.kind='receipt' AND OLD.cancel_requested=0 AND NEW.cancel_requested=1 AND NEW.owner_installation_id IS NOT NULL)
 EXECUTE FUNCTION private._burimunsi_gateway_wake_message();

CREATE FUNCTION private._burimunsi_gateway_wake_revoke() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE prior text:=current_setting('burimunsi.gateway_wake_frame',true);
BEGIN
 PERFORM set_config('burimunsi.gateway_wake_frame','1',true);
 IF TG_TABLE_NAME='devices' THEN DELETE FROM private.burimunsi_gateway_wake_channels WHERE installation_id=NEW.installation_id;
 ELSE DELETE FROM private.burimunsi_gateway_wake_channels WHERE application_id=NEW.application_id;END IF;
 PERFORM set_config('burimunsi.gateway_wake_frame',coalesce(prior,''),true);RETURN NULL;
END;$f$;
REVOKE ALL ON FUNCTION private._burimunsi_gateway_wake_revoke() FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_sms_runtime,collect_importer;
CREATE TRIGGER burimunsi_gateway_wake_revoke_device AFTER UPDATE OF token_hash,ready,revoked_at,allowed_kinds ON collect_sms.devices FOR EACH ROW
 WHEN((OLD.token_hash,OLD.ready,OLD.revoked_at,OLD.allowed_kinds) IS DISTINCT FROM(NEW.token_hash,NEW.ready,NEW.revoked_at,NEW.allowed_kinds))
 EXECUTE FUNCTION private._burimunsi_gateway_wake_revoke();
CREATE TRIGGER burimunsi_gateway_wake_revoke_application AFTER UPDATE OF token_hash,revoked_at,allowed_kinds ON collect_sms.applications FOR EACH ROW
 WHEN((OLD.token_hash,OLD.revoked_at,OLD.allowed_kinds) IS DISTINCT FROM(NEW.token_hash,NEW.revoked_at,NEW.allowed_kinds))
 EXECUTE FUNCTION private._burimunsi_gateway_wake_revoke();
DO $inventory$
DECLARE body text;definition text;anchor text:='''managed:storage_iceberg''';entry jsonb;
BEGIN
 entry:=jsonb_build_array(jsonb_build_object('name','private:burimunsi_gateway_wake_channels','relation','private.burimunsi_gateway_wake_channels',
  'scope','unmapped_private','purpose','Short-lived OpenSMS device wake subscription','known_links','authorized gateway installation and application','blocked',true));
 SELECT prosrc,pg_get_functiondef(oid) INTO STRICT body,definition FROM pg_proc WHERE oid='private._retention_manifest_catalog_v2()'::regprocedure;
 IF length(definition)-length(replace(definition,body,''))<>length(body) OR position('private:burimunsi_gateway_wake_channels' IN body)>0 THEN
  RAISE EXCEPTION 'gateway_wake_retention_catalog_changed';END IF;
 EXECUTE replace(definition,body,format('SELECT jsonb_set(base,''{private_classes}'',(base->''private_classes'')||%L::jsonb) FROM (%s) prior(base)',
  entry::text,rtrim(body,E'; \t\r\n')));
 SELECT prosrc,pg_get_functiondef(oid) INTO STRICT body,definition FROM pg_proc WHERE oid='private.retention_capture_inventory_v2(uuid,text,bigint,text,integer)'::regprocedure;
 IF length(body)-length(replace(body,anchor,''))<>length(anchor) THEN RAISE EXCEPTION 'gateway_wake_retention_inventory_changed';END IF;
 EXECUTE replace(definition,body,replace(body,anchor,'''private:burimunsi_gateway_wake_channels'','||anchor));
END;$inventory$;
COMMIT;
