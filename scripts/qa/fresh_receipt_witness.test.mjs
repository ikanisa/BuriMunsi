// Runs production witness SQL only against a test-owned, Unix-socket cluster.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startOwnedPg17 } from '../supabase/current-pg-transfer/test-support/owned-pg17.mjs';

const fixtureSql = fileURLToPath(new URL('./fresh_receipt_witness.fixture.sql', import.meta.url));
const migration = fileURLToPath(new URL('../../supabase/migrations/20261124114500_burimunsi_payments.sql', import.meta.url));
const witness = fileURLToPath(new URL('./fresh_receipt_witness.sql', import.meta.url));
const defaultBindings = {
  collection_id: 'group-a', receiving_account_id: 'wallet-a', provider: 'm-money',
  provider_reference: '0001', amount_rwf: '1000',
  start: '2026-11-24T10:00:00+02:00', end: '2026-11-24T10:10:00+02:00',
};

test('fresh receipt witness checks exactly one scoped and timely SMS-linked payment', async t => {
  const cluster = await startOwnedPg17({ prefix: 'collect-pg-transfer-', initialUser: 'collect_fixture' });
  t.after(async () => assert.equal((await cluster.close()).removed, true));
  const psql = (role, args, input = '') => spawnSync(join(cluster.bin, 'psql'),
    ['-XqwAt', '-h', cluster.socket, '-p', String(cluster.port), '-d', 'postgres',
      '-U', role, '-v', 'ON_ERROR_STOP=1', ...args], {
      input, encoding: 'utf8', env: { ...cluster.env, PGCONNECT_TIMEOUT: '3' },
      timeout: 8000, maxBuffer: 32768,
    });
  const setup = psql(cluster.initialUser, ['-f', fixtureSql, '-f', migration, '-f', '-'], `
    SET ROLE postgres;
    INSERT INTO burimunsi.raw_sms VALUES
      ('new-sms','group-a',repeat('a',64),decode('ff','hex'),'2026-11-24T08:01:00Z'),
      ('old-sms','group-a',repeat('b',64),decode('ff','hex'),'2026-11-24T07:59:00Z'),
      ('other-sms','group-b',repeat('c',64),decode('ff','hex'),'2026-11-24T08:01:00Z');
    INSERT INTO burimunsi.payments
      (id,collection_id,receiving_account_id,provider,provider_reference,direction,amount_rwf,
       occurred_at,created_at,sms_source_id)
    VALUES
      ('current','group-a','wallet-a','m-money','0001','incoming',1000,'2026-11-24T08:00:00Z','2026-11-24T08:02:00Z','new-sms'),
      ('outbound','group-a','wallet-a','m-money','0002','outgoing',1000,'2026-11-24T08:00:00Z','2026-11-24T08:02:00Z',null),
      ('earlier-capture','group-a','wallet-a','m-money','0003','incoming',1000,'2026-11-24T08:00:00Z','2026-11-24T08:02:00Z','old-sms'),
      ('other-group','group-b','wallet-a','m-money','0001','incoming',1000,'2026-11-24T08:00:00Z','2026-11-24T08:02:00Z','other-sms'),
      ('other-wallet','group-a','wallet-b','m-money','0001','incoming',1000,'2026-11-24T08:00:00Z','2026-11-24T08:02:00Z',null),
      ('other-provider','group-a','wallet-a','wallet-other','0001','incoming',1000,'2026-11-24T08:00:00Z','2026-11-24T08:02:00Z',null);
  `);
  assert.equal(setup.status, 0, setup.stderr);
  const run = (override = {}, role = 'collect_runtime') => psql(role, [
    ...Object.entries({ ...defaultBindings, ...override }).flatMap(([key, val]) => ['-v', `${key}=${val}`]),
    '-f', witness,
  ]);

  for (const [label, override, expected] of [
    ['exact match, no cross-scope double count', {}, [1,1,1]],
    ['same reference on second read', {}, [1,1,1]],
    ['wrong amount', {amount_rwf:'999'}, [1,0,0]],
    ['creation exactly at exclusive cutoff', {end:'2026-11-24T08:02:00Z'}, [1,1,0]],
    ['capture timestamp outside window', {provider_reference:'0003'}, [1,1,0]],
    ['outgoing record', {provider_reference:'0002'}, [1,0,0]],
    ['exact reference retains leading zeroes', {provider_reference:'1'}, [0,0,0]],
  ]) await t.test(label, () => {
    const result = run(override);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      visible_reference_rows: expected[0], matching_incoming_rows: expected[1], fresh_sms_linked_rows: expected[2],
    });
  });
  await t.test('invalid windows return no result', () => {
    for (const end of ['2026-11-26T12:00:00Z', '2026-11-24T07:59:59Z', '2026-11-24T08:10:00']) {
      const result = run({end});
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /invalid_fresh_receipt_witness_input/);
    }
  });
  await t.test('anonymous role cannot read witness rows', () => {
    const result = run({}, 'anon');
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /permission denied/);
  });
});
