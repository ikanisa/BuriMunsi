import {MANAGED_SUPABASE_ORIGIN} from './deployment-profile.js';

export const BURIMUNSI_ADMIN_ORIGIN = 'https://burimunsi-admin.ikanisa.com';
export const BURIMUNSI_PRODUCT_MODE = 'standalone';
export const MANAGED_PRODUCTION_PROFILE_SHA256 = '55ea350d7bf9ddef3e98022952bfe179da6216d52051ae0f4d6457d884ed1c61';

const privacyDocuments = new Set([
  '/privacy/account-deletion',
  '/privacy/account-deletion/',
  '/privacy/account-deletion/assets/style.css',
]);
const adminAuthMethods = new Map([
  ['/api/admin/auth/phone-passcode', 'POST'],
  ['/api/admin/auth/session', 'GET'],
  ['/api/admin/auth/passcode/verify', 'POST'],
  ['/api/admin/auth/logout', 'POST'],
]);
const retiredAdminRoutes = new Set([
  '/api/admin/burimunsi/access',
  '/api/admin/team/invite',
  '/api/admin/team/invitation-status',
  '/api/admin/team/v2',
]);
const gatewayReads = new Set(['/v1/momo/gateway/profile', '/v1/momo/gateway/status']);
const gatewayWrites = new Set(['/v1/momo/gateway/pair', '/v1/momo/gateway/ingest', '/v1/momo/gateway/heartbeat']);
const reservedAdminCreates = new Set([
  '/api/admin/operations/groups',
  '/api/admin/momo/accounts',
  '/api/admin/momo/bindings',
]);

export function isManagedProductionProfile(env) {
  return env.APP_ENVIRONMENT === 'production' && env.SUPABASE_URL === MANAGED_SUPABASE_ORIGIN &&
    typeof env.COLLECT_DEPLOYMENT_PROFILE === 'string' &&
    env.COLLECT_DEPLOYMENT_PROFILE_SHA256 === MANAGED_PRODUCTION_PROFILE_SHA256;
}

// Call only after verification of the canonical deployment profile. The
// standalone entrypoints select this check in source, so a missing setting
// can never fall back to the shared member surface.
export function requireStandaloneDeployment(env) {
  if (env.BURIMUNSI_PRODUCT_MODE !== BURIMUNSI_PRODUCT_MODE || !isManagedProductionProfile(env) ||
      typeof env.BURIMUNSI_COLLECTION_ID !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(env.BURIMUNSI_COLLECTION_ID)) {
    throw new Error('burimunsi_standalone_deployment_unconfigured');
  }
  return env.BURIMUNSI_COLLECTION_ID;
}

export function standalonePrivacyRoute(method, path) {
  return ['GET', 'HEAD'].includes(method) && privacyDocuments.has(path);
}

export function standaloneAdminRoute(method, path) {
  if (!path.startsWith('/api/admin/')) return false;
  if (path === '/api/admin/oversight/sms-health') return method === 'GET';
  if (path === '/api/admin/auth' || path.startsWith('/api/admin/auth/')) {
    return adminAuthMethods.has(path) && adminAuthMethods.get(path) === method;
  }
  if (retiredAdminRoutes.has(path) || path.startsWith('/api/admin/team/v2/') ||
      /^\/api\/admin\/team\/[0-9a-f-]{36}\/resend$/.test(path)) return false;
  return !(method === 'POST' && reservedAdminCreates.has(path));
}

export function standaloneHttpRoute(functionName, request) {
  const path = new URL(request.url).pathname;
  const method = request.method === 'OPTIONS' ? request.headers.get('Access-Control-Request-Method') : request.method;
  if (functionName === 'admin-api') return standaloneAdminRoute(method, path);
  if (functionName !== 'collect-api') return false;
  if (path === '/v1/burimunsi/managed' || path.startsWith('/v1/burimunsi/managed/')) return false;
  if (path === '/v1/burimunsi' || path.startsWith('/v1/burimunsi/')) return true;
  if (path === '/health' || gatewayReads.has(path)) return method === 'GET';
  if (path === '/v1/rpc/get_public_runtime_config' || gatewayWrites.has(path)) return method === 'POST';
  return standalonePrivacyRoute(method, path);
}
