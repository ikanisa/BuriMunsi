import test from 'node:test';
import assert from 'node:assert/strict';
import {PROJECT, sha} from './access.mjs';
import {reviseRuntimeViaManagement} from './management-revision.mjs';

const previous = 'a'.repeat(64), next = 'b'.repeat(64);
const preimages = {BURIMUNSI_PRODUCT_MODE: sha('standalone'), BURIMUNSI_COLLECTION_ID: sha('synthetic-collection')};
const owner = {session_user: 'postgres', current_user: 'postgres', current_database: 'postgres',
  version: 170006, isolation: 'read committed', project: PROJECT};

function fixture({identity = owner, unknownQuiesce = false} = {}) {
  const queries = [], records = [];
  let current = {mode: 'open', epoch: '10', operation_id: null, source_sha256: previous};
  let functions = ['collect-api', 'admin-api', 'collect-jobs'].map((slug, i) => ({
    slug, id: `00000000-0000-4000-8000-00000000000${i}`, status: 'ACTIVE',
    verify_jwt: false, version: 1, ezbr_sha256: previous,
  }));
  const input = {label: 'fixture-revision', testEvidence: {passed: true, sourceSha256: next},
    expectedBefore: {mode: 'open', epoch: 10, source_sha256: previous},
    expectedFunctions: functions, expectedSecretPreimages: preimages, requireChangedBundles: true};
  let sourceSecret = previous;
  const result = (value, status = 201) => ({status, json: () => structuredClone(value)});
  const dependencies = {
    captureSnapshot: () => ({sourceSha: next, summary: () => ({sourceSha256: next}), makeForm: slug => slug}),
    check: () => ({status: 'passed', sourceSha256: next}),
    readRegistration: () => null,
    save(name) { records.push(name); },
    async api(path, options) {
      if (path === 'secrets') {
        if (options) {
          const changes = JSON.parse(options.body);
          assert.deepEqual(changes, [{name: 'BUILD_SOURCE_ID', value: next}]);
          sourceSecret = next;
        }
        return result(Object.entries({...preimages, BUILD_SOURCE_ID: sha(sourceSecret)})
          .map(([name, value]) => ({name, value})));
      }
      if (path === 'functions') return result(functions);
      if (path.startsWith('functions/deploy?slug=')) {
        assert.equal(options.body, path.split('=')[1]);
        functions = functions.map(row => row.slug === options.body
          ? {...row, version: 2, ezbr_sha256: next} : row);
        return result({version: 2});
      }
      assert.equal(path, 'database/query');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/json');
      const body = JSON.parse(options.body);
      queries.push(body);
      assert.equal(body.read_only, false);
      assert.ok(!body.query.includes(';'));
      if (body.query.startsWith('SELECT session_user,')) return result([identity]);
      if (body.query.startsWith('SELECT mode,epoch,')) return result([current]);
      if (body.query.startsWith('SELECT count(*)::int n')) return result([{n: 0}]);
      if (body.query.startsWith('SELECT private._collect_fence_scheduler_status()')) {
        return result([{status: {checked: true, coverageVerified: true, blocking: false}}]);
      }
      if (body.query.includes('FROM supabase_migrations.schema_migrations'.toLowerCase())) return result([]);
      const [operation, value, source, from, to] = body.parameters;
      assert.ok(/\$1::uuid/.test(body.query));
      if (body.query.includes('collect_fence_begin_quiesce')) {
        assert.equal(value, '10'); assert.equal(source, previous);
        if (unknownQuiesce) throw Error('lost acknowledgement');
        current = {...current, mode: 'quiescing', operation_id: operation};
      } else if (body.query.includes('collect_fence_drain_v3')) {
        assert.equal(operation, current.operation_id);
        assert.equal(value, '10'); assert.equal(source, previous);
        current = {...current, mode: 'fenced'};
      } else if (body.query.includes('collect_fence_upgrade_source_v3')) {
        assert.equal(value, current.operation_id);
        assert.equal(source, '10'); assert.equal(from, previous); assert.equal(to, next);
        current = {mode: 'fenced', epoch: '11', operation_id: operation, source_sha256: next};
      } else {
        assert.match(body.query, /collect_fence_release_v3/);
        assert.equal(value, '11'); assert.equal(source, next);
        current = {mode: 'open', epoch: '12', operation_id: operation, source_sha256: next};
      }
      return result([{v: current}]);
    },
  };
  return {input, dependencies, records, queries};
}

test('Management transport runs the real initial revision using only bound single statements', async () => {
  const f = fixture();
  assert.deepEqual(await reviseRuntimeViaManagement(f.input, f.dependencies),
    {status: 'revision_deployed_live', sourceSha256: next, epoch: '12'});
  assert.deepEqual(f.queries.filter(q => q.parameters.length).map(q => q.query.split('(')[0]), [
    'SELECT private.collect_fence_begin_quiesce', 'SELECT private.collect_fence_drain_v3',
    'SELECT private.collect_fence_upgrade_source_v3', 'SELECT private.collect_fence_release_v3',
  ]);
  assert.equal(f.records[0], 'revision-fixture-revision-intent.json');
  assert.equal(f.records.at(-1), 'revision-fixture-revision-complete.json');
});

test('Management transport refuses migration, resume and unbound standalone configuration', async () => {
  const f = fixture();
  for (const input of [{migrations: [{}]}, {resumeFencedRevision: 'prior'},
    {acceptAncillaryRequalification: true}, {expectedSecretPreimages: null},
    {expectedSecretPreimages: {...preimages, BURIMUNSI_PRODUCT_MODE: sha('collect')}}]) {
    await assert.rejects(reviseRuntimeViaManagement({...f.input, ...input}, {
      api() { assert.fail('unsupported operation reached the provider'); },
    }), /initial_standalone_management_revision_required/);
  }
});

test('Management transport verifies PostgreSQL project, owner, version and transaction isolation first', async () => {
  for (const identity of [{...owner, current_user: 'supabase_read_only_user'}, {...owner, project: 'foreign'},
    {...owner, version: 160001}, {...owner, isolation: 'serializable'}]) {
    const f = fixture({identity});
    await assert.rejects(reviseRuntimeViaManagement(f.input, f.dependencies), /cloud_identity_mismatch/);
    assert.equal(f.queries.length, 1);
    assert.equal(f.records.length, 0);
  }
});

test('an uncertain fence write is sent once and stops at its existing intent', async () => {
  const f = fixture({unknownQuiesce: true});
  await assert.rejects(reviseRuntimeViaManagement(f.input, f.dependencies), {
    message: 'management_revision_write_outcome_unknown', outcome: 'commit_requires_reconciliation',
  });
  assert.equal(f.queries.filter(query => query.parameters.length).length, 1);
  assert.deepEqual(f.records, ['revision-fixture-revision-intent.json']);
});
