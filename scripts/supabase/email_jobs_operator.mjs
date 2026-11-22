import {createHash, randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolveDeploymentProfile, canonicalProfile} from '../../supabase/functions/_shared/deployment-profile.js';
import {readSchedulerReadiness, renderSql as renderJobsSql, stable, validateConnection} from './jobs_config.mjs';
import {render as renderGoogleMaintenance} from './sql-maintenance/operator.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;
const dispatchIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const templateFile = new URL('../../supabase/jobs/email-bootstrap.sql', import.meta.url);
const routineTypes = {text: 25, jsonb: 3802, uuid: 2950, void: 2278};
const mainRoutines = [
  'activate_jobs', 'dispatch_jobs', 'jobs_state', 'native_jobs_epoch', 'pause_jobs',
  'reconcile_jobs', 'record_jobs_readiness', 'review_unknown_jobs', 'tick_jobs',
];
const readinessFields = [
  'format', 'profile_sha256', 'endpoint', 'source_sha256', 'deployment_sha256',
  'runtime_evidence_sha256', 'provider_evidence_sha256', 'token_custody_evidence_sha256',
  'copy_inventory_evidence_sha256', 'quota_evidence_sha256', 'verified_at',
  'email_admission', 'monthly_budget',
];
const admissionFields = ['contract', 'source_sha256', 'approval_sha256', 'admitted_from', 'batch_limit'];

function exactFields(value, fields) {
  return value != null && Object.keys(value).sort().join() === [...fields].sort().join();
}

export function emailDeployment(env = process.env) {
  const profile = resolveDeploymentProfile(env);
  if (!env.COLLECT_DEPLOYMENT_PROFILE || profile.mode !== 'managed' ||
      sha(canonicalProfile(profile)) !== env.COLLECT_DEPLOYMENT_PROFILE_SHA256) {
    throw Error('Verified Cloud email deployment required');
  }
  return {
    format: 'collect.email.scheduler.v1',
    profile_sha256: env.COLLECT_DEPLOYMENT_PROFILE_SHA256,
    endpoint: profile.supabase_origin + '/functions/v1/collect-email-jobs',
    vault_name: 'collect_email_job_token_v1',
    cron: '*/5 * * * *',
    install_active: false,
    max_monthly_budget: 10000,
    batch_limit: 1,
  };
}

function routineManifest(sql) {
  const definition = /CREATE FUNCTION collect_ops\.([a-z_]+)\(([^)]*)\) RETURNS (text|jsonb|void) LANGUAGE (sql|plpgsql)( STABLE)? SET search_path=pg_catalog AS \$\$([\s\S]*?)\$\$;/g;
  return Array.from(sql.matchAll(definition), ([, name, args, result, language, stableFlag, body]) => {
    const parameters = args ? args.split(',').map(arg => arg.trim().split(/\s+/)) : [];
    if (parameters.some(parts => parts.length !== 2 || !routineTypes[parts[1]])) {
      throw Error('Review exact email routine parameters');
    }
    return {
      name,
      arguments: parameters.map(parts => routineTypes[parts[1]]).join(' '),
      argument_names: parameters.map(parts => parts[0]),
      return_type: String(routineTypes[result]),
      language,
      volatility: stableFlag ? 's' : 'v',
      body_sha256: sha(body),
    };
  });
}

export async function renderEmailSql(env = process.env) {
  const config = emailDeployment(env);
  const template = await readFile(templateFile, 'utf8');
  const configSha = sha(stable(config));
  const templateSha = sha(template);
  let sql = template
    .replaceAll('__PROFILE_SHA256__', config.profile_sha256)
    .replaceAll('__ENDPOINT__', config.endpoint)
    .replaceAll('__CONFIG_SHA256__', configSha)
    .replaceAll('__TEMPLATE_SHA256__', templateSha);

  const email = routineManifest(sql);
  if (email.length !== 9) throw Error('Review exact email routine set');
  const jobs = await renderJobsSql(undefined, env);
  const main = routineManifest(jobs.sql);
  if (main.length !== mainRoutines.length || main.map(routine => routine.name).sort().join() !== mainRoutines.join()) {
    throw Error('Review exact main scheduler routine set');
  }
  // Bind the exact body of the optional SQL-maintenance routine.
  const google = await renderGoogleMaintenance();
  main.push({
    name: 'cleanup_google_expired', arguments: '', argument_names: [], return_type: '3802',
    language: 'plpgsql', volatility: 'v', body_sha256: google.functionSha,
  });
  sql = sql.replace('__EMAIL_ROUTINE_MANIFEST__', stable(email))
    .replace('__MAIN_ROUTINE_MANIFEST__', stable(main));
  if (/__[A-Z_]+__/.test(sql) || config.endpoint.includes("'")) throw Error('Invalid email template');
  return {sql, configSha, templateSha, sqlSha: sha(sql)};
}

export function validateEmailReadiness(value, env = process.env, now = Date.now()) {
  const deployment = emailDeployment(env);
  if (!exactFields(value, readinessFields) || value.format !== 'collect.email.readiness.v1' ||
      value.profile_sha256 !== deployment.profile_sha256 || value.endpoint !== deployment.endpoint ||
      !Number.isSafeInteger(value.monthly_budget) || value.monthly_budget < 1 ||
      value.monthly_budget > deployment.max_monthly_budget) throw Error('Exact reviewed email readiness required');
  if (readinessFields.some(key => key.endsWith('_sha256') && !digestPattern.test(value[key]))) {
    throw Error('Evidence hashes required');
  }
  const verifiedAt = Date.parse(value.verified_at);
  if (!Number.isFinite(verifiedAt) || new Date(verifiedAt).toISOString() !== value.verified_at ||
      verifiedAt < now - 3600000 || verifiedAt > now + 30000) {
    throw Error('Fresh canonical readiness timestamp required');
  }
  const admission = value.email_admission;
  if (!exactFields(admission, admissionFields) || admission.contract !== 'collect.contribution-email.v1' ||
      admission.source_sha256 !== value.source_sha256 || !digestPattern.test(admission.approval_sha256) ||
      admission.batch_limit !== deployment.batch_limit || !Number.isSafeInteger(admission.admitted_from) ||
      admission.admitted_from <= 0 || admission.admitted_from >= 4102444800) {
    throw Error('Bounded source-approved email admission required');
  }
  return value;
}

export function readEmailReadiness(file, env = process.env) {
  return readSchedulerReadiness(file, value => validateEmailReadiness(value, env),
    'Owned independent 0600 readiness file required');
}

// Supply credentials through the private process environment.
export async function runEmailOperation(operation, {sql, readiness, id, evidence, env = process.env} = {}) {
  const deployment = emailDeployment(env);
  if (!sql) throw Error('Verified owner connection required');
  const [owner] = await sql.unsafe('SELECT current_user AS current,session_user AS session');
  if (owner.current !== 'postgres' || owner.session !== 'postgres') throw Error('Owner connection required');
  const [identity] = await sql.unsafe('SELECT private.collect_assert_deployment($1::text) AS verified', [deployment.profile_sha256]);
  if (identity?.verified !== true) throw Error('Database deployment identity mismatch');

  const readValue = async (query, parameters) => (await sql.unsafe(query, parameters))[0].value;
  switch (operation) {
    case 'status':
      return readValue('SELECT collect_ops.email_state() AS value');
    case 'pause':
      return readValue('SELECT collect_ops.pause_email() AS value');
    case 'readiness':
      await sql.unsafe('SELECT collect_ops.record_email_readiness($1::text::jsonb)', [JSON.stringify(readiness)]);
      return {recorded: true, enabled: false};
    case 'probe':
      if (!dispatchIdPattern.test(id ?? '')) throw Error('Retained original dispatch UUID required');
      return readValue("SELECT collect_ops.dispatch_email('probe',$1::uuid) AS value", [id]);
    case 'reconcile':
      return readValue('SELECT collect_ops.reconcile_email() AS value');
    case 'activate':
      if (!digestPattern.test(evidence ?? '')) throw Error('Exact readiness evidence required');
      return readValue('SELECT collect_ops.activate_email($1::text) AS value', [evidence]);
    case 'review-unknown':
      if (!digestPattern.test(evidence ?? '') || !dispatchIdPattern.test(id ?? '')) {
        throw Error('Original UUID and review evidence required');
      }
      return readValue('SELECT collect_ops.review_email_unknown($1::uuid,$2::text) AS value', [id, evidence]);
    default:
      throw Error('Unsupported owner operation');
  }
}

async function runCli([operation, arg, extra]) {
  if (operation === 'render' && arg && !extra) {
    const rendered = await renderEmailSql();
    await writeFile(arg, rendered.sql, {flag: 'wx', mode: 0o600});
    return {config_sha256: rendered.configSha, template_sha256: rendered.templateSha,
      sql_sha256: rendered.sqlSha, active: false};
  }
  if (operation === 'new-dispatch-id' && !arg) return {dispatch_id: randomUUID(), submitted: false};

  emailDeployment();
  const value = process.env.COLLECT_EMAIL_JOBS_DATABASE_URL;
  delete process.env.COLLECT_EMAIL_JOBS_DATABASE_URL;
  const target = validateConnection(value);
  const pg = createRequire(import.meta.url)('pg');
  const client = new pg.Client({
    connectionString: target.href, ssl: {rejectUnauthorized: true, servername: target.hostname},
    connectionTimeoutMillis: 10000, statement_timeout: 15000,
  });
  await client.connect();
  try {
    const sql = {unsafe: async (text, parameters) => (await client.query(text, parameters)).rows};
    const readiness = operation === 'readiness' ? await readEmailReadiness(arg) : undefined;
    const evidence = operation === 'review-unknown' ? extra : arg;
    return await runEmailOperation(operation, {sql, readiness, id: arg, evidence});
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await runCli(process.argv.slice(2))));
  } catch {
    console.error('Email scheduler operation refused; no secret values emitted.');
    process.exitCode = 1;
  }
}
