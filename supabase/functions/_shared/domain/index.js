import { isGoogleProviderNavigation } from '../runtime-env.js';
import { ApiError, json, readJson, first, now } from './core.js';
import { syncEvents } from './sync.js';
import { handleAuth, requireSession } from './auth.js';
import { handleAdmin } from './admin_bridge.js';
import { publicGroups } from './groups.js';
import { notificationEvents } from './notifications.js';
import { evidenceRoute } from './evidence.js';
import { challengeRoute } from './challenge.js';
import { receiptRoute } from './receipts.js';
import { privacyPortalRoute } from './privacy_portal.js';
import { handlePrivacyEmailAuth } from './privacy.js';
import { dispatchOperation, publicRpcNames } from './operations.js';
import { recordPlatformHealth, platformHealthComponent } from './observability.js';
import { momoGatewayRoute } from './momo_gateway.js';
import { clientDiagnosticsRoute } from './client_diagnostics.js';
import { collectNativeRoute } from './burimunsi/collect-route.js';

const publicOperations = new Set(publicRpcNames);
const rosterUploads = new Set([
  'prepare-roster-import', 'roster-import-upload', 'roster-import-extract',
]);

function cors(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (origin && !allowed.includes(origin) && !isGoogleProviderNavigation(request, env)) {
    throw new ApiError(403, 'origin_denied', 'This origin is not allowed.');
  }
  return origin ? {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Request-ID',
    'Access-Control-Max-Age': '600',
  } : {};
}

async function publicRpc(operation, body, env) {
  const key = operation === 'get_active_policy_document'
    ? 'policy:' + (body.p_document_key ?? body.p_slug ?? body.p_kind ?? body.slug)
    : operation;
  const row = await first(env, 'SELECT value_json FROM runtime_config WHERE key=?', key);
  if (!row) {
    throw new ApiError(503, 'configuration_unavailable', 'This information is unavailable. Please contact support.');
  }
  return JSON.parse(row.value_json);
}

async function publicRoute(request, env, url, rpcName) {
  // Native and gateway ingestion own their explicit device and provider guards.
  // Gateway processing is admitted separately from this HTTP request.
  const admission = await collectNativeRoute(request, env) ?? await momoGatewayRoute(request, env);
  if (admission) return admission;

  if (request.method === 'GET' && url.pathname === '/health') {
    await first(env, 'SELECT 1 AS ready');
    return json({
      service: 'collect-platform-api',
      database: 'available',
      release: env.BUILD_SOURCE_ID ?? null,
      checked_at: now(),
    });
  }

  const identity = await challengeRoute(request, env) ??
    await handleAuth(request, env) ??
    await handlePrivacyEmailAuth(request, env);
  if (identity) return identity;

  if (request.method === 'GET' && url.pathname === '/v1/query/public-collections') {
    return json(await publicGroups(env));
  }
  if (publicOperations.has(rpcName)) {
    return json(await publicRpc(rpcName, await readJson(request), env));
  }
  return null;
}

async function memberRoute(request, env, url, rpcName) {
  const actor = await requireSession(request, env);
  const diagnostics = await clientDiagnosticsRoute(request, env, actor);
  if (diagnostics) return diagnostics;

  if (request.method === 'GET' && url.pathname === '/v1/query/notification-events') {
    return json(await notificationEvents(env, actor));
  }
  if (request.method === 'GET' && url.pathname === '/v1/sync') {
    return json(await syncEvents(request, env, actor));
  }
  const evidence = await receiptRoute(request, env, actor) ?? await evidenceRoute(request, env, actor);
  if (evidence) return evidence;

  if (rpcName) {
    return json(await dispatchOperation('rpc', rpcName, await readJson(request), env, actor));
  }
  const functionMatch = request.method === 'POST' && /^\/v1\/functions\/([a-z][a-z0-9_-]{0,100})$/.exec(url.pathname);
  if (functionMatch) {
    const operation = functionMatch[1];
    const body = await readJson(request, rosterUploads.has(operation) ? 7100000 : 32768);
    return json(await dispatchOperation('function', operation, body, env, actor));
  }
  throw new ApiError(404, 'not_found', 'This route is unavailable.');
}

function withHeaders(response, headers) {
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) result.headers.set(name, value);
  return result;
}

export default {
  // Background processing requires its separate scheduled-dispatch admission.
  async scheduled() {},

  async fetch(request, env, ctx) {
    const requestId = crypto.randomUUID();
    const started = performance.now();
    const url = new URL(request.url);
    let headers = {};
    function recordOutcome(status, id, unexpected = false) {
      recordPlatformHealth({
        status,
        component: platformHealthComponent(url.pathname),
        requestId: id,
        sourceId: env.BUILD_SOURCE_ID,
        elapsedMs: performance.now() - started,
        ...(id ? { unexpected } : {}),
      });
    }
    function observe(response) {
      if (response.status === 429 || response.status >= 500) recordOutcome(response.status, null);
      return response;
    }

    try {
      const dedicated = await privacyPortalRoute(request, env) ?? await handleAdmin(request, env, ctx);
      if (dedicated) return observe(dedicated);

      headers = cors(request, env);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

      const rpcName = request.method === 'POST' ? /^\/v1\/rpc\/([a-z][a-z0-9_]{0,100})$/.exec(url.pathname)?.[1] : undefined;
      const response = await publicRoute(request, env, url, rpcName) ?? await memberRoute(request, env, url, rpcName);
      return observe(withHeaders(response, headers));
    } catch (error) {
      const known = error instanceof ApiError;
      const status = known ? error.status : 500;
      recordOutcome(status, requestId, !known);
      return json({
        code: known ? error.code : 'internal_error',
        message: known ? error.message : 'The request could not be completed.',
        request_id: requestId,
      }, status, headers);
    }
  },
};
