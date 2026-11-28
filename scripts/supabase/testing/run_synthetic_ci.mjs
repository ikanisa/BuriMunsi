// Distinct from the Edge DATABASE_URL-backed test lane. These selected suites
// create their own fixtures and never receive active credentials or PG URLs.
import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePg17Bin } from '../current-pg-transfer/test-support/owned-pg17.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const groups = {
  operations: [
    'deploy/managed-native-ingress/worker.test.mjs',
    'deploy/managed-native-ingress/handler-integration/handler-integration.test.mjs',
    'deploy/collect-sms/test/ledger_snapshot_receipt_guard.test.mjs',
    'scripts/supabase/cloud-release/active-managed-jobs-handler.test.mjs',
    'scripts/supabase/cloud-release/managed-jobs-operator.test.mjs',
    'scripts/supabase/cloud-release/managed-jobs-handler.test.mjs',
    'scripts/supabase/storage-inventory-verify/verify.test.mjs',
    'scripts/supabase/storage-inventory-verify/readback.test.mjs',
  ],
  'owned-pg': [
    'scripts/qa/fresh_receipt_witness.test.mjs',
    'scripts/supabase/current-pg-transfer/recovery-rehearsal/prepare-service-data.test.mjs',
    'scripts/supabase/cloud-release/burimunsi-automatic-receipt-e2e.test.mjs',
    'scripts/supabase/cloud-release/burimunsi-event-driven-jobs.test.mjs',
    'scripts/supabase/cloud-release/burimunsi-gateway-admission.test.mjs',
    'scripts/supabase/cloud-release/burimunsi-gateway-wake.test.mjs',
    'scripts/supabase/cloud-release/burimunsi-inbox-storage-page.test.mjs',
    'scripts/supabase/cloud-release/burimunsi-member-statement.test.mjs',
    'scripts/supabase/cloud-release/burimunsi-membership-record-number.test.mjs',
    'scripts/supabase/cloud-release/burimunsi-web-directory.test.mjs',
    'scripts/supabase/cloud-release/burimunsi-payment-reference.test.mjs',
  ],
};

// Child tests explicitly install their own gateway, HTTP and object doubles.
// This gives default fetch no network authority, while allowing owned PG Unix
// sockets and Deno fixture drivers with their own frozen/offline permissions.
const noDefaultFetch = 'data:text/javascript,globalThis.fetch=async()=>%7Bthrow%20Error(%22SYNTHETIC_FETCH_NOT_INJECTED%22)%7D';
const fail = code => { throw new Error(code); };
try {
  const lane = process.argv[2];
  if (process.argv.length !== 3 || !Object.hasOwn(groups, lane)) fail('SELECT_OPERATIONS_OR_OWNED_PG');
  if (process.versions.node !== '24.19.0') fail('NODE_24_19_0_REQUIRED');
  const env = {PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C'};
  for (const key of ['HOME', 'TMPDIR', 'DENO_DIR']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  if (lane === 'owned-pg') {
    if (process.getuid?.() === 0) fail('NON_ROOT_OWNED_PG_REQUIRED');
    const bin = resolvePg17Bin();
    for (const name of ['pg_dump', 'pg_restore']) accessSync(join(bin, name), constants.X_OK);
    env.COLLECT_SYNTHETIC_PG_BIN = normalize(bin);
    const deno = spawnSync('deno', ['--version'], {cwd: root, env, encoding: 'utf8', timeout: 5000});
    if (deno.status !== 0 || !/^deno 2[.]9[.]6 /.test(deno.stdout ?? '')) fail('DENO_2_9_6_REQUIRED');
  }
  const result = spawnSync(process.execPath, [
    '--experimental-transform-types', '--import', noDefaultFetch, '--test', '--test-concurrency=1', '--test-timeout=90000', ...groups[lane],
  ], {cwd: root, env, stdio: 'inherit'});
  if (result.error || result.signal || result.status === null) fail('SYNTHETIC_CI_RUNNER_FAILED');
  process.exitCode = result.status;
} catch (error) {
  console.error('Synthetic CI: ' + error.message);
  process.exitCode = 1;
}
