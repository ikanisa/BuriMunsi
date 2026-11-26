-- Browser Home reads the same verified wallet SMS balance as Android.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $guard$
BEGIN
  PERFORM private._collect_fence_require_operator();
  IF NOT EXISTS (SELECT FROM private.collect_fence_control WHERE singleton AND mode='fenced')
    OR EXISTS (SELECT FROM collect_ops.jobs_config WHERE singleton AND enabled)
    OR EXISTS (SELECT FROM collect_ops.jobs_dispatches WHERE state IN ('awaiting','unconfirmed')) THEN
    RAISE EXCEPTION 'burimunsi_admin_home_balance_requires_fence' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT FROM pg_proc
    WHERE oid=to_regprocedure('private.burimunsi_home_savings(text)') AND prosecdef AND proowner='postgres'::regrole
      AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='464abd96b7560ef82a7aa386d781a5f60afd72fc4b1d1b4d7f5dea615169c7d8'
  ) THEN
    RAISE EXCEPTION 'burimunsi_admin_home_balance_predecessor_changed' USING ERRCODE='55000';
  END IF;
END;
$guard$;

-- Owner-only. The two entry points prove their own callers before using it.
CREATE FUNCTION private._burimunsi_latest_wallet_sms_balance(p_collection text,p_receiving_account text)
RETURNS TABLE(observed_at timestamptz,balance numeric)
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $wallet$
  WITH wallet_payments AS MATERIALIZED (
    SELECT p.id,p.collection_id,p.receiving_account_id,p.sms_source_id,p.direction,p.occurred_at
    FROM burimunsi.payments p
    JOIN app.momo_receiving_accounts w ON w.id=p_receiving_account AND w.currency='RWF' AND w.status='active'
    WHERE p.collection_id=p_collection AND p.receiving_account_id=p_receiving_account
      AND p.occurred_at<=statement_timestamp()
  ), observations AS (
    SELECT v.balance_rwf,p.occurred_at
    FROM wallet_payments p
    JOIN private.burimunsi_payment_wallet_observations v ON v.payment_id=p.id AND v.source_id=p.sms_source_id
      AND v.observed_at=p.occurred_at
    JOIN private.burimunsi_auto_sms_jobs j ON j.payment_id=p.id AND j.source_id=v.source_id
      AND j.collection_id=p.collection_id AND j.receiving_account_id=p.receiving_account_id AND j.facts_sha256=v.facts_sha256
    WHERE v.balance_rwf IS NOT NULL AND j.state='completed' AND j.phase='finished' AND j.relation='accepted'
      AND j.payment_outcome='successful'
      AND NOT EXISTS (SELECT FROM private.burimunsi_auto_sms_jobs bad
        WHERE bad.payment_id=p.id AND bad.collection_id=p.collection_id AND bad.receiving_account_id=p.receiving_account_id
          AND bad.state='completed' AND bad.relation='conflict')
    UNION ALL
    SELECT t.wallet_balance_after_minor,p.occurred_at
    FROM wallet_payments p
    JOIN private.burimunsi_transaction_scopes x ON x.transaction_id=p.id AND x.collection_id=p.collection_id
      AND x.receiving_account_id=p.receiving_account_id AND x.native_source_id=p.sms_source_id
    JOIN app.momo_transactions t ON t.id=x.transaction_id AND t.receiving_account_id=x.receiving_account_id
    JOIN app.momo_parse_attempts a ON a.id=t.parse_attempt_id AND a.outcome='accepted'
    JOIN app.momo_transaction_sources link ON link.transaction_id=t.id AND link.parse_attempt_id=a.id
      AND link.raw_sms_id=a.raw_sms_id AND link.raw_sms_id=p.sms_source_id AND link.relation='accepted'
    JOIN app.sms_receipts r ON r.id=link.raw_sms_id AND r.body_sha256=a.source_body_sha256
    WHERE t.currency='RWF' AND t.currency_scale=0 AND t.has_conflict=0
      AND t.event_kind=CASE p.direction WHEN 'incoming' THEN 'incoming_receipt' ELSE 'outgoing' END
      AND t.transaction_time_source='sms_body_and_provider_profile'
      AND t.wallet_balance_after_minor BETWEEN 0 AND 9007199254740991
      AND CASE WHEN t.transaction_at ~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
        AND pg_input_is_valid(t.transaction_at,'timestamp with time zone') THEN t.transaction_at::timestamptz=p.occurred_at ELSE false END
      AND NOT EXISTS (SELECT FROM app.momo_transaction_sources bad WHERE bad.transaction_id=t.id AND bad.relation='conflict')
  )
  SELECT max(o.occurred_at) AS observed_at,
    CASE WHEN min(o.balance_rwf)=max(o.balance_rwf) THEN min(o.balance_rwf)::numeric END AS balance
  FROM observations o WHERE o.occurred_at=(SELECT max(v.occurred_at) FROM observations v)
$wallet$;
REVOKE ALL ON FUNCTION private._burimunsi_latest_wallet_sms_balance(text,text)
  FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime,collect_sms_runtime;

CREATE OR REPLACE FUNCTION private.burimunsi_home_savings(p_collection text)
RETURNS TABLE(lifetime_contributions_rwf numeric,latest_wallet_balance_rwf numeric,reconciliation_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $home$
DECLARE actor record;
BEGIN
  PERFORM private._collect_fence_require_runtime();
  SELECT * INTO actor FROM private.burimunsi_pin_context();
  IF NOT FOUND OR p_collection IS DISTINCT FROM actor.collection_id
    OR p_collection IS DISTINCT FROM current_setting('burimunsi.collection_id',true)
    OR ('records.read'=ANY(actor.capabilities)) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'burimunsi_home_savings_denied' USING ERRCODE='42501';
  END IF;

  RETURN QUERY WITH scope AS MATERIALIZED (
    SELECT s.collection_id,s.receiving_account_id
    FROM private.burimunsi_scopes s JOIN app.collections c ON c.id=s.collection_id AND c.status='active'
    WHERE s.collection_id=p_collection AND c.currency='RWF'
  ), effective_contributions AS MATERIALIZED (
    SELECT l.amount_minor,l.member_id,p.id AS legacy_payment_id
    FROM scope s
    JOIN app.ledger_entries l ON l.collection_id=s.collection_id AND l.kind='contribution' AND l.amount_minor>0 AND l.currency='RWF'
    JOIN app.payments p ON p.id=l.payment_id AND p.collection_id=l.collection_id
      AND p.status IN ('reconciled','confirmed') AND p.member_id=l.member_id AND p.amount_minor=l.amount_minor
      AND p.evidence_id=l.evidence_id AND p.currency=l.currency
    JOIN app.memberships m ON m.collection_id=l.collection_id AND m.user_id=l.member_id
    WHERE NOT EXISTS (SELECT FROM app.ledger_entries inverse WHERE inverse.reverses_entry_id=l.id)
  ), contributions AS (
    SELECT sum(c.amount_minor) AS total FROM effective_contributions c
  ), wallet_payments AS MATERIALIZED (
    SELECT p.id,p.collection_id,p.receiving_account_id,p.sms_source_id,p.direction,p.amount_rwf,p.member_id,p.occurred_at
    FROM scope s JOIN app.momo_receiving_accounts w ON w.id=s.receiving_account_id AND w.currency='RWF' AND w.status='active'
    JOIN burimunsi.payments p ON p.collection_id=s.collection_id AND p.receiving_account_id=s.receiving_account_id
    WHERE p.occurred_at<=statement_timestamp()
  ), latest AS (
    SELECT wallet.*
    FROM private._burimunsi_latest_wallet_sms_balance(
      p_collection,(SELECT receiving_account_id FROM scope)) wallet
  ), comparison AS (
    SELECT q.closing_rwf
    FROM latest l
    JOIN scope s ON l.balance IS NOT NULL
    JOIN private.burimunsi_home_reconciliation_checkpoints q ON q.collection_id=s.collection_id
      AND q.receiving_account_id=s.receiving_account_id AND q.closed_at=l.observed_at
    CROSS JOIN contributions c
    CROSS JOIN LATERAL private._burimunsi_home_statement_basis(
      q.collection_id,q.receiving_account_id,q.opened_at,q.closed_at) b
    WHERE b.complete_scope AND b.movement_count=q.movement_count AND b.movements_sha256=q.movements_sha256
      AND b.incoming_rwf=q.incoming_rwf AND b.outgoing_rwf=q.outgoing_rwf AND c.total=q.incoming_rwf
      -- The existing wire comparison has no opening, fee or reversal term.
      AND q.opening_rwf-q.fees_rwf+q.reversal_credits_rwf-q.reversal_debits_rwf=0
      AND q.fees_rwf>=coalesce((SELECT sum(v.fee_rwf) FROM wallet_payments p
        JOIN private.burimunsi_payment_wallet_observations v ON v.payment_id=p.id AND v.source_id=p.sms_source_id
          AND v.observed_at=p.occurred_at),0)
      AND NOT EXISTS (SELECT FROM wallet_payments p WHERE p.direction='incoming' AND NOT EXISTS (
        SELECT FROM app.momo_financial_links f JOIN effective_contributions posted ON posted.legacy_payment_id=f.payment_id
        WHERE f.transaction_id=p.id AND posted.amount_minor=p.amount_rwf
          AND posted.member_id=p.member_id AND f.beneficiary_member_id=posted.member_id))
  )
  SELECT CASE WHEN c.total BETWEEN 0 AND 9007199254740991 THEN c.total END,l.balance,
    CASE WHEN v.closing_rwf IS NULL THEN 'unavailable' WHEN v.closing_rwf=l.balance THEN 'reconciled' ELSE 'mismatch' END
  FROM contributions c CROSS JOIN latest l LEFT JOIN comparison v ON true;
END;
$home$;
CREATE FUNCTION private.burimunsi_admin_home_sms_balance(p_collection text)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $admin$
DECLARE actor jsonb:=private.burimunsi_browser_pin_context();
BEGIN
  PERFORM private._collect_fence_require_runtime();
  PERFORM private._burimunsi_assert_browser_sms_payments_read(p_collection);
  IF p_collection IS DISTINCT FROM current_setting('burimunsi.collection_id',true)
    OR private.burimunsi_browser_pin_assert_actor('sms.read',NULL,NULL,1,NULL) IS DISTINCT FROM actor->>'principalId'
    OR NOT EXISTS (
      SELECT FROM private.burimunsi_accounts a
      WHERE a.collection_id=p_collection AND a.id=(actor->>'accountId')::uuid
        AND a.principal_user_id=actor->>'principalId' AND a.role='admin' AND a.active AND NOT a.removed
        AND a.capabilities @> ARRAY['records.read','sms.read']
    ) THEN
    RAISE EXCEPTION 'burimunsi_admin_home_balance_denied' USING ERRCODE='42501';
  END IF;
  RETURN (
    SELECT wallet.balance
    FROM private.burimunsi_scopes s JOIN app.collections c ON c.id=s.collection_id AND c.status='active' AND c.currency='RWF'
    CROSS JOIN LATERAL private._burimunsi_latest_wallet_sms_balance(s.collection_id,s.receiving_account_id) wallet
    WHERE s.collection_id=p_collection
  );
END;
$admin$;
REVOKE ALL ON FUNCTION private.burimunsi_admin_home_sms_balance(text)
  FROM PUBLIC,anon,authenticated,service_role,collect_importer,collect_runtime,collect_sms_runtime;
GRANT EXECUTE ON FUNCTION private.burimunsi_admin_home_sms_balance(text) TO collect_runtime;

COMMIT;
