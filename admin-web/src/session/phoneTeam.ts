import {AdminRequestError, isJsonObject, isVerificationUuid, type JsonObject} from '../api/contracts';
import {normalizeLoginPhone} from './phonePasscode';
import type {AdminUser} from './sessionResponses';

export type PhoneTeamRole = 'admin' | 'staff';
export const phoneTeamRoles = {admin: 'Admin', staff: 'Staff'} as const;
export interface PhoneTeamMember {
  id: string; displayName: string; phone: string; role: PhoneTeamRole; active: boolean; version: number;
}
export interface PhoneTeam {
  currentAccountId: string; canManage: boolean; members: PhoneTeamMember[];
  permissionsByRole: Record<PhoneTeamRole, string[]>;
}

function invalid(): never {throw new Error('The team directory could not be verified.');}
function permissions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500 || !value.every(item => typeof item === 'string' && /^[a-z][a-z0-9_.-]{0,95}$/.test(item))) return invalid();
  return [...new Set(value as string[])].sort();
}
export function parsePhoneTeam(body: JsonObject, actor: Pick<AdminUser, 'accountId'|'phone'|'role'|'permissions'>): PhoneTeam {
  if (body.contractVersion !== 1 || !isVerificationUuid(body.currentAccountId) || body.currentAccountId !== actor.accountId ||
      typeof body.canManage !== 'boolean' || !Array.isArray(body.members) || body.members.length > 10_000 ||
      !isJsonObject(body.permissionsByRole) || Object.keys(body.permissionsByRole).sort().join(',') !== 'admin,staff') return invalid();
  if (body.canManage && (actor.role !== 'admin' || !actor.permissions.includes('admin_users.manage'))) return invalid();
  const ids = new Set<string>(), phones = new Set<string>();
  const members = body.members.map((member): PhoneTeamMember => {
    if (!isJsonObject(member) || !isVerificationUuid(member.id) || ids.has(member.id) ||
        typeof member.displayName !== 'string' || !member.displayName.trim() || member.displayName.length > 120 ||
        typeof member.phone !== 'string' || !/^\+2507[2389]\d{7}$/.test(member.phone) || phones.has(member.phone) ||
        (member.role !== 'admin' && member.role !== 'staff') || typeof member.active !== 'boolean' ||
        typeof member.version !== 'number' || !Number.isSafeInteger(member.version) || member.version < 1) return invalid();
    ids.add(member.id); phones.add(member.phone);
    return {id: member.id, displayName: member.displayName, phone: member.phone, role: member.role, active: member.active, version: member.version};
  });
  const self = members.find(member => member.id === actor.accountId);
  if (!self?.active || self.phone !== actor.phone || self.role !== actor.role) return invalid();
  return {currentAccountId: body.currentAccountId, canManage: body.canManage, members,
    permissionsByRole: {admin: permissions(body.permissionsByRole.admin), staff: permissions(body.permissionsByRole.staff)}};
}

export type TeamChange =
  | {kind: 'create'; requestId: string; displayName: string; phone: string; role: PhoneTeamRole}
  | {kind: 'access'; requestId: string; member: PhoneTeamMember; active: boolean; role: PhoneTeamRole};

export function prepareTeamAccount(team: PhoneTeam, name: string, number: string, role: PhoneTeamRole): TeamChange {
  const displayName = name.trim(), phone = normalizeLoginPhone(number);
  if (displayName.length < 2 || displayName.length > 100 || [...displayName].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    throw new Error('Enter a name between 2 and 100 characters.');
  if (team.members.some(member => member.phone === phone)) throw new Error('That phone number already has an account.');
  return {kind: 'create', requestId: crypto.randomUUID(), displayName, phone, role};
}

export function confirmTeamReceipt(response: JsonObject, change: TeamChange): void {
  if (response.applied !== true || !isVerificationUuid(response.id) || typeof response.version !== 'number' ||
      !Number.isSafeInteger(response.version) || (change.kind === 'access' ?
        response.id !== change.member.id || response.version !== change.member.version + 1 : response.version !== 1)) {
    throw new AdminRequestError('The account change could not be confirmed.', {outcomeUnknown: true});
  }
}
