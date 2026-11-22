import assert from 'node:assert/strict';
import {createHash, createHmac, randomUUID} from 'node:crypto';
import {registerHooks} from 'node:module';
import test from 'node:test';
import {dispatchMessage} from '../../../supabase/functions/_shared/managed-jobs-dispatch-auth.mjs';

const shared = new URL('../../../supabase/functions/_shared/', import.meta.url);
const runtime = new URL('edge-runtime.js', shared).href;
const doubles = new Map([
  ['./deployment-database.js', 'export async function assertRuntimeDeployment() {}'],
  ['./postgres-connections.js', `export const connection = () => ({});
    export const fenceConnection = () => ({reserve() { throw Error('unexpected fence I/O'); }});`],
  ['./postgres.js', 'export class PostgresDatabase { constructor() { return globalThis.__activeJobsFixture.database; } }'],
  ['./adapters.js', `export class SupabaseObjectBucket {}
    export const providerAdapters = env => env.OPENAI_API_KEY
      ? {AI: {run: () => globalThis.__activeJobsFixture.provider()}} : {};`],
]);
const hooks = registerHooks({resolve(specifier, context, next) {
  if (context.parentURL === runtime && doubles.has(specifier)) {
    return {url: 'data:text/javascript,' + encodeURIComponent(doubles.get(specifier)), shortCircuit: true};
  }
  return next(specifier, context);
}});
const {createScheduledHandler} = await import(new URL('edge-jobs-handler.js', shared));
test.after(() => { hooks.deregister(); delete globalThis.__activeJobsFixture; });

const origin = 'https://rrlduytparvsjfmegalh.supabase.co';
const source = 'a'.repeat(64);
const approval = 'b'.repeat(64);
const signKey = 'c'.repeat(64);
const digest = value => createHash('sha256').update(value).digest('hex');
const signature = ({dispatch_id, dispatch_expires_at}, build = source) => 'Bearer ' + createHmac('sha256', signKey)
  .update(dispatchMessage(build, dispatch_id, dispatch_expires_at)).digest('hex');
const admission = {
  contract: 'collect.native-sms-automation.v1', source_sha256: source,
  approval_sha256: approval, model_id: 'synthetic-model', batch_limit: 1,
};

function fixture({native = false, allowCompletion = true} = {}) {
  const events = [];
  const tickets = new Map();
  const completed = new Map();
  const database = {
    sql: {begin() { throw Error('unexpected database I/O'); }},
    setApplicationWork(work) { this.applicationWork = work; },
    prepare(sql) { return {bind: (id, build, value, extra) => ({first: async () => {
      assert.equal(build, source);
      const ticket = tickets.get(id);
      if (sql.includes('collect_managed_job_claim(')) {
        events.push('claim');
        if (!ticket || ticket.claimed || JSON.stringify(ticket.body) !== value) return {accepted: false};
        assert.equal(extra, signature(ticket.body).slice(7));
        ticket.claimed = true;
        return {accepted: true};
      }
      assert.equal(ticket?.claimed, true);
      if (sql.includes('collect_managed_job_complete(')) {
        events.push('complete');
        if (allowCompletion) completed.set(id, value);
        return {accepted: allowCompletion};
      }
      assert.match(sql, /collect_native_provider_reserve\(/);
      assert.equal(value, admission.model_id);
      assert.equal(extra, approval);
      events.push('reserve');
      return {accepted: true};
    }})}; },
  };
  globalThis.__activeJobsFixture = {database, provider: async () => { events.push('provider'); return {}; }};
  const env = {
    APP_ENVIRONMENT: 'test', SUPABASE_URL: origin,
    COLLECT_DATABASE_URL: 'postgres://fixture:synthetic@127.0.0.1:1/active_jobs_test',
    SUPABASE_PUBLISHABLE_KEY: 'synthetic-public', SUPABASE_SECRET_KEY: 'synthetic-server',
    BUILD_SOURCE_ID: source, COLLECT_JOB_AUTH_MODE: 'supabase_dispatch_hmac_v1', COLLECT_JOB_SIGNING_KEY: signKey,
    MOMO_PROCESSING_PAUSED: 'true', COLLECT_JOBS_MODE: 'maintenance_only',
    ...(native ? {
      BURIMUNSI_NATIVE_AUTO_TRANSACTIONS_ENABLED: 'true', MOMO_AI_ENABLED: 'true', OPENAI_API_KEY: 'synthetic-ai',
      MOMO_AI_MODEL: admission.model_id, COLLECT_JOB_NATIVE_SMS_APPROVAL_SHA256: approval,
    } : {}),
  };
  const maintenance = {status: 'complete', examined_limit: 100, purged: 0, provider_calls: 0};
  const processing = {paused: true, processed: 0, results: []};
  const diagnostics = {status: 'complete', removed: 0};
  const handler = createScheduledHandler(() => env, async (_env, options) => {
    assert.equal(options.limit, 100);
    events.push('maintenance');
    return maintenance;
  }, async (_env, options) => {
    assert.equal(options, undefined);
    return processing;
  }, {
    openWork: async options => {
      assert.equal(options.kind, 'jobs');
      events.push('fence');
      return {kind: 'jobs', async assert() {}, async finish() { events.push('finish'); }};
    },
    reportHealth() {},
    cleanupDiagnostics: async (_env, options) => {
      assert.equal(options.limit, 1000);
      return diagnostics;
    },
    processNativeAuto: async (admitted, options) => {
      assert.equal(options.limit, 1);
      await admitted.AI.run(null, {max_tokens: 400, response_format: {
        json_schema: {properties: {schema_version: {enum: ['momo-native-extraction.v2']}}},
      }});
      return {status: 'complete', processed: 1, results: [{state: 'completed', relation: 'duplicate', private: 'fixture'}]};
    },
    processNativeSmsLedger: async () => ({status: 'complete', processed: 0, results: []}),
  });
  return {
    events, completed, maintenance, processing, diagnostics,
    ticket(extra) {
      const body = {dispatch_id: randomUUID(), dispatch_expires_at: Math.floor(Date.now() / 1000) + 60, ...extra};
      tickets.set(body.dispatch_id, {body, claimed: false});
      return body;
    },
    call(body, authorization = signature(body)) {
      return handler(new Request(origin + '/functions/v1/collect-jobs', {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: authorization}, body: JSON.stringify(body),
      }));
    },
  };
}

test('current jobs handler claims the signed ticket once and records the exact maintenance response', async () => {
  const f = fixture();
  const payload = f.ticket();
  assert.equal((await f.call(payload, signature(payload, approval))).status, 401);
  assert.deepEqual(f.events, []);
  const expired = f.ticket({dispatch_expires_at: Math.floor(Date.now() / 1000) - 1});
  assert.equal((await f.call(expired)).status, 401);
  assert.deepEqual(f.events, []);
  const response = await f.call(payload);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(f.completed.get(payload.dispatch_id), digest(body));
  assert.equal(body, JSON.stringify({
    dispatch_id: payload.dispatch_id,
    maintenance: f.maintenance,
    processing: f.processing,
    notifications: {status: 'disabled', paused: true, processed: 0, results: [], recovered_unknown: 0},
    realtime: {status: 'disabled', scanned: 0, attempted: 0, failed: 0, overflowed: 0, delivery_confirmed: false, authoritative_polling: true},
    diagnostics: f.diagnostics,
  }));
  assert.deepEqual(f.events, ['fence', 'claim', 'maintenance', 'complete', 'finish']);
  assert.equal((await f.call(payload)).status, 401);
  assert.equal(f.events.filter(event => event === 'maintenance').length, 1);
});

test('current jobs handler requires exact native approval and reserves its budget before processing', async () => {
  const f = fixture({native: true});
  for (const value of [undefined, {...admission, source_sha256: approval}, {...admission, approval_sha256: source},
    {...admission, model_id: 'other-model'}, {...admission, batch_limit: 2}]) {
    const payload = f.ticket(value === undefined ? {} : {native_sms_admission: value});
    const response = await f.call(payload);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {code: 'native_sms_admission_changed'});
  }
  assert.equal(f.events.includes('maintenance'), false);
  assert.equal(f.events.includes('provider'), false);
  f.events.length = 0;
  const payload = f.ticket({native_sms_admission: admission});
  const response = await f.call(payload);
  assert.equal(response.status, 200);
  const bytes = await response.text();
  assert.equal(f.completed.get(payload.dispatch_id), digest(bytes));
  const data = JSON.parse(bytes);
  assert.deepEqual(data.native_sms_admission, admission);
  assert.deepEqual(data.native_auto_processing, {status: 'complete', processed: 1, results: [{state: 'completed', relation: 'duplicate'}]});
  assert.deepEqual(f.events, ['fence', 'claim', 'maintenance', 'reserve', 'provider', 'complete', 'finish']);
});

test('a current successful cycle with unconfirmed completion stays unconfirmed', async () => {
  const f = fixture({allowCompletion: false});
  const payload = f.ticket();
  const response = await f.call(payload);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {code: 'job_completion_unconfirmed'});
  assert.equal((await f.call(payload)).status, 401);
  assert.equal(f.events.filter(event => event === 'complete').length, 1);
  assert.equal(f.events.filter(event => event === 'maintenance').length, 1);
});
