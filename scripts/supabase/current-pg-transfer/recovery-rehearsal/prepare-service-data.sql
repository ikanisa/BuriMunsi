-- Run only against the isolated typed service restore, before starting Auth or application traffic.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF current_setting('cluster_name') <> 'burimunsi_isolated_recovery'
     OR current_setting('server_version_num')::int / 10000 <> 17
     OR current_setting('listen_addresses') NOT IN ('', '127.0.0.1', '::1')
     OR (inet_server_addr() IS NOT NULL AND inet_server_addr() NOT IN ('127.0.0.1'::inet, '::1'::inet))
     OR current_setting('shared_preload_libraries') <> ''
     OR coalesce(current_setting('cron.launch_active_jobs', true), 'off') <> 'off' THEN
    RAISE EXCEPTION 'isolated_service_restore_required';
  END IF;
END $guard$;

LOCK TABLE burimunsi.payments, auth.refresh_tokens IN ACCESS EXCLUSIVE MODE;

-- The source COPY excludes generated attributes. Compare against PostgreSQL's
-- parsed expression so an existing ordinary or incompatible field cannot pass.
CREATE TEMP TABLE recovery_expected_allocation (
  member_id text,
  allocation_state text GENERATED ALWAYS AS
    (CASE WHEN member_id IS NULL THEN 'unallocated' ELSE 'allocated' END) STORED
) ON COMMIT DROP;

DO $allocation$
DECLARE
  existing record;
  expected_definition text;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_attribute WHERE attrelid='burimunsi.payments'::regclass
     AND attname='member_id' AND atttypid='text'::regtype AND NOT attisdropped) THEN
    RAISE EXCEPTION 'typed_payment_member_required';
  END IF;
  SELECT pg_get_expr(d.adbin,d.adrelid) INTO STRICT expected_definition
    FROM pg_attrdef d JOIN pg_attribute a ON (a.attrelid,a.attnum)=(d.adrelid,d.adnum)
    WHERE a.attrelid='pg_temp.recovery_expected_allocation'::regclass AND a.attname='allocation_state';
  SELECT a.attgenerated, a.atttypid, pg_get_expr(d.adbin,d.adrelid) AS definition INTO existing
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON (d.adrelid,d.adnum)=(a.attrelid,a.attnum)
    WHERE a.attrelid='burimunsi.payments'::regclass AND a.attname='allocation_state' AND NOT a.attisdropped;
  IF NOT FOUND THEN
    EXECUTE format('ALTER TABLE burimunsi.payments ADD COLUMN allocation_state text GENERATED ALWAYS AS (%s) STORED',expected_definition);
  ELSIF existing.attgenerated <> 's' OR existing.atttypid <> 'text'::regtype OR existing.definition IS DISTINCT FROM expected_definition THEN
    RAISE EXCEPTION 'recovered_allocation_expression_changed';
  END IF;
END $allocation$;

-- COPY of explicit Auth IDs does not advance its serial sequence. A source
-- sequence already beyond the imported rows retains its complete high-water mark.
DO $auth$
DECLARE
  token_sequence regclass := pg_get_serial_sequence('auth.refresh_tokens','id');
  largest bigint;
  last_id bigint;
  called boolean;
  ceiling bigint;
BEGIN
  SELECT seqmax INTO STRICT ceiling FROM pg_sequence WHERE seqrelid=token_sequence AND seqincrement=1 AND NOT seqcycle;
  SELECT max(id) INTO largest FROM auth.refresh_tokens;
  EXECUTE format('SELECT last_value,is_called FROM %s',token_sequence) INTO STRICT last_id,called;
  IF largest >= ceiling OR (called AND last_id >= ceiling) THEN
    RAISE EXCEPTION 'recovered_refresh_token_sequence_exhausted';
  END IF;
  IF largest > last_id OR (largest = last_id AND NOT called) THEN
    -- Transactional RESTART preserves the previous state on a failed completion.
    EXECUTE format('ALTER SEQUENCE %s RESTART WITH %s',token_sequence,largest+1);
  END IF;
END $auth$;
COMMIT;
