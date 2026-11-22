import {verifyDeploymentProfile} from './deployment-profile.js';
import {managedAdminChallengeParent} from './admin-security.js';
import {configurePublicRuntimeEnv, normalizeRuntimeEnv} from './runtime-env.js';
import {openApplicationWork} from './application-fence.js';
import {prepareNativeIngress, requireNativeAdmission} from './edge-native-admission.js';
import {EdgeRuntimeWork, isFenceFailure, observeFailure} from './edge-runtime.js';
import {browserCors, edgeHttpResponse, logicalRequest, mergeCollectOrigins} from './edge-http-transport.js';
import {gatewayUploadHeld, isGatewayIngest, nativeGatewayUploadsEnabled} from './gateway-upload-hold.js';
import {createCollectNativeRuntime} from './domain/burimunsi/collect-runtime.js';
import {isCollectNativeRoute, unavailableHeldObservation} from './domain/burimunsi/collect-route.js';
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
} = {}) {
  const admin = functionName === 'admin-api';
  const collect = functionName === 'collect-api';

  return async request => {
    const started = performance.now();
    const runtime = new EdgeRuntimeWork();
    let env;
    let cors = {};
    try {
      env = configurePublicRuntimeEnv(envReader());
      await verifyDeploymentProfile(env);
      mergeCollectOrigins(env);

      let logical = logicalRequest(request, functionName);
      const path = new URL(logical.url).pathname;
      const challengeParent = collect ? managedAdminChallengeParent(logical, env) : null;
      if (admin ? !path.startsWith('/api/admin/') : path.startsWith('/api/admin')) {
        return json({code: 'not_found'}, 404);
      }
      const headers = browserCors(env, logical, admin, challengeParent);
      if (headers === null) return json({code: 'origin_denied'}, 403);
      cors = headers;
      if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});

      if (collect && isGatewayIngest(request.method, path) && !nativeGatewayUploadsEnabled(env)) {
        const {code, message, status} = gatewayUploadHeld();
        return json({code, message}, status, cors);
      }

      let nativeNetworkBucket;
      let pendingNativeIngress;
      if (isCollectNativeRoute(logical)) {
        if (!collect) return json({code: 'not_found'}, 404, cors);
        const unavailable = unavailableHeldObservation(logical);
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
      env.MOMO_PROCESSING_PAUSED ??= 'true';
      env.AUTH_MEMBER_REGISTRATION_ENABLED ??= 'false';
      await runtime.initializeDatabase(env);
      const work = await runtime.admit(env, openWork, admin ? 'http_admin' : 'http_collect', request.signal);
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
      const documentEnv = challengeParent ? {...env, ALLOWED_ORIGINS: challengeParent} : env;
      const response = await worker.fetch(logical, documentEnv, {waitUntil: promise => runtime.waitUntil(promise)});
      return await edgeHttpResponse(response, logical, {functionName, path, admin, cors});
    } catch (error) {
      const health = {
        status: 503,
        component: 'platform',
        sourceId: env?.BUILD_SOURCE_ID,
        elapsedMs: performance.now() - started,
      };
      if (isFenceFailure(error)) {
        observeFailure(reportHealth, {...health, requestId: null});
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
