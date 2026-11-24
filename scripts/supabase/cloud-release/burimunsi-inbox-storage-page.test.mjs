import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import pg from '../node_modules/pg/lib/index.js';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';

test('a complete SMS page uses one fenced storage transaction and retains each individual object proof', async t => {
  const cluster = await startOwnedPg17({prefix:'collect-pg-transfer-', initialUser:'collect_fixture'});
  const client = new pg.Client({host:cluster.socket, port:cluster.port, database:'postgres', user:cluster.initialUser});
  t.after(async () => {try {await client.end();} finally {await cluster.close();}});
  await client.connect();
  const migration = await readFile(new URL('../../../supabase/migrations/20261020134444_collect_curated_platform_baseline.sql', import.meta.url), 'utf8');
  const tables = migration.slice(migration.indexOf('CREATE TABLE private.storage_namespace ('), migration.indexOf('-- One canonical metadata writer.'));
  assert.ok(tables.startsWith('CREATE TABLE private.storage_namespace (') && tables.includes('CREATE TABLE private.storage_objects ('));
  await client.query('CREATE SCHEMA private; CREATE ROLE collect_runtime; ' + tables);
  await client.query(`GRANT USAGE ON SCHEMA private TO collect_runtime;
    GRANT SELECT ON ALL TABLES IN SCHEMA private TO collect_runtime;
    GRANT INSERT ON private.storage_namespace TO collect_runtime;
    INSERT INTO private.storage_namespace (singleton,origin,bucket) VALUES(true,'https://fixture.invalid','private-evidence');
    INSERT INTO private.storage_put_intents (object_key,operation_id,sha256,fingerprint,size,scope,http_metadata,custom_metadata,state)
      SELECT 'sms/item-'||i, 'test-read-'||i, encode(sha256(convert_to('envelope-'||i,'UTF8')),'hex'), repeat('a',64),
        octet_length('envelope-'||i),jsonb_build_object('ownerId','one','entityId','item-'||i,'purpose','sms_receipt'),
        '{"contentType":"application/octet-stream"}','{}','committed'
      FROM generate_series(1,10) AS item(i);
    INSERT INTO private.storage_objects (object_key,operation_id,sha256,fingerprint,size,scope,http_metadata,custom_metadata)
      SELECT object_key,operation_id,sha256,fingerprint,size,scope,http_metadata,custom_metadata FROM private.storage_put_intents`);
  const driver = fileURLToPath(new URL('./fixtures/burimunsi-page-storage-driver.mjs', import.meta.url));
  const lock = fileURLToPath(new URL('../deno.lock', import.meta.url));
  const endpoint = cluster.socket+'/.s.PGSQL.'+cluster.port;
  const output = execFileSync('deno',['run','--frozen','--cached-only','--node-modules-dir=none','--lock='+lock,
    '--allow-read','--allow-env','--allow-net=unix:'+endpoint,'--allow-write='+endpoint,driver,cluster.socket,String(cluster.port)],
    {timeout:30000,encoding:'utf8'});
  const proof = JSON.parse(output);
  assert.equal(proof.original.transactions,20);
  assert.equal(proof.page.transactions,1);
  assert.equal(proof.original.objects,10);
  assert.equal(proof.page.objects,10);
  assert.ok(proof.page.leaseChecks < proof.original.leaseChecks);
  t.diagnostic(JSON.stringify(proof));
});
