-- Phone Admin authority comes from the signed-in operator and their approved collection.
-- A business membership is independent of that operator account.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $migration$
DECLARE change record; old_body text; definition text;
BEGIN
  PERFORM private._collect_fence_require_operator();
  IF NOT EXISTS(SELECT 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced') THEN
    RAISE EXCEPTION 'burimunsi_phone_sms_scope_requires_fence';
  END IF;

  FOR change IN SELECT * FROM (VALUES
    ('private.burimunsi_observation_admin_scope(text,boolean)',
     'cd4c8c07c83b6d8ecd038d93a95e9c6d0452217f7e87e77d678a4b6dafb7b38b',
     $before$   PERFORM private.burimunsi_browser_pin_assert_actor('sms.read',p_collection,'admin',1,NULL);
   RETURN a || jsonb_build_object('collectionId',p_collection,'label',(SELECT title FROM app.collections WHERE id=p_collection));$before$,
     $after$   DECLARE phone_actor jsonb:=private.burimunsi_browser_pin_context();
   BEGIN
     IF phone_actor->>'operatorRole' IS DISTINCT FROM 'admin'
        OR phone_actor->>'collectionId' IS DISTINCT FROM p_collection
        OR phone_actor->>'principalId' IS DISTINCT FROM a->>'principalId'
        OR phone_actor->>'adminId' IS DISTINCT FROM a->>'adminId'
        OR phone_actor->>'sessionId' IS DISTINCT FROM a->>'sessionId' THEN
       RAISE EXCEPTION 'burimunsi_observation_admin_denied' USING ERRCODE='42501';
     END IF;
     PERFORM set_config('burimunsi.pin_frame','1',true);
     PERFORM 1 FROM private.burimunsi_accounts account
       WHERE account.id=(phone_actor->>'accountId')::uuid AND account.collection_id=p_collection
         AND account.principal_user_id=phone_actor->>'principalId' AND account.role='admin'
         AND account.active AND NOT account.removed AND ARRAY['records.read','sms.read']::text[] <@ account.capabilities
       FOR SHARE OF account;
     IF NOT FOUND THEN
       RAISE EXCEPTION 'burimunsi_observation_admin_denied' USING ERRCODE='42501';
     END IF;
     -- Continue through the existing active operator approval and native authority checks.
   END;$after$),
    ('private.burimunsi_observation_admin_collections()',
     '06f04c1cdb5659021e96b56c924b797b3f238036a224c012b8d81a46d8331ef4',
     $before$   PERFORM private.burimunsi_browser_pin_assert_actor('sms.read',v->>'collectionId','admin',1,NULL);
   RETURN (SELECT jsonb_build_array(jsonb_build_object('collectionId',id,'label',title)) FROM app.collections WHERE id=v->>'collectionId');$before$,
     $after$   v:=private.burimunsi_observation_admin_scope(v->>'collectionId',false);
   RETURN jsonb_build_array(jsonb_build_object('collectionId',v->>'collectionId','label',v->>'label'));$after$),
    ('private.burimunsi_admin_sms_health()',
     '2eb90d160fab0cbf1f2dcd82f6c37750d1792aece1ea178dea1654782d18c702',
     $before$PERFORM private.burimunsi_browser_pin_assert_actor('sms.read',groups[1],'admin',1,NULL);$before$,
     $after$PERFORM private.burimunsi_observation_admin_scope(groups[1],false);$after$),
    ('private.burimunsi_admin_sms_operations()',
     'f51fc0677a1a21e9978fb26c4daebc110a599137fce7f20539cf97e0e94b1186',
     $before$PERFORM private.burimunsi_browser_pin_assert_actor('system_health.read',group_id,'admin',1,NULL);
    PERFORM private.burimunsi_browser_pin_assert_actor('sms.read',group_id,'admin',1,NULL);$before$,
     $after$PERFORM private.burimunsi_browser_pin_assert_actor('system_health.read',NULL,NULL,1,NULL);
    PERFORM private.burimunsi_observation_admin_scope(group_id,false);$after$)
  ) AS changes(signature,expected_sha,before_sql,after_sql) LOOP
    SELECT p.prosrc,pg_get_functiondef(p.oid) INTO STRICT old_body,definition
      FROM pg_proc p WHERE p.oid=change.signature::regprocedure AND p.prosecdef AND p.proowner='postgres'::regrole;
    IF encode(sha256(convert_to(old_body,'UTF8')),'hex')<>change.expected_sha
       OR length(old_body)-length(replace(old_body,change.before_sql,''))<>length(change.before_sql) THEN
      RAISE EXCEPTION 'burimunsi_phone_sms_scope_preimage_changed: %',change.signature;
    END IF;
    EXECUTE replace(definition,old_body,replace(old_body,change.before_sql,change.after_sql));
  END LOOP;
END;
$migration$;

COMMIT;
