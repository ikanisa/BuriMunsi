// PostgreSQL boundary test, not hosted or HTTP authentication qualification.
// Reuses the production query text and DDL; synthetic scope and dispatch are
// intentionally separate from Edge session checks and browser fault injection.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadBuriPostgresFixture} from './postgres-fixture.mjs';
import {COLLECT_MUTATION_LOCK} from '../../postgres-mutation-lock.js';

const fixture=loadBuriPostgresFixture();
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const migration=name=>read('../../../../migrations/'+name);

function query(source, prefix) {
 const literals=source.split('`').filter((s,i)=>i%2===1&&s.startsWith(prefix));
 assert.equal(literals.length,1,'Expected exact production SQL: '+prefix);
 assert(!literals[0].includes('${'),'Dynamic SQL needs an explicit test fixture contract');
 return '$q$'+literals[0]+'$q$';
}
function table(source, name) {
 const prefix='CREATE TABLE '+name+' (';
 const start=source.indexOf(prefix), end=source.indexOf('\n);',start);
 assert(start>=0&&end>start);
 return source.slice(start,end+3);
}

test('native allocation recovery preserves one committed payment and original-session receipt', {skip:!fixture},()=>{
 const admin=read('../../domain/admin_burimunsi_payments.js');
 const pay=read('../../domain/burimunsi/postgres-payments.js');
 const schema=migration('20261124114500_burimunsi_payments.sql');
 const commands=migration('20261109234517_burimunsi_native_operator_schema.sql');
 const rls=schema.match(/CREATE POLICY burimunsi_payments_scope[\s\S]+?;/)?.[0];
 const ack=query(admin,'SELECT r.response,p.member_id,p.version::text AS payment_version');
 const prior=query(admin,'SELECT session_id,operation,fingerprint,response FROM private.burimunsi_command_receipts');
 const insert=query(admin,'INSERT INTO private.burimunsi_command_receipts');
 const member=query(pay,'SELECT m.user_id FROM app.memberships');
 const update=query(pay,'UPDATE burimunsi.payments SET member_id=');
 assert(rls);

 const setup=`
   CREATE ROLE collect_runtime;
   CREATE SCHEMA app;
   CREATE SCHEMA private;
   CREATE SCHEMA burimunsi;
   CREATE TABLE private.burimunsi_accounts(id uuid,collection_id text,PRIMARY KEY(id,collection_id));
   CREATE TABLE private.burimunsi_scopes(collection_id text PRIMARY KEY);
   CREATE TABLE app.momo_receiving_accounts(id text PRIMARY KEY);
   CREATE TABLE app.sms_receipts(id text PRIMARY KEY);
   CREATE TABLE app.users(id text PRIMARY KEY,access_status text,member_type text);
   CREATE TABLE app.memberships(collection_id text,user_id text,active integer,PRIMARY KEY(collection_id,user_id));
   ${table(schema,'burimunsi.payments')}
   ${table(commands,'private.burimunsi_command_receipts')}
   ALTER TABLE burimunsi.payments ENABLE ROW LEVEL SECURITY;
   ALTER TABLE burimunsi.payments FORCE ROW LEVEL SECURITY;
   ${rls}
   GRANT USAGE ON SCHEMA app,private,burimunsi TO collect_runtime;
   GRANT SELECT,UPDATE ON app.users,app.memberships TO collect_runtime;
   GRANT SELECT,UPDATE (member_id, version, updated_at) ON burimunsi.payments TO collect_runtime;
   GRANT SELECT,INSERT,UPDATE ON private.burimunsi_command_receipts TO collect_runtime;
   INSERT INTO private.burimunsi_accounts VALUES ('11111111-1111-4111-8111-111111111111','synthetic-group'),('22222222-2222-4222-8222-222222222222','synthetic-group');
   INSERT INTO private.burimunsi_scopes VALUES ('synthetic-group'),('other-group');
   INSERT INTO app.momo_receiving_accounts VALUES ('wallet');
   INSERT INTO app.users VALUES ('member-a','active','member'),('member-b','active','member');
   INSERT INTO app.memberships VALUES ('synthetic-group','member-a',1),('synthetic-group','member-b',1);
   INSERT INTO burimunsi.payments(id, collection_id, receiving_account_id, provider, direction, amount_rwf)
     VALUES ('first','synthetic-group','wallet','synthetic','incoming',100),('rollback','synthetic-group','wallet','synthetic','incoming',150),
            ('other','other-group','wallet','synthetic','incoming',999);
   CREATE FUNCTION public.fixture_allocate(akey uuid,skey uuid,rkey uuid,pkey text,mkey text,ver bigint,fail_insert boolean)
   RETURNS jsonb LANGUAGE plpgsql AS $fn$
   DECLARE old record; m record; p record; reply jsonb; fp text:=repeat(CASE mkey WHEN 'member-a' THEN 'a' ELSE 'b' END,64);
   BEGIN
      PERFORM pg_advisory_xact_lock(${COLLECT_MUTATION_LOCK}::bigint);
      PERFORM set_config('burimunsi.collection_id','synthetic-group',true);
      EXECUTE ${prior} INTO old USING 'synthetic-group',akey,rkey;
      IF old.session_id IS NOT NULL THEN
        IF old.session_id<>skey OR old.operation<>'burimunsi.allocate' OR old.fingerprint<>fp THEN
          RAISE EXCEPTION 'fixture idempotency conflict' USING ERRCODE='P0001';
        END IF;
        RETURN old.response;
      END IF;
      EXECUTE ${member} INTO m USING 'synthetic-group',mkey;
      IF m.user_id IS DISTINCT FROM mkey THEN RAISE EXCEPTION 'member unavailable'; END IF;
      EXECUTE ${update} INTO p USING 'synthetic-group',pkey,mkey,ver;
      IF p.id IS DISTINCT FROM pkey OR p.member_id IS DISTINCT FROM mkey OR p.allocation_state <> 'allocated' THEN
        RAISE EXCEPTION 'payment changed';
      END IF;
      reply:=jsonb_build_object('paymentId',p.id,'memberId',p.member_id,'state',p.allocation_state,'version',p.version);
      EXECUTE ${insert} USING 'synthetic-group',akey,rkey,skey,'burimunsi.allocate',
        CASE WHEN fail_insert THEN 'deliberately-invalid' ELSE fp END,reply,0::bigint;
      RETURN reply;
   END;
   $fn$;
   CREATE FUNCTION public.fixture_receipt(akey uuid,skey uuid,rkey uuid,pkey text) RETURNS text
   LANGUAGE plpgsql AS $fn$
   DECLARE found record;
   BEGIN
      PERFORM set_config('burimunsi.collection_id','synthetic-group',true);
      EXECUTE ${ack} INTO found USING 'synthetic-group',akey,rkey,skey,'burimunsi.allocate',pkey;
      IF found.response IS NULL THEN RETURN 'unconfirmed'; END IF;
      IF found.member_id IS DISTINCT FROM found.response->>'memberId' OR
         found.payment_version IS DISTINCT FROM found.response->>'version' THEN RETURN 'inconsistent'; END IF;
      RETURN found.payment_version;
   END;
   $fn$;
 `;
 const run=sql=>{
    const result=fixture.run('postgres',['-Atq'],sql);
    assert.equal(result.status,0,result.stderr);
    return result.stdout.trim().split('\n').filter(Boolean);
 };
 run(setup);
 const actor="'11111111-1111-4111-8111-111111111111'",otherActor="'22222222-2222-4222-8222-222222222222'";
 const session="'33333333-3333-4333-8333-333333333333'",otherSession="'44444444-4444-4444-8444-444444444444'";
 const key="'55555555-5555-4555-8555-555555555555'",fresh="'66666666-6666-4666-8666-666666666666'";
 const runtime=sql=>run('SET ROLE collect_runtime;'+sql);
 // The original acknowledgement is intentionally not used. A different
 // PostgreSQL connection has to recover it after the original transaction.
 runtime(`SELECT public.fixture_allocate(${actor},${session},${key},'first','member-a',1,false);`);
 assert.deepEqual(runtime(`
  SELECT public.fixture_receipt(${actor},${session},${key},'first');
  SELECT public.fixture_receipt(${actor},${otherSession},${key},'first');
  SELECT public.fixture_receipt(${otherActor},${session},${key},'first');
  SELECT public.fixture_receipt(${actor},${session},${key},'other');
  SELECT public.fixture_allocate(${actor},${session},${key},'first','member-a',1,false)->>'version';
 `),['2','unconfirmed','unconfirmed','unconfirmed','2']);
 runtime(`
  DO $done$ BEGIN
   BEGIN
    PERFORM public.fixture_allocate(${actor},${session},${key},'first','member-b',1,false);
    RAISE EXCEPTION 'expected conflict was absent' USING ERRCODE='XX000';
   EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'fixture idempotency conflict' THEN RAISE; END IF;
   END;
   BEGIN
    PERFORM public.fixture_allocate(${actor},${session},${fresh},'first','member-a',1,false);
    RAISE EXCEPTION 'stale new request unexpectedly accepted' USING ERRCODE='XX000';
   EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'payment changed' THEN RAISE; END IF;
   END;
   BEGIN
    PERFORM public.fixture_allocate(${actor},${session},${fresh},'rollback','member-a',1,true);
    RAISE EXCEPTION 'expected receipt write failure was absent';
   EXCEPTION WHEN check_violation THEN NULL; END;
  END $done$;
 `);
 assert.deepEqual(runtime(`
  BEGIN;
  SELECT set_config('burimunsi.collection_id','synthetic-group',true);
  UPDATE burimunsi.payments SET version=3 WHERE id='first';
  SELECT public.fixture_receipt(${actor},${session},${key},'first');
  ROLLBACK;
 `),['synthetic-group','inconsistent']);
 assert.deepEqual(run(`
  SELECT id||':'||version||':'||allocation_state||':'||amount_rwf FROM burimunsi.payments ORDER BY id;
  SELECT count(*) FROM private.burimunsi_command_receipts;
 `),['first:2:allocated:100','other:1:unallocated:999','rollback:1:unallocated:150','1']);
});
