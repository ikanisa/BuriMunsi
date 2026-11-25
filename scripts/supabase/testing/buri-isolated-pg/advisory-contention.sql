-- H01 operator snapshot. Run only with approved read-only diagnostics access.
-- No application rows, SQL text, values, user names, or client addresses.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL statement_timeout = '2s';
SET LOCAL lock_timeout = '250ms';
WITH targets(label,classid,objid,objsubid) AS (
  VALUES ('buri-authority'::text,(734636924058501::bigint >> 32)::oid,
          (734636924058501::bigint & 4294967295)::oid,1),
         ('release-fence-command',7346371::oid,1::oid,2),
         ('release-fence-write',7346371::oid,2::oid,2)
), locks AS MATERIALIZED (
  SELECT t.label,l.pid,l.granted,l.mode,l.waitstart
    FROM pg_locks l JOIN targets t USING (classid,objid,objsubid)
   WHERE l.locktype='advisory'
     AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
), subjects AS MATERIALIZED (
  SELECT DISTINCT pid FROM locks WHERE pid IS NOT NULL
), activity AS MATERIALIZED (
  SELECT a.pid,a.backend_start,a.xact_start,a.state
    FROM pg_stat_activity a JOIN subjects s USING (pid)
), waiters AS MATERIALIZED (
  SELECT l.*,CASE WHEN pid IS NULL THEN ARRAY[]::integer[]
                  ELSE pg_blocking_pids(pid) END AS blockers
    FROM locks l WHERE NOT granted
)
SELECT statement_timestamp() AS observed_at,t.label,
       (SELECT count(*) FROM locks l WHERE l.label=t.label AND l.granted) AS holders,
       (SELECT count(*) FROM waiters w WHERE w.label=t.label) AS waiters,
       w.pid AS waiter_pid,w.waitstart AS wait_started_at,
       h.pid AS confirmed_holder_pid,
       ha.backend_start AS holder_backend_started_at,ha.xact_start AS holder_transaction_started_at,
       ha.state AS holder_state,
       CASE WHEN w.pid IS NULL THEN NULL ELSE cardinality(w.blockers) END AS blocker_count,
       (w.pid IS NOT NULL AND h.pid IS NULL) AS pair_unconfirmed
  FROM targets t
  LEFT JOIN waiters w USING (label)
  LEFT JOIN locks h ON h.label=w.label AND h.granted AND h.pid=ANY(w.blockers)
  LEFT JOIN activity ha ON ha.pid=h.pid
  ORDER BY t.label,w.pid,h.pid;
ROLLBACK;
