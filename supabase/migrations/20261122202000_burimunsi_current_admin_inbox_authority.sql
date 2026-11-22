-- A physical app installation contributes one Admin inbox. Its authenticated
-- phone/PIN sign-in determines the current account even after an account switch.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';
DO $preflight$
BEGIN
 PERFORM private._collect_fence_require_operator();
 IF NOT EXISTS(SELECT 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced')
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='private.burimunsi_observation_admin_inbox_check(text)'::regprocedure
   AND pg_get_userbyid(p.proowner)='postgres' AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='4b5ed5da8923fe7cce5dabe7e8cceff38b195ff355f3794e238c788e097757e5') THEN
  RAISE EXCEPTION 'admin_inbox_authority_precondition' USING ERRCODE='55000';END IF;
END;$preflight$;

-- Existing immutable links keep their original timestamps. Future PIN logins
-- already serialize on the installation grant before inserting this link.
-- A rolled-back login can leave a sequence gap but no sign-in evidence.
CREATE SEQUENCE private.burimunsi_handset_signin_order AS bigint;
ALTER TABLE private.burimunsi_pin_session_links ADD COLUMN handset_signin_order bigint CHECK(handset_signin_order>0);
ALTER SEQUENCE private.burimunsi_handset_signin_order OWNED BY private.burimunsi_pin_session_links.handset_signin_order;
ALTER TABLE private.burimunsi_pin_session_links ALTER COLUMN handset_signin_order
 SET DEFAULT nextval('private.burimunsi_handset_signin_order'::regclass);
REVOKE ALL ON SEQUENCE private.burimunsi_handset_signin_order FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;
CREATE INDEX burimunsi_handset_pin_signins ON private.burimunsi_sessions(collection_id,grant_id,installation_id,id)
 WHERE auth_method='phone_pin';

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

 WITH eligible AS MATERIALIZED (
  SELECT c.installation_id,c.grant_id,c.grant_version,c.generation,c.account_id,a.principal_user_id,scope.version AS scope_version,root.authority
  FROM private.burimunsi_observation_consents c
  JOIN private.burimunsi_accounts a ON a.id=c.account_id AND a.collection_id=c.collection_id
    AND a.active AND NOT a.removed AND a.role='admin'
  JOIN private.burimunsi_device_grants g ON g.id=c.grant_id AND g.version=c.grant_version
    AND g.installation_id=c.installation_id AND g.collection_id=c.collection_id AND g.active
  JOIN private.burimunsi_device_accounts d ON d.grant_id=g.id AND d.account_id=a.id AND d.collection_id=c.collection_id
  JOIN private.burimunsi_scopes scope ON scope.collection_id=c.collection_id
  CROSS JOIN LATERAL (SELECT private.burimunsi_pin_root_snapshot(a.collection_id,a.principal_user_id,a.phone,a.role,a.capabilities) AS authority) root
  WHERE c.collection_id=p_collection AND c.enabled AND root.authority IS NOT NULL
 ), devices AS MATERIALIZED (
  SELECT DISTINCT installation_id,grant_id,grant_version FROM eligible
 ), current_login AS MATERIALIZED (
  SELECT d.*,last_login.all_accounts,last_login.signed_in_accounts,last_login.live_accounts,last_login.signed_at
  FROM devices d CROSS JOIN LATERAL (
   SELECT max(last.created_at) AS signed_at,array_agg(DISTINCT last.account_id) AS all_accounts,
    array_agg(DISTINCT last.account_id) FILTER(WHERE NOT last.revoked) AS signed_in_accounts,
    array_agg(DISTINCT last.account_id) FILTER(WHERE NOT last.revoked AND last.current_credential) AS live_accounts
   FROM (
    SELECT s.account_id,l.created_at,s.revoked,s.grant_version=d.grant_version AND s.credential_version=a.credential_version
      AND l.account_version=a.version AND l.scope_version=e.scope_version AND l.authority_snapshot=e.authority AS current_credential
    FROM private.burimunsi_sessions s
    JOIN private.burimunsi_pin_session_links l ON l.native_session_id=s.id AND l.collection_id=s.collection_id
     AND l.account_id=s.account_id AND l.principal_user_id=s.principal_user_id AND l.created_at=s.created_at
    JOIN private.burimunsi_accounts a ON a.id=s.account_id AND a.collection_id=s.collection_id AND a.principal_user_id=s.principal_user_id
    LEFT JOIN eligible e ON e.installation_id=d.installation_id AND e.grant_id=d.grant_id AND e.account_id=s.account_id
    WHERE s.collection_id=p_collection AND s.installation_id=d.installation_id AND s.grant_id=d.grant_id AND s.auth_method='phone_pin'
    ORDER BY l.handset_signin_order DESC NULLS LAST,l.created_at DESC FETCH FIRST 1 ROW WITH TIES
   ) last
  ) last_login
 ), handsets AS MATERIALIZED (
  SELECT e.installation_id,e.account_id,e.principal_user_id,x.state,x.checked_at,x.report
  FROM current_login d JOIN eligible e ON e.installation_id=d.installation_id AND e.grant_id=d.grant_id
   AND cardinality(d.all_accounts)=1 AND e.account_id=ANY(d.signed_in_accounts)
  LEFT JOIN private.burimunsi_inbox_checks x ON x.collection_id=p_collection AND x.installation_id=e.installation_id
    AND x.account_id=e.account_id AND x.grant_id=e.grant_id AND x.grant_version=e.grant_version AND x.consent_generation=e.generation
    AND x.checked_at>=d.signed_at AND e.account_id=ANY(d.live_accounts)
  UNION ALL
  -- Missing sign-in evidence or a tied historical login cannot select another
  -- account's saved sweep. Count the installation once with an unknown result.
  SELECT d.installation_id,NULL::uuid,NULL::text,NULL::text,NULL::bigint,NULL::jsonb FROM current_login d
   WHERE d.all_accounts IS NULL OR cardinality(d.all_accounts)>1 AND EXISTS(
    SELECT 1 FROM eligible e WHERE e.installation_id=d.installation_id AND e.grant_id=d.grant_id AND e.account_id=ANY(d.signed_in_accounts))
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
