-- One active phone Admin per BuriMunsi collection. Preserve all existing
-- inactive/removed identities and history; refuse existing duplicates.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $preflight$
BEGIN
  PERFORM private._collect_fence_require_operator();
  -- Match release_v3: advisory ingress, advisory effects, singleton row.
  -- Keep the guard held through account DDL/backfill verification.
  PERFORM pg_catalog.pg_advisory_xact_lock(7346371,1);
  PERFORM pg_catalog.pg_advisory_xact_lock(7346371,2);
  PERFORM 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'burimunsi_single_admin_requires_fence' USING ERRCODE='55000';
  END IF;
END;
$preflight$;

LOCK TABLE private.burimunsi_accounts IN SHARE ROW EXCLUSIVE MODE;
DO $audit$
BEGIN
  IF EXISTS(SELECT FROM private.burimunsi_accounts
            WHERE role='admin' AND active AND NOT removed
            GROUP BY collection_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'burimunsi_single_admin_preexisting_conflict' USING ERRCODE='55000';
  END IF;
END;
$audit$;

-- Reserve the slot even if a linked Admin identity is unavailable: a separate
-- link repair must not make a second already-active account eligible.
CREATE UNIQUE INDEX burimunsi_single_admin
  ON private.burimunsi_accounts(collection_id)
  WHERE role='admin' AND active AND NOT removed;

-- Do not mint a second, dormant Admin identity by promoting an inactive Staff
-- account. Existing inactive Admin rows may remain and be inspected/retired.
CREATE FUNCTION private.burimunsi_refuse_new_inactive_admin() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $guard$
BEGIN
  IF NEW.role='admin' AND NOT NEW.removed AND NOT NEW.active THEN
    IF TG_OP='INSERT' THEN
      RAISE unique_violation USING MESSAGE='burimunsi_single_admin', CONSTRAINT='burimunsi_single_admin';
    ELSIF OLD.role IS DISTINCT FROM 'admin' OR OLD.removed OR OLD.collection_id IS DISTINCT FROM NEW.collection_id THEN
      RAISE unique_violation USING MESSAGE='burimunsi_single_admin', CONSTRAINT='burimunsi_single_admin';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;
REVOKE ALL ON FUNCTION private.burimunsi_refuse_new_inactive_admin() FROM PUBLIC;
CREATE TRIGGER burimunsi_refuse_new_inactive_admin
 BEFORE INSERT OR UPDATE OF role,active,removed,collection_id
 ON private.burimunsi_accounts FOR EACH ROW
 EXECUTE FUNCTION private.burimunsi_refuse_new_inactive_admin();
COMMIT;
