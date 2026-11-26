BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- The Realtime SELECT runs under the subscriber's role. The private browser
-- account lookup is already reached through the scoped, expiring join guard.
-- Verify the same immutable owner binding in that frame without a call to
-- the owner DTO, whose direct runtime/operator guard must remain intact.
DO $owner_join$
DECLARE
  target constant regprocedure := 'private.burimunsi_browser_operator(text,text,uuid,boolean)'::regprocedure;
  definition text;
  digest text;
  needle constant text := $old$AND (w.role<>'owner' OR private.collect_owner_is(w.id,u.id,w.email))$old$;
  replacement constant text := $new$AND CASE
        WHEN w.role<>'owner' THEN true
        WHEN current_setting('role',true)='anon' AND current_setting('burimunsi.admin_live_frame',true)='1'
          AND current_setting('burimunsi.collection_id',true)=p_group THEN EXISTS(
            SELECT FROM private.collect_owner_identity binding WHERE binding.singleton
              AND binding.admin_user_id=w.id AND binding.principal_user_id=u.id AND binding.owner_email=w.email)
        ELSE private.collect_owner_is(w.id,u.id,w.email)
      END$new$;
BEGIN
  PERFORM private._collect_fence_require_operator();
  IF NOT EXISTS(SELECT FROM private.collect_fence_control WHERE singleton AND mode='fenced')
    OR EXISTS(SELECT FROM collect_ops.jobs_config WHERE singleton AND enabled)
    OR EXISTS(SELECT FROM collect_ops.jobs_dispatches WHERE state IN ('awaiting','unconfirmed')) THEN
    RAISE EXCEPTION 'burimunsi_admin_live_owner_requires_fence' USING ERRCODE='55000';
  END IF;
  SELECT pg_get_functiondef(oid),encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO STRICT definition,digest
    FROM pg_proc WHERE oid=target AND prosecdef AND proowner='postgres'::regrole;
  IF digest<>'f2dd2674ee5b6c91b672d165fde09462426e213c36b97269c540b7c6ee4a6965'
    OR length(definition)-length(replace(definition,needle,''))<>length(needle)
    OR EXISTS (SELECT FROM unnest(ARRAY['anon','authenticated','service_role','collect_runtime','collect_importer']) AS app_role(name)
      WHERE has_function_privilege(app_role.name,target,'EXECUTE')) THEN
    RAISE EXCEPTION 'burimunsi_admin_live_owner_preimage_changed' USING ERRCODE='55000';
  END IF;
  EXECUTE replace(definition,needle,replacement);
END;
$owner_join$;

COMMIT;
