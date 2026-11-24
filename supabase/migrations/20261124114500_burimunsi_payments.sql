-- BuriMunsi stores incoming and outgoing M-Money payments in one table.
-- Captured SMS and allocation are independently scoped to the same group.
CREATE SCHEMA burimunsi AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA burimunsi FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA burimunsi TO collect_runtime;

CREATE TABLE burimunsi.raw_sms (
  id text PRIMARY KEY REFERENCES private.burimunsi_unresolved_observations(source_id) ON DELETE CASCADE,
  collection_id text NOT NULL REFERENCES private.burimunsi_scopes(collection_id),
  object_sha256 text NOT NULL CHECK (object_sha256 ~ '^[a-f0-9]{64}$'),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 1048576),
  stored_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE burimunsi.payments (
  id text PRIMARY KEY,
  collection_id text NOT NULL REFERENCES private.burimunsi_scopes(collection_id),
  receiving_account_id text NOT NULL REFERENCES app.momo_receiving_accounts(id),
  provider text NOT NULL,
  provider_reference text CHECK (provider_reference IS NULL OR
    (char_length(provider_reference) BETWEEN 1 AND 160 AND provider_reference !~ '[[:space:]]')),
  direction text NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  amount_rwf bigint NOT NULL CHECK (amount_rwf BETWEEN 1 AND 9007199254740991),
  occurred_at timestamptz,
  source_time text NOT NULL DEFAULT '',
  counterparty_name text,
  counterparty_identifier text,
  sms_source_id text UNIQUE REFERENCES app.sms_receipts(id) ON DELETE SET NULL,
  member_id text,
  allocation_state text GENERATED ALWAYS AS
    (CASE WHEN member_id IS NULL THEN 'unallocated' ELSE 'allocated' END) STORED,
  version bigint NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (collection_id, member_id) REFERENCES app.memberships(collection_id, user_id)
);

CREATE UNIQUE INDEX burimunsi_payments_provider_reference
  ON burimunsi.payments(collection_id, receiving_account_id, provider, provider_reference)
  WHERE provider_reference IS NOT NULL;
CREATE INDEX burimunsi_payments_recent
  ON burimunsi.payments(collection_id, (coalesce(occurred_at, created_at)) DESC, id DESC);
CREATE INDEX burimunsi_payments_member
  ON burimunsi.payments(collection_id, member_id);

-- Carry forward source-backed payments and established member assignments.
-- The former receipt and payment IDs remain usable for existing links.
WITH scoped AS (
  SELECT t.*, s.collection_id, s.native_source_id, j.posting_facts AS facts,
    m.user_id AS assigned_member
  FROM private.burimunsi_transaction_scopes s
  JOIN app.momo_transactions t ON t.id = s.transaction_id AND t.receiving_account_id = s.receiving_account_id
  LEFT JOIN private.burimunsi_auto_sms_jobs j ON j.source_id = s.native_source_id AND j.collection_id = s.collection_id
  LEFT JOIN app.momo_financial_links f ON f.transaction_id = t.id
  LEFT JOIN app.payments old ON old.id = f.payment_id AND old.collection_id = s.collection_id
    AND old.member_id = f.beneficiary_member_id AND old.status IN ('confirmed', 'reconciled')
  LEFT JOIN app.memberships m ON m.collection_id = s.collection_id AND m.user_id = old.member_id
), validated AS (
  SELECT *,
    coalesce(facts->>'event_kind', event_kind) AS payment_kind,
    coalesce(facts->>'currency', currency) AS payment_currency,
    coalesce(facts->>'amount_minor', amount_minor::text) AS payment_amount,
    coalesce(facts->>'transaction_at', transaction_at) AS payment_time,
    coalesce(facts->>'provider_transaction_id', provider_transaction_id) AS reference
  FROM scoped
  WHERE (facts->>'payment_outcome' = 'successful')
    OR (facts->>'payment_outcome' IS NULL AND event_kind IN ('incoming_receipt', 'outgoing'))
)
INSERT INTO burimunsi.payments (
  id, collection_id, receiving_account_id, provider, provider_reference, direction, amount_rwf,
  occurred_at, source_time, counterparty_name, counterparty_identifier, sms_source_id,
  member_id, version, created_at, updated_at
)
SELECT id, collection_id, receiving_account_id, provider,
  CASE WHEN reference ~ '^[^[:space:]]{1,160}$' THEN reference END,
  CASE payment_kind WHEN 'incoming_receipt' THEN 'incoming' ELSE 'outgoing' END,
  payment_amount::bigint,
  CASE WHEN payment_time ~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
    AND pg_input_is_valid(payment_time, 'timestamp with time zone') THEN payment_time::timestamptz END,
  coalesce(facts->>'transaction_datetime_raw', transaction_datetime_raw, ''),
  coalesce(facts->>'counterparty_name', payer_name),
  coalesce(facts->>'counterparty_identifier', payer_identifier),
  native_source_id,
  assigned_member, version, created_at::timestamptz, updated_at::timestamptz
FROM validated
WHERE payment_kind IN ('incoming_receipt', 'outgoing') AND payment_currency = 'RWF'
  AND CASE WHEN pg_input_is_valid(payment_amount, 'bigint')
    THEN payment_amount::bigint BETWEEN 1 AND 9007199254740991 ELSE false END;

ALTER TABLE burimunsi.raw_sms ENABLE ROW LEVEL SECURITY;
ALTER TABLE burimunsi.raw_sms FORCE ROW LEVEL SECURITY;
ALTER TABLE burimunsi.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE burimunsi.payments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA burimunsi FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON burimunsi.raw_sms TO collect_runtime;
GRANT SELECT, INSERT, UPDATE (member_id, version, updated_at) ON burimunsi.payments TO collect_runtime;
CREATE POLICY burimunsi_raw_sms_scope ON burimunsi.raw_sms TO collect_runtime
  USING (collection_id = nullif(current_setting('burimunsi.collection_id', true), ''))
  WITH CHECK (collection_id = nullif(current_setting('burimunsi.collection_id', true), ''));
CREATE POLICY burimunsi_payments_scope ON burimunsi.payments TO collect_runtime
  USING (collection_id = nullif(current_setting('burimunsi.collection_id', true), ''))
  WITH CHECK (collection_id = nullif(current_setting('burimunsi.collection_id', true), ''));

-- Close the legacy write path for this product, including older loaded code.
CREATE FUNCTION private.burimunsi_block_legacy_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
BEGIN
  IF EXISTS (SELECT 1 FROM private.burimunsi_scopes s WHERE s.collection_id = NEW.collection_id) THEN
    RAISE EXCEPTION 'burimunsi_payments_only' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$body$;
REVOKE ALL ON FUNCTION private.burimunsi_block_legacy_entry() FROM PUBLIC, anon, authenticated, service_role, collect_runtime;
CREATE TRIGGER burimunsi_payments_only
  BEFORE INSERT ON app.ledger_entries FOR EACH ROW EXECUTE FUNCTION private.burimunsi_block_legacy_entry();
