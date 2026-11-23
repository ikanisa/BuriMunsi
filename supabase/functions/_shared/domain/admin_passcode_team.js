import {browserPasscodeSession} from './admin_browser_passcode.js';
import {adminPasscodeProof} from './admin_email_policy.js';
import {ApiError, first, json, readJson, uuid} from './core.js';
import {nativePinHasher} from './burimunsi/native-secrets.js';
import {normalizePhone} from './burimunsi/values.js';

const unavailable = () => new ApiError(503, 'team_unavailable', 'Team access is temporarily unavailable.');
const invalid = () => new ApiError(400, 'invalid_account', 'Check the account details and try again.');
const denied = () => new ApiError(403, 'permission_required', 'An Admin with team access can manage accounts.');
const roleValid = role => ['admin','staff'].includes(role);
const exact = (body, fields) => Object.keys(body).length === fields.length && fields.every(field => Object.hasOwn(body, field));

export async function handlePasscodeTeam(request, env, path) {
  const create = path === '/team/accounts' && request.method === 'POST';
  const access = request.method === 'POST' && /^\/team\/accounts\/([a-f0-9-]{36})\/access$/.exec(path);
  const read = path === '/team' && request.method === 'GET';
  if (!read && !create && !access) throw new ApiError(404,'not_found','This account action is unavailable.');
  if (new URL(request.url).search) throw invalid();
  const account = await browserPasscodeSession(request,env);
  const proof = adminPasscodeProof(account);
  const permission = read ? 'admin_users.read' : 'admin_users.manage';
  if (proof.operatorRole !== 'admin' || !account.permissions.includes(permission)) throw denied();

  try {
    if (read) {
      const row = await first(env,'SELECT private.burimunsi_browser_team(?) AS result',proof.collectionId);
      if (row?.result?.contractVersion !== 1 || row.result.currentAccountId !== proof.accountId) throw unavailable();
      return json(row.result);
    }
    const body = await readJson(request,2048);
    const requestId = uuid(body.requestId);
    let command, pinHash = null;
    if (create) {
      if (!exact(body,['requestId','displayName','phone','role']) || !roleValid(body.role) ||
          typeof body.displayName !== 'string' || body.displayName.trim().length < 2 ||
          body.displayName.trim().length > 100 || /[\x00-\x1f\x7f]/.test(body.displayName)) throw invalid();
      let phone;
      try { phone = normalizePhone(body.phone); } catch { throw invalid(); }
      if (typeof env.BURIMUNSI_DEFAULT_STAFF_PIN !== 'string' || !/^[0-9]{4}$/.test(env.BURIMUNSI_DEFAULT_STAFF_PIN)) throw unavailable();
      pinHash = await nativePinHasher(env).hash(phone,env.BURIMUNSI_DEFAULT_STAFF_PIN);
      command = {action:'create',phone,displayName:body.displayName.trim(),role:body.role};
    } else {
      const fields = Object.hasOwn(body,'role') ? ['requestId','expectedVersion','active','role'] : ['requestId','expectedVersion','active'];
      if (!exact(body,fields) || (Object.hasOwn(body,'role') && !roleValid(body.role)) || typeof body.active !== 'boolean' ||
          !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) throw invalid();
      command = {action:'access',id:uuid(access[1]),expectedVersion:body.expectedVersion,active:body.active,
        ...(Object.hasOwn(body,'role') ? {role:body.role} : {})};
    }
    const row = await first(env,'SELECT private.burimunsi_browser_team_write(?,?::uuid,?::text::jsonb,?::text::jsonb) AS result',
      proof.collectionId,requestId,JSON.stringify(command),pinHash && JSON.stringify(pinHash));
    if (row?.result?.applied !== true || !Number.isSafeInteger(row.result.version)) throw unavailable();
    return json(row.result);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.code === '23505' && (error.constraint_name ?? error.constraint) === 'burimunsi_single_admin')
      throw new ApiError(409,'burimunsi_single_admin','BuriMunsi already has an active Admin. Create or keep this account as Staff.');
    if (error?.code === '23505' || error?.code === '40001') throw new ApiError(409,'account_changed','This account or request has changed. Refresh the team list.');
    if (error?.message === 'burimunsi_last_admin') throw new ApiError(409,'last_admin','Keep at least one active Admin.');
    if (error?.message === 'burimunsi_own_access') throw new ApiError(409,'own_access','Another Admin must change your access.');
    if (error?.code === '42501') throw denied();
    if (error?.code === '22023') throw invalid();
    throw unavailable();
  }
}
