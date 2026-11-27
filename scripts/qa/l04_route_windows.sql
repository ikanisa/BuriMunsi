-- Supabase Logs Explorer, ClickHouse. Choose a bounded UTC time range.
-- Each row is one source in one five-minute window. Missing rows or coverage
-- disagreement cannot establish recovery. No URL, query string or body leaves
-- the source. The API gateway and function invocation use different path keys.
SELECT toStartOfFiveMinutes(timestamp) AS window_start, source,
       count() AS source_records,
       countIf(path = '' OR method = '' OR status = 0) AS malformed,
       countIf(method = 'POST' AND path = '/functions/v1/collect-api/v1/burimunsi/sms/observations/reconcile-batch') AS responses,
       countIf(method = 'POST' AND path = '/functions/v1/collect-api/v1/burimunsi/sms/observations/reconcile-batch'
               AND status = 503) AS http_503
FROM (
  SELECT timestamp, source,
         multiIf(source = 'edge_logs', log_attributes['request.path'], log_attributes['request.pathname']) AS path,
         log_attributes['request.method'] AS method,
         toUInt16OrZero(log_attributes['response.status_code']) AS status
  FROM logs WHERE source IN ('edge_logs', 'function_edge_logs')
) AS requests
GROUP BY window_start, source
ORDER BY window_start, source
