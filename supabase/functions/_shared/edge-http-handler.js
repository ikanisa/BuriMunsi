import {verifyDeploymentProfile} from './deployment-profile.js';
import {BURIMUNSI_ADMIN_ORIGIN, requireStandaloneDeployment, standaloneHttpRoute, standalonePrivacyRoute} from './burimunsi-standalone.js';
import {standalonePrivacySupport} from './burimunsi-privacy-support.js';
import {managedAdminChallengeParent} from './admin-security.js';
import {configurePublicRuntimeEnv, normalizeRuntimeEnv} from './runtime-env.js';
import {openApplicationWork} from './application-fence.js';
import {prepareNativeIngress, requireNativeAdmission} from './edge-native-admission.js';
import {EdgeRuntimeWork, isFenceFailure, observeFailure} from './edge-runtime.js';
import {browserCors, edgeHttpResponse, logicalRequest, mergeCollectOrigins} from './edge-http-transport.js';
import {gatewayUploadHeld, isGatewayIngest, nativeGatewayUploadsEnabled} from './gateway-upload-hold.js';
import {createCollectNativeRuntime} from './domain/burimunsi/collect-runtime.js';
import {isCollectNativeRoute, unavailableHeldObservation} from './domain/burimunsi/collect-route.js';
import {isReconcileBatch, reconcileFenceObservation} from './domain/burimunsi/reconcile-fence-health.js';
import {isPhonePinRecordRead} from './domain/burimunsi/wire/native-http.mjs';
import {json} from './domain/core.js';
import worker from './domain/index.js';
import {recordPlatformHealth} from './domain/observability.js';

function assertNotCancelled(signal) {
  if (signal.aborted) throw new Error('request_cancelled_before_dispatch');
}

/**
 * @param {string} functionName
 * @param {()=>Record<string, unknown>} [envReader]
 * @param {object} [options]
 * @param {boolean} [options.standalone]
 * @param {typeof openApplicationWork} [options.openWork]
 * @param {typeof recordPlatformHealth} [options.reportHealth]
 * @param {(request:Request,env:Record<string,unknown>)=>Promise<{request:Request,networkBucket:(request:Request)=>Promise<string>|string}>} [options.admitDirectSupabaseNativeIngress]
 * @param {(request:Request,env:Record<string,unknown>)=>Promise<object>} [options.verifyNativeIngress]
 * @param {(token:object,consume:Function)=>Promise<{request:Request,networkBucket:Function}>} [options.claimNativeIngress]
 * @param {(db:object,work:object,values:object)=>Promise<boolean>} [options.consumeNativeIngressNonce]
 */
export function createHandler(functionName, envReader = () => Deno.env.toObject(), {
  openWork = openApplicationWork, reportHealth = recordPlatformHealth,
  admitDirectSupabaseNativeIngress, verifyNativeIngress, claimNativeIngress, consumeNativeIngressNonce,
  standalone = false,
} = {}) {
  const admin = functionName === 'admin-api';
  const collect = functionName === 'collect-api';

  return async request => {
    const started = performance.now();
    const runtime = new EdgeRuntimeWork();
    let env;
    let cors = {};
    let reconcileRequest;
    function reportReconcileFence({cause, stage = undefined}, error = undefined) {
      try {
        const result = reportHealth({
          status: 503, component: 'platform', requestId: null, sourceId: env?.BUILD_SOURCE_ID,
          elapsedMs: performance.now() - started,
          reconcileFence: reconcileFenceObservation(reconcileRequest, runtime.work, cause,
            stage ?? (runtime.stage === 'dispatch' ? 'admitted_dispatch' : undefined), error),
        });
        if (result && typeof result.then === 'function') {
          // Let the isolate finish the log independently of the client and the
          // application lease. runtime.waitUntil() would retain business work.
          const done = Promise.resolve(result).catch(() => {});
          if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(done);
        }
      } catch { /* Observability must preserve the original response and admission outcome. */ }
    }
    try {
      env = configurePublicRuntimeEnv(envReader());
      await verifyDeploymentProfile(env);
      const collectionId = standalone ? requireStandaloneDeployment(env) : undefined;
      mergeCollectOrigins(env);

      let logical = logicalRequest(request, functionName);
      const path = new URL(logical.url).pathname;
      const challengeParent = collect && !standalone ? managedAdminChallengeParent(logical, env) : null;
      if (admin ? !path.startsWith('/api/admin/') : path.startsWith('/api/admin')) {
        return json({code: 'not_found'}, 404);
      }
      if (standalone && !standaloneHttpRoute(functionName, logical)) return json({code: 'not_found'}, 404);
      const browserMethod = logical.method === 'OPTIONS' ? logical.headers.get('Access-Control-Request-Method') : logical.method;
      const privacyOrigin = standalone && collect && standalonePrivacyRoute(browserMethod, path) &&
        logical.headers.get('Origin') === BURIMUNSI_ADMIN_ORIGIN ? BURIMUNSI_ADMIN_ORIGIN : null;
      const approvedBrowserOrigin = challengeParent ?? privacyOrigin;
      const headers = browserCors(env, logical, admin, approvedBrowserOrigin);
      if (headers === null) return json({code: 'origin_denied'}, 403);
      cors = headers;
      if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});

      if (standalone && collect) {
        const privacy = standalonePrivacySupport(logical, {directEdge: true, headers: cors});
        if (privacy) return privacy;
      }

      if (collect && isGatewayIngest(request.method, path) && !nativeGatewayUploadsEnabled(env)) {
        const {code, message, status} = gatewayUploadHeld();
        return json({code, message}, status, cors);
      }

      let nativeNetworkBucket;
      let pendingNativeIngress;
      if (isCollectNativeRoute(logical)) {
        if (!collect) return json({code: 'not_found'}, 404, cors);
        if (isReconcileBatch(logical.method, path)) reconcileRequest = logical;
        const unavailable = unavailableHeldObservation(logical, env);
        if (unavailable) return unavailable;

        runtime.stage = 'native_ingress';
        const ingress = await prepareNativeIngress(logical, env, {
          admitDirectSupabaseNativeIngress, verifyNativeIngress, claimNativeIngress, consumeNativeIngressNonce,
        });
        logical = ingress.request;
        nativeNetworkBucket = ingress.networkBucket;
        pendingNativeIngress = ingress.pendingClaim;
      }

      runtime.stage = 'normalization';
      env = normalizeRuntimeEnv(env);
      if (standalone) {
        env.AUTH_MEMBER_REGISTRATION_ENABLED = 'false';
        env.AUTH_ANONYMOUS_ENABLED = 'false';
        env.GOOGLE_AUTH_ENABLED = 'false';
      }
      env.MOMO_PROCESSING_PAUSED ??= 'true';
      env.AUTH_MEMBER_REGISTRATION_ENABLED ??= 'false';
      const nativeSnapshotRead = standalone && collect && logical.method === 'GET' &&
        logical.headers.get('X-BuriMunsi-Auth') === 'phone_pin' &&
        isPhonePinRecordRead(path,new URL(logical.url).search);
      await runtime.initializeDatabase(env, collectionId, standalone && openWork === openApplicationWork);
      const work = await runtime.admit(env, openWork, admin ? 'http_admin' : 'http_collect', request.signal,
        standalone && logical.method === 'GET', nativeSnapshotRead && openWork === openApplicationWork);
      const admittedAt = nativeSnapshotRead ? performance.now() : 0;
      assertNotCancelled(request.signal);

      if (pendingNativeIngress) {
        runtime.stage = 'native_nonce_claim';
        const admitted = requireNativeAdmission(await claimNativeIngress(
          pendingNativeIngress,
          values => consumeNativeIngressNonce(env.DB, work, values),
        ));
        if (request.signal.aborted) throw new Error('native_ingress_unconfigured');
        logical = admitted.request;
        nativeNetworkBucket = admitted.networkBucket;
      }

      runtime.initializeAdapters(env);
      if (collect && isCollectNativeRoute(logical)) {
        runtime.stage = 'native_initialization';
        const native = await createCollectNativeRuntime(env, {trustedNetworkBucket: nativeNetworkBucket});
        if (native) env.BURIMUNSI_NATIVE_ROUTE = native;
      }

      runtime.stage = 'dispatch';
      assertNotCancelled(request.signal);
      const routeEnv = approvedBrowserOrigin ? {...env, ALLOWED_ORIGINS: approvedBrowserOrigin} : env;
      const response = await worker.fetch(logical, routeEnv, {waitUntil: promise => runtime.waitUntil(promise),
        ...(reconcileRequest ? {reportReconcileFence} : {})});
      const output = await edgeHttpResponse(response, logical, {functionName, path, admin, cors});
      if (nativeSnapshotRead && output.ok) {
        const finished = performance.now();
        output.headers.set('Server-Timing', `admission;dur=${Math.round(admittedAt - started)}, records;dur=${Math.round(finished - admittedAt)}`);
      }
      return output;
    } catch (error) {
      const health = {
        status: 503,
        component: 'platform',
        sourceId: env?.BUILD_SOURCE_ID,
        elapsedMs: performance.now() - started,
      };
      if (isFenceFailure(error)) {
        if (reconcileRequest) reportReconcileFence({cause: error.code}, error);
        else observeFailure(reportHealth, {...health, requestId: null});
        return json({code: error.code, message: error.message}, 503, cors);
      }
      const requestId = crypto.randomUUID();
      observeFailure(reportHealth, {
        ...health, requestId, runtimeFailure: {error, stage: runtime.stage, env},
      });
      return json({code: 'backend_unavailable', message: 'The backend is unavailable.', request_id: requestId}, 503);
    } finally {
      runtime.finish();
    }
  };
}
