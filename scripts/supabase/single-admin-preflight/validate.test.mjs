import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertPinnedFile, classifySynthetic} from './validate.mjs';
import {scenario} from './fixture.mjs';

const blocked = 'fixture_reconciliation_required';
function check(status, args) {
  assert.deepEqual(classifySynthetic(...args), {status, syntheticOnly: true, hostedAuthorization: false, retryAuthorized: false});
}
test('pins exact original and transaction body without executing either', assertPinnedFile);
test('classifies both exact states and only their valid phases', () => {
  check('fixture_preimage_matches', scenario());
  check('fixture_postimage_matches', scenario('acknowledged', true));
  check(blocked, scenario('preflight', true));
  check(blocked, scenario('acknowledged', false));
});
test('unknown ACK plus committed state never retries; matching preimage only holds', () => {
  check('fixture_unknown_ack_postimage_matches', scenario('unknown_ack', true));
  check('fixture_unknown_ack_preimage_matches_hold', scenario('unknown_ack'));
});
test('fence, epoch, independent busy lanes and existing duplicate reject an otherwise matching pair', () => {
  for (const change of [
    o => o.fence.mode = 'open', o => o.fence.epoch++,
    o => o.admissions.ingress = 'busy', o => o.admissions.effects = 'busy',
    o => o.admissions.schedulers = 'unknown', o => o.admissions.inFlight = 1,
    o => o.conflictingActiveAdmins = 1,
  ]) for (const args of [scenario(), scenario('unknown_ack', true)]) {
    change(args[1]); check(blocked, args);
  }
});
test('mixed data/catalog states and tampering despite matching count stay blocked', () => {
  for (const change of [
    o => o.history.digest = '0'.repeat(64), o => o.history.targetEntries = 2, o => o.history.targetSql = null,
    o => o.catalog.index.predicate = 'role=admin', o => o.catalog.index.valid = false,
    o => o.catalog.trigger.enabled = 'disabled', o => o.catalog.trigger.event = 'INSERT',
    o => o.catalog.guard.publicExec = true, o => o.catalog.guard.expectedOwner = false,
    o => o.catalog.guard.exactDefinition = false, o => o.catalog.guard = null,
    o => o.catalog = scenario()[1].catalog, o => o.history = scenario()[1].history,
  ]) {
    const args = scenario('unknown_ack', true);
    change(args[1]); check(blocked, args);
  }
});
test('strict evidence shape and exact source/intent pins reject unrecognized data', () => {
  let args = scenario(); args[0].release.base = 'a'.repeat(40);
  assert.throws(() => classifySynthetic(...args), /FIXTURE_RELEASE_MISMATCH/);
  args = scenario(); args[0].expectedEpoch = NaN;
  assert.throws(() => classifySynthetic(...args), /FIXTURE_EPOCH_INVALID/);
  args = scenario('ready');
  assert.throws(() => classifySynthetic(...args), /FIXTURE_PHASE_INVALID/);
  args = scenario(); args[1].extra = true;
  assert.throws(() => classifySynthetic(...args), /FIXTURE_SHAPE_INVALID/);
  args = scenario(); Object.defineProperty(args[1].fence, 'epoch', {get: () => { throw Error('not executed'); }});
  check(blocked, args);
});
