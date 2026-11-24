-- Synthetic mixed-source records for the payment activity query and its scoped SQL readers.
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE collect_importer; CREATE ROLE collect_runtime;
CREATE SCHEMA app; CREATE SCHEMA private; CREATE SCHEMA fixture;
CREATE FUNCTION fixture.id(n int) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT '00000000-0000-4000-8000-'||lpad(n::text,12,'0')$$;
CREATE TABLE private.collect_fence_control(singleton boolean,mode text);
INSERT INTO private.collect_fence_control VALUES(true,'fenced');
CREATE FUNCTION private._collect_fence_require_operator() RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE FUNCTION private.burimunsi_browser_pin_context() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('principalId','fixture-principal','collectionId',current_setting('fixture.group_id',true),
 'operatorRole',nullif(current_setting('fixture.operator_role',true),''))$$;
CREATE FUNCTION private.assert_actor(text,text,text,int,int) RETURNS text LANGUAGE sql AS $$
 SELECT CASE WHEN $1=ANY(string_to_array(current_setting('fixture.grants',true),',')) THEN 'fixture-principal' END$$;
CREATE FUNCTION private.burimunsi_observation_admin_scope(text,boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('fixture.group_id',true) IS DISTINCT FROM $1 OR current_setting('fixture.operator_role',true) IS DISTINCT FROM 'admin'
  OR private.assert_actor('sms.read',NULL,NULL,1,NULL) IS NULL THEN RAISE EXCEPTION 'source_denied' USING ERRCODE='42501'; END IF;
 RETURN private.burimunsi_browser_pin_context();
END$$;

CREATE TABLE app.users(id text PRIMARY KEY,full_name text);
CREATE TABLE app.collections(id text PRIMARY KEY,title text);
CREATE TABLE app.payment_evidence(id text PRIMARY KEY,collection_id text,external_reference text);
CREATE TABLE app.payments(id text PRIMARY KEY,collection_id text,member_id text,evidence_id text,intent_id text,
 amount_minor bigint,currency text,status text,payer_display_name text,created_at text,revision bigint,payment_reference text);
CREATE TABLE app.reconciliations(id text,payment_id text,evidence_id text,status text);
CREATE TABLE app.ledger_entries(payment_id text,collection_id text,amount_minor bigint);
CREATE TABLE app.momo_receiving_accounts(id text PRIMARY KEY,public_code text,recipient_name text);
CREATE TABLE app.momo_transactions(id text PRIMARY KEY,receiving_account_id text,provider_transaction_id text,event_kind text,amount_minor bigint,
 currency text,currency_scale bigint,payer_name text,transaction_at text,created_at text,allocation_state text,has_conflict bigint,parse_attempt_id text);
CREATE TABLE app.momo_financial_links(transaction_id text PRIMARY KEY,payment_id text,beneficiary_member_id text);
CREATE TABLE app.momo_transaction_sources(transaction_id text,raw_sms_id text,parse_attempt_id text,relation text);
CREATE TABLE app.momo_parse_attempts(id text PRIMARY KEY,raw_sms_id text,outcome text,source_body_sha256 text,parser_version text,profile_version text,created_at text);
CREATE TABLE app.sms_receipts(id text PRIMARY KEY,owner_user_id text,originating_session_id text,body_sha256 text,object_sha256 text,status text,
 evidence_level text,created_at text);
CREATE TABLE private.burimunsi_transaction_scopes(transaction_id text,collection_id text,receiving_account_id text);
CREATE TABLE private.burimunsi_sms_source_scopes(source_id text,collection_id text,receiving_account_id text,owner_user_id text,source_body_sha256 text,object_sha256 text);
CREATE TABLE private.burimunsi_auto_sms_jobs(source_id text,collection_id text,receiving_account_id text);
CREATE TABLE fixture.native(transaction_id text PRIMARY KEY,group_id text);
CREATE FUNCTION private.burimunsi_admin_transaction_facts(text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('scope',coalesce((SELECT jsonb_build_object('kind',CASE WHEN n.group_id=current_setting('fixture.group_id',true)
  THEN 'visible' ELSE 'hidden' END,'groupId',n.group_id) FROM fixture.native n WHERE n.transaction_id=$1),jsonb_build_object('kind','managed')),'facts',NULL)$$;
CREATE TABLE fixture.observations(collection_id text,source_id text,admitted_at bigint,retention_state text,body_sha256 text,
 owner_user_id text,object_key text,object_sha256 text,fingerprint text,key_id text,source_fingerprint text,processing text,payment_reference text);
CREATE FUNCTION private.burimunsi_observation_admin_rows(text)
RETURNS TABLE(source_id text,admitted_at bigint,retention_state text,body_sha256 text,owner_user_id text,object_key text,
 object_sha256 text,fingerprint text,key_id text,source_fingerprint text) LANGUAGE sql AS $$
 SELECT o.source_id,o.admitted_at,o.retention_state,o.body_sha256,o.owner_user_id,o.object_key,o.object_sha256,o.fingerprint,o.key_id,o.source_fingerprint
 FROM fixture.observations o WHERE o.collection_id=$1$$;
CREATE FUNCTION private.burimunsi_admin_observation_outcomes(text,text[],boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
 IF cardinality($2)>100 THEN RAISE EXCEPTION 'too_many_sources'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('sourceId',o.source_id,'processing',o.processing,
  'paymentReference',CASE WHEN $3 THEN o.payment_reference END,'payerStatus',NULL,'payerReason',NULL)),'[]'::jsonb)
  FROM fixture.observations o WHERE o.collection_id=$1 AND o.source_id=ANY($2));
END$$;

SET search_path=app,public;
INSERT INTO app.collections VALUES(fixture.id(1),'Scoped group'),(fixture.id(2),'Other group');
INSERT INTO app.users VALUES(fixture.id(3),'Synthetic member');
INSERT INTO app.momo_receiving_accounts VALUES(fixture.id(4),'020','Scoped receiver'),(fixture.id(5),'030','Other receiver');
INSERT INTO app.payment_evidence VALUES(fixture.id(21),fixture.id(1),'provider-PAY%_ABC'),(fixture.id(22),fixture.id(1),'other'),
 (fixture.id(23),fixture.id(2),'provider-PAY%_ABC');
INSERT INTO app.payments SELECT fixture.id(p),fixture.id(g),CASE WHEN p=12 THEN NULL ELSE fixture.id(3) END,fixture.id(e),NULL,
 500,'RWF',st,'Payer name','2026-01-02T23:59:59.000Z',1,ref FROM (VALUES
  (11,1,21,'confirmed','111111111111'),(12,1,22,'recorded','222222222222'),(13,2,23,'confirmed','444444444444')
 ) fixture(p,g,e,st,ref);
INSERT INTO app.reconciliations VALUES(fixture.id(41),fixture.id(12),fixture.id(22),'proposed');
INSERT INTO app.ledger_entries VALUES(fixture.id(11),fixture.id(1),500);
INSERT INTO app.momo_transactions SELECT fixture.id(t),fixture.id(wallet),ref,'incoming_receipt',500,'RWF',0,'Payer name',
 '2026-01-01T21:59:59.000Z','2026-01-03T00:00:00.000Z','unallocated',0,fixture.id(a)
 FROM (VALUES(31,4,'provider-PAY%_ABC',201),(32,4,'unassigned',205),(33,5,'hidden',208),(34,5,'no group proof',214)) x(t,wallet,ref,a);
INSERT INTO app.momo_financial_links VALUES(fixture.id(31),fixture.id(11),fixture.id(3)),(fixture.id(33),fixture.id(13),fixture.id(3));
INSERT INTO private.burimunsi_transaction_scopes VALUES(fixture.id(31),fixture.id(1),fixture.id(4)),
 (fixture.id(32),fixture.id(1),fixture.id(4)),(fixture.id(33),fixture.id(2),fixture.id(5));
INSERT INTO fixture.native VALUES(fixture.id(31),fixture.id(1)),(fixture.id(33),fixture.id(2));

INSERT INTO app.sms_receipts SELECT fixture.id(n),'fixture-owner',CASE WHEN n IN(104,105,107,108) THEN 'managed-session' END,
 repeat('a',64),repeat('b',64),'received','client_received','2026-01-04T00:00:00.000Z' FROM generate_series(101,109) n WHERE n<>106;
INSERT INTO private.burimunsi_sms_source_scopes SELECT fixture.id(n),fixture.id(CASE WHEN n=108 THEN 2 ELSE 1 END),
 fixture.id(4),'fixture-owner',repeat(CASE WHEN n=107 THEN 'c' ELSE 'a' END,64),repeat('b',64) FROM generate_series(104,108) n WHERE n<>106;
INSERT INTO fixture.observations SELECT fixture.id(1),fixture.id(n),round(extract(epoch FROM TIMESTAMPTZ '2026-01-03 22:00Z')*1000)::bigint+n,
 CASE WHEN n=106 THEN 'unresolved' ELSE 'retained' END,CASE WHEN n<>106 THEN repeat('a',64) END,'fixture-owner','sms/'||fixture.id(n),repeat('b',64),
 repeat('c',64),'fixture-key',repeat('d',64),CASE WHEN n=101 THEN 'posted' WHEN n=102 THEN 'duplicate' WHEN n=103 THEN 'blocked' ELSE 'pending' END,
 CASE WHEN n=101 THEN '111111111111' END FROM unnest(ARRAY[101,102,103,106,109]) n;
INSERT INTO fixture.observations SELECT fixture.id(1),fixture.id(n),round(extract(epoch FROM TIMESTAMPTZ '2025-12-31 12:00Z')*1000)::bigint+n,
 'unresolved',NULL,'fixture-owner',NULL,NULL,NULL,NULL,NULL,'pending',NULL FROM generate_series(1000,1134) n;
INSERT INTO fixture.observations SELECT fixture.id(2),fixture.id(9999),40000,'unresolved',NULL,'foreign',NULL,NULL,NULL,NULL,NULL,'pending',NULL;
INSERT INTO private.burimunsi_auto_sms_jobs SELECT o.source_id,o.collection_id,fixture.id(4) FROM fixture.observations o WHERE o.retention_state='retained';
INSERT INTO app.momo_parse_attempts SELECT fixture.id(a),fixture.id(s),r,repeat(CASE WHEN a=209 THEN 'c' ELSE 'a' END,64),'v1','p1','2026-01-02T00:00:00.000Z'
 FROM (VALUES(201,101,'accepted'),(202,102,'duplicate'),(203,103,'conflict'),(204,103,'conflict'),(205,105,'accepted'),(208,108,'accepted'),
 (209,109,'duplicate')) f(a,s,r);
INSERT INTO app.momo_transaction_sources SELECT fixture.id(t),fixture.id(s),fixture.id(a),r FROM
 (VALUES(31,101,201,'accepted'),(31,102,202,'duplicate'),(31,103,203,'conflict'),(33,103,204,'conflict'),(32,105,205,'accepted'),
 (33,108,208,'accepted'),(31,109,209,'duplicate')) f(t,s,a,r);
GRANT USAGE ON SCHEMA private, app TO collect_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO collect_runtime;
