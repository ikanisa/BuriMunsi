// Supabase Management API SQL over independent, owner-authorized transactions.
// https://supabase.com/docs/reference/api/v1-run-a-query
import {management, PROJECT, record, sha} from './access.mjs';
import {requireRevisionSchedulerReady, requireSecretPreimages, reviseRuntime} from './revise-runtime.mjs';

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

function smsSourceSettings(binding, source, approvalSha256) {
  return {
    COLLECT_SMS_ENABLED: 'true',
    COLLECT_SMS_DISPATCH_PAUSED: 'false',
    COLLECT_SMS_RELEASE_SHA256: binding.gatewayReleaseSha256,
    COLLECT_SMS_CORE_SOURCE_SHA256: source,
    COLLECT_SMS_SOURCE_APPROVAL: JSON.stringify({
      approvalSha256,
      coreSourceSha256: source,
      format: 'collect.sms.gateway-source-approval.v1',
      gatewayReleaseSha256: binding.gatewayReleaseSha256,
    }),
  };
}

const settingDigests = settings =>
  Object.fromEntries(Object.entries(settings).map(([name, value]) => [name, sha(value)]));

export async function reviseRuntimeViaManagement(input, {api = management, ...dependencies} = {}) {
  const {migrations = [], resumeFencedRevision, acceptAncillaryRequalification,
    expectedBefore, expectedFunctions, expectedSecretPreimages, testEvidence, smsBinding} = input;
  if (!Array.isArray(migrations) || migrations.length !== 0 ||
      resumeFencedRevision != null || acceptAncillaryRequalification ||
      expectedBefore?.mode !== 'open' || !Array.isArray(expectedFunctions) ||
      expectedSecretPreimages?.BURIMUNSI_PRODUCT_MODE !== sha('standalone') ||
      !digest(expectedSecretPreimages?.BURIMUNSI_COLLECTION_ID)) {
    throw Error('initial_standalone_management_revision_required');
  }
  const initialSecrets = (await api('secrets')).json();
  requireSecretPreimages(expectedSecretPreimages, initialSecrets);
  const smsEnabled = initialSecrets.some(row => row.name === 'COLLECT_SMS_ENABLED' && row.value === sha('true'));
  if (!smsEnabled && !smsBinding) {
    return reviseRuntime(input, {...dependencies, api, open: () => openRevisionDatabase(api)});
  }
  if (!smsEnabled || !smsBinding || Object.keys(smsBinding).sort().join('|') !==
      'candidateApprovalSha256|gatewayReleaseSha256|previousApprovalSha256' ||
      Object.values(smsBinding).some(value => !digest(value) || /^0+$/.test(value)) ||
      !digest(testEvidence?.sourceSha256) || !digest(expectedBefore.source_sha256) ||
      new Set([...Object.values(smsBinding), testEvidence.sourceSha256, expectedBefore.source_sha256]).size !== 5 ||
      typeof dependencies.refreshAncillaryAfterSourceSecret !== 'function') {
    throw Error('reviewed_management_sms_rebind_required');
  }
  const before = smsSourceSettings(smsBinding, expectedBefore.source_sha256, smsBinding.previousApprovalSha256);
  const candidate = smsSourceSettings(smsBinding, testEvidence.sourceSha256, smsBinding.candidateApprovalSha256);
  const beforeDigests = settingDigests(before), candidateDigests = settingDigests(candidate);
  requireSecretPreimages(beforeDigests, initialSecrets);

  let revisionDatabase, fenceId, writeAttempted = false, sourceChanged = false;
  async function confirmStoppedFence() {
    if (!revisionDatabase || !uuid(fenceId)) throw Error('management_sms_rebind_fence_unconfirmed');
    const {rows: [current]} = await revisionDatabase.query(fence);
    const {rows: [active]} = await revisionDatabase.query(admissions);
    const {rows: [schedule]} = await revisionDatabase.query(scheduler);
    if (current.mode !== 'fenced' || current.operation_id !== fenceId ||
        Number(current.epoch) !== expectedBefore.epoch ||
        current.source_sha256 !== expectedBefore.source_sha256 || active.n !== 0) {
      throw Error('management_sms_rebind_fence_unconfirmed');
    }
    requireRevisionSchedulerReady(schedule.status);
  }
  const scopedApi = async (path, options) => {
    if (path === 'secrets' && options?.method === 'POST') {
      if (writeAttempted || options.body !== JSON.stringify([{name: 'BUILD_SOURCE_ID', value: testEvidence.sourceSha256}])) {
        throw Error('management_sms_rebind_post_refused');
      }
      requireSecretPreimages({...expectedSecretPreimages, ...beforeDigests}, (await api('secrets')).json());
      await confirmStoppedFence();
      writeAttempted = true;
      const body = JSON.stringify([{name: 'BUILD_SOURCE_ID', value: testEvidence.sourceSha256},
        ...['COLLECT_SMS_CORE_SOURCE_SHA256', 'COLLECT_SMS_SOURCE_APPROVAL'].map(name => ({name, value: candidate[name]}))]);
      const written = await api(path, {...options, body});
      await confirmStoppedFence();
      requireSecretPreimages({...expectedSecretPreimages, ...candidateDigests}, (await api('secrets')).json());
      sourceChanged = true;
      return written;
    }
    if (path.startsWith('functions/deploy?slug=')) {
      if (!sourceChanged) throw Error('management_sms_rebind_unconfirmed');
      await confirmStoppedFence();
    }
    const response = await api(path, options);
    if (path === 'secrets') requireSecretPreimages(sourceChanged ? candidateDigests : beforeDigests, response.json());
    return response;
  };
  const {save = record} = dependencies;
  return reviseRuntime(input, {...dependencies, api: scopedApi,
    async open() {
      revisionDatabase = await openRevisionDatabase(api);
      return revisionDatabase;
    },
    save(name, value) {
      save(name, value);
      if (name === 'revision-' + input.label + '-intent.json') fenceId = value.fenceId;
    }});
}
