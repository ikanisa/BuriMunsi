import type { Context } from "npm:hono@4.13.16";
import { MANAGED_SUPABASE_ORIGIN } from "../../../supabase/functions/_shared/deployment-profile.js";
import { device } from "./auth.ts";
import type { AppEnv } from "./types.ts";
import { ApiError, sha256 } from "./util.ts";

/** The device credential stays on its enrolled gateway. No customer data is returned. */
export async function burimunsiWakeChannel(c: Context<AppEnv>) {
  const handset = device(c);
  const {env} = c;
  const group = env.BURIMUNSI_PAYMENT_SMS_COLLECTION_ID;
  const application = env.OPENSMS_RECEIPT_APPLICATION_ID;
  let key = env.SUPABASE_PUBLISHABLE_KEY;
  if (!key && env.SUPABASE_PUBLISHABLE_KEYS) {
    try { key = JSON.parse(env.SUPABASE_PUBLISHABLE_KEYS).default; } catch { /* Missing capability. */ }
  }
  if (env.SUPABASE_URL !== MANAGED_SUPABASE_ORIGIN || env.BURIMUNSI_PRODUCT_MODE !== "standalone" ||
      env.BURIMUNSI_PAYMENT_SMS_ENABLED !== "true" || env.DISPATCH_PAUSED !== "false" ||
      !group || !application || !handset.allowedKinds.includes("receipt") ||
      typeof key !== "string" || !/^sb_publishable_[A-Za-z0-9_-]{10,300}$/.test(key)) {
    throw new ApiError(404, "wake_unavailable", "Device wake is unavailable");
  }
  // Verify the exact authenticated credential again inside the protected transaction
  // to cover rotation or retirement between HTTP authentication and issuance.
  const bearer = c.req.header("Authorization")!;
  const capability = await env.DB.prepare("SELECT collect_sms.burimunsi_gateway_wake_channel(?,?,?,?) AS channel")
    .bind(handset.id, await sha256(bearer.slice(7)), group, application).first<{topic:string;expiresAt:string}>("channel");
  if (!capability) throw new ApiError(403, "wake_unavailable", "Device wake is unavailable");
  return c.json({...capability, serverTime:new Date().toISOString(), publishableKey:key}, 200, {"Cache-Control":"private, no-store"});
}
