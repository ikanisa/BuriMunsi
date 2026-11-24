import {canManageOperatorAccess} from '../../session/ownerIdentity';
import type {AdminUser} from '../../session/sessionResponses';
import {requiresPermissions} from './routePolicy';

const canManageReceiverAccess = requiresPermissions('admin_users.manage', 'receivers.read', 'receivers.manage');

export function canOpenOperatorProfile(user: AdminUser): boolean {
  return user.financialModel === 'canonical_evidence_ledger' &&
    canManageOperatorAccess(user) && canManageReceiverAccess(user);
}

export function canOpenTeam(user: AdminUser): boolean {
  return (!user.accountId || user.role === 'admin') && user.permissions.includes('admin_users.read');
}
