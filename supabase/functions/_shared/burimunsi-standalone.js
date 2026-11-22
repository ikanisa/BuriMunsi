import {MANAGED_SUPABASE_ORIGIN} from './deployment-profile.js';

export const BURIMUNSI_ADMIN_ORIGIN = 'https://burimunsi-admin.ikanisa.com';
export const BURIMUNSI_PRODUCT_MODE = 'standalone';
export const MANAGED_PRODUCTION_PROFILE_SHA256 = '55ea350d7bf9ddef3e98022952bfe179da6216d52051ae0f4d6457d884ed1c61';

const privacyDocuments = new Set([
  '/privacy/account-deletion',
  '/privacy/account-deletion/',
  '/privacy/account-deletion/assets/client.js',
  '/privacy/account-deletion/assets/style.css',
]);
const privacyActions = new Set([
  '/v1/auth/otp',
  '/v1/auth/verify',
  '/v1/auth/logout',
  '/v1/privacy/email/challenge',
  '/v1/privacy/email/verify',
  '/v1/privacy/email/status',
  '/v1/privacy/email/cancel',
  '/v1/rpc/request_account_deletion_v1',
  '/v1/rpc/get_account_deletion_request_status_v1',
  '/v1/rpc/get_current_account_deletion_request_status_v1',
  '/v1/rpc/get_account_deletion_review_status_v1',
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
  return ['GET', 'HEAD'].includes(method) && privacyDocuments.has(path) ||
    method === 'POST' && privacyActions.has(path);
}

export function standaloneHttpRoute(functionName, request) {
  const path = new URL(request.url).pathname;
  const method = request.method === 'OPTIONS' ? request.headers.get('Access-Control-Request-Method') : request.method;
  if (functionName === 'admin-api') {
    return path.startsWith('/api/admin/') &&
      !(method === 'POST' && reservedAdminCreates.has(path));
  }
  if (functionName !== 'collect-api') return false;
  if (path === '/v1/burimunsi' || path.startsWith('/v1/burimunsi/')) return true;
  if (path === '/health' || gatewayReads.has(path)) return method === 'GET';
  if (path === '/v1/security/challenge') return ['GET', 'HEAD'].includes(method);
  if (path === '/v1/rpc/get_public_runtime_config' || gatewayWrites.has(path)) return method === 'POST';
  return standalonePrivacyRoute(method, path);
}

// The retained browser portal is the sole consumer of the generic phone OTP
// endpoint on this surface. Email verification uses its own account route.
export function standalonePrivacyPhoneBody(path, body) {
  if (path !== '/v1/auth/otp' && path !== '/v1/auth/verify') return true;
  if (body?.surface !== 'member' || typeof body.phone !== 'string' || Object.hasOwn(body, 'email')) return false;
  return path !== '/v1/auth/otp' || body.allow_registration === false && body.should_create_user === false;
}
