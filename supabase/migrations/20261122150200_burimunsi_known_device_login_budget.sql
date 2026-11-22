BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
DO $preflight$
BEGIN
  PERFORM private._collect_fence_require_operator();
  IF NOT EXISTS (SELECT 1 FROM private.collect_fence_control WHERE singleton AND mode='fenced') THEN
    RAISE EXCEPTION 'burimunsi_login_budget_fence_required';
  END IF;
END $preflight$;

-- A returning installation proves possession of its previously registered
-- device credential before it gets its own direct-ingress capacity. The
-- existing account and installation limits apply to every attempt.
CREATE FUNCTION private.burimunsi_pin_login_account(
  p_phone text, p_phone_hash text, p_installation uuid, p_network_hash text, p_now_ms bigint,
  p_device_token_hash text, p_profile text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $function$
DECLARE
  prior_frame text:=current_setting('burimunsi.pin_frame',true);
  effective_network text:=p_network_hash;
  direct_network constant text:=encode(sha256(convert_to(
    'collect.native.supabase-direct.global-budget.v1|https://rrlduytparvsjfmegalh.supabase.co','UTF8')),'hex');
BEGIN
  PERFORM private.burimunsi_setup_fence();
  IF p_network_hash=direct_network AND p_device_token_hash ~ '^[a-f0-9]{64}$'
     AND p_profile IN ('staff','internal_receiver') THEN
    PERFORM set_config('burimunsi.pin_frame','1',true);
    IF EXISTS (
      SELECT 1 FROM private.burimunsi_device_grants d
      JOIN private.burimunsi_device_accounts da ON da.grant_id=d.id AND da.collection_id=d.collection_id
      JOIN private.burimunsi_accounts a ON a.id=da.account_id AND a.collection_id=da.collection_id
      WHERE d.installation_id=p_installation AND d.token_hash=p_device_token_hash AND d.profile=p_profile
        AND d.active AND a.active AND NOT a.removed AND a.phone=p_phone
    ) THEN
      effective_network:=encode(sha256(convert_to('burimunsi.registered-device.v1|'||p_installation::text,'UTF8')),'hex');
    END IF;
    PERFORM set_config('burimunsi.pin_frame',coalesce(prior_frame,''),true);
  END IF;
  RETURN private.burimunsi_pin_login_account(p_phone,p_phone_hash,p_installation,effective_network,p_now_ms);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('burimunsi.pin_frame',coalesce(prior_frame,''),true);
  RAISE;
END $function$;
REVOKE ALL ON FUNCTION private.burimunsi_pin_login_account(text,text,uuid,text,bigint,text,text)
  FROM PUBLIC,anon,authenticated,service_role,collect_runtime,collect_importer;
GRANT EXECUTE ON FUNCTION private.burimunsi_pin_login_account(text,text,uuid,text,bigint,text,text) TO collect_runtime;
COMMIT;
