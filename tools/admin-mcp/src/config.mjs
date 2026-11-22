import { constants } from 'node:fs';
import { lstat, open, mkdir, rename, unlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { BURIMUNSI_ADMIN_ORIGIN } from '../../../deploy/platform-admin/src/admin-session-realm.js';
import { adminCookieTokenForOrigin } from './admin_cookie.mjs';

// Deliberately one reviewed origin. The older Admin domain has a different
// session surface; a configurable URL must never bridge its cookies here.
export const ADMIN_ORIGIN = BURIMUNSI_ADMIN_ORIGIN;
export const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const REQUEST_KEY = /^[A-Za-z0-9_.-]{8,200}$/;
const MAX_CREDENTIAL_BYTES = 4096;
export const isUuid = value => typeof value === 'string' && UUID.test(value);
export const isRequestKey = value => typeof value === 'string' && REQUEST_KEY.test(value);
export class SafeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const invalid = () => { throw new SafeError('invalid_arguments', 'The tool arguments are invalid. Use the published tool schema.'); };
export const unavailable = () => { throw new SafeError('service_unavailable', 'The Admin service could not be verified. No action was retried.'); };
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function strictKeys(value, keys) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
}
export function configuration(env = process.env) {
  if (env.BURIMUNSI_ADMIN_MCP_ORIGIN && env.BURIMUNSI_ADMIN_MCP_ORIGIN !== ADMIN_ORIGIN) {
    throw new SafeError('invalid_configuration', 'Only the reviewed BuriMunsi Admin origin is supported.');
  }
  const credentialFile = env.BURIMUNSI_ADMIN_MCP_SESSION_FILE || join(homedir(), 'Library', 'Application Support', 'BuriMunsi Admin MCP', 'session.json');
  if (!isAbsolute(credentialFile) || credentialFile.includes('\0')) throw new SafeError('invalid_configuration', 'The session file must use an absolute private path.');
  const repository = resolve(import.meta.dirname, '../../..');
  const relation = relative(repository, resolve(credentialFile));
  if (!relation || (!relation.startsWith('..' + '/') && relation !== '..' && !isAbsolute(relation))) {
    throw new SafeError('invalid_configuration', 'Store the local Admin session outside the repository.');
  }
  return Object.freeze({ origin: ADMIN_ORIGIN, credentialFile: resolve(credentialFile) });
}

function privateStat(stat, directory = false) {
  return (directory ? stat.isDirectory() : stat.isFile()) && !stat.isSymbolicLink() &&
    stat.uid === process.getuid() && (stat.mode & 0o077) === 0 && (directory || stat.nlink === 1);
}
function unsafeDirectory() {
  return new SafeError('unsafe_session_file', 'Use an owner-only directory without symbolic links for the Admin session.');
}

async function physicalDirectory(path, create) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    const parent = dirname(path);
    if (!create || error.code !== 'ENOENT' || parent === path) throw error;
    await physicalDirectory(parent, true);
    try { await mkdir(path, { mode: 0o700 }); }
    catch (createError) { if (createError.code !== 'EEXIST') throw createError; }
    stat = await lstat(path);
  }
  if (!stat.isDirectory() || await realpath(path) !== path) throw unsafeDirectory();
  return stat;
}

async function privateDirectory(path, create = false) {
  if (!privateStat(await physicalDirectory(path, create), true)) throw unsafeDirectory();
}
function validateCredential(value, config) {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'accountId,cookie,expiresAt,origin,principalId,sessionId,version' ||
      value.version !== 1 || value.origin !== config.origin || !isUuid(value.accountId) ||
      !isUuid(value.principalId) || !isUuid(value.sessionId) ||
      !adminCookieTokenForOrigin(value.origin, value.cookie) ||
      typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) {
    throw new SafeError('session_unavailable', 'Sign in with the local Admin login command. No browser session is imported.');
  }
  return value;
}
export async function loadCredential(config) {
  let handle;
  try {
    await privateDirectory(dirname(config.credentialFile));
    const before = await lstat(config.credentialFile);
    if (!privateStat(before) || before.size > MAX_CREDENTIAL_BYTES) throw new Error('unsafe');
    handle = await open(config.credentialFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!privateStat(stat) || stat.size > MAX_CREDENTIAL_BYTES || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('unsafe');
    // Bound the actual read in case the file grows after the size check.
    const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_CREDENTIAL_BYTES) throw new Error('unsafe');
    const bytes = buffer.subarray(0, offset);
    const credential = validateCredential(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), config);
    return { ...credential, fingerprint: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError('session_unavailable', 'A private local Admin session is unavailable. Run the local login command.');
  } finally { await handle?.close(); }
}
export async function saveCredential(config, value) {
  validateCredential(value, config);
  const directory = dirname(config.credentialFile);
  await privateDirectory(directory, true);
  try {
    const existing = await lstat(config.credentialFile);
    if (!privateStat(existing)) throw new SafeError('unsafe_session_file', 'The existing session file is not an owner-only regular file.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = join(directory, `.session-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify(value) + '\n');
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temporary, config.credentialFile);
  } finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
}
