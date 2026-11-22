import {adminCookieToken, validateAdminOrigin} from '../admin-security.js';
import {BURIMUNSI_ADMIN_ORIGIN, BURIMUNSI_PRODUCT_MODE} from '../burimunsi-standalone.js';
import {ApiError, digest, first, json, readJson} from './core.js';
import {adminCookie, adminPublicUser} from './admin_accounts_legacy.js';
import {newAdminCookieToken} from './admin_bff_tokens.js';
import {adminPasscodeProof, attestAdminPasscodeAccount} from './admin_email_policy.js';
import {nativePinHasher} from './burimunsi/native-secrets.js';
import {PIN_ITERATIONS} from './burimunsi/pin.js';
import {normalizePhone, requirePin} from './burimunsi/values.js';

const SESSION_SECONDS = 1800;
const cookieHash = token => digest(token);
const csrfToken = token => digest('collect-admin-csrf:' + token);
const iso = value => new Date(value * 1000).toISOString();
const credentialsDenied = () => new ApiError(401, 'invalid_credentials', 'Check your mobile number and passcode.');
const signedOut = () => new ApiError(401, 'unauthenticated', 'Your session has ended. Sign in again.');
const unavailable = () => new ApiError(503, 'admin_sign_in_unavailable', 'BuriMunsi Admin sign-in is temporarily unavailable.');

export const standaloneBrowserPasscode = env => env.BURIMUNSI_PRODUCT_MODE === BURIMUNSI_PRODUCT_MODE;

function originFor(request, env) {
  const origin = validateAdminOrigin(request, env);
  if (origin !== BURIMUNSI_ADMIN_ORIGIN || request.headers.has('Authorization')) {
    throw new ApiError(403, 'origin_rejected', 'Open BuriMunsi Admin to continue.');
  }
  return origin;
}

function collectionFor(env) {
  const group = env.BURIMUNSI_COLLECTION_ID;
  if (typeof group !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(group)) throw unavailable();
  return group;
}

async function requireCsrf(request, token) {
  if (request.headers.get('X-Collect-CSRF') !== await csrfToken(token)) {
    throw new ApiError(403, 'csrf_rejected', 'Refresh BuriMunsi Admin and try again.');
  }
}

async function sqlResult(env, query, ...values) {
  const row = await first(env, query, ...values);
  if (!row || !Object.hasOwn(row, 'result')) throw unavailable();
  return row.result;
}

export async function browserPasscodeSession(request, env, required = true) {
  const origin = originFor(request, env);
  const token = adminCookieToken(request);
  if (!token) {
    if (required) throw signedOut();
    return null;
  }
  const hash = await cookieHash(token);
  const group = collectionFor(env);
  const result = await sqlResult(env,
    'SELECT private.burimunsi_browser_pin_session(?,?,?) AS result', group, hash, origin);
  if (result === null) {
    if (required) throw signedOut();
    return null;
  }
  if (result.collectionId !== group || !['admin','staff'].includes(result.operatorRole) ||
      !['owner','admin','staff'].includes(result.storageRole) || !Number.isSafeInteger(result.expiresAt) ||
      result.expiresAt <= Math.floor(Date.now() / 1000) || !Array.isArray(result.permissions) ||
      result.permissions.some(permission => typeof permission !== 'string')) throw unavailable();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) await requireCsrf(request, token);
  const account = attestAdminPasscodeAccount({
    id: result.adminId, principal_id: result.principalId, email: result.email, role: result.storageRole,
    auth_version: result.authVersion, auth_session_id: result.sessionId, public_id: result.publicId,
    origin, token_hash: hash, expires_at: result.expiresAt, auth_at: result.verifiedAt,
    issued_assurance_level: 1, issued_mfa_at: null, issued_mfa_factor_id: null,
    permissions: result.permissions, csrfToken: await csrfToken(token),
  }, result);
  env.DB.setBrowserPasscodeAccount(account);
  env.ADMIN_ACCOUNT = account;
  return account;
}

function publicSession(account) {
  const proof = adminPasscodeProof(account);
  const {email: _email, ...profile} = adminPublicUser(account) ?? {};
  const user = account ? {
    ...profile,
    accountId: proof.accountId, role: proof.operatorRole, phone: proof.phone, displayName: proof.name, authMethod: 'phone_passcode',
    passcodeVerifiedAt: iso(proof.verifiedAt),
  } : null;
  return {
    user, expiresAt: account ? iso(account.expires_at) : null,
    csrfToken: account?.csrfToken ?? null, ownerEmail: null,
    ...(proof?.operatorRole === 'admin' ? {adminIdentity: {
      schemaVersion: 1, accountId: proof.accountId, adminId: proof.adminId,
      principalId: proof.principalId, collectionId: proof.collectionId, role: 'admin',
    }} : {}),
  };
}

function normalizedCredentials(body, phone) {
  const expected = phone === undefined ? ['phone', 'pin'] : ['pin'];
  try {
    if (Object.keys(body).length !== expected.length || !expected.every(key => Object.hasOwn(body, key))) throw Error();
    return [normalizePhone(phone ?? body.phone), requirePin(body.pin)];
  } catch {
    throw credentialsDenied();
  }
}

async function checkPasscode(request, env, group, phone, pin) {
  const hasher = nativePinHasher(env);
  const phoneHash = await digest(phone);
  // Share the native account budget. A site-wide browser budget applies even
  // to direct requests and does not accept a caller's claimed network address.
  const budgetId = phoneHash.slice(0,8)+'-'+phoneHash.slice(8,12)+'-4'+phoneHash.slice(13,16)+
    '-8'+phoneHash.slice(17,20)+'-'+phoneHash.slice(20,32);
  const network = await digest('burimunsi-browser-passcode:' + BURIMUNSI_ADMIN_ORIGIN);
  const result = await sqlResult(env,
    'SELECT private.burimunsi_browser_pin_candidate(?,?,?,?::uuid,?,?) AS result',
    group, phone, phoneHash, budgetId, network, Date.now());
  if (typeof result?.allowed !== 'boolean') throw unavailable();
  if (!result.allowed) throw new ApiError(429, 'try_again_later', 'Too many attempts. Wait and try again.');
  const account = result.account;
  const dummy = {algorithm: 'pbkdf2-sha256+hmac-v1', pepperId: hasher.pepperId,
    iterations: PIN_ITERATIONS, salt: '0'.repeat(32), hash: '0'.repeat(64)};
  const verified = await hasher.verify(phone, pin, account?.pinHash ?? dummy);
  if (!verified || account?.phone !== phone || !['admin','staff'].includes(account.role)) throw credentialsDenied();
  if (request.signal.aborted) throw new ApiError(400, 'request_aborted', 'The sign-in check was interrupted.');
  return account;
}

async function changeSession(env, query, ...values) {
  try {
    return await sqlResult(env, query, ...values);
  } catch (error) {
    if (error?.code === '42501') throw signedOut();
    throw error;
  }
}

export async function handleBrowserPasscode(request, env, path) {
  const origin = originFor(request, env);
  const group = collectionFor(env);
  if (new URL(request.url).search) throw new ApiError(400, 'invalid_request', 'Invalid sign-in request.');
  if (path === '/auth/session' && request.method === 'GET') {
    const account = await browserPasscodeSession(request, env, false);
    return json(publicSession(account));
  }
  if (request.method !== 'POST') throw new ApiError(404, 'not_found', 'This sign-in action is unavailable.');
  if (path === '/auth/phone-passcode') {
    const [phone, pin] = normalizedCredentials(await readJson(request, 1024));
    const candidate = await checkPasscode(request, env, group, phone, pin);
    const token = newAdminCookieToken();
    const issued = await changeSession(env,
      'SELECT private.burimunsi_browser_pin_issue(?,?::uuid,?,?,?,?::uuid,?::uuid,?) AS result',
      group, candidate.id, candidate.credentialVersion, candidate.version, await cookieHash(token),
      crypto.randomUUID(), crypto.randomUUID(), origin);
    if (issued !== true) throw credentialsDenied();
    const headers = new Headers({Cookie: '__Host-collect_admin=' + token, Origin: origin});
    const account = await browserPasscodeSession(new Request(request.url, {headers}), env);
    const directSession = request.headers.get('X-Collect-Owner-Identity-Version') === '1';
    return json({...publicSession(account), ...(directSession ? {sessionContract: 2} : {})},
      200, {'Set-Cookie': adminCookie(token, SESSION_SECONDS)});
  }
  if (path === '/auth/passcode/change') {
    const account = await browserPasscodeSession(request, env);
    const proof = adminPasscodeProof(account);
    const body = await readJson(request, 1024);
    if (Object.keys(body).length !== 3 || !['current','newPin','confirm'].every(key =>
      typeof body[key] === 'string' && /^[0-9]{4}$/.test(body[key])) ||
      body.newPin !== body.confirm || body.newPin === body.current) {
      throw new ApiError(400, 'invalid_passcode_change', 'Enter your current passcode and confirm a different four-digit passcode.');
    }
    const candidate = await checkPasscode(request, env, group, proof.phone, body.current);
    if (candidate.id !== proof.accountId) throw signedOut();
    const hash = await nativePinHasher(env).hash(proof.phone, body.newPin);
    const changed = await changeSession(env,
      'SELECT private.burimunsi_browser_pin_change(?,?,?,?::uuid,?,?,?::text::jsonb) AS result',
      group, account.token_hash, origin, candidate.id, candidate.credentialVersion, candidate.version, JSON.stringify(hash));
    if (changed !== true) throw signedOut();
    return json({ok:true}, 200, {'Set-Cookie':adminCookie()});
  }
  if (path === '/auth/logout') {
    const token = adminCookieToken(request);
    if (token) {
      await requireCsrf(request, token);
      await changeSession(env, 'SELECT private.burimunsi_browser_pin_logout(?,?,?) AS result',
        group, await cookieHash(token), origin);
    }
    return json({ok: true}, 200, {'Set-Cookie': adminCookie()});
  }
  throw new ApiError(404, 'not_found', 'This sign-in action is unavailable.');
}
