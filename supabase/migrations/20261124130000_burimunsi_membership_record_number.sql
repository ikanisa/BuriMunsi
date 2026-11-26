-- A membership keeps its own public number when its role or activity changes.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $guard$
BEGIN
  PERFORM private._collect_fence_require_operator();
  PERFORM 1 FROM private.collect_fence_control WHERE singleton AND mode = 'fenced' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership_record_number_fence_required' USING ERRCODE = '55000';
  END IF;
END;
$guard$;

LOCK TABLE app.memberships IN ACCESS EXCLUSIVE MODE;
DO $check$
DECLARE
  columns text[];
BEGIN
  SELECT array_agg(attname::text ORDER BY attnum) INTO columns
  FROM pg_attribute WHERE attrelid = 'app.memberships'::regclass AND attnum > 0 AND NOT attisdropped;
  IF columns IS DISTINCT FROM ARRAY['id','collection_id','user_id','role','active','joined_at','revision']
      OR NOT has_table_privilege('collect_runtime','app.memberships','INSERT')
      OR NOT has_table_privilege('collect_runtime','app.memberships','UPDATE') THEN
    RAISE EXCEPTION 'membership_record_number_predecessor_changed' USING ERRCODE = '55000';
  END IF;
END;
$check$;

ALTER TABLE app.memberships ADD COLUMN membership_record_number bigint GENERATED ALWAYS AS IDENTITY
  (START WITH 100000000000 MINVALUE 100000000000 MAXVALUE 999999999999 NO CYCLE);
ALTER TABLE app.memberships
  ADD CONSTRAINT memberships_record_number_shape CHECK (membership_record_number BETWEEN 100000000000 AND 999999999999),
  ADD CONSTRAINT memberships_record_number_unique UNIQUE (membership_record_number);

CREATE FUNCTION private.burimunsi_membership_record_number_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF NEW.membership_record_number IS DISTINCT FROM OLD.membership_record_number THEN
    RAISE EXCEPTION 'membership_record_number_immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION private.burimunsi_membership_record_number_immutable()
  FROM PUBLIC, anon, authenticated, service_role, collect_importer, collect_runtime;
CREATE TRIGGER burimunsi_membership_record_number_immutable BEFORE UPDATE OF membership_record_number ON app.memberships
  FOR EACH ROW EXECUTE FUNCTION private.burimunsi_membership_record_number_immutable();
ALTER TABLE app.memberships ENABLE ALWAYS TRIGGER burimunsi_membership_record_number_immutable;

-- Preserve the original writers' seven columns, including natural-key upserts.
-- Only the database issues the new field, even for OVERRIDING SYSTEM VALUE.
REVOKE INSERT, UPDATE ON app.memberships FROM collect_runtime;
GRANT INSERT (id,collection_id,user_id,role,active,joined_at,revision),
      UPDATE (id,collection_id,user_id,role,active,joined_at,revision) ON app.memberships TO collect_runtime;
DO $authority$
DECLARE
  allocator regclass := pg_get_serial_sequence('app.memberships','membership_record_number')::regclass;
  role_name text;
BEGIN
  EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime', allocator);
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role','collect_importer','collect_runtime'] LOOP
    IF has_column_privilege(role_name,'app.memberships','membership_record_number','INSERT,UPDATE')
        OR has_sequence_privilege(role_name,allocator,'USAGE,SELECT,UPDATE') THEN
      RAISE EXCEPTION 'membership_record_number_write_authority_changed' USING ERRCODE = '55000';
    END IF;
  END LOOP;
END;
$authority$;

-- Include the new column in the existing membership retention class. Keep every
-- subject predicate and all other classes verbatim, evaluating the prior catalog once.
DO $retention$
DECLARE
  body text;
  definition text;
  prior jsonb;
  proposed jsonb;
  path constant text[] := ARRAY['application','memberships','columns'];
  original constant jsonb := '["id","collection_id","user_id","role","active","joined_at","revision"]';
BEGIN
  SELECT p.prosrc, pg_get_functiondef(p.oid) INTO STRICT body, definition FROM pg_proc p
  JOIN pg_language l ON l.oid = p.prolang
  WHERE p.oid = 'private._retention_manifest_catalog_v2()'::regprocedure
    AND l.lanname = 'sql' AND pg_get_userbyid(p.proowner) = 'postgres' AND NOT p.prosecdef
    AND p.provolatile = 'i' AND p.prorettype = 'jsonb'::regtype AND NOT p.proretset
    AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp'] AND p.proacl::text = '{postgres=X/postgres}';
  prior := private._retention_manifest_catalog_v2();
  IF prior #> path IS DISTINCT FROM original OR strpos(definition,body) = 0 THEN
    RAISE EXCEPTION 'membership_retention_predecessor_changed' USING ERRCODE = '55000';
  END IF;
  proposed := jsonb_set(prior,path,original || '["membership_record_number"]'::jsonb,false);
  EXECUTE replace(definition, body, format(
    'WITH prior(value) AS MATERIALIZED (%s) SELECT jsonb_set(value,%L::text[],(value #> %L::text[]) || %L::jsonb,false) FROM prior',
    rtrim(body,E'; \t\r\n'),path,path,'["membership_record_number"]'));
  IF private._retention_manifest_catalog_v2() IS DISTINCT FROM proposed THEN
    RAISE EXCEPTION 'membership_retention_result_changed' USING ERRCODE = '55000';
  END IF;
END;
$retention$;
COMMIT;
