import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadBuriPostgresFixture} from './postgres-fixture.mjs';
import {nativePaymentListingScope,paymentsSql} from '../../domain/burimunsi/postgres-payment-reads.js';

const fixture=loadBuriPostgresFixture();
const migration=name=>readFileSync(new URL('../../../../migrations/'+name,import.meta.url),'utf8');

test('batched native payment projections preserve collection, actor and receipt disclosure', {skip:!fixture},()=>{
  const batch=migration('20261122140000_burimunsi_batch_payment_projections.sql');
  const performance=migration('20261122180000_burimunsi_internal_query_performance.sql');
  const shared=performance.indexOf('-- Shared application admission and scheduler read paths.');
  const directory=performance.indexOf('DO $directory$');
  const directoryEnd=performance.indexOf('\n$directory$;',directory);
  assert.ok(shared>=0);
  assert.ok(directory>shared);
  assert.ok(directoryEnd>directory);
  const readHelpers=performance.slice(0,shared)+'COMMIT;\n';
  const directoryChange=performance.slice(directory,directoryEnd)+'\n$directory$;\n';
  const prior=migration('20261112200100_burimunsi_native_auto_transactions.sql');
  const scalar=prior.match(/CREATE FUNCTION private\.burimunsi_auto_projection\(p_source text\)[\s\S]*?END;\$fn\$;/)?.[0]
    .replace("'outcome',j.payment_outcome,'canReveal',can_reveal", "'outcome',coalesce(j.posting_facts->>'payment_outcome',j.payment_outcome),'canReveal',can_reveal,'facts',j.posting_facts");
  assert.ok(scalar?.includes("j.posting_facts"));
  const setup=`
    CREATE ROLE collect_runtime;
    CREATE ROLE collect_importer;
    CREATE SCHEMA private;
    CREATE SCHEMA app;
    GRANT USAGE ON SCHEMA private,app TO collect_runtime;
    CREATE TABLE private.collect_fence_control(singleton boolean,mode text);
    INSERT INTO private.collect_fence_control VALUES(true,'fenced');
    CREATE FUNCTION private._collect_fence_require_operator() RETURNS void LANGUAGE sql AS 'SELECT pg_catalog.pg_sleep(0)';
    CREATE FUNCTION private._collect_fence_require_runtime() RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('role') <> 'collect_runtime' THEN
          RAISE EXCEPTION 'denied' USING ERRCODE='42501';
        END IF;
      END
    $$;
    CREATE TABLE private.burimunsi_auto_sms_jobs(
      source_id text PRIMARY KEY,collection_id text,state text,payment_outcome text,posting_facts jsonb,
      transaction_id text,relation text);
    INSERT INTO private.burimunsi_auto_sms_jobs(source_id,collection_id,state,payment_outcome,posting_facts) VALUES
      ('mine','group','completed','pending','{"payment_outcome":"successful","amount_minor":25,"transaction_at":"2026-11-22T08:00:00Z","transaction_timezone":"Africa/Kigali"}'),
      ('another','group','completed','failed',NULL),
      ('foreign','other-group','completed','successful','{"amount_minor":900}'),
      ('waiting','group','processing',NULL,NULL);
    CREATE FUNCTION private.burimunsi_pin_context()
    RETURNS TABLE(collection_id text,role text,profile text,capabilities text[]) LANGUAGE sql AS $$
      SELECT 'group', mode, CASE mode WHEN 'admin' THEN 'internal_receiver' ELSE 'staff' END,
        CASE mode WHEN 'admin' THEN ARRAY['records.read','sms.read','gateway.manage']
          WHEN 'staff' THEN ARRAY['records.read'] ELSE ARRAY[]::text[] END
      FROM (SELECT current_setting('synthetic.operator') AS mode) s
    $$;
    CREATE FUNCTION private.burimunsi_pin_assert_actor(text,text,text,bigint,bigint)
    RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        IF $2 <> 'group' OR $4 <> 1 OR current_setting('synthetic.assert_denied',true) = 'yes' THEN
          RAISE EXCEPTION 'denied' USING ERRCODE='42501';
        END IF;
      END
    $$;
    CREATE FUNCTION private.burimunsi_observation_own(text,boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT $2 OR current_setting('burimunsi.native_receipt_frame') <> 'prior-frame' THEN
          RAISE EXCEPTION 'bad reveal frame';
        END IF;
        IF current_setting('synthetic.operator') <> 'admin' OR $1 <> 'mine' THEN
          RAISE EXCEPTION 'denied' USING ERRCODE='42501';
        END IF;
        RETURN '{"private_receipt_proof":"must not be returned"}';
      END
    $$;
    CREATE FUNCTION private.burimunsi_browser_pin_owner_actor(text,text,text,text) RETURNS uuid
      LANGUAGE sql AS $$ SELECT '11111111-1111-4111-8111-111111111111'::uuid $$;
    CREATE FUNCTION private.burimunsi_operator_directory(p_actor text,p_cookie text,p_origin text,p_public text,p_collection text,p_request uuid)
      RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE sid uuid;
    BEGIN
      PERFORM pg_advisory_xact_lock(734636924058501::bigint);
      sid:=private.burimunsi_browser_pin_owner_actor(p_actor,p_cookie,p_origin,p_public);
      RETURN jsonb_build_object('sessionId',sid,'collectionId',p_collection);
    END
    $$;
    CREATE TABLE private.burimunsi_transaction_scopes(
      collection_id text,transaction_id text,receiving_account_id text,native_source_id text);
    CREATE TABLE app.momo_transactions(
      id text,receiving_account_id text,payer_name text,payer_identifier text,amount_minor bigint,transaction_at text,
      transaction_timezone text,transaction_datetime_raw text,provider_transaction_id text,allocation_state text,
      has_conflict integer,version bigint,created_at text,event_kind text,fee_minor bigint,wallet_balance_after_minor bigint);
    INSERT INTO private.burimunsi_transaction_scopes VALUES ('group','tx','wallet','mine');
    INSERT INTO app.momo_transactions VALUES ('tx','wallet','Payer','***123',10,'2026-11-22T08:00:00Z',
      'Africa/Kigali','Exact source','synthetic-ref','unallocated',0,1,'synthetic','incoming_receipt',0,NULL);
    CREATE TABLE app.momo_financial_links(transaction_id text,payment_id text,beneficiary_member_id text);
    CREATE TABLE app.payments(id text,collection_id text,status text,amount_minor bigint,evidence_id text,member_id text);
    CREATE TABLE app.memberships(collection_id text,user_id text);
    CREATE TABLE app.users(id text,full_name text,momo_number text);
    CREATE TABLE app.ledger_entries(payment_id text,collection_id text,kind text,amount_minor bigint,evidence_id text,member_id text);
    CREATE TABLE app.momo_transaction_sources(transaction_id text,raw_sms_id text,relation text);
    GRANT SELECT ON private.burimunsi_transaction_scopes TO collect_runtime;
    GRANT SELECT ON ALL TABLES IN SCHEMA app TO collect_runtime;
  `;
  const verify=`
    GRANT EXECUTE ON FUNCTION private.burimunsi_auto_projection(text) TO collect_runtime;
    DO $acl$
    BEGIN
      IF NOT has_function_privilege('collect_runtime','private.burimunsi_auto_projection_batch(text,text[])','execute')
        OR EXISTS (SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role','collect_importer']) r
          WHERE has_function_privilege(r,'private.burimunsi_auto_projection_batch(text,text[])','execute') OR
            has_function_privilege(r,'private.burimunsi_home_payment_times(text,text[])','execute') OR
            has_function_privilege(r,'private.burimunsi_admin_transaction_facts(text)','execute')) THEN
        RAISE EXCEPTION 'projection grants changed';
      END IF;
    END
    $acl$;
    BEGIN READ ONLY;
    SET LOCAL ROLE collect_runtime;
    SET LOCAL burimunsi.native_receipt_frame='prior-frame';
    DO $compare$
    DECLARE account_role text; row_count integer; differences integer; revealed integer;
    BEGIN
      FOREACH account_role IN ARRAY ARRAY['staff','admin'] LOOP
        PERFORM set_config('synthetic.operator',account_role,true);
        SELECT count(*), count(*) FILTER(WHERE b.value IS DISTINCT FROM private.burimunsi_auto_projection(b.source_id)),
          count(*) FILTER(WHERE b.value->'canReveal'='true'::jsonb)
        INTO row_count,differences,revealed
        FROM private.burimunsi_auto_projection_batch('group',ARRAY['mine','another','foreign','waiting','mine',NULL]) b;
        IF row_count <> 2 OR differences <> 0 OR revealed <> (CASE account_role WHEN 'admin' THEN 1 ELSE 0 END)
          OR current_setting('burimunsi.native_receipt_frame') <> 'prior-frame' THEN
          RAISE EXCEPTION 'native batch does not match exact scalar projections';
        END IF;
        SELECT count(*), count(*) FILTER(
          WHERE t.transaction_at IS DISTINCT FROM p.value->'facts'->>'transaction_at'
            OR t.transaction_timezone IS DISTINCT FROM p.value->'facts'->>'transaction_timezone')
        INTO row_count,differences
        FROM private.burimunsi_home_payment_times('group',ARRAY['mine','another','foreign','waiting','mine',NULL]) t
        JOIN private.burimunsi_auto_projection_batch('group',ARRAY['mine','another']) p USING (source_id);
        IF row_count<>2 OR differences<>0 OR current_setting('burimunsi.native_receipt_frame') <> 'prior-frame' THEN
          RAISE EXCEPTION 'home times escaped the allowed projection';
        END IF;
      END LOOP;
      BEGIN
        PERFORM private.burimunsi_auto_projection_batch('other-group',ARRAY['foreign']);
        RAISE EXCEPTION 'cross-collection request passed';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END;
      BEGIN
        PERFORM private.burimunsi_home_payment_times('other-group',ARRAY['foreign']);
        RAISE EXCEPTION 'cross-collection home times passed';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END;
      PERFORM set_config('synthetic.assert_denied','yes',true);
      BEGIN
        PERFORM private.burimunsi_auto_projection_batch('group',ARRAY['mine']);
        RAISE EXCEPTION 'unverified actor passed';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END;
      PERFORM set_config('synthetic.assert_denied','no',true);
      PERFORM set_config('synthetic.operator','unprivileged',true);
      BEGIN
        PERFORM private.burimunsi_auto_projection_batch('group',ARRAY['mine']);
        RAISE EXCEPTION 'missing records permission passed';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    END
    $compare$;
    SET LOCAL synthetic.operator='staff';
    DO $directory_contract$
    DECLARE result jsonb;
    BEGIN
      result:=private.burimunsi_operator_directory('owner','cookie','origin','public','group',NULL);
      IF result->>'collectionId'<>'group' OR NOT EXISTS(SELECT 1 FROM pg_locks
        WHERE locktype='advisory' AND pid=pg_backend_pid() AND mode='ShareLock')
        OR EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND mode='ExclusiveLock') THEN
        RAISE EXCEPTION 'directory did not preserve scope with a shared mutation lock';
      END IF;
    END
    $directory_contract$;
    PREPARE legacy(text) AS ${paymentsSql(true)} AND t.id='tx';
    PREPARE batch(text) AS ${nativePaymentListingScope}${paymentsSql(true,{batch:true})};
    EXECUTE legacy('group');
    EXECUTE batch('group');
    ROLLBACK;
  `;
  const result=fixture.run('postgres',['-Atq'],setup+scalar+batch+readHelpers+directoryChange+verify);
  assert.equal(result.status,0,result.stderr);
  const lines=result.stdout.trim().split('\n');
  assert.equal(lines.length,2);
  assert.match(lines[0],/^tx\|group\|Payer\|\*\*\*123\|25\|/);
  assert.equal(lines[1],lines[0]);
});
