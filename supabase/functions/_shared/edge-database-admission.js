import {openApplicationWork, sqlFenceBackend} from './application-fence.js';
import {assertRuntimeDeployment} from './deployment-database.js';
import {fenceConnection} from './postgres-connections.js';

// The signed Auth hook and the contribution-email endpoint admit database work
// without loading the general API provider adapters.
export async function admitDatabaseWork(env, {
  target = env.COLLECT_DATABASE_URL,
  sql,
  kind,
  openWork = openApplicationWork,
}) {
  await assertRuntimeDeployment(sql, env);
  return openWork({
    backend: sqlFenceBackend(sql, fenceConnection(target, env)),
    sourceSha256: env.BUILD_SOURCE_ID,
    kind,
  });
}

export function finishDatabaseWork(work, onUnconfirmed = () => {}) {
  if (!work) return;
  // A signed response deadline can expire while acquisition is still pending.
  // Keep ownership until the admission settles and any acquired work is closed.
  const completion = Promise.resolve(work).then(owned => owned.finish()).catch(onUnconfirmed);
  if (typeof EdgeRuntime !== 'undefined') {
    EdgeRuntime.waitUntil(completion);
    return;
  }
  return completion;
}
