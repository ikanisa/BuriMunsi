/* eslint-disable no-control-regex -- Reject controls in server-supplied identity fields. */
import {isJsonObject, isVerificationUuid, type JsonObject} from '../api/contracts';
import {isCanonicalAdminEmail} from './adminEmail';
import type {AdminUser} from './sessionResponses';

/** Protected-owner attestation from the versioned authenticated session only. */
export interface AdminOwnerIdentity {schemaVersion: 1; adminId: string; principalId: string; email: string;}
export interface ScopedAdminIdentity {schemaVersion: 1; accountId: string; adminId: string; principalId: string; collectionId: string; role: 'admin';}
export function parseScopedAdminIdentity(value: unknown, actor: AdminUser): ScopedAdminIdentity | null {
  if (!isJsonObject(value) || Object.keys(value).sort().join(',') !== 'accountId,adminId,collectionId,principalId,role,schemaVersion' ||
      value.schemaVersion !== 1 || value.role !== 'admin' || actor.role !== 'admin' ||
      !isVerificationUuid(value.accountId) || value.accountId !== actor.accountId ||
      !isAdminIdentityId(value.adminId) || value.adminId !== actor.id ||
      !isAdminIdentityId(value.principalId) || value.principalId !== actor.principalId ||
      typeof value.collectionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.collectionId)) return null;
  return Object.freeze({schemaVersion: 1, accountId: value.accountId, adminId: value.adminId,
    principalId: value.principalId, collectionId: value.collectionId, role: 'admin'});
}

export function hasScopedAdminAuthority(user: AdminUser): boolean {
  const proof = user.adminIdentity;
  return user.authMethod === 'phone_passcode' && !!proof && parseScopedAdminIdentity(proof, user) !== null;
}

export function canManageOperatorAccess(user: AdminUser): boolean {
  return user.authMethod === 'phone_passcode' && user.accountId ? hasScopedAdminAuthority(user) : isVerifiedCurrentOwner(user);
}
/** Managed Admin links identify Collect users by their original PostgreSQL text. */
export function isAdminIdentityId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    value === value.trim() && !/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(value);
}
export function parseOwnerIdentitySession(body: JsonObject): AdminOwnerIdentity | null {
  const owner = body.ownerIdentity;
  if (!isJsonObject(owner)) return null;
  if (Object.keys(owner).length !== 4 || !['schemaVersion', 'adminId', 'principalId', 'email'].every(key => Object.hasOwn(owner, key)) || owner.schemaVersion !== 1 ||
      !isAdminIdentityId(owner.adminId) || !isAdminIdentityId(owner.principalId) || !isCanonicalAdminEmail(owner.email) || body.ownerEmail !== owner.email) return null;
  return Object.freeze({schemaVersion: 1, adminId: owner.adminId, principalId: owner.principalId, email: owner.email});
}
/** A role or email alone never proves that the current actor is the owner. */
export function isVerifiedCurrentOwner(user: AdminUser): boolean {
  const owner = user.ownerIdentity;
  return user.role === 'owner' && !!owner && owner.adminId === user.id && owner.principalId === user.principalId && owner.email === user.email;
}
