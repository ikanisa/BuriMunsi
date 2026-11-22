import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {isAbsolute, join} from 'node:path';
import {privateDirectory, readPrivateFile} from '../current-archive/bundle.mjs';
import {HASH, canonical} from '../current-archive/codec.mjs';
import {assertCleanEnvironment} from '../managed-cloud-migrations/operator-core.mjs';
import {management} from './access.mjs';
import {
  forwardMigrationSnapshotSql,
  loadForwardMigrationPlan,
  renderForwardMigrationReconciliationSql,
  renderForwardMigrationSql,
  validateForwardMigrationSnapshot,
} from './forward-migration.mjs';
import {writeReleaseEvidence} from './write-release-evidence.mjs';

const format = 'collect.managed-forward-release.v1';

async function query(api, sql, readOnly = false) {
  // The provider's read_only flag switches to a limited role. Audit the
  // owner-only catalog within a read-only transaction using the owner session.
  const query = readOnly
    ? `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
       SET LOCAL jit=off;
       SET LOCAL statement_timeout='8s';
       ${sql}; ROLLBACK;`
    : `BEGIN ISOLATION LEVEL READ COMMITTED;
       SET LOCAL jit=off;
       SET LOCAL statement_timeout='20s';
       SET LOCAL work_mem='4MB';
       SET LOCAL maintenance_work_mem='16MB';
       SET LOCAL max_parallel_maintenance_workers=0;
       ${sql} COMMIT;`;
  const response = await api('database/query', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({query}),
  });
  return readOnly ? response.json() : undefined;
}

async function observe(api, plan, options) {
  const rows = await query(api, forwardMigrationSnapshotSql(), true);
  assert.ok(Array.isArray(rows) && rows.length === 1
    && Number.isSafeInteger(rows[0].backend_pid) && rows[0].backend_pid > 0,
  'forward_migration_snapshot_missing');
  const {snapshot, backend_pid} = rows[0];
  return {snapshot, backend_pid, ...validateForwardMigrationSnapshot(plan, snapshot, options)};
}

async function witness(api, plan, options) {
  const first = await observe(api, plan, options);
  const second = await observe(api, plan, options);
  assert.equal(first.capture_sha256, second.capture_sha256, 'forward_migration_witness_changed');
  return {...second, witness_backend_pids: [first.backend_pid, second.backend_pid]};
}

async function reconcile(api, plan, directory, intentFile, options, renderOptions) {
  const {version, captureSha256} = renderOptions;
  const intent = JSON.parse(await readPrivateFile(join(directory, intentFile), 65536));
  assert.ok(intent.format === format && intent.version === version
    && intent.capture_sha256 === captureSha256, 'forward_migration_intent_changed');
  const proposal = renderForwardMigrationSql(plan, intent.before, renderOptions);
  assert.equal(intent.sql_sha256, proposal.sql_sha256, 'forward_migration_intent_source_changed');
  await query(api, renderForwardMigrationReconciliationSql(plan, intent.before, renderOptions));
  const observed = await witness(api, plan, options);
  const recorded = canonical(proposal.after) === canonical(observed.snapshot);
  assert.ok(recorded || captureSha256 === observed.capture_sha256, 'forward_migration_outcome_unrecognized');
  const result = {status: recorded ? 'recorded' : 'rolled_back', version,
    sql_sha256: proposal.sql_sha256, observed, at: new Date().toISOString()};
  await writeReleaseEvidence(directory, version + '-managed-reconcile-' + randomUUID() + '.json', result);
  return result;
}

export async function runManagedForwardRelease(
  args,
  {api = management, fixtureDatabase = null} = {},
) {
  const [action, version, captureSha256, evidenceDirectory] = args;
  const inspect = action === 'inspect' && args.length === 1;
  assert.ok(inspect || (['apply', 'reconcile', 'retry'].includes(action) && args.length === 4
    && /^\d{14}$/.test(version) && HASH.test(captureSha256) && isAbsolute(evidenceDirectory)),
  'usage: apply.mjs --managed-forward {inspect | apply|reconcile|retry VERSION CAPTURE_SHA256 PRIVATE_DIRECTORY}');
  assertCleanEnvironment(process.env);
  const plan = await loadForwardMigrationPlan();
  if (inspect) return {status: 'observed', ...await witness(api, plan, {fixtureDatabase})};

  const directory = await privateDirectory(evidenceDirectory);
  const options = {requireFenced: true, fixtureDatabase};
  const renderOptions = {version, captureSha256, fixtureDatabase};
  const intentFile = version + '-managed-intent.json';
  if (action !== 'apply') {
    const result = await reconcile(api, plan, directory, intentFile, options, renderOptions);
    if (action === 'reconcile' || result.status === 'recorded') return result;
  }

  const before = await witness(api, plan, options);
  const proposal = renderForwardMigrationSql(plan, before.snapshot, renderOptions);
  const attemptFile = action === 'apply' ? intentFile : version + '-managed-retry-' + randomUUID() + '.json';
  await writeReleaseEvidence(directory, attemptFile, {format, version, capture_sha256: captureSha256,
    sql_sha256: proposal.sql_sha256, before: before.snapshot, at: new Date().toISOString()});
  try {
    await query(api, proposal.sql);
    const observed = await witness(api, plan, options);
    assert.deepEqual(observed.snapshot, proposal.after, 'forward_migration_readback_changed');
    const result = {status: 'applied_and_read_back', version, sql_sha256: proposal.sql_sha256,
      observed, at: new Date().toISOString()};
    await writeReleaseEvidence(directory, version + '-managed-complete.json', result);
    return result;
  } catch (error) {
    throw new Error('forward_migration_reconcile_required', {cause: error});
  }
}
