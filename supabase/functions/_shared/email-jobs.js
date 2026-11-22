import {verifyDeploymentProfile} from './deployment-profile.js';
import {normalizeRuntimeEnv} from './runtime-env.js';
import {connection} from './postgres-connections.js';
import {PostgresDatabase} from './postgres.js';
import {admitDatabaseWork, finishDatabaseWork} from './edge-database-admission.js';
import {emailAdapters} from './email-adapter.js';
import {drainContributionEmailDispatch, validContributionEmailAdmission} from './domain/contribution_email_delivery.js';
import {parseEmailJobDispatch, emailJobResult} from './email-job-contract.js';
import {json, readJson} from './domain/core.js';

function unconfirmedClose() {
  console.error(JSON.stringify({service: 'collect_email_jobs', event: 'work_close_unconfirmed'}));
}

export function createContributionEmailJobsHandler(envReader = () => Deno.env.toObject(), {
  openWork,
  processEmails = drainContributionEmailDispatch,
  databaseFactory = env => new PostgresDatabase(connection(env.COLLECT_DATABASE_URL, env)),
} = {}) {
  return async request => {
    let work;
    try {
      const input = envReader();
      const token = input.COLLECT_EMAIL_JOB_TOKEN;
      if (typeof token !== 'string' || token.length < 32 || request.headers.get('Authorization') !== `Bearer ${token}`) {
        return json({code: 'unauthorized'}, 401);
      }
      if (request.method !== 'POST') return json({code: 'method_not_allowed'}, 405);
      if (!/^\/(?:functions\/v1\/)?collect-email-jobs\/?$/.test(new URL(request.url).pathname)) {
        return json({code: 'not_found'}, 404);
      }

      let dispatch;
      try {
        dispatch = parseEmailJobDispatch(await readJson(request, 2048));
      } catch {
        return json({code: 'invalid_email_dispatch'}, 400);
      }
      if (input.COLLECT_CONTRIBUTION_EMAIL_ENABLED !== 'true' || !validContributionEmailAdmission(input, dispatch.admission)) {
        return json({code: 'email_admission_unavailable'}, 503);
      }

      await verifyDeploymentProfile(input);
      const env = normalizeRuntimeEnv(input);
      env.DB = databaseFactory(env);
      work = await admitDatabaseWork(env, {sql: env.DB.sql, kind: 'jobs', openWork});
      env.COLLECT_FENCE_WORK = work;
      env.DB.setApplicationWork(work);
      Object.assign(env, emailAdapters(env));

      const {dispatchId, admission} = dispatch;
      const emails = emailJobResult(await processEmails(env, {dispatchId, admission}));
      return json({dispatch_id: dispatchId, email_admission: admission, emails}, emails.status === 'complete' ? 200 : 503);
    } catch {
      return json({code: 'email_jobs_unconfirmed'}, 503);
    } finally {
      await finishDatabaseWork(work, unconfirmedClose);
    }
  };
}
