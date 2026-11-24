// Synthetic accounts and session cookies exist only in this loopback fixture process.
import { randomBytes, randomUUID } from 'node:crypto';

export const fixtureAdminId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const fixtureInitialPasscode = '2468';
const roles = {
  admin: ['overview.read', 'collections.read', 'users.read', 'receivers.read', 'receivers.manage', 'payments.read',
    'ledger.read', 'reconciliations.read', 'sms.read', 'gateway.read', 'account.manage', 'admin_users.read', 'admin_users.manage'],
  staff: ['overview.read'],
};
const cookieKey = 'collect_fixture_session';
const cookie = value => ({'Set-Cookie': `${cookieKey}=${value}; Path=/; HttpOnly; SameSite=Strict${value ? '' : '; Max-Age=0'}`});
const anonymous = {user: null, expiresAt: null, csrfToken: null, ownerEmail: null};
const error = code => ({error: {code}});

export function createPhoneAccountFixture({cookieSignIn, legacySessionResponses, lifetime, json, readBody}) {
  const admin = {id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', displayName: 'Fixture administrator',
    phone: '+250780000001', role: 'admin', active: true, version: 1};
  const members = new Map([[admin.id, admin]]);
  const credentials = new Map([[admin.id, {pin: '0123', adminId: fixtureAdminId, principalId: randomUUID()}]]);
  const sessions = new Map();

  function issueSession(accountId) {
    const session = {accountId, sessionId: randomUUID(), verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + lifetime).toISOString(), csrfToken: randomBytes(32).toString('hex')};
    sessions.set(session.sessionId, session);
    return session;
  }
  const implicit = cookieSignIn ? null : issueSession(admin.id);
  function current(request) {
    const entry = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(cookieKey + '='));
    const session = implicit ?? sessions.get(entry?.slice(cookieKey.length + 1));
    return session && Date.parse(session.expiresAt) > Date.now() && members.get(session.accountId)?.active ? session : null;
  }
  function sessionBody(session) {
    if (!session) return anonymous;
    const {accountId, sessionId, expiresAt, csrfToken, verifiedAt} = session;
    const {phone, role, displayName} = members.get(accountId), {adminId, principalId} = credentials.get(accountId);
    return {user: {id: adminId, accountId, principalId, sessionId, phone, role, displayName, authMethod: 'phone_passcode',
      passcodeVerifiedAt: verifiedAt, financialModel: 'canonical_evidence_ledger', permissions: roles[role]},
    expiresAt, csrfToken, ownerEmail: null,
    ...(role === 'admin' ? {adminIdentity: {schemaVersion: 1, role, accountId, adminId, principalId, collectionId: 'fixture-group'}} : {})};
  }
  function revokeSessions(id) {
    for (const [token, session] of sessions) if (session.accountId === id) sessions.delete(token);
  }
  async function handle(request, response, path, session) {
    const send = (status, body, headers) => json(response, status, body, headers);
    if (path === 'auth/session' && request.method === 'GET') return send(200, sessionBody(session));
    if (request.method === 'POST' && !cookieSignIn) return send(405, error('fixture_read_only'));
    if (path === 'auth/phone-passcode' && request.method === 'POST') {
      const data = await readBody(request);
      const member = [...members.values()].find(member => member.active && member.phone === data?.phone);
      if (!member || Object.keys(data).sort().join(',') !== 'phone,pin' || credentials.get(member.id).pin !== data.pin) {
        return send(401, error('invalid_credentials'));
      }
      const issued = issueSession(member.id);
      const direct = !legacySessionResponses && request.headers['x-collect-owner-identity-version'] === '1';
      return send(200, {...sessionBody(issued), ...(direct ? {sessionContract: 2} : {})}, cookie(issued.sessionId));
    }
    if (!session) return send(401, error('fixture_unauthorized'));
    const actor = members.get(session.accountId);
    if (path === 'team' && request.method === 'GET') {
      if (actor.role !== 'admin') return send(403, error('forbidden'));
      return send(200, {contractVersion: 1, currentAccountId: actor.id, members: [...members.values()], canManage: true, permissionsByRole: roles});
    }
    if (request.method !== 'POST') return send(404, error('fixture_not_found'));
    if (request.headers['x-collect-csrf'] !== session.csrfToken) return send(403, error('csrf_failed'));
    if (path === 'auth/logout') {
      sessions.delete(session.sessionId);
      return send(200, {ok: true}, cookie(''));
    }
    const data = await readBody(request);
    if (path === 'auth/passcode/change') {
      const access = credentials.get(actor.id);
      if (!data || data.current !== access.pin) return send(400, error('invalid_current_pin'));
      if (!/^\d{4}$/.test(data.newPin) || data.newPin !== data.confirm || data.newPin === data.current) return send(400, error('invalid_passcode'));
      access.pin = data.newPin;
      revokeSessions(actor.id);
      return send(200, {ok: true}, cookie(''));
    }
    if (!path.startsWith('team/accounts')) return send(404, error('fixture_not_found'));
    if (actor.role !== 'admin') return send(403, error('forbidden'));
    if (!data?.requestId || request.headers['idempotency-key'] !== data.requestId || !Object.hasOwn(roles, data.role)) return send(400, error('invalid_request'));
    if (path === 'team/accounts') {
      if (Object.keys(data).sort().join(',') !== 'displayName,phone,requestId,role' || typeof data.displayName !== 'string' ||
        !/^\+2507[2389]\d{7}$/.test(data.phone) || [...members.values()].some(member => member.phone === data.phone)) return send(400, error('invalid_account'));
      const id = randomUUID();
      members.set(id, {id, displayName: data.displayName, phone: data.phone, role: data.role, active: true, version: 1});
      credentials.set(id, {pin: fixtureInitialPasscode, adminId: randomUUID(), principalId: randomUUID()});
      return send(200, {applied: true, id, version: 1});
    }
    const id = /^team\/accounts\/([0-9a-f-]{36})\/access$/.exec(path)?.[1], member = members.get(id);
    if (!member) return send(404, error('fixture_not_found'));
    if (member.id === actor.id || typeof data.active !== 'boolean' || data.expectedVersion !== member.version) return send(409, error('account_conflict'));
    Object.assign(member, {role: data.role, active: data.active, version: member.version + 1});
    revokeSessions(member.id);
    return send(200, {applied: true, id, version: member.version});
  }
  function hasPermission(session, permission) {
    const role = session && members.get(session.accountId)?.role;
    return !!role && roles[role].includes(permission);
  }
  return {current, handle, hasPermission};
}
