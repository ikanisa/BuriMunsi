import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from '../../node_modules/pg/lib/index.js';
import {startOwnedPg17} from '../../current-pg-transfer/test-support/owned-pg17.mjs';

const {Client}=pg;
const migrations = await Promise.all([
  '20261118090305_burimunsi_automatic_payment_sms.sql',
  '20261119041100_burimunsi_payment_sms_status.sql',
  '20261119114600_burimunsi_admin_sms_health.sql',
  '20261119114700_collect_payment_display_reference.sql',
  '20261122150100_burimunsi_payment_sms_obligations.sql',
].map(name => readFile(new URL('../../../../supabase/migrations/' + name, import.meta.url), 'utf8')));
export const fixturePaymentId = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const id = fixturePaymentId;
const hash = 'a'.repeat(64);

export async function startPayerFixture(t,{
  groupId:group=id(1), memberId:member=id(2), phoneNumber:phone='+250788000001', applicationId:app='app_'+id(3),
  enabledAgo=60_000, seedHistoricalPayment=false, beforeNoticeMigration,
}={}) {
  const cluster = await startOwnedPg17({prefix: 'collect-pg-transfer-', initialUser: 'collect_fixture'});
  const client = new Client({host:cluster.socket, port:cluster.port, database:'postgres', user:cluster.initialUser});
  t.after(async () => {
    try { await client.end(); } finally { await cluster.close(); }
  });
  await client.connect();
  const query = (sql, args) => client.query(sql, args);
  const db = {exec: query, query, async transaction(run) {
    await query('BEGIN');
    try { const result = await run(db); await query('COMMIT'); return result; }
    catch(error) { await query('ROLLBACK'); throw error; }
  }};
  await db.exec(`
    CREATE ROLE postgres SUPERUSER;
    SET ROLE postgres;
    CREATE ROLE collect_runtime;
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE ROLE collect_importer;
    CREATE SCHEMA collect_ops;
    CREATE SCHEMA collect_sms;
    CREATE SCHEMA cron;
    CREATE TABLE cron.job(jobid integer PRIMARY KEY,active boolean,jobname text DEFAULT 'collect-jobs-maintenance-v1',
      schedule text DEFAULT '* * * * *',command text DEFAULT 'SELECT collect_ops.tick_jobs();',database text DEFAULT current_database());
    INSERT INTO cron.job VALUES(1,true);
    CREATE TABLE collect_ops.jobs_config(singleton boolean,enabled boolean,cron_job_id integer DEFAULT 1);
    CREATE TABLE collect_ops.jobs_dispatches(kind text,state text,observed_at timestamptz,response_sha256 text,id integer GENERATED ALWAYS AS IDENTITY);
    CREATE TABLE collect_sms.messages(message_id text PRIMARY KEY,application_id text,kind text,idempotency_key text,state text);
    ALTER TABLE collect_sms.messages ENABLE ROW LEVEL SECURITY;
    ALTER TABLE collect_sms.messages FORCE ROW LEVEL SECURITY;
    CREATE TABLE collect_sms.devices(last_seen_at text,ready bigint,revoked_at text,allowed_kinds text);
    INSERT INTO collect_ops.jobs_config VALUES(true,true);
    CREATE SCHEMA app;
    CREATE SCHEMA private;
    CREATE TABLE private.collect_managed_job_tickets(dispatch_id integer,completed_at timestamptz,response_sha256 text);
    GRANT USAGE ON SCHEMA private TO collect_runtime, anon;
    CREATE TABLE private.collect_fence_control(singleton boolean,mode text);
    INSERT INTO private.collect_fence_control VALUES(true,'fenced');
    CREATE FUNCTION private._collect_fence_require_operator() RETURNS void LANGUAGE sql AS $$SELECT$$;
    CREATE FUNCTION private.burimunsi_auto_jobs_guard() RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      IF current_setting('role',true)<>'collect_runtime' OR current_setting('test.work_kind',true) IS DISTINCT FROM 'jobs' THEN
        RAISE EXCEPTION 'jobs work required' USING ERRCODE='42501';
      END IF;
    END$$;
    CREATE FUNCTION private._collect_fence_statement() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$;
    CREATE FUNCTION private.managed_phone_binding(text,text,text) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
    CREATE FUNCTION private._retention_manifest_catalog_v2() RETURNS jsonb LANGUAGE sql IMMUTABLE
      SET search_path=pg_catalog,pg_temp AS $$SELECT '{"private_classes":[]}'::jsonb$$;
    CREATE FUNCTION private.retention_capture_inventory_v2(p_operation uuid,p_request text,p_review bigint,p_source text,p_max_rows integer DEFAULT 1000000)
      RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
      BEGIN RETURN jsonb_build_array('private:burimunsi_observation_retry_commands','managed:storage_iceberg'); END$$;
    REVOKE ALL ON FUNCTION private._retention_manifest_catalog_v2(),private.retention_capture_inventory_v2(uuid,text,bigint,text,integer) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION private.retention_capture_inventory_v2(uuid,text,bigint,text,integer) TO collect_runtime;
    CREATE TABLE app.collections(id text PRIMARY KEY,status text);
    CREATE TABLE app.users(id text PRIMARY KEY,access_status text,member_type text,momo_number text);
    CREATE TABLE app.memberships(collection_id text,user_id text,active bigint);
    CREATE TABLE app.payments(id text PRIMARY KEY,collection_id text,member_id text,amount_minor bigint,
      currency text,status text,rail text,evidence_id text);
    CREATE TABLE app.ledger_entries(id text PRIMARY KEY,payment_id text,collection_id text,member_id text,
      kind text,amount_minor bigint,currency text,evidence_id text,posted_at text,reverses_entry_id text);
    CREATE TABLE app.contribution_posting_snapshots(payment_id text,ledger_entry_id text,posted_at text,member_balance_after_minor bigint);
    CREATE TABLE app.momo_financial_links(payment_id text,transaction_id text,beneficiary_member_id text,historical_existing bigint);
    CREATE TABLE app.momo_transactions(id text PRIMARY KEY,mode text,event_kind text,allocation_state text,has_conflict bigint,
      currency text,amount_minor bigint,receiving_account_id text,payer_identifier text,transaction_at text,
      original_transaction_id text,provider_transaction_id text,transaction_time_source text);
    CREATE TABLE private.burimunsi_transaction_scopes(transaction_id text,collection_id text,receiving_account_id text,native_source_id text,policy_version text);
    CREATE TABLE app.assisted_sms_authorizations(collection_id text,recipient_user_id text,destination_sha256 text,
      consent_revision bigint,enabled bigint,phone_verification_challenge_id text);
    CREATE TABLE app.notification_preferences(user_id text,payment_updates bigint);
    CREATE TABLE app.notification_events(id text PRIMARY KEY,user_id text,event_type text,data_json text,created_at text);
    CREATE TABLE app.privacy_retention_barriers(subject_id text);
    CREATE TABLE app.admin_grants(user_id text,permission text);
    CREATE TABLE app.admin_account_role_capabilities(role text,permission text);
    CREATE TABLE private.burimunsi_operator_approvals(collection_id text,principal_user_id text,admin_user_id text,
      active boolean,capabilities text[],phone text,role text);
    CREATE TABLE private.burimunsi_auto_sms_jobs(source_id text,collection_id text,transaction_id text,state text,
      relation text,attempt_count integer,posting_failure_count integer,posting_next_attempt_at bigint,created_at bigint);
    CREATE TABLE private.burimunsi_unresolved_observations(source_id text,collection_id text,created_at bigint);
    CREATE FUNCTION private._collect_fence_require_runtime() RETURNS void LANGUAGE plpgsql AS $$BEGIN
      IF current_setting('role',true) IS DISTINCT FROM 'collect_runtime' OR
         current_setting('test.work_kind',true) IS DISTINCT FROM 'http_admin'
      THEN RAISE EXCEPTION 'Admin runtime required' USING ERRCODE='42501'; END IF;
    END$$;
    CREATE FUNCTION private.burimunsi_managed_admin_snapshot() RETURNS TABLE(
      principal_user_id text,admin_id text,surface text,shared_role text) LANGUAGE sql
      AS $$SELECT 'principal','admin','admin','owner' WHERE current_setting('test.identity',true)='owner'$$;
    CREATE FUNCTION private.assert_actor(text,text,text,bigint,bigint) RETURNS text LANGUAGE plpgsql AS $$BEGIN
      IF NOT EXISTS(SELECT 1 FROM app.admin_grants WHERE user_id='principal' AND permission=$1)
        THEN RAISE EXCEPTION 'permission denied' USING ERRCODE='42501'; END IF;
      RETURN 'principal';
    END$$;
    CREATE FUNCTION private.burimunsi_pin_root_snapshot(text,text,text,text,text[]) RETURNS jsonb LANGUAGE sql
      AS $$SELECT '{}'::jsonb WHERE EXISTS(SELECT 1 FROM app.collections WHERE id=$1 AND status='active')$$;
    CREATE FUNCTION private._burimunsi_inbox_outcome(text,text) RETURNS text LANGUAGE sql AS $$SELECT 'unknown'::text$$;
    CREATE FUNCTION private.burimunsi_observation_admin_scope(p_collection text,p_sensitive boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER AS $fn$
    DECLARE a jsonb:='{"principalId":"principal"}'; BEGIN
     PERFORM set_config('burimunsi.pin_frame','1',true);
     IF NOT EXISTS(SELECT FROM private.burimunsi_operator_approvals WHERE collection_id=p_collection AND active) THEN
       RAISE EXCEPTION 'scope denied' USING ERRCODE='42501'; END IF; RETURN a; END;$fn$;
    CREATE FUNCTION private.burimunsi_observation_admin_collections() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER AS $fn$ DECLARE v jsonb; BEGIN
     PERFORM set_config('burimunsi.pin_frame','1',true);
     RETURN '[]'::jsonb; END;$fn$;
    GRANT USAGE ON SCHEMA app TO collect_runtime;
    GRANT SELECT,INSERT,UPDATE ON app.payments TO collect_runtime;
  `);
  if (seedHistoricalPayment) await db.exec("INSERT INTO app.payments(id,amount_minor) VALUES('historical-payment',1)");
  for (const migration of migrations.slice(0,-1)) await db.exec(migration);
  if (beforeNoticeMigration) await beforeNoticeMigration(client);
  await db.exec("ALTER TABLE app.collections ADD COLUMN IF NOT EXISTS title text DEFAULT 'Test savings group'");
  await db.exec(migrations.at(-1));
  const enabledAt = new Date(Date.now() - enabledAgo).toISOString();
  await db.query("INSERT INTO app.collections VALUES($1,'active')", [group]);
  await db.query("INSERT INTO app.users VALUES($1,'active','direct',$2)", [member, phone]);
  await db.query('INSERT INTO app.memberships VALUES($1,$2,1)', [group, member]);
  async function record(seed, options = {}) {
    return db.transaction(() => post(seed, options));
  }
  async function post(seed, { payer = '0788 000 001', mode = 'live', age = 10_000, postedAge = 5_000 } = {}) {
    const pay = id(seed), entry = id(seed + 1), source = id(seed + 2), event = id(seed + 3);
    const observed = new Date(Date.now() - age).toISOString();
    const posted = new Date(Date.now() - postedAge).toISOString();
    await db.query("INSERT INTO app.payments VALUES($1,$2,$3,125,'RWF','reconciled','rwanda_momo','evidence')", [pay, group, member]);
    await db.query("INSERT INTO app.ledger_entries VALUES($1,$2,$3,$4,'contribution',125,'RWF','evidence',$5,NULL)", [entry, pay, group, member, posted]);
    await db.query('INSERT INTO app.contribution_posting_snapshots VALUES($1,$2,$3,765)', [pay, entry, posted]);
    await db.query('INSERT INTO app.momo_financial_links VALUES($1,$2,$3,0)', [pay, source, member]);
    await db.query(
      "INSERT INTO app.momo_transactions VALUES($1,$2,'incoming_receipt','linked',0,'RWF',125,'wallet',$3,$4,NULL,$1,'sms_body_and_provider_profile')",
      [source, mode, payer, observed],
    );
    await db.query("INSERT INTO private.burimunsi_transaction_scopes VALUES($1,$2,'wallet',$1,'native.auto.v1')", [source, group]);
    await db.query("INSERT INTO app.notification_events VALUES($1,$2,'contribution',$3,$4)", [event, member, JSON.stringify({
      payment_id: pay, collection_id: group, amount_rwf: 125, member_balance_after_contribution_rwf: 765,
      group_balance_after_contribution_rwf: 10000, group_name: 'Test savings group', posted_at: posted,
      balance_basis: 'after_this_contribution',
    }), posted]);
    return {pay, entry, posted};
  }
  function rpc(fn, parameters, casts, kind = 'jobs', role = 'collect_runtime') {
    return db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL ROLE ${role}; SET LOCAL collect.edge_verified='true'; SET LOCAL test.work_kind='${kind}'; SET LOCAL test.identity='owner';`);
      const args = casts.map((cast, i) => `$${i + 1}::${cast}`).join(',');
      return (await tx.query(`SELECT private.${fn}(${args}) AS result`, parameters)).rows[0].result;
    });
  }
  return {
    client, db, record, post, rpc, cluster, enabledAt,group,member,phone,app,
    async adminHealth(role = 'collect_runtime', kind = 'http_admin') {
      return db.transaction(async tx => {
        await tx.exec(`SET LOCAL ROLE ${role};
          SET LOCAL collect.edge_verified='true'; SET LOCAL test.work_kind='${kind}'; SET LOCAL test.identity='owner';
          SET LOCAL burimunsi.native_receipt_frame='before'; SET LOCAL burimunsi.payment_sms_frame='before';
          SET LOCAL burimunsi.observation_frame='before'; SET LOCAL burimunsi.pin_frame='before';`);
        const result=(await tx.query('SELECT private.burimunsi_admin_sms_health() AS result')).rows[0].result;
        for (const frame of ['native_receipt','payment_sms','observation','pin']) {
          const {value}=(await tx.query('SELECT current_setting($1) AS value', ['burimunsi.'+frame+'_frame'])).rows[0];
          assert.equal(value, 'before');
        }
        return result;
      });
    },
    readiness: () => rpc('burimunsi_payment_sms_readiness', [group, enabledAt, app], ['text', 'timestamptz', 'text']),
    claim: (collection = group, kind, role) => rpc('burimunsi_claim_payment_sms', [collection, enabledAt, app, 1],
      ['text', 'timestamptz', 'text', 'integer'], kind, role),
    prepare: (r, collection = group) => rpc('burimunsi_prepare_payment_sms_v2', [collection, r.attempt_id, r.claim_token, hash], ['text', 'uuid', 'uuid', 'text']),
    finish: (r, state, providerState = null) => rpc('burimunsi_finish_payment_sms', [group, r.attempt_id, r.claim_token, state, providerState, hash],
      ['text', 'uuid', 'uuid', 'text', 'text', 'text']),
  };
}

