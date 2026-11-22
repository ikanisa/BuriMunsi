import {createHandler as createSignedHandler} from '../send-sms-hook/handler.mjs';
import {verifyDeploymentProfile} from './deployment-profile.js';
import {normalizeDatabaseTarget} from './runtime-env.js';
import {guardedFetch, noteUnknownEffect} from './application-fence.js';
import {admitDatabaseWork, finishDatabaseWork} from './edge-database-admission.js';
import {connection} from './postgres-connections.js';

function unavailable() {
  return new Response(JSON.stringify({error: {http_code: 503, message: 'SMS service unavailable.'}}), {
    status: 503,
    headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
  });
}

function beginWork(env) {
  // This worker deliberately has no injected Supabase database or service keys.
  // Validate the explicit target before opening either fence connection.
  if (!env.COLLECT_DATABASE_URL) throw new Error('COLLECT_DATABASE_URL is required.');
  const target = normalizeDatabaseTarget(env);
  return admitDatabaseWork(env, {target, sql: connection(target, env), kind: 'http_collect'});
}

async function verifyHookRuntime(env) {
  const profile = await verifyDeploymentProfile(env);
  // The Auth application credential must be independent of the receipt credential.
  if (env.COLLECT_DEPLOYMENT_PROFILE === undefined || env.AUTH_PROJECT_ID !== profile.id ||
      env.APP_ENVIRONMENT !== profile.environment || env.SUPABASE_URL !== profile.supabase_origin ||
      !/^[a-f0-9]{64}$/.test(env.BUILD_SOURCE_ID ?? '') ||
      env.OPENSMS_APPLICATION_TOKEN === env.OPENSMS_RECEIPT_APPLICATION_TOKEN ||
      env.OPENSMS_APPLICATION_ID === env.OPENSMS_RECEIPT_APPLICATION_ID) {
    throw new Error('sms_hook_configuration');
  }
}

function assertActive(signal) {
  if (signal.aborted) throw new Error('sms_hook_deadline');
}

/** Signature and body validation precede database admission and provider work.
 * The signed handler owns the four-second response deadline. Any late
 * acquisition or transport completion remains owned after the response.
 */
export function createCollectSendSmsHandler(envReader = () => Deno.env.toObject(), {
  admit = beginWork,
  handlerOptions = {},
} = {}) {
  return async request => {
    let env;
    try {
      env = {...envReader()};
    } catch {
      return unavailable();
    }
    // GoTrue v2.197.0's signed payload has no requested channel. The custom
    // OpenSMS hook and native WhatsApp delivery are mutually exclusive modes.
    if (env.AUTH_SMS_ENABLED !== 'true' || env.AUTH_PHONE_DELIVERY_MODE !== 'opensms_hook' ||
        env.AUTH_WHATSAPP_ENABLED === 'true') {
      return unavailable();
    }

    let workPromise, work;
    const transport = async (url, options) => {
      assertActive(options.signal);
      workPromise ??= (async () => {
        await verifyHookRuntime(env);
        assertActive(options.signal);
        work = await admit(env);
        env.COLLECT_FENCE_WORK = work;
        return work;
      })();
      await workPromise;
      assertActive(options.signal);
      return guardedFetch(env, 'sms_otp', url, options);
    };
    try {
      const result = await createSignedHandler(
        {...env, OPENSMS_SENDER_LABEL: env.OPENSMS_SENDER_LABEL ?? 'Collect'},
        {...handlerOptions, transport},
      )(request);
      if (result.status >= 500 && work) noteUnknownEffect(env, 'sms_otp');
      return result;
    } catch {
      return unavailable();
    } finally {
      void finishDatabaseWork(workPromise);
    }
  };
}
