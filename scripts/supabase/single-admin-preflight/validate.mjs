// SYNTHETIC ONLY: no SQL client, network transport, or operator entry point.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

const pin = Object.freeze({
  format: 'burimunsi-single-admin-synthetic-v1',
  base: '2e7b4a2b2fb87dde04ff9da0090a1b416fe5bce3',
  migration: '20261123061132_burimunsi_single_admin.sql',
  sql: '631c125c2caed28585d15f9e47123ba8b8347ef1422da638e38c14d11ccd42ae',
  body: 'c73920b11be890931cf1b40ca22d8be937f5857f33b5ec78b38bccacf1cee68e',
});
const before = Object.freeze({
  count: 110, tail: '20261122204000',
  digest: 'a2e678437a11012ee4be10a889fccd1cc64313fe3d3816d6ac51a8f04c892aaf',
  targetEntries: 0, targetSql: null,
});
const after = Object.freeze({
  count: 111, tail: '20261123061132',
  digest: '56949dbd4474555a1c7a0b09c01d6c28394be96aeab4f548d7269704b95cdb2c',
  targetEntries: 1, targetSql: pin.sql,
});
const absent = Object.freeze({index: null, trigger: null, guard: null});
const present = Object.freeze({
  index: Object.freeze({
    name: 'private.burimunsi_single_admin', table: 'private.burimunsi_accounts',
    key: 'collection_id', predicate: 'role=admin AND active AND NOT removed',
    unique: true, valid: true, ready: true,
  }),
  trigger: Object.freeze({
    name: 'burimunsi_refuse_new_inactive_admin', table: 'private.burimunsi_accounts',
    event: 'BEFORE INSERT OR UPDATE OF role,active,removed,collection_id',
    level: 'ROW', enabled: 'origin', guard: 'private.burimunsi_refuse_new_inactive_admin()',
  }),
  guard: Object.freeze({
    signature: 'private.burimunsi_refuse_new_inactive_admin()', returns: 'trigger',
    language: 'plpgsql', execution: 'invoker', searchPath: 'pg_catalog,pg_temp',
    publicExec: false, expectedOwner: true, exactDefinition: true,
  }),
});

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (ok, reason) => { if (!ok) throw Error(reason); };
const record = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const fields = (v, names) => record(v) && Reflect.ownKeys(v).length === names.length &&
  names.every(name => {
    const d = Object.getOwnPropertyDescriptor(v, name);
    return d && 'value' in d;
  });
const exact = (v, expected) => record(expected)
  ? fields(v, Object.keys(expected)) && Object.keys(expected).every(k => exact(v[k], expected[k]))
  : v === expected;

export function assertPinnedFile() {
  const bytes = readFileSync(new URL('../../../supabase/migrations/' + pin.migration, import.meta.url));
  need(sha(bytes) === pin.sql, 'SOURCE_SQL_DRIFT');
  const sql = bytes.toString('utf8');
  const starts = [...sql.matchAll(/^BEGIN;\s*$/gm)];
  const ends = [...sql.matchAll(/^COMMIT;\s*$/gm)];
  need(starts.length === 1 && ends.length === 1 && starts[0].index < ends[0].index, 'SOURCE_FRAME_DRIFT');
  const body = sql.slice(0, starts[0].index) + sql.slice(starts[0].index + starts[0][0].length, ends[0].index) +
    sql.slice(ends[0].index + ends[0][0].length);
  need(sha(body) === pin.body, 'SOURCE_BODY_DRIFT');
}

// The epoch is supplied by a separate synthetic intent, not adopted from the observation.
// The values below are normalized fixture assertions, never raw SQL or hosted evidence.
export function classifySynthetic(intent, observed) {
  assertPinnedFile();
  need(fields(intent, ['release', 'expectedEpoch', 'phase']) && exact(intent.release, pin), 'FIXTURE_RELEASE_MISMATCH');
  need(Number.isSafeInteger(intent.expectedEpoch) && intent.expectedEpoch > 0, 'FIXTURE_EPOCH_INVALID');
  need(['preflight', 'acknowledged', 'unknown_ack'].includes(intent.phase), 'FIXTURE_PHASE_INVALID');
  need(fields(observed, ['fence', 'admissions', 'history', 'catalog', 'conflictingActiveAdmins']), 'FIXTURE_SHAPE_INVALID');
  const held = exact(observed.fence, {mode: 'fenced', epoch: intent.expectedEpoch}) &&
    exact(observed.admissions, {ingress: 'idle', effects: 'idle', schedulers: 'settled', inFlight: 0});
  const cleanAccounts = observed.conflictingActiveAdmins === 0;
  const isBefore = exact(observed.history, before) && exact(observed.catalog, absent);
  const isAfter = exact(observed.history, after) && exact(observed.catalog, present);
  let status = 'fixture_reconciliation_required';
  if (held && cleanAccounts) {
    if (intent.phase === 'preflight' && isBefore) status = 'fixture_preimage_matches';
    if (intent.phase === 'acknowledged' && isAfter) status = 'fixture_postimage_matches';
    if (intent.phase === 'unknown_ack' && isAfter) status = 'fixture_unknown_ack_postimage_matches';
    if (intent.phase === 'unknown_ack' && isBefore) status = 'fixture_unknown_ack_preimage_matches_hold';
  }
  return Object.freeze({status, syntheticOnly: true, hostedAuthorization: false, retryAuthorized: false});
}
