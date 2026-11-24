import type {AdminUser} from '../../session/sessionResponses';
import {hasScopedAdminAuthority} from '../../session/ownerIdentity';

/** The enrollment endpoint also checks the operator's current native approval for its collection. */
export function canAddMember(user: AdminUser): boolean {
  return user.financialModel === 'canonical_evidence_ledger' && hasScopedAdminAuthority(user) &&
    user.permissions.includes('users.manage') && user.permissions.includes('collections.manage');
}
