import { ObservationLockTimeout } from './errors.js';
import { sha256 } from './values.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest = /^[0-9a-f]{64}$/;

// Accept only the validated, authenticated batch. The private inbox inventory
// can reproduce the page fingerprint from its ordered opaque source keys.
export async function reconciliationDiagnostic(requestId, body, elapsedMs, error) {
  const keys = body.items.map(item => item.sourceKey);
  if (!keys.length || keys.length > 20 || !keys.every(key => typeof key === 'string' && digest.test(key))) {
    throw new TypeError('invalid diagnostic page');
  }
  const idDigest = value => typeof value === 'string' && uuid.test(value) ? sha256(value.toLowerCase()) : null;
  const [request, run, page] = await Promise.all([
    idDigest(requestId), idDigest(body.runId), sha256(keys.join('\n')),
  ]);
  return { event: 'burimunsi_reconcile_503', request_sha256: request, run_sha256: run,
    page_sha256: page, items: keys.length, duration_ms: Math.round(elapsedMs),
    cause: error instanceof ObservationLockTimeout ? 'database_lock_timeout' : 'unclassified' };
}
