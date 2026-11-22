// Supabase Management API SQL over independent, owner-authorized transactions.
// https://supabase.com/docs/reference/api/v1-run-a-query
import {management, PROJECT, sha} from './access.mjs';
import {requireSecretPreimages, reviseRuntime} from './revise-runtime.mjs';

const identity = "SELECT session_user,current_user,current_database(),current_setting('server_version_num')::int AS version,current_setting('transaction_isolation') AS isolation,(SELECT project_ref FROM private.collect_fence_control WHERE singleton) AS project";
const fence = 'SELECT mode,epoch,operation_id,source_sha256 FROM private.collect_fence_control WHERE singleton';
const admissions = "SELECT count(*)::int n FROM private.collect_fence_admissions a WHERE state IN('active','unresolved') AND NOT private._collect_stopped_matches(a.admission_id,a.epoch,a.source_sha256,a.kind)";
const scheduler = 'SELECT private._collect_fence_scheduler_status() AS status';
const history = "select version,name,encode(sha256(convert_to(statements[1],'UTF8')),'hex') sha256,cardinality(statements)::int entries from supabase_migrations.schema_migrations order by version";
const reads = new Set([identity, fence, admissions, scheduler, history]);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const epoch = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) &&
  Number.isSafeInteger(Number(value)) && Number(value) >= 0;
const transitions = new Map([
  ...['begin_quiesce', 'drain_v3', 'release_v3'].map(action => [
    `SELECT private.collect_fence_${action}($1,$2,$3)${action === 'release_v3' ? '' : ' v'}`,
    {sql: `SELECT private.collect_fence_${action}($1::uuid,$2::bigint,$3::text) AS v`, checks: [uuid, epoch, digest]},
  ]),
  ['SELECT private.collect_fence_upgrade_source_v3($1,$2,$3,$4,$5,$6,$7,$8)', {
    sql: 'SELECT private.collect_fence_upgrade_source_v3($1::uuid,$2::uuid,$3::bigint,$4::text,$5::text,$6::text,$7::text,$8::text) AS v',
    checks: [uuid, uuid, epoch, digest, digest, digest, digest, digest],
  }],
]);

async function openRevisionDatabase(api) {
  let closed = false;
  async function query(sql, parameters = []) {
    const transition = transitions.get(sql);
    const checks = transition?.checks ?? [];
    if (closed || (!transition && !reads.has(sql)) || !Array.isArray(parameters) ||
        parameters.length !== checks.length || checks.some((check, index) => !check(parameters[index]))) {
      throw Error('management_revision_statement_refused');
    }
    try {
      const response = await api('database/query', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        // The owner role is needed even for the private scheduler and admission reads.
        body: JSON.stringify({query: transition?.sql ?? sql, parameters, read_only: false}),
      });
      const rows = response.json();
      if (response.status !== 201 || !Array.isArray(rows) ||
          (sql !== history && rows.length !== 1) ||
          rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
        throw Error('management_revision_response_invalid');
      }
      return {rows, rowCount: rows.length};
    } catch (error) {
      if (!transition) throw error;
      const unknown = Error('management_revision_write_outcome_unknown');
      unknown.outcome = 'commit_requires_reconciliation';
      throw unknown;
    }
  }
  const {rows: [owner]} = await query(identity);
  if (owner.session_user !== 'postgres' || owner.current_user !== 'postgres' ||
      owner.current_database !== 'postgres' || Math.floor(owner.version / 10000) !== 17 ||
      owner.isolation !== 'read committed' || owner.project !== PROJECT) {
    throw Error('cloud_identity_mismatch');
  }
  return {query, async end() { closed = true; }};
}

export async function reviseRuntimeViaManagement(input, {api = management, ...dependencies} = {}) {
  const {migrations = [], resumeFencedRevision, acceptAncillaryRequalification,
    expectedBefore, expectedFunctions, expectedSecretPreimages} = input;
  if (!Array.isArray(migrations) || migrations.length !== 0 ||
      resumeFencedRevision != null || acceptAncillaryRequalification ||
      expectedBefore?.mode !== 'open' || !Array.isArray(expectedFunctions) ||
      expectedSecretPreimages?.BURIMUNSI_PRODUCT_MODE !== sha('standalone') ||
      !digest(expectedSecretPreimages?.BURIMUNSI_COLLECTION_ID)) {
    throw Error('initial_standalone_management_revision_required');
  }
  requireSecretPreimages(expectedSecretPreimages, (await api('secrets')).json());
  return reviseRuntime(input, {...dependencies, api, open: () => openRevisionDatabase(api)});
}
