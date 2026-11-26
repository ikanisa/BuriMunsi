import {AdminRequestError, type AdminApiClient, type AdminBackend, type JsonObject} from '../api/client';
import {isJsonObject} from '../api/contracts';
import {hasScopedAdminAuthority} from './ownerIdentity';
import {parseAdminUser, parseEmailProof, parseSessionUser, type AdminUser} from './sessionResponses';

export interface SessionReadback {
  isCurrent?: () => boolean;
  matches: (user: AdminUser) => boolean;
  message: string;
}

export interface SessionHomeBootstrap {
  collectionId: string;
  home: JsonObject;
}

function readHomeBootstrap(body: JsonObject, user: AdminUser, csrfToken?: string | null): SessionHomeBootstrap | undefined {
  if (!csrfToken || user.authMethod !== 'phone_passcode' || !user.accountId || !user.principalId ||
      user.financialModel !== 'canonical_evidence_ledger' || !['overview.read','payments.read'].every(grant => user.permissions.includes(grant))) return;
  const bootstrap = body.homeBootstrap;
  if (!isJsonObject(bootstrap) || Object.keys(bootstrap).length !== 5 || bootstrap.version !== 1 ||
      bootstrap.actorId !== user.id || bootstrap.sessionId !== user.sessionId ||
      typeof bootstrap.collectionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(bootstrap.collectionId) ||
      bootstrap.collectionId !== body.homeCollectionId || !isJsonObject(bootstrap.home)) return;
  if (user.role === 'admin' ? !hasScopedAdminAuthority(user) || user.adminIdentity?.collectionId !== bootstrap.collectionId :
      user.role !== 'staff' || body.adminIdentity != null) return;
  return {collectionId: bootstrap.collectionId, home: bootstrap.home};
}

/** A refresh can install only the user and CSRF proof that it read under its own authority. */
export async function readAdminSession(request: AdminApiClient['request'], backend: AdminBackend, isCurrent: () => boolean, sessionHome = false) {
  let csrfToken: string | null | undefined;
  const body = await request('auth/session', sessionHome ? {authenticated: false, sessionHome: true} : {authenticated: false}, {
    isCurrent,
    receiveCsrf: token => { csrfToken = token; },
  });
  if (!isCurrent()) return null;
  if (body.user === null) return {user: null, csrfToken};
  const user = backend === 'supabase' ? parseSessionUser(body, Date.now()) : parseAdminUser(body);
  return {user, csrfToken, homeBootstrap: sessionHome ? readHomeBootstrap(body, user, csrfToken) : undefined};
}

export async function readSessionEmailProof(request: AdminApiClient['request'], user: AdminUser, isCurrent: () => boolean): Promise<string | null> {
  try {
    const proof = await request('auth/email-verification', {authenticated: false, expectedStatus: 200}, {isCurrent});
    if (!isCurrent()) return null;
    if (typeof proof.sessionId === 'string' && proof.sessionId !== user.sessionId) throw new Error('Session mismatch.');
    return parseEmailProof(proof, user, Date.now());
  } catch (failure) {
    if (!isCurrent()) return null;
    // A retired client or mismatched proof cannot establish the earlier session response.
    if (failure instanceof AdminRequestError && failure.statusCode === 426 ||
        failure instanceof Error && failure.message === 'Session mismatch.') throw failure;
    return null;
  }
}
