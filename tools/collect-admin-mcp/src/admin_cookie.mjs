import {adminCookieNameForOrigin} from '../../../deploy/platform-admin/src/admin-session-realm.js';

export {adminCookieNameForOrigin};

const tokenPattern = /^[a-f0-9]{64}$/;

export function formatAdminCookie(origin, token) {
  const name = adminCookieNameForOrigin(origin);
  return name && typeof token === 'string' && tokenPattern.test(token) ? `${name}=${token}` : null;
}

export function adminCookieTokenForOrigin(origin, pair) {
  const name = adminCookieNameForOrigin(origin);
  if (!name || typeof pair !== 'string' || !pair.startsWith(name + '=')) return null;
  const token = pair.slice(name.length + 1);
  return tokenPattern.test(token) ? token : null;
}

export function parseAdminCookie(headers, origin, {deletion = false} = {}) {
  const name = adminCookieNameForOrigin(origin);
  const values = headers?.getSetCookie?.() ?? [];
  if (!name || values.length !== 1) return null;

  const [pair, ...parts] = values[0].split(';').map(part => part.trim());
  const token = deletion ? '' : adminCookieTokenForOrigin(origin, pair);
  if (token === null || (deletion && pair !== name + '=')) return null;

  const attributes = new Map();
  for (const part of parts) {
    const delimiter = part.indexOf('=');
    const key = (delimiter === -1 ? part : part.slice(0, delimiter)).toLowerCase();
    if (!key || attributes.has(key)) return null;
    attributes.set(key, delimiter === -1 ? null : part.slice(delimiter + 1));
  }
  const maxAge = attributes.get('max-age');
  const validAge = deletion ? maxAge === '0' : /^[1-9][0-9]{0,5}$/.test(maxAge ?? '');
  if (!validAge || attributes.get('secure') !== null || attributes.get('httponly') !== null ||
      attributes.get('path') !== '/' || attributes.get('samesite')?.toLowerCase() !== 'strict' ||
      attributes.has('domain')) return null;
  return token;
}
