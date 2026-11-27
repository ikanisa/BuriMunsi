import { SafeError, isAccountIdentity, isCollectionId, isUuid, object, unavailable, loadCredential } from './config.mjs';
import { sendAdminJson, UnconfirmedAdminResponse } from './admin_http.mjs';
import { adminCookieTokenForOrigin, parseAdminCookie } from './admin_cookie.mjs';

const authError = () => { throw new SafeError('session_unavailable', 'The local Admin session ended or changed. Sign in again; no request was replayed.'); };
const cancelledRead = () => new SafeError('cancelled', 'The read was cancelled. No action was retried.');
// Canonical grants include three-part names such as auth.mfa.enroll. This
// validates bounded response syntax only; authority still requires exact grants.
export const capabilityName = value => typeof value === 'string' && value.length <= 128 &&
  !/[^a-z_.]/.test(value) && /^[a-z_]+(?:\.[a-z_]+){1,2}$/.test(value);

/** Read or submit a fixed Admin operation and expose safe errors only. */
export async function requestJson(config, path, options) {
  let reply;
  try {
    reply = await sendAdminJson(config, path, options);
  } catch (error) {
    if (error instanceof SafeError) throw error;
    if (error instanceof UnconfirmedAdminResponse && error.cancelled) throw cancelledRead();
    unavailable();
  }
  const { status, value, headers } = reply;
  if (status === 401) authError();
  if (status === 403) throw new SafeError('permission_denied', 'Your current Admin account cannot read this information.');
  if (status === 404) throw new SafeError('record_unavailable', 'This record is unavailable for the current account.');
  if (status === 429) throw new SafeError('rate_limited', 'The Admin service rate limit was reached. Wait before making another request.');
  if (status < 200 || status >= 300) unavailable();
  return { value, headers };
}

export function parseSession(value) {
  const user = value.user;
  if (user === null) authError();
  if (!object(user)) unavailable();
  const phone = user.authMethod === 'phone_passcode';
  const validIdentity = phone ? isAccountIdentity : isUuid;
  if (!validIdentity(user.id) || !isUuid(user.sessionId) || !validIdentity(user.principalId) ||
      (!phone && typeof user.email !== 'string') || (user.email != null && (typeof user.email !== 'string' || user.email.length > 254)) ||
      !['owner', 'admin', 'staff'].includes(user.role) ||
      user.financialModel !== 'canonical_evidence_ledger' || !Array.isArray(user.permissions) || user.permissions.length > 256 ||
      user.permissions.some(p => !capabilityName(p))) unavailable();
  const now = Date.now();
  let phoneIdentity;
  if (phone) {
    const proof = value.adminIdentity;
    const verifiedAt = Date.parse(user.passcodeVerifiedAt);
    if (!['admin', 'staff'].includes(user.role) || !isUuid(user.accountId) ||
        typeof user.phone !== 'string' || !/^\+2507[2389]\d{7}$/.test(user.phone) ||
        typeof user.passcodeVerifiedAt !== 'string' || !/(?:Z|\+00:00)$/.test(user.passcodeVerifiedAt) ||
        !Number.isFinite(verifiedAt) || verifiedAt > now + 60_000 ||
        typeof value.csrfToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.csrfToken)) unavailable();
    if (user.role === 'admin' ? !object(proof) || Object.keys(proof).sort().join(',') !== 'accountId,adminId,collectionId,principalId,role,schemaVersion' ||
        proof.schemaVersion !== 1 || proof.role !== 'admin' ||
        proof.accountId !== user.accountId || proof.adminId !== user.id || proof.principalId !== user.principalId ||
        !isCollectionId(proof.collectionId) : proof != null) unavailable();
    phoneIdentity = { authMethod: user.authMethod, phone: user.phone, phoneAccountId: user.accountId,
      collectionId: proof?.collectionId ?? null, passcodeVerifiedAt: user.passcodeVerifiedAt };
  }
  const expiresAt = typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : NaN;
  const mfaAt = user.mfaAt ?? null;
  const proofTime = typeof mfaAt === 'string' ? Date.parse(mfaAt) : NaN;
  const assuranceLevel = user.assuranceLevel ?? (phone ? 1 : undefined);
  const validAssurance = assuranceLevel === 1 ? mfaAt === null :
    assuranceLevel === 2 && Number.isFinite(proofTime) && proofTime <= now + 60_000;
  const supportedPolicy = (user.mfaRequired === undefined || user.mfaRequired === false) &&
    (user.mfaAvailable === undefined || typeof user.mfaAvailable === 'boolean');
  if (!supportedPolicy || !validAssurance || !Number.isFinite(expiresAt) || expiresAt <= now) unavailable();
  return { id: user.id, email: user.email, role: user.role, sessionId: user.sessionId, principalId: user.principalId,
    permissions: [...new Set(user.permissions)].sort(), assuranceLevel,
    mfaAt, financialModel: user.financialModel, expiresAt: value.expiresAt, ...phoneIdentity };
}
export async function readAdminSessionResponse(config, cookie, signal) {
  const {value, headers} = await requestJson(config, '/api/admin/auth/session', { cookie, signal });
  if (headers.getSetCookie().length) {
    const token = parseAdminCookie(headers, config.origin);
    if (!token || token !== adminCookieTokenForOrigin(config.origin, cookie)) authError();
  }
  return {user: parseSession(value), csrfToken: value.csrfToken};
}

export async function readAdminSession(config, cookie, signal) {
  return (await readAdminSessionResponse(config, cookie, signal)).user;
}

export const sameAdminSession = (before, after) => JSON.stringify(before) === JSON.stringify(after);

export function credentialMatchesSession(credential, user) {
  return credential.accountId === user.id && credential.sessionId === user.sessionId && credential.principalId === user.principalId &&
    (credential.version === 2 ? user.authMethod === 'phone_passcode' && credential.phoneAccountId === user.phoneAccountId &&
      credential.collectionId === user.collectionId : !user.authMethod);
}

export async function credentialIsCurrent(config, credential) {
  return credential.fingerprint === (await loadCredential(config)).fingerprint;
}

export class AdminApi {
  constructor(config) { this.config = config; }
  async withAuthority(permission, read, signal) {
    if (signal?.aborted) throw cancelledRead();
    const credential = await loadCredential(this.config);
    const before = await readAdminSession(this.config, credential.cookie, signal);
    if (!credentialMatchesSession(credential, before)) authError();
    const required = permission == null ? [] : Array.isArray(permission) ? permission : [permission];
    if (required.some(value => !before.permissions.includes(value))) throw new SafeError('permission_denied', 'Your current Admin account cannot read this information.');
    const value = await read({ user: before,
      get: async path => (await requestJson(this.config, path, { cookie: credential.cookie, signal })).value });
    if (signal?.aborted) throw cancelledRead();
    if (!await credentialIsCurrent(this.config, credential)) authError();
    const after = await readAdminSession(this.config, credential.cookie, signal);
    if (!sameAdminSession(before, after) || !await credentialIsCurrent(this.config, credential)) authError();
    if (signal?.aborted) throw cancelledRead();
    return value;
  }
}
