-- Admin reads one conservative summary of the inboxes taking part in automatic
-- collection. Counts describe SMS entries on phones, including a shared receipt
-- on two phones. Payment totals come from the ledger.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';
DO $preflight$
BEGIN
 PERFORM private._collect_fence_require_operator();
 IF NOT EXISTS (SELECT 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced')
    OR to_regprocedure('private._burimunsi_handset_inventory(text,uuid,text,uuid)') IS NULL THEN
  RAISE EXCEPTION 'admin_inbox_coverage_precondition' USING ERRCODE='55000';
 END IF;
END;$preflight$;

CREATE OR REPLACE FUNCTION private.burimunsi_observation_admin_inbox_check(p_collection text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE
 prior_group text:=current_setting('burimunsi.collection_id',true);
 prior_native text:=current_setting('burimunsi.native_receipt_frame',true);
 prior_inbox text:=current_setting('burimunsi.inbox_frame',true);
 prior_pin text:=current_setting('burimunsi.pin_frame',true);
 prior_observation text:=current_setting('burimunsi.observation_frame',true);
 result jsonb;
BEGIN
 PERFORM set_config('burimunsi.inbox_frame','1',true);
 PERFORM set_config('burimunsi.pin_frame','1',true);
 PERFORM set_config('burimunsi.observation_frame','1',true);
 PERFORM private.burimunsi_observation_admin_scope(p_collection,false);
 PERFORM set_config('burimunsi.collection_id',p_collection,true);
 PERFORM set_config('burimunsi.native_receipt_frame','1',true);

 WITH handsets AS MATERIALIZED (
  SELECT c.installation_id,c.account_id,a.principal_user_id,x.state,x.checked_at,x.report
  FROM private.burimunsi_observation_consents c
  JOIN private.burimunsi_accounts a ON a.id=c.account_id AND a.collection_id=c.collection_id
    AND a.active AND NOT a.removed AND a.role='admin'
  JOIN private.burimunsi_device_grants g ON g.id=c.grant_id AND g.version=c.grant_version
    AND g.installation_id=c.installation_id AND g.collection_id=c.collection_id AND g.active
  JOIN private.burimunsi_device_accounts link ON link.grant_id=g.id AND link.account_id=a.id
    AND link.collection_id=c.collection_id
  LEFT JOIN private.burimunsi_inbox_checks x ON x.collection_id=c.collection_id AND x.installation_id=c.installation_id
    AND x.account_id=c.account_id AND x.grant_id=c.grant_id AND x.grant_version=c.grant_version
    AND x.consent_generation=c.generation
  WHERE c.collection_id=p_collection AND c.enabled
 ), checked AS MATERIALIZED (
  SELECT h.*,CASE WHEN state='verified' THEN
    private._burimunsi_handset_inventory(p_collection,account_id,principal_user_id,installation_id)
  END AS inventory FROM handsets h
 ), evidence AS (
  SELECT *,
   CASE WHEN state='verified' AND (
      inventory->>'revision' IS NULL OR inventory->>'revision' IS DISTINCT FROM report->>'collectionRevision'
      OR inventory->'hasPending' IS DISTINCT FROM 'false'::jsonb
      OR inventory->'hasUnmatchedCanonical' IS DISTINCT FROM 'false'::jsonb
      OR inventory->'recordedCount' IS DISTINCT FROM report->'candidateCount'
   ) THEN 'stale' ELSE coalesce(state,'unknown') END AS current_state
  FROM checked
 ), metrics AS (
  SELECT current_state,checked_at,
    CASE WHEN current_state IN ('verified','incomplete') THEN (report->>'candidateCount')::bigint END AS candidates,
    CASE WHEN current_state IN ('verified','incomplete') THEN (report->>'missingCount')::bigint END AS missing,
    CASE WHEN current_state IN ('verified','incomplete') THEN (report->>'pendingCount')::bigint END AS pending,
    CASE WHEN current_state='verified' AND (report->>'candidateCount')::bigint=0 THEN true
         WHEN current_state IN ('verified','incomplete') AND report->>'phoneLatestKey' IS NOT NULL
         THEN (report->>'phoneLatestKey') IS NOT DISTINCT FROM (report->>'parsedLatestKey') END AS matched
  FROM evidence
 )
 SELECT jsonb_build_object(
  'state',CASE WHEN bool_or(current_state IN ('stale','incomplete')) THEN 'incomplete'
               WHEN bool_or(current_state='checking') THEN 'checking'
               WHEN count(*)>0 AND bool_and(current_state='verified') THEN 'verified' ELSE 'unknown' END,
  'checkedAt',CASE WHEN count(checked_at)=count(*) THEN min(checked_at) END,
  'candidateCount',CASE WHEN count(candidates)=count(*) THEN sum(candidates) END,
  'missingCount',CASE WHEN count(missing)=count(*) THEN sum(missing) END,
  'pendingCount',CASE WHEN count(pending)=count(*) THEN sum(pending) END,
  'headsMatch',CASE WHEN bool_or(NOT matched) THEN false WHEN count(matched)=count(*) THEN bool_and(matched) END
 ) INTO result FROM metrics;

 PERFORM set_config('burimunsi.collection_id',coalesce(prior_group,''),true);
 PERFORM set_config('burimunsi.native_receipt_frame',coalesce(prior_native,''),true);
 PERFORM set_config('burimunsi.inbox_frame',coalesce(prior_inbox,''),true);
 PERFORM set_config('burimunsi.pin_frame',coalesce(prior_pin,''),true);
 PERFORM set_config('burimunsi.observation_frame',coalesce(prior_observation,''),true);
 RETURN result;
END;$fn$;
REVOKE ALL ON FUNCTION private.burimunsi_observation_admin_inbox_check(text)
 FROM PUBLIC,anon,authenticated,service_role,collect_importer;
GRANT EXECUTE ON FUNCTION private.burimunsi_observation_admin_inbox_check(text) TO collect_runtime;
COMMIT;
