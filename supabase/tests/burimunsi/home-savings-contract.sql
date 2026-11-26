-- Run only in a new socket-only PG17 fixture named collect_home_savings_fixture.
-- psql -X -v source_root=/absolute/BuriMunsi -f supabase/tests/burimunsi/home-savings-contract.sql
\set ON_ERROR_STOP on
DO $guard$
BEGIN
  IF current_setting('cluster_name')<>'collect_home_savings_fixture'
    OR inet_server_addr() IS NOT NULL OR session_user<>'collect_fixture' THEN
    RAISE EXCEPTION 'Disposable Home savings fixture required';
  END IF;
END;
$guard$;
CREATE ROLE postgres SUPERUSER;
SET SESSION AUTHORIZATION postgres;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE ROLE collect_importer;
CREATE ROLE collect_runtime;
CREATE ROLE collect_sms_runtime;
CREATE SCHEMA collect_ops;
CREATE SCHEMA app;
CREATE SCHEMA private;
CREATE SCHEMA burimunsi;
GRANT USAGE ON SCHEMA private TO collect_runtime,anon;
CREATE TABLE collect_ops.jobs_config(singleton boolean,enabled boolean);
CREATE TABLE collect_ops.jobs_dispatches(state text);
CREATE TABLE private.collect_fence_control(singleton boolean,mode text);
INSERT INTO private.collect_fence_control VALUES (true,'fenced');
CREATE FUNCTION private._collect_fence_require_operator() RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE FUNCTION private._collect_fence_statement() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$;
CREATE FUNCTION private._collect_fence_no_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable' USING ERRCODE='55000'; END;
$$;
CREATE FUNCTION private._collect_fence_require_runtime() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'collect_runtime'
    OR current_setting('collect.edge_verified',true) IS DISTINCT FROM 'true' THEN RAISE insufficient_privilege; END IF;
END;
$$;
CREATE FUNCTION private.burimunsi_pin_context() RETURNS TABLE(collection_id text,capabilities text[]) LANGUAGE sql AS $$
  SELECT current_setting('fixture.actor_collection'),string_to_array(current_setting('fixture.actor_capabilities'),',')
  WHERE nullif(current_setting('fixture.actor_collection',true),'') IS NOT NULL
$$;
CREATE TABLE private.burimunsi_accounts (id uuid PRIMARY KEY, collection_id text, principal_user_id text,
  role text, active boolean, removed boolean, capabilities text[]);
INSERT INTO private.burimunsi_accounts VALUES
  ('f3000000-0000-4000-8000-000000000003','home','fixture-admin','admin',true,false,ARRAY['records.read','sms.read']);
CREATE FUNCTION private.burimunsi_browser_pin_context() RETURNS jsonb LANGUAGE sql AS $$
  SELECT CASE WHEN nullif(current_setting('fixture.browser_role',true),'') IS NOT NULL THEN
    jsonb_build_object('collectionId','home','accountId','f3000000-0000-4000-8000-000000000003',
      'principalId','fixture-admin','operatorRole',current_setting('fixture.browser_role',true)) END
$$;
CREATE FUNCTION private.burimunsi_browser_pin_assert_actor(text,text,text,bigint,bigint) RETURNS text LANGUAGE sql AS $$
  SELECT 'fixture-admin' WHERE $1=ANY(string_to_array(current_setting('fixture.browser_permissions',true),','))
$$;
CREATE TABLE app.collections(id text PRIMARY KEY,status text,currency text);
CREATE TABLE app.momo_receiving_accounts(id text PRIMARY KEY,provider text,status text,currency text,timezone text);
CREATE TABLE private.burimunsi_scopes(collection_id text PRIMARY KEY,receiving_account_id text);
CREATE TABLE app.memberships(collection_id text,user_id text);
CREATE TABLE app.payments(id text PRIMARY KEY,collection_id text,status text,member_id text,
  amount_minor bigint,evidence_id text,currency text);
CREATE TABLE app.ledger_entries(id text PRIMARY KEY,payment_id text,collection_id text,kind text,
  amount_minor bigint,member_id text,evidence_id text,currency text,reverses_entry_id text);
CREATE TABLE app.sms_receipts(id text PRIMARY KEY,owner_user_id text,body_sha256 text,object_sha256 text);
CREATE TABLE burimunsi.payments(id text PRIMARY KEY,collection_id text,receiving_account_id text,
  provider text,provider_reference text,direction text,amount_rwf bigint,occurred_at timestamptz,source_time text,
  counterparty_name text,counterparty_identifier text,sms_source_id text,created_at timestamptz,updated_at timestamptz,member_id text);
CREATE TABLE private.burimunsi_native_receipt_origins(source_id text PRIMARY KEY,collection_id text,
  fingerprint text,principal_user_id text,body_sha256 text,object_sha256 text);
CREATE TABLE private.burimunsi_auto_sms_jobs(source_id text PRIMARY KEY,collection_id text,receiving_account_id text,
  state text,phase text,attempt_id uuid,source_fingerprint text,profile_sha256 text,facts_sha256 text,relation text,
  payment_outcome text,payment_id text,transaction_id text,lease_token uuid,lease_until bigint,event_identity_sha256 text,
  event_inbox_sha256 text,event_has_service_time boolean,last_error text,next_attempt_at bigint,updated_at bigint);
CREATE TABLE app.momo_parse_attempts(id text PRIMARY KEY,raw_sms_id text,attempt_number bigint DEFAULT 1,
  model_id text,schema_version text,prompt_version text,parser_version text,profile_version text,profile_json text,
  source_body_sha256 text,output_json text,validation_json text,outcome text,created_at text);
CREATE TABLE private.burimunsi_transaction_scopes(transaction_id text,collection_id text,receiving_account_id text,native_source_id text);
CREATE TABLE app.momo_transactions(id text PRIMARY KEY,receiving_account_id text,wallet_balance_after_minor bigint,
  parse_attempt_id text,transaction_at text,transaction_time_source text,currency text,currency_scale bigint,
  has_conflict bigint,event_kind text);
CREATE TABLE app.momo_transaction_sources(transaction_id text,parse_attempt_id text,raw_sms_id text,relation text);
CREATE TABLE app.momo_financial_links(transaction_id text PRIMARY KEY,payment_id text,beneficiary_member_id text);
CREATE FUNCTION app.strftime(text) RETURNS text LANGUAGE sql AS $$SELECT clock_timestamp()::text$$;
CREATE FUNCTION private.burimunsi_auto_jobs_guard() RETURNS void LANGUAGE sql AS $$
  SELECT private._collect_fence_require_runtime()
$$;
CREATE FUNCTION private.burimunsi_auto_snapshot(source text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor',jsonb_build_object('collectionId',j.collection_id),
    'proof',jsonb_build_object('fingerprint',o.fingerprint,'bodySha256',o.body_sha256),
    'profile',jsonb_build_object('profileSha256',j.profile_sha256,'profile',jsonb_build_object(
      'provider',w.provider,'timezone',w.timezone,'profile_version','test','profile_json','{}')))
  FROM private.burimunsi_auto_sms_jobs j JOIN private.burimunsi_native_receipt_origins o ON o.source_id=j.source_id
  JOIN app.momo_receiving_accounts w ON w.id=j.receiving_account_id WHERE j.source_id=source
$$;

-- Load the exact unmodified 24 November function, including its deployed body
-- hash, so the test exercises the migration's actual finalizer amendment.
WITH source AS (
  SELECT pg_read_file(:'source_root'||'/supabase/migrations/20261124114501_burimunsi_record_payments.sql') AS body
), locate AS (
  SELECT body,strpos(body,'CREATE OR REPLACE FUNCTION private.burimunsi_auto_finish(') AS start FROM source
)
SELECT substr(body,start,strpos(substr(body,start),'$finish$;')+length('$finish$;')-1)
FROM locate WHERE start>0
\gexec

INSERT INTO app.collections VALUES ('home','active','RWF'),('other','active','RWF');
INSERT INTO app.momo_receiving_accounts VALUES
  ('wallet','mtn','active','RWF','Africa/Kigali'),('other-wallet','mtn','active','RWF','Africa/Kigali');
INSERT INTO private.burimunsi_scopes VALUES ('home','wallet'),('other','other-wallet');
INSERT INTO app.memberships VALUES ('home','member'),('other','member');
INSERT INTO app.payments VALUES
  ('posted','home','confirmed','member',600,'e1','RWF'),
  ('wrong-amount','home','confirmed','member',500,'e2','RWF'),
  ('reversed','home','reversed','member',400,'e3','RWF'),
  ('another-group','other','confirmed','member',5000,'e4','RWF');
INSERT INTO app.ledger_entries VALUES
  ('posted','posted','home','contribution',600,'member','e1','RWF',NULL),
  ('wrong-amount','wrong-amount','home','contribution',200,'member','e2','RWF',NULL),
  ('original','reversed','home','contribution',400,'member','e3','RWF',NULL),
  ('inverse','reversed','home','reversal',-400,'member','e3','RWF','original'),
  ('outside','another-group','other','contribution',5000,'member','e4','RWF',NULL);

INSERT INTO burimunsi.payments(id,collection_id,receiving_account_id,provider,provider_reference,direction,
  amount_rwf,occurred_at,source_time,sms_source_id) VALUES
  ('legacy','home','wallet','mtn','old','incoming',50,'2025-01-01T10:00:00Z','source time','legacy-sms'),
  ('valid','home','wallet','mtn','valid','outgoing',250,'2025-01-02T10:00:00Z','source time','valid-sms'),
  ('forged','home','wallet','mtn','forged','outgoing',250,'2025-01-03T10:00:00Z','source time','forged-sms'),
  ('foreign-wallet','home','other-wallet','mtn','foreign','outgoing',900,'2025-01-04T10:00:00Z','source time','foreign-sms');
INSERT INTO app.sms_receipts
SELECT name,'owner',encode(sha256(convert_to(name,'UTF8')),'hex'),repeat('b',64)
FROM unnest(ARRAY['legacy-sms','valid-sms','forged-sms','foreign-sms','fresh-sms']) name;
INSERT INTO private.burimunsi_native_receipt_origins
SELECT id,'home',repeat('c',64),owner_user_id,body_sha256,object_sha256 FROM app.sms_receipts;
INSERT INTO private.burimunsi_transaction_scopes VALUES ('legacy','home','wallet','legacy-sms');
INSERT INTO app.momo_transactions VALUES
  ('legacy','wallet',1500,'legacy-attempt','2025-01-01T10:00:00Z','sms_body_and_provider_profile','RWF',0,0,'incoming_receipt');
INSERT INTO app.momo_transaction_sources VALUES ('legacy','legacy-attempt','legacy-sms','accepted');
INSERT INTO app.momo_parse_attempts (id,raw_sms_id,source_body_sha256,outcome)
SELECT 'legacy-attempt',id,body_sha256,'accepted' FROM app.sms_receipts WHERE id='legacy-sms';

CREATE FUNCTION pg_temp.facts(reference text,instant text,wallet bigint,fee bigint) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('source_mode','catch_up','event_kind','outgoing','payment_outcome','successful',
    'provider_transaction_id',reference,'original_transaction_id',NULL,'amount_minor',250,'currency','RWF',
    'counterparty_name',NULL,'counterparty_identifier',NULL,'transaction_at',instant,
    'transaction_datetime_raw','source time','fee_minor',fee,'wallet_balance_after_minor',wallet)
$$;
CREATE FUNCTION pg_temp.report(wallet text,fee text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('schema_version','momo-native-extraction.v2','wallet_balance_after_raw',wallet,'fee_amount_raw',fee)
$$;
INSERT INTO app.momo_parse_attempts (id,raw_sms_id,model_id,schema_version,parser_version,source_body_sha256,output_json,outcome) VALUES
  ('30000000-0000-4000-8000-000000000001','valid-sms','test/model','momo-native-extraction.v2','burimunsi-auto.v2',
    encode(sha256(convert_to('valid-sms','UTF8')),'hex'),pg_temp.report('1,234 RWF','10 RWF')::text,'accepted'),
  ('30000000-0000-4000-8000-000000000002','forged-sms','test/model','momo-native-extraction.v2','burimunsi-auto.v2',
    encode(sha256(convert_to('forged-sms','UTF8')),'hex'),pg_temp.report('9,999 RWF',NULL)::text,'accepted');
INSERT INTO private.burimunsi_auto_sms_jobs (source_id,collection_id,receiving_account_id,state,phase,attempt_id,
  source_fingerprint,profile_sha256,facts_sha256,relation,payment_outcome,payment_id) VALUES
  ('valid-sms','home','wallet','completed','finished','30000000-0000-4000-8000-000000000001',repeat('c',64),repeat('d',64),
    encode(sha256(convert_to(jsonb_build_object('model','test/model','output',pg_temp.report('1,234 RWF','10 RWF'),
      'facts',pg_temp.facts('valid','2025-01-02T10:00:00.000Z',1234,10))::text,'UTF8')),'hex'),'accepted','successful','valid'),
  ('forged-sms','home','wallet','completed','finished','30000000-0000-4000-8000-000000000002',repeat('c',64),repeat('d',64),
    repeat('e',64),'accepted','successful','forged');

\ir ../../migrations/20261126152453_burimunsi_home_savings.sql

WITH source AS (
  SELECT pg_read_file(:'source_root'||'/supabase/migrations/20261126150200_burimunsi_admin_sms_payment_scope.sql') AS body
), locate AS (
  SELECT body,strpos(body,'CREATE FUNCTION private._burimunsi_assert_browser_sms_payments_read(') AS start FROM source
)
SELECT substr(body,start,strpos(substr(body,start),'$guard$;')+length('$guard$;')-1)
FROM locate WHERE start>0
\gexec
\ir ../../migrations/20261126170200_burimunsi_admin_home_sms_balance.sql

DO $backfill$
BEGIN
  IF (SELECT count(*) FROM private.burimunsi_payment_wallet_observations)<>1 OR
    NOT EXISTS (SELECT FROM private.burimunsi_payment_wallet_observations WHERE payment_id='valid'
      AND balance_rwf=1234 AND fee_rwf=10) THEN RAISE EXCEPTION 'Authenticated scalar backfill changed'; END IF;
  IF has_table_privilege('collect_runtime','private.burimunsi_payment_wallet_observations','SELECT')
    OR has_function_privilege('anon','private.burimunsi_home_savings(text)','EXECUTE') THEN
    RAISE EXCEPTION 'Wallet evidence privileges expanded';
  END IF;
END;
$backfill$;

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE collect_runtime;
SET LOCAL collect.edge_verified='true';
SET LOCAL burimunsi.collection_id='home';
SET LOCAL fixture.actor_collection='home';
SET LOCAL fixture.actor_capabilities='records.read';
DO $read$
DECLARE s record;
BEGIN
  SELECT * INTO STRICT s FROM private.burimunsi_home_savings('home');
  IF ROW(s.lifetime_contributions_rwf,s.latest_wallet_balance_rwf,s.reconciliation_status)
    IS DISTINCT FROM ROW(600::numeric,1234::numeric,'unavailable'::text) THEN RAISE EXCEPTION 'Incorrect scoped Home result'; END IF;
  BEGIN
    PERFORM private.burimunsi_home_savings('other');
    RAISE EXCEPTION 'Cross-group Home read succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('fixture.actor_capabilities','sms.read',true);
  BEGIN
    PERFORM private.burimunsi_home_savings('home');
    RAISE EXCEPTION 'Home read succeeded without records.read';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$read$;
COMMIT;

BEGIN;
DELETE FROM private.burimunsi_payment_wallet_observations WHERE payment_id='valid';
SET LOCAL ROLE collect_runtime;
SET LOCAL collect.edge_verified='true';
SET LOCAL burimunsi.collection_id='home';
SET LOCAL fixture.actor_collection='home';
SET LOCAL fixture.actor_capabilities='records.read';
DO $legacy$
BEGIN
  IF (SELECT latest_wallet_balance_rwf FROM private.burimunsi_home_savings('home')) IS DISTINCT FROM 1500::numeric THEN
    RAISE EXCEPTION 'Authenticated predecessor observation was not used';
  END IF;
END;
$legacy$;
ROLLBACK;

INSERT INTO private.burimunsi_auto_sms_jobs (source_id,collection_id,receiving_account_id,state,phase,
  source_fingerprint,profile_sha256,lease_token,lease_until,event_identity_sha256) VALUES
  ('fresh-sms','home','wallet','processing','dispatched',repeat('c',64),repeat('d',64),
    '30000000-0000-4000-8000-000000000004',floor(extract(epoch FROM clock_timestamp())*1000)+60000,repeat('f',64));
BEGIN;
SET LOCAL ROLE collect_runtime;
SET LOCAL collect.edge_verified='true';
SET LOCAL burimunsi.collection_id='home';
DO $accept$
DECLARE value jsonb;
BEGIN
  FOR i IN 1..2 LOOP
    value:=private.burimunsi_auto_finish('fresh-sms','30000000-0000-4000-8000-000000000004',repeat('c',64),repeat('d',64),
      '30000000-0000-4000-8000-000000000003','test/model',pg_temp.report('0 RWF','0 RWF'),
      pg_temp.facts('new','2025-01-05T10:00:00.000Z',0,0));
    IF value->>'relation' IS DISTINCT FROM 'accepted' THEN RAISE EXCEPTION 'Exact finalization replay changed'; END IF;
  END LOOP;
END;
$accept$;
COMMIT;

DO $capture$
BEGIN
  IF (SELECT count(*) FROM private.burimunsi_payment_wallet_observations)<>2 OR
    NOT EXISTS (SELECT FROM private.burimunsi_payment_wallet_observations WHERE payment_id='fresh-sms'
      AND balance_rwf=0 AND fee_rwf=0 AND observed_at='2025-01-05T10:00:00Z'::timestamptz) THEN
    RAISE EXCEPTION 'Accepted finalizer did not retain its exact scalar or replay was not idempotent';
  END IF;
END;
$capture$;

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE collect_runtime;
SET LOCAL collect.edge_verified='true';
SET LOCAL burimunsi.collection_id='home';
SET LOCAL fixture.actor_collection='home';
SET LOCAL fixture.actor_capabilities='records.read';
DO $latest$
BEGIN
  IF (SELECT latest_wallet_balance_rwf FROM private.burimunsi_home_savings('home')) IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'Latest independently observed zero balance was not retained';
  END IF;
END;
$latest$;
COMMIT;

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE collect_runtime;
SET LOCAL collect.edge_verified='true';
SET LOCAL burimunsi.collection_id='home';
SET LOCAL fixture.browser_role='admin';
SET LOCAL fixture.browser_permissions='payments.read,sms.read';
DO $web_read$
BEGIN
  IF private.burimunsi_admin_home_sms_balance('home') IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'The latest verified zero balance was not available to Browser Admin';
  END IF;
  BEGIN
    PERFORM private.burimunsi_admin_home_sms_balance('other');
    RAISE EXCEPTION 'A different collection balance was disclosed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF has_function_privilege('private._burimunsi_latest_wallet_sms_balance(text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'The underlying SMS balance helper was directly accessible';
  END IF;
  PERFORM set_config('fixture.browser_role','staff',true);
  BEGIN
    PERFORM private.burimunsi_admin_home_sms_balance('home');
    RAISE EXCEPTION 'Staff could read the SMS balance';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('fixture.browser_role','admin',true);
  PERFORM set_config('fixture.browser_permissions','payments.read',true);
  BEGIN
    PERFORM private.burimunsi_admin_home_sms_balance('home');
    RAISE EXCEPTION 'An Admin without the SMS grant could read the SMS balance';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$web_read$;
COMMIT;

-- The provider statement lines are built independently of the database
-- basis function. The same two principal movements are attested in three
-- wallets with a matching, differing, and adjusted latest reported balance.
CREATE TEMP TABLE fixture_statements(group_id text PRIMARY KEY,reported bigint,opening bigint,fees bigint,closing bigint);
INSERT INTO fixture_statements VALUES ('balanced',350,50,50,350),('different',320,0,0,350),('adjusted',390,40,0,390);
INSERT INTO app.collections SELECT group_id,'active','RWF' FROM fixture_statements;
INSERT INTO app.momo_receiving_accounts SELECT group_id||'-wallet','mtn','active','RWF','Africa/Kigali' FROM fixture_statements;
INSERT INTO private.burimunsi_scopes SELECT group_id,group_id||'-wallet' FROM fixture_statements;
INSERT INTO app.memberships SELECT group_id,'member' FROM fixture_statements;
INSERT INTO app.payments SELECT group_id||'-posting',group_id,'confirmed','member',600,group_id||'-evidence','RWF' FROM fixture_statements;
INSERT INTO app.ledger_entries
SELECT group_id||'-credit',group_id||'-posting',group_id,'contribution',600,'member',group_id||'-evidence','RWF',NULL
FROM fixture_statements;
INSERT INTO app.momo_financial_links SELECT group_id||'-incoming',group_id||'-posting','member' FROM fixture_statements;
INSERT INTO app.sms_receipts
SELECT group_id||'-sms','owner',encode(sha256(convert_to(group_id,'UTF8')),'hex'),repeat('b',64) FROM fixture_statements;
INSERT INTO burimunsi.payments(id,collection_id,receiving_account_id,provider,provider_reference,direction,
  amount_rwf,occurred_at,source_time,sms_source_id,member_id)
SELECT group_id||'-incoming',group_id,group_id||'-wallet','mtn','IN1','incoming',600,'2025-01-01T10:00:00Z'::timestamptz,'source time',NULL,'member'
FROM fixture_statements
UNION ALL
SELECT group_id||'-outgoing',group_id,group_id||'-wallet','mtn','OUT1','outgoing',250,'2025-01-02T10:00:00Z'::timestamptz,'source time',group_id||'-sms',NULL
FROM fixture_statements;
INSERT INTO private.burimunsi_transaction_scopes
SELECT group_id||'-outgoing',group_id,group_id||'-wallet',group_id||'-sms' FROM fixture_statements;
INSERT INTO app.momo_transactions SELECT group_id||'-outgoing',group_id||'-wallet',reported,group_id||'-attempt',
  '2025-01-02T10:00:00Z','sms_body_and_provider_profile','RWF',0,0,'outgoing' FROM fixture_statements;
INSERT INTO app.momo_parse_attempts (id,raw_sms_id,source_body_sha256,outcome)
SELECT group_id||'-attempt',r.id,r.body_sha256,'accepted' FROM fixture_statements JOIN app.sms_receipts r ON r.id=group_id||'-sms';
INSERT INTO app.momo_transaction_sources
SELECT group_id||'-outgoing',group_id||'-attempt',group_id||'-sms','accepted' FROM fixture_statements;

CREATE FUNCTION pg_temp.statement_hash() RETURNS text LANGUAGE sql AS $$
  SELECT encode(sha256(convert_to(E'IN1\tincoming\t600\t1735725600000\nOUT1\toutgoing\t250\t1735812000000\n','UTF8')),'hex')
$$;
DO $checkpoint$
DECLARE s record;
BEGIN
  FOR s IN SELECT * FROM fixture_statements LOOP
    PERFORM private.burimunsi_admit_home_reconciliation_checkpoint(s.group_id,s.group_id||'-wallet',
      '2025-01-01T09:00:00Z','2025-01-02T10:00:00Z',repeat('1',64),repeat('2',64),pg_temp.statement_hash(),2,
      s.opening,600,250,s.fees,0,0,s.closing);
  END LOOP;
  BEGIN
    PERFORM private.burimunsi_admit_home_reconciliation_checkpoint('balanced','balanced-wallet',
      '2025-01-01T09:00:00Z','2025-01-02T10:00:00Z',repeat('1',64),repeat('2',64),repeat('3',64),2,50,600,250,50,0,0,350);
    RAISE EXCEPTION 'Mismatched statement movement digest was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    UPDATE private.burimunsi_home_reconciliation_checkpoints SET review_sha256=repeat('3',64);
    RAISE EXCEPTION 'Reviewed checkpoint was mutable';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
END;
$checkpoint$;

CREATE FUNCTION pg_temp.assert_home_status(group_id text,expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('burimunsi.collection_id',group_id,true),set_config('fixture.actor_collection',group_id,true);
  IF (SELECT reconciliation_status FROM private.burimunsi_home_savings(group_id)) IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'Home statement status differs from expected status for %',group_id;
  END IF;
END;
$$;
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE collect_runtime;
SET LOCAL collect.edge_verified='true';
SET LOCAL fixture.actor_capabilities='records.read';
SELECT pg_temp.assert_home_status('balanced','reconciled'),
       pg_temp.assert_home_status('different','mismatch'),
       pg_temp.assert_home_status('adjusted','unavailable');
COMMIT;

INSERT INTO burimunsi.payments(id,collection_id,receiving_account_id,provider,provider_reference,direction,amount_rwf,occurred_at)
VALUES ('late','balanced','balanced-wallet','mtn','OUT2','outgoing',40,'2025-01-03T10:00:00Z');
DELETE FROM app.momo_financial_links WHERE transaction_id='different-incoming';
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE collect_runtime;
SET LOCAL collect.edge_verified='true';
SET LOCAL fixture.actor_capabilities='records.read';
SELECT pg_temp.assert_home_status('balanced','unavailable'),pg_temp.assert_home_status('different','unavailable');
COMMIT;
SELECT 'home_savings_contract_pass' AS status;
