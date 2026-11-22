import { guardedFetch, noteUnknownEffect } from "./application-fence.js";
import { ApiError } from "./domain/core.js";

const providerDenialStatuses = new Set([400, 401, 403, 422, 429]);
const emptyLogoutPaths = new Set([
  "/logout",
  "/logout?scope=local",
  "/logout?scope=global",
]);
const invalidSession = () =>
  new ApiError(401, "invalid_session", "Sign in again.");
const authUnavailable = () =>
  new ApiError(503, "auth_unavailable", "The identity service is unavailable.");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function bearerToken(request) {
  return request.headers.get("Authorization")?.match(/^Bearer (\S+)$/)?.[1];
}

export function confirmedIdentity(user, type) {
  if (
    type === "phone" && user.phone_confirmed_at &&
    typeof user.phone === "string"
  ) {
    const phone = user.phone.replace(/^\+/, "");
    return /^[1-9]\d{1,14}$/.test(phone) ? "+" + phone : null;
  }
  if (
    type === "email" && user.email_confirmed_at &&
    typeof user.email === "string"
  ) {
    return user.email.trim().toLowerCase() || null;
  }
  return null;
}

/**
 * @param {Record<string, any>} env
 * @param {string} path
 * @param {{method?: string, token?: string | null, body?: unknown, admin?: boolean}} options
 */
export async function authRequest(
  env,
  path,
  { method = "POST", token = null, body = null, admin = false } = {},
) {
  const key = admin
    ? env.SUPABASE_SERVICE_ROLE_KEY
    : env.SUPABASE_PUBLISHABLE_KEY;
  if (!env.SUPABASE_URL || !key) {
    throw new ApiError(503, "auth_unavailable", "Sign-in is not configured.");
  }
  if (
    typeof path !== "string" || !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\\\r\n#]/.test(path) || path.includes("..")
  ) {
    throw authUnavailable();
  }

  const headers = { apikey: key, "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = "Bearer " + token;
  } else if (admin && !key.startsWith("sb_secret_")) {
    headers.Authorization = "Bearer " + key;
  }
  const response = await guardedFetch(
    env,
    "auth",
    env.SUPABASE_URL + "/auth/v1" + path,
    {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers,
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    },
  );

  // GoTrue returns no JSON for a successful authenticated logout.
  if (
    response.status === 204 && method === "POST" &&
    emptyLogoutPaths.has(path) &&
    typeof token === "string" && token.length > 0 && !/\s/.test(token)
  ) return {};

  let data;
  try {
    data = await response.json();
  } catch {
    noteUnknownEffect(env, "auth");
    throw authUnavailable();
  }
  if (response.ok) return data;
  if (response.status >= 500) noteUnknownEffect(env, "auth");
  throw new ApiError(
    providerDenialStatuses.has(response.status) ? response.status : 503,
    typeof data?.error_code === "string" ? data.error_code : "auth_unavailable",
    response.status === 429
      ? "Too many attempts. Try again later."
      : "The identity request could not be verified.",
  );
}

// Decoding supports comparison and refresh scheduling. Only verifyToken proves
// that the candidate belongs to a current GoTrue user.
export function claimsOf(token) {
  if (typeof token !== "string") throw invalidSession();
  const parts = token.split(".");
  if (parts.length !== 3) throw invalidSession();
  let claims;
  try {
    claims = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    throw invalidSession();
  }
  if (!isRecord(claims)) throw invalidSession();
  return claims;
}

function claimsMatchUser(claims, user, issuer, at) {
  const audience = claims.aud;
  return isRecord(user) &&
    typeof user.id === "string" && user.id.length > 0 &&
    claims.sub === user.id &&
    claims.role === "authenticated" &&
    (audience === "authenticated" ||
      Array.isArray(audience) && audience.includes("authenticated")) &&
    typeof claims.session_id === "string" && claims.session_id.length > 0 &&
    Number.isSafeInteger(claims.exp) && claims.exp > at &&
    claims.iss === issuer;
}

export async function verifyToken(
  env,
  token,
  { allowAnonymous = false, allowAnonymousTransition = false } = {},
) {
  if (typeof token !== "string" || token.startsWith("sb_")) {
    throw new ApiError(
      401,
      "invalid_session",
      "A signed-in user token is required.",
    );
  }
  const claims = claimsOf(token);
  const user = await authRequest(env, "/user", { method: "GET", token });
  const issuer = env.SUPABASE_AUTH_ISSUER ?? env.SUPABASE_URL + "/auth/v1";
  if (!claimsMatchUser(claims, user, issuer, Math.floor(Date.now() / 1000))) {
    throw invalidSession();
  }

  if (
    Object.hasOwn(user, "is_anonymous") &&
      typeof user.is_anonymous !== "boolean" ||
    Object.hasOwn(claims, "is_anonymous") &&
      typeof claims.is_anonymous !== "boolean"
  ) throw invalidSession();
  const anonymousUser = user.is_anonymous === true;
  const anonymousClaim = claims.is_anonymous === true;
  const convertedGuest = allowAnonymous && allowAnonymousTransition &&
    anonymousClaim && user.is_anonymous === false;
  if (anonymousUser !== anonymousClaim && !convertedGuest) {
    throw invalidSession();
  }
  if (anonymousUser && !allowAnonymous) {
    throw new ApiError(
      403,
      "verified_identity_required",
      "Verify an email address or phone number to continue.",
    );
  }
  return { user, claims, token };
}
