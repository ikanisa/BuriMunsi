import {isCanonicalAdminEmail} from './adminEmail';
import {isVerifiedCurrentOwner} from './ownerIdentity';
import type {VerificationMode} from './returnLocation';
import type {AdminUser} from './sessionResponses';

export const TEAM_OWNER_EMAIL = 'info@ikanisa.com';
export const TEAM_MANAGE = 'admin_users.manage';
export const TEAM_MEMBER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const TEAM_VERIFICATION_REQUIRED = 'Verify your current owner sign-in before managing team access.';

export function hasTeamManagementGrant(actor: AdminUser): boolean {
  return actor.role === 'owner' && actor.permissions.includes(TEAM_MANAGE);
}

export function isLegacyTeamOwner(actor: AdminUser): boolean {
  return hasTeamManagementGrant(actor) && actor.email === TEAM_OWNER_EMAIL;
}

export function isTeamManager(actor: AdminUser, mode: VerificationMode): boolean {
  return mode === 'email' ? hasTeamManagementGrant(actor) && isVerifiedCurrentOwner(actor) : isLegacyTeamOwner(actor);
}

export function isTeamTargetEmail(email: unknown, actor: Pick<AdminUser, 'email'>, mode: VerificationMode): email is string {
  return isCanonicalAdminEmail(email) && email !== actor.email.toLowerCase() &&
    (mode === 'email' || email !== TEAM_OWNER_EMAIL);
}

export function isTeamTarget(
  member: {id: string; email: string; role: AdminUser['role']; status: 'active' | 'invited' | 'revoked'},
  actor: AdminUser,
  mode: VerificationMode,
): boolean {
  return TEAM_MEMBER_ID.test(member.id) && member.id !== actor.id && member.role !== 'owner' &&
    member.status !== 'revoked' && isTeamTargetEmail(member.email, actor, mode);
}

/** Check the owning session before every access, including after a digest. */
export function bindTeamStorage(requireCurrent: () => void, resolveStorage = () => sessionStorage): Storage {
  return {
    get length() { return 0; },
    clear() { throw new Error('Unsupported recovery operation.'); },
    key() { return null; },
    getItem(key) {
      requireCurrent();
      return resolveStorage().getItem(key);
    },
    setItem(key, value) {
      requireCurrent();
      resolveStorage().setItem(key, value);
    },
    removeItem(key) {
      requireCurrent();
      resolveStorage().removeItem(key);
    },
  };
}
