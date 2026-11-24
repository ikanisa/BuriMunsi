BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '8s';

DO $preflight$
BEGIN
  PERFORM private._collect_fence_require_operator();
  IF NOT EXISTS (SELECT 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced' AND project_ref='rrlduytparvsjfmegalh') THEN
    RAISE EXCEPTION 'inbox_freshness_requires_fenced_release' USING ERRCODE='55000';
  END IF;
END;
$preflight$;

-- Match Android's five-minute verified proof and 24-hour resumable scan.
CREATE FUNCTION private._burimunsi_inbox_check_fresh(p_state text,p_checked_at bigint,p_now_ms bigint)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $fresh$
  SELECT p_checked_at<=p_now_ms AND CASE p_state
    WHEN 'verified' THEN p_checked_at>p_now_ms-300000
    WHEN 'checking' THEN p_checked_at>p_now_ms-86400000
    ELSE false END;
$fresh$;
REVOKE ALL ON FUNCTION private._burimunsi_inbox_check_fresh(text,bigint,bigint)
  FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;

DO $update$
DECLARE
  body text;
  definition text;
  guarded text;
  finish_anchor text := 'IF active.state=''checking'' THEN UPDATE private.burimunsi_inbox_checks';
  inventory_anchor text := 'SELECT h.*,CASE WHEN state=''verified'' THEN';
  summary_anchor text := 'CASE WHEN state=''verified'' AND (';
  fresh text := 'private._burimunsi_inbox_check_fresh(state,checked_at,floor(extract(epoch FROM statement_timestamp())*1000)::bigint)';
BEGIN
  SELECT prosrc,pg_get_functiondef(oid) INTO STRICT body,definition FROM pg_proc
  WHERE oid='private.burimunsi_observation_inbox_check(jsonb)'::regprocedure AND proowner='postgres'::regrole
    AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog, pg_temp'] AND proacl::text='{postgres=X/postgres,collect_runtime=X/postgres}';
  IF encode(sha256(convert_to(body,'UTF8')),'hex')<>'ce004ad0ea9d50158f2fac5ecddfb6922d2e14e0ac688419aa94af30cd7609ff'
    OR strpos(body,finish_anchor)=0 THEN RAISE EXCEPTION 'handset_inbox_checkpoint_changed'; END IF;
  -- A repeated verified checkpoint has just passed the same consent, inventory,
  -- complete page count and chronological head checks as its first completion.
  EXECUTE replace(definition,body,replace(body,finish_anchor,
    'IF active.state=''checking'' OR phase=''verified'' THEN UPDATE private.burimunsi_inbox_checks'));

  SELECT prosrc,pg_get_functiondef(oid) INTO STRICT body,definition FROM pg_proc
  WHERE oid='private.burimunsi_observation_admin_inbox_check(text)'::regprocedure AND proowner='postgres'::regrole
    AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog, pg_temp'] AND proacl::text='{postgres=X/postgres,collect_runtime=X/postgres}';
  IF encode(sha256(convert_to(body,'UTF8')),'hex')<>'a627f9e2c02cd285f4e3b42189ddf0ed99dd17baf6f098ddb93a765c5f1be407'
    OR strpos(body,inventory_anchor)=0 OR strpos(body,summary_anchor)=0 THEN RAISE EXCEPTION 'admin_inbox_authority_changed'; END IF;
  guarded := replace(body,inventory_anchor,'SELECT h.*,CASE WHEN state=''verified'' AND ' || fresh || ' THEN');
  guarded := replace(guarded,summary_anchor,
    'CASE WHEN state IN (''checking'',''verified'') AND NOT ' || fresh || ' THEN ''stale'' WHEN state=''verified'' AND (');
  EXECUTE replace(definition,body,guarded);
END;
$update$;
COMMIT;
