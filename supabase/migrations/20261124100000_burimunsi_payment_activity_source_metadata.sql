-- The feed pages payments and evidence together. Keep the native admission
-- population, including sources still awaiting storage, behind its existing
-- collection-specific reader. Return metadata only.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $check$
BEGIN
  PERFORM private._collect_fence_require_operator();
  IF NOT EXISTS (SELECT 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced') THEN
    RAISE EXCEPTION 'burimunsi_payment_activity_requires_fence' USING ERRCODE='55000';
  END IF;
END;
$check$;

CREATE FUNCTION private.burimunsi_payment_activity_sources(p_collection text,p_financial boolean,p_observations boolean)
RETURNS TABLE(kind text,source_id text,occurred_at timestamptz,status text,account_id text,source_digest text,
              payment_reference text,payer_status text,payer_reason text,reservation jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE
  actor jsonb;
  phone jsonb:=private.burimunsi_browser_pin_context();
  prior_collection text:=current_setting('burimunsi.collection_id',true);
  prior_native text:=current_setting('burimunsi.native_receipt_frame',true);
BEGIN
  IF p_financial IS NULL OR p_observations IS NULL THEN
    RAISE EXCEPTION 'invalid_activity_source_filter' USING ERRCODE='22023';
  END IF;
  actor:=private.burimunsi_observation_admin_scope(p_collection,false);
  IF p_collection IS NULL OR phone->>'collectionId' IS DISTINCT FROM p_collection
     OR coalesce(phone->>'operatorRole','')<>'admin' OR phone->>'principalId' IS NULL
     OR phone->>'principalId' IS DISTINCT FROM actor->>'principalId' THEN
    RAISE EXCEPTION 'payment_activity_source_denied' USING ERRCODE='42501';
  END IF;
  IF p_financial AND private.assert_actor('payments.read',NULL,NULL,1,NULL) IS DISTINCT FROM actor->>'principalId' THEN
    RAISE EXCEPTION 'payment_activity_read_required' USING ERRCODE='42501';
  END IF;
  PERFORM set_config('burimunsi.collection_id',p_collection,true);
  RETURN QUERY
    SELECT 'capture'::text,s.id,s.created_at::timestamptz,s.status,sc.receiving_account_id,s.body_sha256,
           NULL::text,NULL::text,NULL::text,NULL::jsonb
    FROM private.burimunsi_sms_source_scopes sc JOIN app.sms_receipts s
      ON s.id=sc.source_id AND sc.owner_user_id=s.owner_user_id
     AND sc.source_body_sha256=s.body_sha256 AND sc.object_sha256=s.object_sha256
    WHERE sc.collection_id=p_collection AND s.originating_session_id IS NOT NULL AND s.evidence_level='client_received';
  IF p_observations THEN
    PERFORM set_config('burimunsi.native_receipt_frame','1',true);
    -- Processing accepts at most 100 exact source IDs per call. Evaluate it in
    -- batches over this snapshot, so older receipts can still match a filter.
    RETURN QUERY
      WITH records AS MATERIALIZED (
        SELECT r.*,((row_number() OVER (ORDER BY r.source_id))-1)/100 AS batch
        FROM private.burimunsi_observation_admin_rows(p_collection) r
      ), batches AS (
        SELECT array_agg(r.source_id ORDER BY r.source_id) AS ids FROM records r GROUP BY r.batch
      ), outcomes AS MATERIALIZED (
        SELECT item FROM batches b CROSS JOIN LATERAL
          jsonb_array_elements(private.burimunsi_admin_observation_outcomes(p_collection,b.ids,p_financial)) result(item)
      )
      SELECT 'receiver_sms'::text,r.source_id,to_timestamp(r.admitted_at / 1000.0),
             CASE WHEN r.retention_state='unresolved' AND o.item->>'processing'='pending' THEN 'unresolved'
                  ELSE o.item->>'processing' END,j.receiving_account_id,r.body_sha256,
             o.item->>'paymentReference',o.item->>'payerStatus',o.item->>'payerReason',
             CASE WHEN r.retention_state='retained' THEN jsonb_build_object(
                'sourceId',r.source_id,'ownerUserId',r.owner_user_id,'objectKey',r.object_key,
                'objectSha256',r.object_sha256,'fingerprint',r.fingerprint,'keyId',r.key_id,
                'sourceFingerprint',r.source_fingerprint,'bodySha256',r.body_sha256) END
      FROM records r JOIN outcomes o ON o.item->>'sourceId'=r.source_id
      LEFT JOIN private.burimunsi_auto_sms_jobs j ON j.source_id=r.source_id AND j.collection_id=p_collection;
    PERFORM set_config('burimunsi.native_receipt_frame',coalesce(prior_native,''),true);
  END IF;
  PERFORM set_config('burimunsi.collection_id',coalesce(prior_collection,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('burimunsi.native_receipt_frame',coalesce(prior_native,''),true);
  PERFORM set_config('burimunsi.collection_id',coalesce(prior_collection,''),true);
  RAISE;
END;
$body$;
REVOKE ALL ON FUNCTION private.burimunsi_payment_activity_sources(text,boolean,boolean)
  FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;
GRANT EXECUTE ON FUNCTION private.burimunsi_payment_activity_sources(text,boolean,boolean) TO collect_runtime;
-- A managed MoMo record can be scoped before it has a payment. This
-- financial-only projection keeps Staff independent of the Admin SMS reader.
CREATE FUNCTION private.burimunsi_payment_activity_transactions(p_collection text)
RETURNS TABLE(transaction_id text,account_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE
  actor jsonb:=private.burimunsi_browser_pin_context();
  prior_collection text:=current_setting('burimunsi.collection_id',true);
BEGIN
  IF p_collection IS NULL OR actor->>'collectionId' IS DISTINCT FROM p_collection
     OR coalesce(actor->>'operatorRole','') NOT IN ('admin','staff')
     OR actor->>'principalId' IS NULL OR private.assert_actor('payments.read',NULL,NULL,1,NULL) IS DISTINCT FROM actor->>'principalId' THEN
    RAISE EXCEPTION 'payment_activity_read_required' USING ERRCODE='42501';
  END IF;
  PERFORM set_config('burimunsi.collection_id',p_collection,true);
  RETURN QUERY SELECT s.transaction_id,s.receiving_account_id FROM private.burimunsi_transaction_scopes s
    WHERE s.collection_id=p_collection;
  PERFORM set_config('burimunsi.collection_id',coalesce(prior_collection,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('burimunsi.collection_id',coalesce(prior_collection,''),true);
  RAISE;
END;
$body$;
REVOKE ALL ON FUNCTION private.burimunsi_payment_activity_transactions(text)
  FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime;
GRANT EXECUTE ON FUNCTION private.burimunsi_payment_activity_transactions(text) TO collect_runtime;
COMMIT;
