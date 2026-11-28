import {SupabaseObjectBucket, providerAdapters} from './adapters.js';
import {sqlFenceBackend} from './application-fence.js';
import {assertRuntimeDeployment, prepareDeploymentCheck} from './deployment-database.js';
import {connection, fenceConnection} from './postgres-connections.js';
import {PostgresDatabase} from './postgres.js';
import {sha256} from './domain/burimunsi/values.js';

const unresolvedReasons = new Set(['lease_lost', 'work_lost', 'dispatch_unconfirmed']);
const admissionId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function observeUnresolvedWork(work, reason) {
  try {
    const [id, epoch] = work.tuple();
    if (typeof id !== 'string' || !admissionId.test(id) || !Number.isSafeInteger(epoch) || epoch < 1) return;
    console.warn(JSON.stringify({
      service: 'collect_platform_api',
      event: 'application_work_unresolved',
      scope: 'application_only',
      admission_sha256: await sha256(id),
      epoch,
      reason: unresolvedReasons.has(reason) ? reason : 'unclassified',
    }));
  } catch {
    // This observation cannot change the recorded outcome or the response.
  }
}

// Keep the lifecycle stage with the request. Both entry points report failures
// using these same labels and keep the admission open for background work.
export class EdgeRuntimeWork {
  stage = 'environment';
  work;
  beforeRegister;

  /** @param {string} [standaloneCollectionId] */
  async initializeDatabase(env, standaloneCollectionId = undefined, checkAtRegistration = false) {
    this.stage = 'database_initialization';
    env.DB = new PostgresDatabase(connection(env.COLLECT_DATABASE_URL, env));
    if (checkAtRegistration) {
      this.beforeRegister = await prepareDeploymentCheck(env, standaloneCollectionId);
      if (!this.beforeRegister) throw new Error('deployment_identity_required');
    } else {
      await assertRuntimeDeployment(env.DB.sql, env, standaloneCollectionId);
    }
  }

  async admit(env, openWork, kind, signal, waitForReadCapacity = false, standaloneRead = false, observePinLoginCapacity = false) {
    this.stage = 'fence_admission';
    this.work = await openWork({
      backend: sqlFenceBackend(env.DB.sql, fenceConnection(env.COLLECT_DATABASE_URL, env), this.beforeRegister,
        waitForReadCapacity ? signal : undefined, standaloneRead, observePinLoginCapacity),
      sourceSha256: env.BUILD_SOURCE_ID,
      kind,
      ...(signal === undefined ? {} : {signal}),
    });
    env.COLLECT_FENCE_WORK = this.work;
    env.DB.setApplicationWork(this.work);
    return this.work;
  }

  initializeAdapters(env) {
    this.stage = 'storage_initialization';
    env.PRIVATE_MEDIA = new SupabaseObjectBucket(env);
    this.stage = 'provider_initialization';
    Object.assign(env, providerAdapters(env));
  }

  waitUntil(promise) {
    this.work.waitUntil(promise);
    if (typeof EdgeRuntime !== 'undefined') {
      EdgeRuntime.waitUntil(Promise.resolve(promise).catch(() => {}));
    }
  }

  finish() {
    const work = this.work;
    if (!work) return;
    const done = work.finish().then(result => {
      if (result?.state === 'unresolved') return observeUnresolvedWork(work, result.reason);
    }).catch(() => {
      observeFailure(console.error, JSON.stringify({
        service: 'collect_platform_api',
        event: 'application_work_close_unconfirmed',
        scope: 'application_only',
      }));
    });
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(done);
    return done;
  }
}

export function isFenceFailure(error) {
  return error?.code === 'application_fenced' || error?.code === 'application_fence_unavailable';
}

// Health observations never change an admitted response or application work.
export function observeFailure(report, value) {
  try {
    report(value);
  } catch {
    // Health reporting must leave the original outcome intact.
  }
}
