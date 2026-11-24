-- A full group of screen reads must leave room for the real jobs admission.
BEGIN;
DO $fixture$
DECLARE
 source text;
BEGIN
 IF inet_server_addr() IS NOT NULL OR current_database() !~ '^collect_archive_[0-9a-f]{24}_test$'
    OR current_setting('cluster_name') <> 'collect_archive_next_fixture' THEN
  RAISE EXCEPTION 'owned_phone_fixture_required';
 END IF;
 SELECT source_sha256 INTO STRICT source FROM private.collect_fence_control WHERE singleton AND mode='open';
 PERFORM set_config('role','collect_runtime',true);
 PERFORM set_config('collect.edge_verified','true',true);
 PERFORM set_config('burimunsi.read_admission','1',true);
 FOR i IN 1..7 LOOP
  PERFORM private.collect_fence_register(gen_random_uuid(),source,'http_admin');
 END LOOP;
 BEGIN
  PERFORM private.collect_fence_register(gen_random_uuid(),source,'http_collect');
  RAISE EXCEPTION 'eighth_read_consumed_worker_slot';
 EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM <> 'burimunsi_read_capacity' THEN RAISE; END IF;
 END;
 PERFORM private.collect_fence_register(gen_random_uuid(),source,'jobs');
 BEGIN
  PERFORM private.collect_fence_register(gen_random_uuid(),source,'jobs');
  RAISE EXCEPTION 'hard_limit_exceeded';
 EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM <> 'collect_fence_capacity' THEN RAISE; END IF;
 END;
END;
$fixture$;
ROLLBACK;
