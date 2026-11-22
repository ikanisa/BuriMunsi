-- The phone/PIN account and its current collection authorize receiver work.
-- Each handset retains its own proof of possession, consent and inbox inventory.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
DO $preflight$
BEGIN
 PERFORM private._collect_fence_require_operator();
 IF NOT EXISTS(SELECT 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced')
  OR to_regprocedure('private.burimunsi_browser_team(text)') IS NULL
  OR to_regprocedure('private.burimunsi_observation_inbox_check(jsonb)') IS NULL THEN
  RAISE EXCEPTION 'admin_handset_precondition' USING ERRCODE='55000';END IF;
END;$preflight$;

-- Modify the maintained routines in place, preserving activation, custody,
-- authentication, operation fencing and source-version checks installed since.
CREATE FUNCTION pg_temp.buri_handset_patch(signature text,anchor text,replacement text,matches integer DEFAULT 1)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE body text;definition text;
BEGIN
 SELECT p.prosrc,pg_get_functiondef(p.oid) INTO STRICT body,definition FROM pg_proc p
 WHERE p.oid=to_regprocedure(signature) AND pg_get_userbyid(p.proowner)='postgres';
 IF length(body)-length(replace(body,anchor,''))<>matches*length(anchor)
  OR length(definition)-length(replace(definition,body,''))<>length(body) THEN
  RAISE EXCEPTION 'admin_handset_predecessor_changed: %',signature USING ERRCODE='55000';END IF;
 EXECUTE replace(definition,body,replace(body,anchor,replacement));
END;$fn$;

-- Called only after normal PIN verification and its locked account, grant,
-- install token and collection checks, including the same checks on renewal.
-- Previously disabled consent remains disabled, including across grant rotation.
CREATE FUNCTION private._burimunsi_admin_handset_signin(p_group text,p_account uuid,p_install uuid,
 p_grant uuid,p_version bigint,p_role text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE old_obs text:=current_setting('burimunsi.observation_frame',true);
BEGIN
 IF p_role IS DISTINCT FROM 'admin' THEN RETURN;END IF;
 PERFORM set_config('burimunsi.observation_frame','1',true);
 IF NOT EXISTS(SELECT 1 FROM private.burimunsi_observation_consents c
  WHERE (c.collection_id,c.account_id,c.installation_id,c.grant_id,c.grant_version)=(p_group,p_account,p_install,p_grant,p_version)) THEN
  INSERT INTO private.burimunsi_observation_consents AS c
    (collection_id,account_id,installation_id,grant_id,grant_version,generation,enabled,updated_at)
  VALUES(p_group,p_account,p_install,p_grant,p_version,1,true,floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
  ON CONFLICT(collection_id,account_id,installation_id) DO UPDATE SET grant_id=excluded.grant_id,
   grant_version=excluded.grant_version,generation=c.generation+1,updated_at=excluded.updated_at
  WHERE (c.grant_id,c.grant_version) IS DISTINCT FROM (excluded.grant_id,excluded.grant_version);
 END IF;
 PERFORM set_config('burimunsi.observation_frame',coalesce(old_obs,''),true);
END;$fn$;
REVOKE ALL ON FUNCTION private._burimunsi_admin_handset_signin(text,uuid,uuid,uuid,bigint,text)
 FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;

SELECT pg_temp.buri_handset_patch('private.burimunsi_pin_create_session(text,uuid,uuid,text,text,bigint,uuid,text,bigint,bigint,bigint)',
 $a$ RETURN jsonb_build_object('created',true,'expiresAt',actual_expires,'grantId',d.id,'grantVersion',d.version);$a$,
 $b$ PERFORM private._burimunsi_admin_handset_signin(p_collection,a.id,p_installation,d.id,d.version,a.role);
 RETURN jsonb_build_object('created',true,'expiresAt',actual_expires,'grantId',d.id,'grantVersion',d.version);$b$);
SELECT pg_temp.buri_handset_patch('private.burimunsi_pin_renew_session(text,uuid,text,text,text,bigint)',
 $a$ RETURN QUERY SELECT c.* FROM private.burimunsi_pin_session_context(p_token,p_installation,p_device_token,p_profile) c;$a$,
 $b$ PERFORM private._burimunsi_admin_handset_signin(p_collection,verified.account_id,p_installation,verified.grant_id,verified.grant_version,verified.role);
 RETURN QUERY SELECT c.* FROM private.burimunsi_pin_session_context(p_token,p_installation,p_device_token,p_profile) c;$b$);

SELECT pg_temp.buri_handset_patch('private.burimunsi_observation_actor(boolean)',
 $a$a.role<>'admin' OR a.profile<>'internal_receiver'
  OR NOT('sms.read'=ANY(a.capabilities)) OR NOT('gateway.manage'=ANY(a.capabilities))$a$,
 $b$a.role IS DISTINCT FROM 'admin' OR a.profile IS NULL OR a.profile NOT IN('internal_receiver','staff')$b$,2);
SELECT pg_temp.buri_handset_patch('private.burimunsi_observation_actor(boolean)',
 $a$ELSE ARRAY['sms.read'] END LOOP$a$,$b$ELSE ARRAY[]::text[] END LOOP$b$);

-- The paired path can reconcile its own exact envelope, sender/body and account
-- only. This operation never exposes SMS text and does not confer gateway control.
SELECT pg_temp.buri_handset_patch('private.burimunsi_observation_gateway_lookup(uuid,text)',
 ' PERFORM private.burimunsi_observation_actor(true);','');

DO $worker$
DECLARE routine text;privilege_clause text:=$clause$  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['sms.read','sms.reveal']::text[]) required(permission)
   WHERE NOT EXISTS(SELECT 1 FROM app.admin_grants g JOIN app.admin_principal_links l ON l.user_id=g.user_id
    JOIN app.admin_users u ON u.id=l.admin_user_id JOIN app.admin_account_role_capabilities rc ON rc.role=u.role AND rc.permission=g.permission
    WHERE g.user_id=o.principal_user_id AND g.permission=required.permission AND u.status='active'))$clause$;
BEGIN
 FOREACH routine IN ARRAY ARRAY['private.burimunsi_auto_snapshot(text)','private.burimunsi_auto_candidates(text)'] LOOP
  PERFORM pg_temp.buri_handset_patch(routine,privilege_clause,'');
 END LOOP;
END;$worker$;
SELECT pg_temp.buri_handset_patch('private.burimunsi_auto_snapshot(text)',
 $a$AND b.role='admin' AND 'sms.read'=ANY(b.capabilities)
  AND 'gateway.manage'=ANY(b.capabilities)$a$,$b$AND b.role='admin'$b$);
SELECT pg_temp.buri_handset_patch('private.burimunsi_auto_candidates(text)',
 $a$  AND 'sms.read'=ANY(b.capabilities) AND 'gateway.manage'=ANY(b.capabilities)$a$,'');
SELECT pg_temp.buri_handset_patch('private.burimunsi_auto_snapshot(text)',
 $a$d.profile='internal_receiver'$a$,$b$d.profile IN('internal_receiver','staff')$b$);
SELECT pg_temp.buri_handset_patch('private.burimunsi_auto_candidates(text)',
 $a$device.profile='internal_receiver'$a$,$b$device.profile IN('internal_receiver','staff')$b$);
SELECT pg_temp.buri_handset_patch('private.burimunsi_observation_history_rows(text)',
 $a$d.profile='internal_receiver'$a$,$b$d.profile IN('internal_receiver','staff')$b$);

-- The stable Android row identity may survive an account change or reinstall.
-- An independent installation can keep its own source without reading another
-- principal's receipt. Provider transaction deduplication remains wallet-scoped.
ALTER TABLE private.burimunsi_observation_requests DROP CONSTRAINT burimunsi_observation_source_key_unique;
ALTER TABLE private.burimunsi_observation_requests ADD CONSTRAINT burimunsi_observation_source_key_unique
 UNIQUE(collection_id,account_id,installation_id,source_key);
DO $key_scope$
DECLARE routine text;
BEGIN
 FOREACH routine IN ARRAY ARRAY['private.burimunsi_observation_key_lookup(text,text,text)',
  'private.burimunsi_observation_key_prepare(text,text,text,uuid,text,text,text,text,bigint)'] LOOP
  PERFORM pg_temp.buri_handset_patch(routine,$a$WHERE collection_id=a->>'collectionId' AND source_key=p_key$a$,
   $b$WHERE collection_id=a->>'collectionId' AND account_id=(a->>'accountId')::uuid
   AND installation_id=(a->>'installationId')::uuid AND source_key=p_key AND
   (principal_user_id=a->>'principalUserId' OR private._burimunsi_handset_legacy(a->>'collectionId',(a->>'accountId')::uuid,
    a->>'principalUserId',burimunsi_observation_requests.source_id,p_body))$b$);
 END LOOP;
END;$key_scope$;
SELECT pg_temp.buri_handset_patch('private.burimunsi_observation_held_prepare(text,text,text,uuid,text,text,text,text,bigint)',
 $a$WHERE q.collection_id=ctx->>'collectionId' AND q.source_key=p_key$a$,
 $b$WHERE q.collection_id=ctx->>'collectionId' AND q.account_id=(ctx->>'accountId')::uuid
  AND q.principal_user_id=ctx->>'principalUserId' AND q.installation_id=(ctx->>'installationId')::uuid AND q.source_key=p_key$b$);

-- Imported history is eligible for an exact, same-account reconciliation.
-- Only the Edge worker receives the opaque object descriptor. Raw disclosure
-- continues through observation_history_own and the separate audited reveal.
SELECT pg_temp.buri_handset_patch('private.burimunsi_observation_legacy_candidates(text)',
 'private.burimunsi_observation_actor(true)','private.burimunsi_observation_actor(false)');
SELECT pg_temp.buri_handset_patch('private.burimunsi_observation_legacy_candidates(text)',
 $a$  proof:=private.burimunsi_observation_history_own(item.source_id);$a$,
 $b$  SELECT jsonb_build_object('sourceId',r.source_id,'requestId',r.request_id,'bodySha256',r.body_sha256,
   'object_key',r.object_key,'object_sha256',r.object_sha256,'size_bytes',r.size_bytes,'id',r.source_id,
   'createdAt',r.created_at,'principalUserId',r.principal_user_id,'sessionId',a->>'sessionId',
   'consentGeneration',(c->>'generation')::bigint,'fingerprint',r.fingerprint) INTO proof
   FROM private.burimunsi_observation_history_rows(item.source_id) r
   WHERE r.account_id=(a->>'accountId')::uuid AND r.collection_id=cid AND r.body_sha256=p_body
    AND private.burimunsi_observation_storage_matches(r.object_key,
     jsonb_build_object('ownerId',r.principal_user_id,'purpose','sms_receipt','entityId',r.source_id),r.object_sha256);$b$);
SELECT pg_temp.buri_handset_patch('private.burimunsi_observation_legacy_present()',
 $a$WHERE collection_id=a->>'collectionId' AND source_key IS NULL$a$,
 $b$WHERE collection_id=a->>'collectionId' AND account_id=(a->>'accountId')::uuid AND source_key IS NULL
   AND (installation_id=(a->>'installationId')::uuid AND principal_user_id=a->>'principalUserId' OR EXISTS(
    SELECT 1 FROM private.collect_imported_native_history h JOIN private.collect_migration_actor_lineage l
     ON l.source_actor_id=burimunsi_observation_requests.principal_user_id AND l.cloud_primary_id=a->>'principalUserId'
    WHERE h.collection_id=a->>'collectionId' AND h.source_id=burimunsi_observation_requests.source_id))$b$);

-- A reinstall can witness a legacy, immutable same-account receipt. Keep the
-- exact proven relationship across census runs. This table grants no new
-- financial, raw-disclosure or ingestion authority.
CREATE TABLE private.burimunsi_handset_legacy_matches(
 collection_id text NOT NULL,account_id uuid NOT NULL,installation_id uuid NOT NULL,principal_user_id text NOT NULL,
 source_key text NOT NULL CHECK(source_key ~ '^[a-f0-9]{64}$'),source_id text NOT NULL REFERENCES private.collect_imported_native_history(source_id),
 PRIMARY KEY(collection_id,account_id,installation_id,source_key),UNIQUE(collection_id,account_id,installation_id,source_id),
 FOREIGN KEY(account_id,collection_id) REFERENCES private.burimunsi_accounts(id,collection_id));
ALTER TABLE private.burimunsi_handset_legacy_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.burimunsi_handset_legacy_matches FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.burimunsi_handset_legacy_matches FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;
CREATE POLICY handset_inbox_frame ON private.burimunsi_handset_legacy_matches TO postgres
 USING(current_setting('role',true)='collect_runtime' AND current_setting('collect.edge_verified',true)='true'
  AND current_setting('burimunsi.inbox_frame',true)='1')
 WITH CHECK(current_setting('role',true)='collect_runtime' AND current_setting('collect.edge_verified',true)='true'
  AND current_setting('burimunsi.inbox_frame',true)='1');
CREATE TRIGGER collect_fence_statement_v1 BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON private.burimunsi_handset_legacy_matches
 FOR EACH STATEMENT EXECUTE FUNCTION private._collect_fence_statement();
ALTER TABLE private.burimunsi_handset_legacy_matches ENABLE ALWAYS TRIGGER collect_fence_statement_v1;
CREATE TRIGGER handset_legacy_match_retained BEFORE UPDATE OR DELETE OR TRUNCATE ON private.burimunsi_handset_legacy_matches
 FOR EACH STATEMENT EXECUTE FUNCTION private._collect_fence_no_erasure();
ALTER TABLE private.burimunsi_handset_legacy_matches ENABLE ALWAYS TRIGGER handset_legacy_match_retained;

-- The imported manifest, historical owner mapping, original grant tuple,
-- original request and the journal must all agree. Callers holding a receipt
-- ID alone cannot attach it to a new handset.
CREATE FUNCTION private._burimunsi_handset_legacy(p_group text,p_account uuid,p_principal text,p_source text,p_body text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE proof boolean;obs text:=current_setting('burimunsi.observation_frame',true);native text:=current_setting('burimunsi.native_receipt_frame',true);
BEGIN
 PERFORM set_config('burimunsi.observation_frame','1',true);PERFORM set_config('burimunsi.native_receipt_frame','1',true);
 SELECT EXISTS(SELECT 1 FROM private.collect_imported_native_history h
 JOIN private.burimunsi_unresolved_observations r ON r.source_id=h.source_id AND r.collection_id=h.collection_id
  AND r.request_id=h.request_id AND r.fingerprint=h.source_fingerprint AND r.body_sha256=h.body_sha256 AND r.object_sha256=h.object_sha256
 JOIN private.burimunsi_native_receipt_origins o ON o.source_id=r.source_id AND
  (o.collection_id,o.account_id,o.principal_user_id,o.installation_id,o.grant_id,o.grant_version,o.request_id,o.fingerprint,o.body_sha256,o.object_sha256)=
  (r.collection_id,r.account_id,r.principal_user_id,r.installation_id,r.grant_id,r.grant_version,r.request_id,r.fingerprint,r.body_sha256,r.object_sha256)
 JOIN private.burimunsi_observation_requests q ON q.source_id=r.source_id AND
  (q.collection_id,q.account_id,q.principal_user_id,q.installation_id,q.grant_id,q.grant_version,q.request_id,q.fingerprint)=
  (r.collection_id,r.account_id,r.principal_user_id,r.installation_id,r.grant_id,r.grant_version,r.request_id,r.fingerprint)
 JOIN private.collect_migration_actor_lineage l ON l.source_actor_id=o.principal_user_id AND l.cloud_primary_id=p_principal
 WHERE h.collection_id=p_group AND r.account_id=p_account AND h.source_id=p_source AND r.body_sha256=p_body
  AND private.burimunsi_observation_storage_matches(r.object_key,
   jsonb_build_object('ownerId',r.principal_user_id,'purpose','sms_receipt','entityId',r.source_id),r.object_sha256)) INTO proof;
 PERFORM set_config('burimunsi.observation_frame',coalesce(obs,''),true);PERFORM set_config('burimunsi.native_receipt_frame',coalesce(native,''),true);
 RETURN proof;
END;$fn$;
REVOKE ALL ON FUNCTION private._burimunsi_handset_legacy(text,uuid,text,text,text)
 FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;

-- The native route and the Admin aggregate call this same owner-only projection.
-- Sources with no evidence tying them to this installation are outside its
-- inventory. A broken link within the inventory prevents certification.
CREATE FUNCTION private._burimunsi_handset_inventory(p_group text,p_account uuid,p_principal text,p_installation uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE n integer;recorded integer;pending boolean;changed boolean;revision text;profile jsonb;
 obs text:=current_setting('burimunsi.observation_frame',true);
 native text:=current_setting('burimunsi.native_receipt_frame',true);
 inbox text:=current_setting('burimunsi.inbox_frame',true);
BEGIN
 IF p_group IS NULL OR p_account IS NULL OR p_installation IS NULL OR p_principal IS NULL
  OR p_group IS DISTINCT FROM current_setting('burimunsi.collection_id',true) THEN
  RAISE EXCEPTION 'burimunsi_observation_denied' USING ERRCODE='42501';END IF;
 PERFORM set_config('burimunsi.observation_frame','1',true);PERFORM set_config('burimunsi.native_receipt_frame','1',true);
 PERFORM set_config('burimunsi.inbox_frame','1',true);
 SELECT jsonb_build_array(w.id,w.provider,w.status,w.profile_status,w.profile_version,w.profile_json,w.currency,w.timezone,
  d.expected_receiving_account_id,d.revision,d.enabled,d.profile_version,d.profile_json,d.evidence_sha256) INTO profile
 FROM private.burimunsi_scopes s JOIN app.momo_receiving_accounts w ON w.id=s.receiving_account_id
 LEFT JOIN private.burimunsi_detection_profiles d ON d.collection_id=s.collection_id WHERE s.collection_id=p_group;
 IF profile IS NULL THEN RAISE EXCEPTION 'burimunsi_observation_profile_unavailable' USING ERRCODE='55000';END IF;
 WITH ids AS MATERIALIZED (
  SELECT q.source_id FROM private.burimunsi_observation_requests q WHERE
   (q.collection_id,q.account_id,q.principal_user_id,q.installation_id)=(p_group,p_account,p_principal,p_installation)
  UNION SELECT o.source_id FROM private.burimunsi_native_receipt_origins o WHERE
   (o.collection_id,o.account_id,o.installation_id)=(p_group,p_account,p_installation) AND
   (o.principal_user_id=p_principal OR EXISTS(SELECT 1 FROM private.collect_imported_native_history h
    JOIN private.collect_migration_actor_lineage l ON l.source_actor_id=o.principal_user_id AND l.cloud_primary_id=p_principal
    WHERE h.collection_id=p_group AND h.source_id=o.source_id))
  UNION SELECT x.source_id FROM private.burimunsi_sms_source_scopes x WHERE
   (x.collection_id,x.custodian_account_id,x.owner_user_id,x.installation_id)=(p_group,p_account,p_principal,p_installation)
  UNION SELECT a.source_id FROM private.burimunsi_handset_legacy_matches a WHERE
   (a.collection_id,a.account_id,a.principal_user_id,a.installation_id)=(p_group,p_account,p_principal,p_installation) LIMIT 100001
 ), evidence AS (
  SELECT ids.source_id, q.source_id IS NOT NULL AND r.source_id IS NULL AS awaiting,
   r.source_id IS NOT NULL OR g.source_id IS NOT NULL AS retained,
   CASE WHEN r.source_id IS NULL THEN q.source_id IS NULL AND g.source_id IS NULL
    ELSE q.source_id IS NULL OR (r.collection_id,r.account_id,r.principal_user_id,r.installation_id,r.grant_id,r.grant_version,r.request_id,r.fingerprint)
      IS DISTINCT FROM (q.collection_id,q.account_id,q.principal_user_id,q.installation_id,q.grant_id,q.grant_version,q.request_id,q.fingerprint)
     OR r.collection_id IS DISTINCT FROM p_group OR r.account_id IS DISTINCT FROM p_account
     OR (r.principal_user_id IS DISTINCT FROM p_principal OR r.installation_id IS DISTINCT FROM p_installation OR h.source_id IS NOT NULL)
      AND NOT private._burimunsi_handset_legacy(p_group,p_account,p_principal,r.source_id,r.body_sha256)
     OR s.id IS NULL OR (s.owner_user_id,s.body_sha256,s.object_sha256,s.object_key)
      IS DISTINCT FROM (r.principal_user_id,r.body_sha256,r.object_sha256,'sms/'||r.source_id)
     OR x.source_id IS NOT NULL AND (x.owner_user_id,x.source_body_sha256,x.object_sha256)
      IS DISTINCT FROM (r.principal_user_id,r.body_sha256,r.object_sha256)
     OR NOT private.burimunsi_observation_storage_matches(r.object_key,
      jsonb_build_object('ownerId',r.principal_user_id,'purpose','sms_receipt','entityId',r.source_id),r.object_sha256)
     OR reservation.object_key IS NULL OR reservation.scope IS DISTINCT FROM
      jsonb_build_object('ownerId',r.principal_user_id,'purpose','sms_receipt','entityId',r.source_id)
     OR reservation.aad IS DISTINCT FROM 'sms:'||r.source_id||':'||r.object_sha256 OR reservation.plaintext_sha256 IS DISTINCT FROM r.object_sha256
     OR reservation.key_id IS NULL OR reservation.key_id IS DISTINCT FROM saved.custom_metadata->>'key_id'
     OR reservation.source_fingerprint IS DISTINCT FROM saved.custom_metadata->>'source_fingerprint' END AS mismatch,
   encode(sha256(convert_to(jsonb_build_array(to_jsonb(q),to_jsonb(r),to_jsonb(x),to_jsonb(g),to_jsonb(s),to_jsonb(saved),to_jsonb(intent),
    (to_jsonb(reservation)-'sealed_body')||jsonb_build_object('sealed_sha256',encode(sha256(convert_to(reservation.sealed_body,'UTF8')),'hex')),
    to_jsonb(deletion),to_jsonb(j),'held',hold.source_id,private._burimunsi_inbox_outcome(ids.source_id,p_group))::text,'UTF8')),'hex') AS digest
  FROM ids LEFT JOIN private.burimunsi_observation_requests q ON q.source_id=ids.source_id
  LEFT JOIN private.burimunsi_unresolved_observations r ON r.source_id=ids.source_id
  LEFT JOIN app.sms_receipts s ON s.id=ids.source_id
  LEFT JOIN private.burimunsi_sms_source_scopes x ON x.source_id=ids.source_id
  LEFT JOIN LATERAL private._burimunsi_inbox_gateway(p_group,ids.source_id,NULL) g ON
   (g.account_id,g.owner_id,g.installation)=(p_account,p_principal,p_installation)
  LEFT JOIN private.collect_imported_native_history h ON h.source_id=ids.source_id
  LEFT JOIN private.burimunsi_auto_sms_jobs j ON j.source_id=ids.source_id
  LEFT JOIN private.burimunsi_held_observation_sources hold ON hold.source_id=ids.source_id
  LEFT JOIN private.storage_objects saved ON saved.object_key=r.object_key
  LEFT JOIN private.storage_put_intents intent ON intent.object_key=r.object_key
  LEFT JOIN private.storage_payload_reservations reservation ON reservation.object_key=r.object_key
  LEFT JOIN private.storage_delete_intents deletion ON deletion.object_key=r.object_key
 )
 SELECT count(*),count(*) FILTER(WHERE retained),coalesce(bool_or(awaiting),false),coalesce(bool_or(mismatch),false),
  encode(sha256(convert_to(jsonb_build_array('burimunsi.handset.inventory.v2',p_group,p_account,p_principal,p_installation,profile,
   coalesce(string_agg(digest,'' ORDER BY source_id),''))::text,'UTF8')),'hex')
 INTO n,recorded,pending,changed,revision FROM evidence;
 IF n>100000 THEN RAISE EXCEPTION 'burimunsi_observation_snapshot_limit' USING ERRCODE='54000';END IF;
 PERFORM set_config('burimunsi.observation_frame',coalesce(obs,''),true);PERFORM set_config('burimunsi.native_receipt_frame',coalesce(native,''),true);
 PERFORM set_config('burimunsi.inbox_frame',coalesce(inbox,''),true);
 RETURN jsonb_build_object('groupId',p_group,'hasPending',pending,'hasRecorded',recorded>0,'recordedCount',recorded,
  'hasUnmatchedCanonical',changed,'revision',revision);
END;$fn$;
REVOKE ALL ON FUNCTION private._burimunsi_handset_inventory(text,uuid,text,uuid)
 FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;

CREATE OR REPLACE FUNCTION private.burimunsi_observation_reconcile_verified_status() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE a jsonb:=private.burimunsi_observation_context();
BEGIN
 RETURN private._burimunsi_handset_inventory(a->>'collectionId',(a->>'accountId')::uuid,a->>'principalUserId',(a->>'installationId')::uuid)
  ||jsonb_build_object('scope','verified_installation');
END;$fn$;

CREATE OR REPLACE FUNCTION private.burimunsi_observation_reconcile_status() RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
 SELECT private.burimunsi_observation_reconcile_verified_status()-'scope'
$fn$;

SELECT pg_temp.buri_handset_patch('private.burimunsi_observation_inbox_page(uuid,jsonb)',
 $a$   WHERE r.source_id=source AND r.collection_id=cid AND r.body_sha256=item->>'bodySha256') AND NOT EXISTS($a$,
 $b$   WHERE r.source_id=source AND r.collection_id=cid AND r.body_sha256=item->>'bodySha256'
    AND r.account_id=active.account_id AND r.installation_id=device AND r.principal_user_id=ctx->>'principalUserId')
   AND NOT private._burimunsi_handset_legacy(cid,active.account_id,ctx->>'principalUserId',source,item->>'bodySha256') AND NOT EXISTS($b$);
SELECT pg_temp.buri_handset_patch('private.burimunsi_observation_inbox_page(uuid,jsonb)',
 $a$  SELECT * INTO prior FROM private.burimunsi_inbox_check_items$a$,
 $b$  IF source IS NOT NULL AND private._burimunsi_handset_legacy(cid,active.account_id,ctx->>'principalUserId',source,item->>'bodySha256') THEN
   INSERT INTO private.burimunsi_handset_legacy_matches(collection_id,account_id,installation_id,principal_user_id,source_key,source_id)
    VALUES(cid,active.account_id,device,ctx->>'principalUserId',item->>'key',source) ON CONFLICT DO NOTHING;
   IF NOT EXISTS(SELECT 1 FROM private.burimunsi_handset_legacy_matches l WHERE l.collection_id=cid AND l.account_id=active.account_id
    AND l.installation_id=device AND l.principal_user_id=ctx->>'principalUserId' AND l.source_key=item->>'key' AND l.source_id=source) THEN
    RAISE EXCEPTION 'inbox_source_changed' USING ERRCODE='40001';END IF;
  END IF;
  SELECT * INTO prior FROM private.burimunsi_inbox_check_items$b$);
-- Source presence and outcome from an ordinary previous installation do not
-- describe the current one. Imported history remains read-only and lineage-gated.
SELECT pg_temp.buri_handset_patch('private.burimunsi_observation_processing_status(jsonb)',
 $a$SELECT 1 FROM private.burimunsi_observation_history_rows(source) r
   WHERE private.burimunsi_observation_storage_matches$a$,
 $b$SELECT 1 FROM private.burimunsi_observation_history_rows(source) r
   WHERE (r.installation_id=(a->>'installationId')::uuid OR private.collect_imported_native_source(source))
    AND private.burimunsi_observation_storage_matches$b$);

-- A valid new grant edition may attest an already terminal receipt from the
-- same account and physical installation. It cannot retry or revive the old
-- grant's work, and cannot expose the original body.
SELECT pg_temp.buri_handset_patch('private.burimunsi_observation_processing_status(jsonb)',
 $a$    status:=coalesce(status,'unknown');$a$,
 $b$    IF status IS NULL THEN
     SELECT private._burimunsi_inbox_outcome(r.source_id,r.collection_id) INTO status
      FROM private.burimunsi_unresolved_observations r WHERE r.source_id=source AND r.collection_id=a->>'collectionId'
       AND r.account_id=(a->>'accountId')::uuid AND r.principal_user_id=a->>'principalUserId'
       AND r.installation_id=(a->>'installationId')::uuid AND r.grant_id=(a->>'grantId')::uuid
       AND r.grant_version<(a->>'grantVersion')::bigint AND private.burimunsi_observation_storage_matches(r.object_key,
        jsonb_build_object('ownerId',r.principal_user_id,'purpose','sms_receipt','entityId',r.source_id),r.object_sha256);
     IF status NOT IN('parsed','duplicate') THEN status:='unknown';END IF;
    END IF;
    status:=coalesce(status,'unknown');$b$);

DO $retention$
DECLARE body text;definition text;class jsonb:=jsonb_build_array(jsonb_build_object(
 'name','private:burimunsi_handset_legacy_matches','relation','private.burimunsi_handset_legacy_matches','scope','unmapped_private',
 'purpose','Exact same-account legacy receipt witnessed in this handset inbox','known_links','collection, account, installation and original source','blocked',true));
BEGIN
 SELECT p.prosrc,pg_get_functiondef(p.oid) INTO STRICT body,definition FROM pg_proc p
 WHERE p.oid='private._retention_manifest_catalog_v2()'::regprocedure AND pg_get_userbyid(p.proowner)='postgres';
 IF strpos(body,'private:burimunsi_handset_legacy_matches')>0 OR length(definition)-length(replace(definition,body,''))<>length(body) THEN
  RAISE EXCEPTION 'admin_handset_retention_changed' USING ERRCODE='55000';END IF;
 EXECUTE replace(definition,body,format('SELECT jsonb_set(base,''{private_classes}'',(base->''private_classes'')||%L::jsonb) FROM (%s) prior(base)',
  class::text,rtrim(body,E'; \t\r\n')));
 PERFORM pg_temp.buri_handset_patch('private.retention_capture_inventory_v2(uuid,text,bigint,text,integer)',
  '''managed:storage_iceberg''','''private:burimunsi_handset_legacy_matches'',''managed:storage_iceberg''');
END;$retention$;
COMMIT;
