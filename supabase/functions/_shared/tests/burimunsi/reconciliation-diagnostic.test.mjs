import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mapObservationError } from '../../domain/burimunsi/observation-evidence.js';
import { reconciliationDiagnostic } from '../../domain/burimunsi/reconciliation-diagnostic.js';

const hash = value => createHash('sha256').update(value).digest('hex');
test('a batch 503 identifies only the original request, run and ordered page by digest', async () => {
  const id = 'dcfc0000-0000-4000-8000-000000000001';
  const run = 'dcfc0000-0000-4000-8000-000000000002';
  const keys = ['0'.repeat(64), '1'.repeat(64)];
  const body = {runId:run, items:keys.map(sourceKey => ({sourceKey, rawBody:'private fixture', rawSender:'private'}))};
  const e = mapObservationError({code:'55P03', message:'private SQL'});
  const result = await reconciliationDiagnostic(id.toUpperCase(), body, 123.7, e);
  assert.deepEqual(result, {event:'burimunsi_reconcile_503', request_sha256:hash(id), run_sha256:hash(run),
    page_sha256:hash(keys.join('\n')), items:2, duration_ms:124, cause:'database_lock_timeout'});
  assert.equal(e.status, 503);
  assert.equal(e.code, 'observation_unavailable');
  assert.equal((await reconciliationDiagnostic(id, {items:body.items.toReversed()}, 2, Error('private'))).run_sha256, null);
  assert.notEqual((await reconciliationDiagnostic(id, {items:body.items.toReversed()}, 2, e)).page_sha256, result.page_sha256);
  const generic = await reconciliationDiagnostic('private', body, 0, {code:'55P03', message:'private'});
  assert.equal(generic.cause, 'unclassified');
  assert.equal(generic.request_sha256, null);
  await assert.rejects(reconciliationDiagnostic(id,{items:[{sourceKey:'private'}]},0,e));
});
