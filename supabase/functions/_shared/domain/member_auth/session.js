import { ApiError, first, rows } from "../core.js";
import { authRequest, bearerToken, verifyToken } from "../../auth-http.js";
import { guestAuthUser, guestResponseSession } from "../anonymous_auth.js";
import { principalLink, resolveActivePrincipal } from "./principal.js";
import { fail, mfaUnavailable, unix } from "./support.js";

function originalAuthenticationAt(claims, at) {
  // Token iat renews on refresh; only a validated first-factor AMR event is fresh.
  let authAt = 0;
  for (const entry of Array.isArray(claims.amr) ? claims.amr : []) {
    if (
      entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
      ["otp", "password", "oauth"].includes(entry.method) &&
      Number.isSafeInteger(entry.timestamp) && entry.timestamp > 0 &&
      entry.timestamp <= at
    ) {
      authAt = authAt === 0
        ? entry.timestamp
        : Math.min(authAt, entry.timestamp);
    }
  }
  return authAt; // Missing event evidence preserves ordinary access without freshness.
}

const factorIdIsValid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function userWithFactors(user) {
  // The authenticated GET /user endpoint omits an empty enrolled-factor list.
  // Normalize only this outward user DTO; retain the raw verified provider user.
  const factors = Object.hasOwn(user, "factors") ? user.factors : [];
  if (
    !Array.isArray(factors) || factors.length > 128 ||
    factors.some((factor) =>
      !isObject(factor) || !factorIdIsValid(factor.id) ||
      typeof factor.factor_type !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(factor.factor_type) ||
      !["unverified", "verified"].includes(factor.status)
    )
  ) {
    throw new ApiError(
      503,
      "auth_user_unavailable",
      "Account details could not be confirmed. Try again.",
    );
  }
  return { ...user, factors };
}

async function requireManagedSession(env, { user, claims }) {
  const managed = await first(
    env,
    "SELECT private.is_managed_session(?::uuid,?::uuid) AS allowed",
    user.id,
    claims.session_id,
  );
  if (managed?.allowed !== true) fail("access_revoked");
}

function applicationSession(env, sessionId) {
  return first(env, "SELECT * FROM auth_sessions WHERE id=?", sessionId);
}

export async function projectSession(
  env,
  verified,
  {
    surface = "member",
    mfaVerified = false,
    existingLinkOnly = false,
    expectedAuthUserId = null,
    expectedUserId = null,
    rejectExistingIdentity = false,
  } = {},
) {
  if (mfaVerified) throw mfaUnavailable();
  const { user, claims } = verified;
  if (user.is_anonymous === true || claims.is_anonymous === true) {
    fail("verified_identity_required", 403);
  }
  if (expectedAuthUserId !== null && user.id !== expectedAuthUserId) {
    fail("verified_identity_mismatch", 403);
  }
  env.DB.setClaims(claims);
  if (env.AUTH_ANONYMOUS_ENABLED === "true") {
    const upgrade = await first(
      env,
      "SELECT private.guest_upgrade_projection_allowed() AS allowed",
    );
    if (upgrade?.allowed !== true) fail("guest_upgrade_unknown", 403);
  }
  await requireManagedSession(env, verified);
  const principal = await resolveActivePrincipal(env, verified, {
    surface,
    existingLinkOnly,
    expectedUserId,
    rejectExistingIdentity,
  });
  const previous = await applicationSession(env, claims.session_id);
  const admission = await first(
    env,
    "SELECT a.id FROM admin_sessions s JOIN admin_users a ON a.id=s.user_id JOIN admin_principal_links l ON l.admin_user_id=a.id WHERE s.auth_session_id=? AND a.status='active' AND s.auth_version=a.auth_version AND l.user_id=? AND s.expires_at>?",
    claims.session_id,
    principal.id,
    unix(),
  );
  const actualSurface = admission ? "admin" : surface;
  if (actualSurface === "admin" && !env.ADMIN_AUTH_EXCHANGE && !admission) {
    fail("admin_admission_required", 403);
  }
  const authAt = previous?.auth_at ?? originalAuthenticationAt(claims, unix());
  if (!previous) {
    const lifetime = actualSurface === "admin" ? 28800 : 2592000;
    const expiry = (await first(
      env,
      "SELECT private.session_expiry(?) AS expires_at",
      unix() + lifetime,
    ))
      .expires_at;
    await env.DB.prepare(
      `INSERT INTO auth_sessions(id,user_id,surface,auth_at,created_at,expires_at,assurance_level,mfa_at,mfa_factor_id) VALUES(?,?,?,?,?,?,1,NULL,NULL) ON CONFLICT(id) DO NOTHING`,
    ).bind(
      claims.session_id,
      principal.id,
      actualSurface,
      authAt,
      unix(),
      expiry,
    ).run();
  }
  const session = await applicationSession(env, claims.session_id);
  const expiresAt = Number(session?.expires_at);
  if (
    !session || session.revoked_at != null ||
    session.surface !== actualSurface ||
    session.user_id !== principal.id || !Number.isSafeInteger(expiresAt) ||
    expiresAt <= unix()
  ) fail("access_revoked");
  const effectiveAal =
    Number(session.assurance_level) === 2 && claims.aal === "aal2" ? 2 : 1;
  const permissions = actualSurface === "admin"
    ? new Set(
      (await rows(
        env,
        `SELECT g.permission FROM admin_grants g JOIN admin_sessions s ON s.auth_session_id=? JOIN admin_users a ON a.id=s.user_id JOIN admin_account_role_capabilities c ON c.role=a.role AND c.permission=g.permission WHERE g.user_id=? AND g.permission<>'auth.mfa.enroll' AND a.status='active' AND s.auth_version=a.auth_version`,
        claims.session_id,
        principal.id,
      )).map((r) => r.permission),
    )
    : new Set();
  const actor = {
    userId: principal.id,
    sessionId: claims.session_id,
    surface: actualSurface,
    assuranceLevel: effectiveAal,
    aal: effectiveAal === 2 ? "aal2" : "aal1",
    authAt: effectiveAal === 2 ? session.mfa_at : session.auth_at,
    mfaAt: effectiveAal === 2 ? session.mfa_at : null,
    mfaFactorId: effectiveAal === 2 ? session.mfa_factor_id : null,
    permissions,
    user: {
      ...user,
      id: principal.id,
      auth_user_id: user.id,
      user_metadata: {
        full_name: principal.full_name,
        public_id: principal.public_id,
        country_code: principal.country_code,
        currency_code: principal.currency_code,
        momo_provider: principal.momo_provider,
        momo_number: principal.momo_number,
      },
      app_metadata: {
        provider: user.app_metadata?.provider,
        roles: permissions.size ? ["admin"] : ["member"],
        permissions: [...permissions],
      },
    },
  };
  env.AUTH_ACTOR = actor;
  env.AUTH_VERIFIED = verified;
  return actor;
}
function requestIdentity(
  request,
  env,
  { allowAnonymous = false, allowAnonymousTransition = false } = {},
) {
  const token = bearerToken(request);
  if (!token) fail();
  const cached = env.AUTH_VERIFIED;
  if (cached?.token === token && cached.claims.is_anonymous !== true) {
    return cached;
  }
  return verifyToken(env, token, { allowAnonymous, allowAnonymousTransition });
}

export async function requireSession(request, env) {
  return projectSession(env, await requestIdentity(request, env));
}

export async function responseSession(env, data, options = {}) {
  const verified = await verifyToken(env, data?.access_token, {
    allowAnonymous: options.allowGuest === true,
  });
  if (verified.user.is_anonymous === true) {
    return guestResponseSession(env, data, verified);
  }
  const actor = await projectSession(env, verified, options);
  return { ...data, user: actor.user };
}

export async function currentAuthUser(request, env) {
  const verified = await requestIdentity(request, env, {
    allowAnonymous: env.AUTH_ANONYMOUS_ENABLED === "true",
  });
  if (verified.user.is_anonymous === true) return guestAuthUser(env, verified);
  const actor = await projectSession(env, verified);
  return userWithFactors(actor.user);
}

export async function logoutSession(request, env) {
  const verified = await requestIdentity(request, env, {
    allowAnonymous: env.AUTH_ANONYMOUS_ENABLED === "true",
    allowAnonymousTransition: true,
  });
  if (verified.claims.is_anonymous === true) {
    await authRequest(env, "/logout?scope=local", { token: verified.token });
    return { ok: true };
  }
  // A still-valid provider credential may outlive the application projection.
  // Look up its existing owner and revoke only that session without projecting
  // a privileged actor or recreating a profile during logout.
  const { user, claims } = verified;
  env.DB.setClaims(claims);
  await requireManagedSession(env, verified);
  const link = await principalLink(env, user.id);
  const session = await applicationSession(env, claims.session_id);
  if (
    !link || !session || session.user_id !== link.user_id ||
    session.revoked_at != null
  ) {
    fail("access_revoked");
  }
  await authRequest(env, "/logout?scope=local", { token: verified.token });
  await env.DB.prepare(
    "UPDATE auth_sessions SET revoked_at=?,revocation_reason='signed_out' WHERE id=? AND user_id=? AND revoked_at IS NULL",
  ).bind(unix(), claims.session_id, link.user_id).run();
  return { ok: true };
}
