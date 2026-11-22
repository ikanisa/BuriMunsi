import { confirmedIdentity } from "../../auth-http.js";
import { first, id, now, rows } from "../core.js";
import { fail } from "./support.js";

export const matchingMemberPrincipalIdsSql =
  `SELECT id FROM users WHERE lower(email)=? OR phone=?
   UNION SELECT l.user_id AS id FROM admin_principal_links l
     JOIN admin_users a ON a.id=l.admin_user_id JOIN users u ON u.id=l.user_id
     WHERE a.email=? AND a.status IN('active','invited')`;

export function principalLink(env, authUserId) {
  return first(
    env,
    "SELECT user_id FROM private.auth_principal_links WHERE auth_user_id=?",
    authUserId,
  );
}

async function activePrincipal(env, userId) {
  const principal = await first(env, "SELECT * FROM users WHERE id=?", userId);
  if (principal?.access_status !== "active") fail("access_revoked", 403);
  return principal;
}

async function matchPrincipal(env, surface, email, phone) {
  if (surface === "admin") {
    return first(
      env,
      "SELECT l.user_id AS id FROM admin_users a JOIN admin_principal_links l ON l.admin_user_id=a.id WHERE a.email=? AND a.status IN('active','invited')",
      email,
    );
  }
  const matches = await rows(
    env,
    matchingMemberPrincipalIdsSql,
    email,
    phone,
    email,
  );
  if (matches.length > 1) fail("identity_link_conflict", 409);
  return matches[0];
}

async function linkExistingPrincipal(env, authUserId, userId, proof) {
  await activePrincipal(env, userId);
  await env.DB.prepare(
    `INSERT INTO private.auth_principal_links(auth_user_id,user_id,proof_reference)
     SELECT ?,id,? FROM users WHERE id=? AND access_status='active' ON CONFLICT DO NOTHING`,
  ).bind(authUserId, proof, userId).run();
  const link = await principalLink(env, authUserId);
  if (link?.user_id !== userId) fail("identity_link_conflict", 409);
  return userId;
}

async function createLinkedPrincipal(env, authUserId, proof, email, phone) {
  const userId = id();
  const stamp = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users(id,public_id,phone,email,full_name,created_at,updated_at)
       VALUES(?,(SELECT printf('%06d',min(candidate)) FROM (
         SELECT 0 AS candidate UNION ALL
         SELECT CAST(public_id AS INTEGER)+1 FROM users WHERE public_id!='999999'
       ) c WHERE candidate<1000000
       AND NOT EXISTS(SELECT 1 FROM users WHERE public_id=printf('%06d',candidate))),?,?,'',?,?)`,
    ).bind(userId, phone, email, stamp, stamp),
    env.DB.prepare(
      "INSERT INTO private.auth_principal_links(auth_user_id,user_id,proof_reference) VALUES(?,?,?)",
    ).bind(authUserId, userId, proof),
  ]);
  return userId;
}

async function resolveUnlinkedPrincipal(
  env,
  { user, claims },
  { surface, rejectExistingIdentity },
) {
  const email = confirmedIdentity(user, "email");
  const phone = confirmedIdentity(user, "phone");
  const matched = await matchPrincipal(env, surface, email, phone);
  const proof = "supabase-auth-getuser:" + claims.session_id;
  if (matched) {
    if (rejectExistingIdentity) {
      fail("identity_already_exists", 409);
    }
    const userId = await linkExistingPrincipal(env, user.id, matched.id, proof);
    return activePrincipal(env, userId);
  }
  if (!email && !phone) fail("verified_identity_required", 403);
  if (surface !== "member" || env.AUTH_MEMBER_REGISTRATION_ENABLED !== "true") {
    fail("registration_unavailable", 403);
  }
  const userId = await createLinkedPrincipal(env, user.id, proof, email, phone);
  return activePrincipal(env, userId);
}

export async function resolveActivePrincipal(env, verified, options) {
  const { user } = verified;
  const { surface, existingLinkOnly, expectedUserId } = options;
  const link = await principalLink(env, user.id);
  if (
    (existingLinkOnly && !link) ||
    (expectedUserId !== null && link?.user_id !== expectedUserId)
  ) {
    fail("verified_identity_mismatch", 403);
  }
  if (link) return activePrincipal(env, link.user_id);
  if (surface !== "member") return resolveUnlinkedPrincipal(env, verified, options);

  try {
    return await env.DB.withWriteTransaction(async (DB) => {
      // A Team invitation can claim this email without populating users.email.
      // Read both identity sources while holding the same lock as that write.
      const scoped = { ...env, DB };
      const concurrentLink = await principalLink(scoped, user.id);
      if (concurrentLink) return activePrincipal(scoped, concurrentLink.user_id);
      return resolveUnlinkedPrincipal(scoped, verified, options);
    });
  } catch (error) {
    if (error?.code !== "23505") throw error;
    // Read only after rollback. Only this exact managed Auth link can win.
    const winner = await principalLink(env, user.id);
    if (winner) return activePrincipal(env, winner.user_id);
    fail("identity_link_conflict", 409);
  }
}
