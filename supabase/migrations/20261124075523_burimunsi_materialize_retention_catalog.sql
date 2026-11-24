-- Each catalog extension reads its predecessor twice. Evaluate each predecessor
-- once so an inventory read cannot expand the nested expressions exponentially.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5s';

DO $migration$
DECLARE
  previous_body text;
  definition text;
  candidate text;
BEGIN
  PERFORM private._collect_fence_require_operator();
  IF NOT EXISTS (
    SELECT 1 FROM private.collect_fence_control
    WHERE singleton AND mode = 'fenced' AND project_ref = 'rrlduytparvsjfmegalh'
  ) THEN
    RAISE EXCEPTION 'retention_catalog_fence_required' USING ERRCODE = '55000';
  END IF;

  SELECT p.prosrc, pg_get_functiondef(p.oid) INTO previous_body, definition
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
  WHERE p.oid = to_regprocedure('private._retention_manifest_catalog_v2()')
    AND pg_get_userbyid(p.proowner) = 'postgres' AND l.lanname = 'sql'
    AND p.prorettype = 'jsonb'::regtype AND NOT p.proretset
    AND NOT p.prosecdef AND p.provolatile = 'i'
    AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
    AND p.proacl::text = '{postgres=X/postgres}';
  IF NOT FOUND OR encode(sha256(convert_to(previous_body, 'UTF8')), 'hex')
      <> 'c2f0d9c6cdb45e05f5fcb0e11b75086763b8e2ada9874946b3f6b0a4195d1778' THEN
    RAISE EXCEPTION 'retention_catalog_predecessor_changed' USING ERRCODE = '55000';
  END IF;

  -- The previous body is pinned above. Every one of its nineteen nested
  -- subqueries gains its own materialized input. The original JSON expressions
  -- and the materialized input already present in the catalog stay intact.
  candidate := replace(
    replace(previous_body, ' FROM (', ' FROM (WITH retained_input(value) AS MATERIALIZED ('),
    ') prior(base)', ') SELECT value FROM retained_input) prior(base)'
  );
  IF encode(sha256(convert_to(candidate, 'UTF8')), 'hex')
      <> 'a0dbd6a6655e0174f1ca755bf64da572b9dad57e6011b189a473cc58752bee83'
      OR strpos(definition, previous_body) = 0 THEN
    RAISE EXCEPTION 'retention_catalog_definition_changed' USING ERRCODE = '55000';
  END IF;

  -- No call to the slow predecessor and no read of customer records.
  EXECUTE replace(definition, previous_body, candidate);
END;
$migration$;
COMMIT;
