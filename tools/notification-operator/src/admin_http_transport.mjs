import { ORIGINS, OperatorError, need, sha } from './contract.mjs';
import { formatAdminCookie, parseAdminCookie } from '../../collect-admin-mcp/src/admin_cookie.mjs';

const MAX_RESPONSE_BYTES = 256 * 1024;
const JSON_MEDIA_TYPE = 'application/json';

export const ADMIN_ROUTES = Object.freeze({
  session: { path: 'auth/session', method: 'GET', cookie: 'session' },
  passwordLogin: { path: 'auth/login', method: 'POST', successStatus: 200, cookie: 'login' },
  signInChallenge: { path: 'auth/otp', method: 'POST', successStatus: 200, cookie: 'none' },
  signInVerification: { path: 'auth/verify', method: 'POST', successStatus: 200, cookie: 'login' },
  emailStatus: { path: 'auth/email-verification', method: 'GET', successStatus: 200, cookie: 'none' },
  emailChallenge: { path: 'auth/email/request', method: 'POST', successStatus: 202, cookie: 'none' },
  emailVerification: { path: 'auth/email/verify', method: 'POST', successStatus: 200, cookie: 'none' },
  logout: { path: 'auth/logout', method: 'POST', successStatus: 200, cookie: 'remove' },
  notificationOperator: { path: 'notification-operator', method: 'POST' },
});

export function csrfFor(cookie) {
  return sha('collect-admin-csrf:' + cookie);
}

export function hasUnexpectedCookie(headers, origin, expectedCookie = null) {
  return (headers.getSetCookie?.() ?? []).length > 0 &&
    (expectedCookie === null || parseAdminCookie(headers, origin) !== expectedCookie);
}

export function requireAdminCookie(headers, origin, options) {
  need((headers.getSetCookie?.() ?? []).length === 1, 'auth_cookie_missing_or_ambiguous');
  const token = parseAdminCookie(headers, origin, options);
  need(token !== null, 'auth_cookie_constraints_invalid');
  return token;
}

async function readJson(response) {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  need(mediaType === JSON_MEDIA_TYPE, 'non_json_response');

  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.byteLength;
    need(bytes <= MAX_RESPONSE_BYTES, 'response_too_large');
    chunks.push(chunk);
  }

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } catch {
    throw new OperatorError('invalid_json_response');
  }
}

/** The fixed routes and current in-memory cookie are the only transport inputs. */
export function createAdminTransport({ origin, fetchImpl, timeoutMs }) {
  need(ORIGINS.includes(origin), 'independently_approved_frontend_origin_required');
  need(typeof fetchImpl === 'function' && Number.isSafeInteger(timeoutMs) &&
    timeoutMs >= 100 && timeoutMs <= 30000, 'invalid_transport_configuration');

  return async function send({ path, method }, body, { cookie, csrf, signal, assertCurrent }) {
    const headers = {
      Accept: JSON_MEDIA_TYPE,
      Origin: origin,
      'X-Collect-Admin': '1',
      'X-Collect-Requested-With': 'collect-admin',
      'Sec-Fetch-Site': 'same-origin',
    };
    if (body !== undefined) headers['Content-Type'] = JSON_MEDIA_TYPE;
    if (cookie) {
      const pair = formatAdminCookie(origin, cookie);
      need(pair, 'auth_cookie_constraints_invalid');
      headers.Cookie = pair;
      if (method === 'POST') {
        need(csrf === csrfFor(cookie), 'current_csrf_required');
        headers['X-Collect-CSRF'] = csrf;
      }
    }
    need(!signal?.aborted, 'request_cancelled_before_dispatch');

    let response;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      response = await fetchImpl(origin + '/api/admin/' + path, {
        method,
        headers,
        redirect: 'manual',
        cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assertCurrent();
      need(!response.redirected && (response.ok || response.status >= 400), 'redirect_refused');
      const value = await readJson(response);
      assertCurrent();
      return { value, headers: response.headers, status: response.status, ok: response.ok };
    } catch (error) {
      if (error instanceof OperatorError && method !== 'POST') throw error;
      const code = error instanceof OperatorError ? error.code : 'transport_outcome_unknown';
      throw new OperatorError(code, { unknown: method === 'POST' });
    } finally {
      if (response?.body && !response.bodyUsed) void response.body.cancel().catch(() => {});
    }
  };
}
