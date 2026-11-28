-- Synthetic prerequisites for the actual payments migration. Never run on hosted DBs.
CREATE ROLE postgres SUPERUSER;
CREATE ROLE anon LOGIN;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE ROLE collect_runtime LOGIN;
SET ROLE postgres;
CREATE SCHEMA app;
CREATE SCHEMA private;
CREATE TABLE private.burimunsi_scopes(collection_id text PRIMARY KEY);
CREATE TABLE app.momo_receiving_accounts(id text PRIMARY KEY);
CREATE TABLE app.sms_receipts(id text PRIMARY KEY);
CREATE TABLE private.burimunsi_unresolved_observations(source_id text PRIMARY KEY);
CREATE TABLE app.memberships(collection_id text, user_id text, PRIMARY KEY(collection_id, user_id));
CREATE TABLE app.momo_transactions(id text, receiving_account_id text, provider text,
  provider_transaction_id text, event_kind text, currency text, amount_minor bigint, transaction_at text,
  transaction_datetime_raw text, payer_name text, payer_identifier text, version bigint,
  created_at text, updated_at text);
CREATE TABLE private.burimunsi_transaction_scopes(transaction_id text, collection_id text,
  receiving_account_id text, native_source_id text);
CREATE TABLE private.burimunsi_auto_sms_jobs(source_id text, collection_id text, posting_facts jsonb);
CREATE TABLE app.momo_financial_links(transaction_id text, payment_id text, beneficiary_member_id text);
CREATE TABLE app.payments(id text, collection_id text, member_id text, status text);
CREATE TABLE app.ledger_entries(collection_id text, amount bigint);
INSERT INTO private.burimunsi_scopes VALUES ('group-a'), ('group-b');
INSERT INTO app.momo_receiving_accounts VALUES ('wallet-a'), ('wallet-b');
INSERT INTO app.sms_receipts VALUES ('new-sms'), ('old-sms'), ('other-sms');
INSERT INTO private.burimunsi_unresolved_observations VALUES ('new-sms'), ('old-sms'), ('other-sms');
