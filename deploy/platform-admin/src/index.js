import {isLocalChallengePath} from './local-challenge-route.mjs';
import {createCollectTransport} from './supabase-transport.js';
import {verifyDeploymentProfile} from '../../../supabase/functions/_shared/deployment-profile.js';
import {standalonePrivacySupport} from '../../../supabase/functions/_shared/burimunsi-privacy-support.js';
import {versionedStatic} from './static-recovery.js';
import {BURIMUNSI_ADMIN_ORIGIN, BURIMUNSI_ADMIN_PROFILE_ID} from './admin-session-realm.js';

const API_ROOT = '/api';
const MANAGED_ROOTS = [API_ROOT, '/v1', '/functions', '/privacy'];
// Every installed Admin worker passes this exact online document through to the host.
const ONLINE_WORKSPACE = '/api/admin/workspace';

function failure(status, code, message) {
  return Response.json({error: {code, message}}, {status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  }});
}

function hasRoot(path, root) {
  return path === root || path.startsWith(root + '/');
}

async function validateManagedHost(env) {
  if (env.COLLECT_DEPLOYMENT_PROFILE === undefined ||
      (env.COLLECT_BACKEND ?? 'supabase') !== 'supabase' || env.SUPABASE_INTERNAL_URL !== undefined) {
    throw new Error('BuriMunsi backend profile is required');
  }
  const profile = await verifyDeploymentProfile(env);
  if (env.SUPABASE_URL !== profile.supabase_origin || profile.id !== BURIMUNSI_ADMIN_PROFILE_ID ||
      profile.environment !== 'production' ||
      env.APP_ENVIRONMENT !== undefined && env.APP_ENVIRONMENT !== profile.environment ||
      [profile.admin_origin, profile.member_api_origin, profile.public_origin, profile.google_callback_origin]
        .some(origin => origin !== BURIMUNSI_ADMIN_ORIGIN)) {
    throw new Error('Backend profile mismatch');
  }
}

async function serveAssets(request, url, assets) {
  if (url.pathname.startsWith('/_build/')) return versionedStatic(request, assets);
  // Typed deep links and worker installs use the same physical shell.
  const shell = ['GET', 'HEAD'].includes(request.method) &&
    (url.pathname === '/' || url.pathname === ONLINE_WORKSPACE || hasRoot(url.pathname, '/admin'));
  // The public document is identical for every account. Only the normal API
  // calls made by the running application should carry a session.
  const response = await assets.fetch(shell ? new Request(new URL('/index.html', url), {method: request.method}) : request);
  if (response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'text/html') return response;
  const output = new Response(response.body, response);
  // The service worker verifies the exact shell bytes across intermediaries.
  output.headers.set('Cache-Control', 'no-store, no-transform');
  return output;
}

export function createAdminWorker({fetchImpl = (request, init) => globalThis.fetch(request, init)} = {}) {
  const transport = createCollectTransport({
    frontendOrigin: BURIMUNSI_ADMIN_ORIGIN,
    allowedFrontendOrigins: [BURIMUNSI_ADMIN_ORIGIN],
    burimunsi: true,
    fetchImpl,
  });
  let validated;
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.origin !== BURIMUNSI_ADMIN_ORIGIN || env.ADMIN_ORIGIN !== BURIMUNSI_ADMIN_ORIGIN) {
        return failure(403, 'origin_denied', 'This workspace origin is unavailable.');
      }
      try {
        const profile = [env.COLLECT_DEPLOYMENT_PROFILE, env.COLLECT_DEPLOYMENT_PROFILE_SHA256,
          env.COLLECT_BACKEND, env.SUPABASE_URL, env.SUPABASE_INTERNAL_URL !== undefined, env.APP_ENVIRONMENT];
        if (!validated || profile.some((value, i) => value !== validated[i])) {
          await validateManagedHost(env);
          validated = profile;
        }
      } catch {
        return failure(503, 'backend_configuration_invalid', 'The workspace backend is unavailable.');
      }
      const privacy = standalonePrivacySupport(request);
      if (privacy) return privacy;
      if (hasRoot(url.pathname, '/.well-known') || isLocalChallengePath(url.pathname)) {
        return failure(404, 'not_found', 'This service route is unavailable.');
      }
      if (url.pathname === ONLINE_WORKSPACE) {
        if (!['GET', 'HEAD'].includes(request.method)) {
          return failure(405, 'method_not_allowed', 'Open the workspace in a browser.');
        }
        const mode = request.headers.get('Sec-Fetch-Mode');
        const destination = request.headers.get('Sec-Fetch-Dest');
        if ((mode && mode !== 'navigate') || (destination && destination !== 'document') ||
            !request.headers.get('Accept')?.split(',').some(value => value.split(';')[0].trim().toLowerCase() === 'text/html')) {
          return failure(406, 'document_required', 'Open the workspace in a browser.');
        }
        return serveAssets(request, url, env.ASSETS);
      }
      if (MANAGED_ROOTS.some(root => hasRoot(url.pathname, root))) {
        return await transport(request) ?? failure(404, 'not_found', 'This service route is unavailable.');
      }
      return serveAssets(request, url, env.ASSETS);
    },
  };
}

export default createAdminWorker();
