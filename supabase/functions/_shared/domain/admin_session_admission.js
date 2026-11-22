import { confirmedIdentity } from "../auth-http.js";
import { ApiError, digest, first, id } from "./core.js";
import { projectSession } from "./auth.js";
import { isAdminEmailDenialError } from "./admin_email_auth.js";
import { encryptAdminTokens, newAdminCookieToken } from "./admin_bff_tokens.js";
import { failAdminAccount as fail } from "./admin_account_support/errors.js";

const unix = () => Math.floor(Date.now() / 1000);

async function prepareAccount(env, verified) {
  const email = confirmedIdentity(verified.user, "email");
  if (!email) fail("admin_access_not_approved");
  const account = await first(
    env,
    `SELECT a.id,a.auth_version,l.user_id AS principal_id
     FROM admin_users a JOIN admin_principal_links l ON l.admin_user_id=a.id
     WHERE a.email=? AND a.status IN('active','invited') FOR UPDATE OF a`,
    email,
  );
  if (!account) fail("admin_access_not_approved");
  const at = unix();
  const activated = await env.DB.prepare(
    `UPDATE admin_users SET status='active',password_hash='supabase-managed',
       accepted_at=COALESCE(accepted_at,?),updated_at=?
     WHERE id=? AND auth_version=? AND status IN('active','invited')`,
  ).bind(at, at, account.id, account.auth_version).run();
  if (activated.meta.changes !== 1) fail("session_changed", 401);
  return account;
}

async function storeSession(env, verified, session) {
  // Activation revokes predecessor projections. The new projection and any
  // initial proof share the transaction with that activation.
  const account = await prepareAccount(env, verified);
  await projectSession(env, verified, { surface: "admin" });
  const { hash, publicId, sid, origin, cipher, emailChallengeId } = session;
  const projected = await first(
    env,
    "SELECT * FROM auth_sessions WHERE id=? AND user_id=? AND revoked_at IS NULL",
    sid,
    account.principal_id,
  );
  if (projected?.surface !== "admin") fail("session_changed", 401);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO admin_sessions(token_hash,public_id,user_id,auth_version,auth_session_id,origin,created_at,expires_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    ).bind(
      hash,
      publicId,
      account.id,
      account.auth_version,
      sid,
      origin,
      projected.auth_at,
      projected.expires_at,
    ),
    env.DB.prepare(
      "INSERT INTO private.bff_sessions(token_hash,auth_user_id,auth_session_id,token_ciphertext) VALUES(?,?,?,?)",
    ).bind(hash, verified.user.id, sid, cipher),
    env.DB.prepare(
      "INSERT INTO admin_account_audit(id,actor_id,subject_id,action,occurred_at) VALUES(?,?,?,'supabase_signed_in',?)",
    ).bind(id(), account.id, account.id, unix()),
    ...(emailChallengeId === null ? [] : [
      env.DB.prepare(
        "SELECT private.admin_email_record_initial(?,?,?,?,?) AS result",
      )
        .bind(account.id, hash, origin, publicId, emailChallengeId),
    ]),
  ]);
}

async function committedSession(
  env,
  verified,
  { hash, publicId, sid, origin, emailChallengeId },
) {
  const retained = await first(
    env,
    emailChallengeId === null
      ? `SELECT b.auth_user_id,b.auth_session_id FROM private.bff_sessions b
         JOIN admin_sessions s ON s.token_hash=b.token_hash
         WHERE b.token_hash=? AND s.public_id=? AND s.origin=?`
      : `SELECT b.auth_user_id,b.auth_session_id,EXISTS(
           SELECT 1 FROM private.admin_sensitive_email_proofs p
           WHERE p.challenge_id=? AND p.admin_id=s.user_id AND p.auth_user_id=b.auth_user_id
             AND p.original_session_id=b.auth_session_id AND p.verified_session_id=b.auth_session_id
             AND p.cookie_hash=b.token_hash AND p.public_session_id=s.public_id
             AND p.auth_version=s.auth_version AND p.origin=s.origin
         ) AS initial_proof FROM private.bff_sessions b
         JOIN admin_sessions s ON s.token_hash=b.token_hash
         WHERE b.token_hash=? AND s.public_id=? AND s.origin=?`,
    ...(emailChallengeId === null
      ? [hash, publicId, origin]
      : [emailChallengeId, hash, publicId, origin]),
  ).catch(() => null);
  return retained?.auth_user_id === verified.user.id &&
    retained?.auth_session_id === sid &&
    (emailChallengeId === null || retained.initial_proof === true);
}

export async function admitAdminSession(
  env,
  verified,
  data,
  { origin, emailChallengeId },
) {
  const sid = verified.claims.session_id;
  const token = newAdminCookieToken();
  const hash = await digest(token);
  const cipher = await encryptAdminTokens(env, {
    auth_user_id: verified.user.id,
    auth_session_id: sid,
  }, data);
  const session = {
    hash,
    publicId: id(),
    sid,
    origin,
    cipher,
    emailChallengeId,
  };
  env.DB.setClaims(verified.claims);
  try {
    await env.DB.withWriteTransaction((DB) =>
      storeSession({ ...env, DB, ADMIN_AUTH_EXCHANGE: true }, verified, session)
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (await committedSession(env, verified, session)) return token;
    if (emailChallengeId === null) throw error;
    if (isAdminEmailDenialError(error)) {
      throw new ApiError(
        403,
        "admin_email_denied",
        "This email verification is unavailable.",
      );
    }
    throw new ApiError(
      503,
      "admin_email_operation_unknown",
      "The email verification result is unconfirmed. Check the current verification before continuing.",
    );
  }
  return token;
}
