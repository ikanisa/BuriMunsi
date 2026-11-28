import {assertEquals} from 'jsr:@std/assert@1.0.14';
import {fenceFailure, openApplicationWork} from '../application-fence.js';
import {createHandler} from '../serve.js';
import {createPlatformHealthReporter} from '../domain/observability.js';
import {reconcileFenceObservation} from '../domain/burimunsi/reconcile-fence-health.js';
import {sha256} from '../domain/burimunsi/values.js';
import {fencedTest, ownFixtureWork, syntheticFenceBackend, SYNTHETIC_FENCE_SOURCE} from './helpers/fenced-unit.js';

const origin = 'https://rrlduytparvsjfmegalh.supabase.co';
const endpoint = '/v1/burimunsi/sms/observations/reconcile-batch';
const correlation = '69ccef5b-9883-7b12-aadd-c86bf80dcaca';
const admission = '6a0fb26f-be6e-4b50-be81-f2ac2d845dd8';
const cause = 'application_fence_unavailable';
const fixtureText = 'private-fixture-must-not-appear';
const environment = () => ({
  SUPABASE_URL: origin, COLLECT_DATABASE_URL: 'postgres://fixture:synthetic@127.0.0.1:55439/collect_edge_test',
  SUPABASE_PUBLISHABLE_KEY: 'synthetic-public', SUPABASE_SECRET_KEY: 'synthetic-secret',
  APP_ENVIRONMENT: 'test', BUILD_SOURCE_ID: SYNTHETIC_FENCE_SOURCE, BURIMUNSI_NATIVE_ENABLED: 'true',
});

function request(clientId: string | null = correlation, route = endpoint, method = 'POST', contract = 'burimunsi.native.v1') {
  const headers = new Headers({'X-BuriMunsi-Contract': contract, 'X-Request-ID': correlation,
    'X-BuriMunsi-Device': fixtureText, 'Authorization': 'Bearer ' + fixtureText});
  if (clientId !== null) headers.set('X-BuriMunsi-Request', clientId);
  return new Request(origin + '/functions/v1/collect-api' + route, {method, headers,
    ...(method === 'POST' ? {body: fixtureText} : {})});
}

function capture() {
  let time = 0;
  const events: Record<string, unknown>[] = [];
  const pending: Promise<boolean>[] = [];
  const recorder = createPlatformHealthReporter({emit: (_level: string, text: string) => {
    events.push(JSON.parse(text));
  }, clock: () => time});
  const report = (value: Parameters<typeof recorder>[0]) => {
    const result = recorder(value);
    if (result instanceof Promise) pending.push(result);
    return result;
  };
  return {events, report, flush: () => Promise.all(pending), nextMinute() { time += 60000; }};
}

function verifyEvent(event: Record<string, unknown>, stage: string, admissionHash: string | null,
    clientHash: string | null, expectedCause = cause) {
  assertEquals(event, {service: 'collect_platform_api', schema_version: 1, event: 'service_degraded',
    component: 'platform', status: 503, request_id: null, source_id: SYNTHETIC_FENCE_SOURCE,
    elapsed_ms: event.elapsed_ms, operation: 'native_reconcile_batch', stage, cause: expectedCause,
    admission_sha256: admissionHash, epoch: admissionHash ? 1 : null, request_sha256: clientHash});
  assertEquals(JSON.stringify(event).includes(fixtureText), false);
}

fencedTest('normal reconcile handler distinguishes pre-registration, missing ACK, failed lease and admitted failure', async () => {
  const clientHash = await sha256(correlation);
  const admissionHash = await sha256(admission);
  for (const stage of ['before_registration', 'registration_unconfirmed', 'registered_before_work', 'admitted_before_dispatch']) {
    const {events, report, flush} = capture();
    const backend = syntheticFenceBackend();
    let opens = 0, claims = 0;
    if (stage === 'registration_unconfirmed') backend.register = async () => { throw Error(fixtureText); };
    if (stage === 'registered_before_work') backend.lease = async () => { throw Error(fixtureText); };
    const handler = createHandler('collect-api', environment, {
      reportHealth: report,
      verifyNativeIngress: async () => {
        if (stage === 'before_registration') throw fenceFailure(null);
        return {};
      },
      claimNativeIngress: async () => { claims++; throw fenceFailure(null); },
      consumeNativeIngressNonce: async () => false,
      openWork: async options => {
        opens++;
        const fixture = {...options, id: admission, backend} as const;
        return ownFixtureWork(await openApplicationWork(fixture));
      },
    });
    const response = await handler(request(correlation, endpoint + '?private=' + fixtureText));
    assertEquals(response.status, 503);
    assertEquals(await response.json(), {code: cause, message: 'The service is temporarily unavailable. Keep the original request pending.'});
    assertEquals(response.headers.get('X-BuriMunsi-Request'), null);
    await flush();
    assertEquals(events.length, 1);
    const registered = stage === 'registered_before_work' || stage === 'admitted_before_dispatch';
    verifyEvent(events[0], stage, registered ? admissionHash : null, clientHash);
    assertEquals(opens, stage === 'before_registration' ? 0 : 1);
    assertEquals(claims, stage === 'admitted_before_dispatch' ? 1 : 0);
    assertEquals(backend.rows.size, registered ? 1 : 0);
    if (stage === 'registered_before_work') {
      const row = backend.rows.get(admission);
      assertEquals([row.state, row.reason, row.externalDispatches, row.uncertainDispatches],
        ['settled', 'cancelled_before_work', 0, 0]);
    }
  }
});

fencedTest('missing, invalid, wrong-version and unsubmitted client IDs stay unlinked; other methods and paths retain the ordinary event', async () => {
  const {events, report, flush} = capture();
  const handler = createHandler('collect-api', environment, {
    reportHealth: report, verifyNativeIngress: async () => ({}), claimNativeIngress: async () => { throw Error('Unexpected nonce claim'); },
    consumeNativeIngressNonce: async () => false, openWork: async () => { throw fenceFailure({code: 'application_fenced'}); },
  });
  for (const input of [request(null), request(fixtureText), request(correlation.toUpperCase()),
      request(correlation.replace('-aadd-', '-7add-')), request(correlation, endpoint, 'POST', 'unknown')]) {
    const response = await handler(input);
    assertEquals((await response.json()).code, 'application_fenced');
    await flush();
    verifyEvent(events.at(-1)!, 'before_registration', null, null, 'application_fenced');
  }
  for (const input of [request(correlation, endpoint, 'GET'), request(correlation, endpoint + '-other'), request(correlation, '/health')]) {
    const response = await handler(input);
    assertEquals(response.status, 503);
    const last = events.at(-1)!;
    assertEquals(Object.keys(last).sort(), ['component','elapsed_ms','event','request_id','schema_version','service','source_id','status']);
    assertEquals(last.event, 'service_degraded');
  }
});

fencedTest('the shared reporter rejects unowned fields and invalid admission tuples and applies one common 64+1 budget', async () => {
  const {events, report, nextMinute} = capture();
  const input = {component: 'platform', status: 503, requestId: null, sourceId: SYNTHETIC_FENCE_SOURCE, elapsedMs: 12};
  const observe = (tuple: () => unknown[], reason = cause) =>
    reconcileFenceObservation(request(null), {tuple}, reason, 'native_authority', undefined);
  await report({...input, reconcileFence: {stage: fixtureText, cause, id: admission, private: fixtureText}});
  assertEquals(events[0].operation, undefined);
  await report({...input, reconcileFence: observe(() => [admission, 1], fixtureText)});
  assertEquals(events[1].operation, undefined);
  for (const tuple of [() => [admission, 0], () => [admission, 1.5], () => [admission, '1'], () => [fixtureText, 1],
      () => [correlation, 1], () => [null, 1], () => { throw Error(fixtureText); }]) {
    await report({...input, reconcileFence: observe(tuple)});
    verifyEvent(events.at(-1)!, 'native_authority', null, null);
  }
  const observation = observe(() => [admission, 1]);
  while (events.length < 64) report({...input, component: 'admin'});
  await report({...input, reconcileFence: observation});
  await report({...input, reconcileFence: observation});
  assertEquals(events.length, 65);
  assertEquals(events[64], {service:'collect_platform_api',schema_version:1,event:'events_suppressed',component:'platform',
    status:null,request_id:null,source_id:SYNTHETIC_FENCE_SOURCE,elapsed_ms:null});
  nextMinute();
  await report({...input, reconcileFence: observation});
  verifyEvent(events[65], 'native_authority', await sha256(admission), null);
  assertEquals(JSON.stringify(events).includes(fixtureText), false);
});

fencedTest('disabled or unavailable diagnostics preserve the fence result and perform no retry', async () => {
  for (const reportHealth of [() => false, () => { throw Error(fixtureText); }, async () => { throw Error(fixtureText); }]) {
    let attempts = 0;
    const handler = createHandler('collect-api', environment, {reportHealth,
      verifyNativeIngress: async () => { attempts++; throw fenceFailure(null); },
      claimNativeIngress: async () => { throw Error('Unexpected nonce claim'); }, consumeNativeIngressNonce: async () => false});
    const response = await handler(request());
    assertEquals(response.status, 503);
    assertEquals((await response.json()).code, cause);
    assertEquals(attempts, 1);
  }
});

fencedTest('unavailable hashing keeps the fixed failure stage and cause without an unpaired epoch or raw IDs', async () => {
  const saved = Object.getOwnPropertyDescriptor(crypto.subtle, 'digest');
  const {events, report} = capture();
  const observation = reconcileFenceObservation(request(), {tuple: () => [admission, 1]}, cause, 'native_authority', undefined);
  try {
    Object.defineProperty(crypto.subtle, 'digest', {configurable: true, value: async () => { throw Error(fixtureText); }});
    await report({component: 'platform', status: 503, requestId: null, sourceId: SYNTHETIC_FENCE_SOURCE,
      elapsedMs: 2, reconcileFence: observation});
    verifyEvent(events[0], 'native_authority', null, null);
  } finally {
    if (saved) Object.defineProperty(crypto.subtle, 'digest', saved);
    else Reflect.deleteProperty(crypto.subtle, 'digest');
  }
});

fencedTest('a pending reporter is retained by the isolate while the response and business lease finish', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'EdgeRuntime');
  const held = Promise.withResolvers<boolean>();
  const background: Promise<unknown>[] = [];
  const backend = syntheticFenceBackend();
  const closed = Promise.withResolvers<void>();
  const close = backend.close;
  let attempts = 0;
  backend.close = async (...args: Parameters<typeof close>) => {
    const row = await close(...args);
    closed.resolve();
    return row;
  };
  Object.defineProperty(globalThis, 'EdgeRuntime', {configurable: true,
    value: {waitUntil: (pending: Promise<unknown>) => background.push(pending)}});
  let timer;
  try {
    const handler = createHandler('collect-api', environment, {reportHealth: () => held.promise,
      verifyNativeIngress: async () => ({}), claimNativeIngress: async () => { throw fenceFailure(null); },
      consumeNativeIngressNonce: async () => false, openWork: async options => {
        attempts++;
        const fixture = {...options, id: admission, backend} as const;
        return ownFixtureWork(await openApplicationWork(fixture));
      }});
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Error('Response or lease waited for diagnostics')), 1000);
    });
    const response = await Promise.race([handler(request()), deadline]);
    assertEquals(response.status, 503);
    await Promise.race([closed.promise, deadline]);
    assertEquals(attempts, 1);
    assertEquals(backend.rows.get(admission).state, 'settled');
    assertEquals(background.length, 2); // One diagnostic and the existing work close.
    held.reject(Error(fixtureText));
    await Promise.all(background);
  } finally {
    clearTimeout(timer);
    held.resolve(false);
    if (saved) Object.defineProperty(globalThis, 'EdgeRuntime', saved);
    else Reflect.deleteProperty(globalThis, 'EdgeRuntime');
  }
});
