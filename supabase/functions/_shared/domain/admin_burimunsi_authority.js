import { adminSessionOriginMatches } from '../admin-security.js';
import { BURIMUNSI_PRODUCT_MODE } from '../burimunsi-standalone.js';
import { applicationWork, applicationWorkTuple } from '../application-fence.js';
import { verifyDeploymentProfile } from '../deployment-profile.js';
import { requireFreshAdminEmail } from './admin_email_policy.js';
import { preliminaryCurrentOwner } from './admin_owner_precheck.js';
import { ApiError } from './core.js';

export const BURI_ADMIN_PRIVATE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, private',
  'Pragma': 'no-cache',
  'Vary': 'Cookie, Origin',
});

/** Translate proof failures from an existing SQL command for its login method. */
export function rethrowWorkflowSessionFailure(error, env) {
  if (!['recent_email_sign_in_required', 'recent_email_verification_required', 'recent_passcode_required'].includes(error?.message)) return;
  if (env.BURIMUNSI_PRODUCT_MODE === BURIMUNSI_PRODUCT_MODE) {
    throw new ApiError(401, 'unauthenticated', 'Your session has ended. Sign in again.');
  }
  throw new ApiError(403, 'recent_email_sign_in_required', 'Verify your current Admin email before continuing.');
}

/** Check the administrator's current grants and request fence before choosing a collection. */
export async function requireBuriMunsiAdmin({
  request,
  env,
  account,
  permissions,
  adminMessage,
  unavailableCode,
  unavailableMessage,
}) {
  if (
    !await preliminaryCurrentOwner(env, account) ||
    !permissions.every((permission) => account.permissions.includes(permission))
  ) {
    const code = env.BURIMUNSI_PRODUCT_MODE === BURIMUNSI_PRODUCT_MODE ? 'admin_required' : 'owner_required';
    throw new ApiError(403, code, adminMessage);
  }
  requireFreshAdminEmail(account);

  const work = applicationWork(env);
  const profile = await verifyDeploymentProfile(env);
  if (
    work.kind !== 'http_admin' || env.DB?.applicationWork !== work ||
    applicationWorkTuple(work)[2] !== env.BUILD_SOURCE_ID ||
    !adminSessionOriginMatches(request, env, profile, account)
  ) {
    throw new ApiError(503, unavailableCode, unavailableMessage);
  }
}
