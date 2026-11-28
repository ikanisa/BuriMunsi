import {fenceOpeningObservation} from '../../application-fence.js';
import {CONTRACT_VERSION} from './wire/native-contract.mjs';
import {sha256} from './values.js';

const path = '/v1/burimunsi/sms/observations/reconcile-batch';
const causes = new Set(['application_fenced', 'application_fence_unavailable']);
const openingStages = new Set(['before_registration', 'registration_unconfirmed', 'registered_before_work']);
const admittedStages = new Set(['admitted_before_dispatch', 'admitted_dispatch', 'native_authority', 'native_handler']);
const admissionUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const clientUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const caughtResponses = new WeakMap();
const observations = new WeakMap();
const mappedCauses = new WeakMap();

function fenceCause(error) {
  return causes.has(error?.code) ? error.code : mappedCauses.get(error);
}

// The native observation contract intentionally maps several failures to
// one public error. Keep a recognized original fence cause off the wire.
export function mappedReconcileFence(error, publicError) {
  const cause = fenceCause(error);
  if (cause) mappedCauses.set(publicError, cause);
  return publicError;
}

export function isReconcileBatch(method, pathname) {
  return method === 'POST' && pathname === path;
}

// The native adapters turn failures into normal Responses. Carry only the
// owned catch site and recognized fence code to the existing status reporter.
export function markReconcileFenceResponse(request, response, error, stage) {
  if (response.status === 503 && admittedStages.has(stage)) {
    const cause = fenceCause(error);
    if (cause && isReconcileBatch(request.method, new URL(request.url).pathname)) {
      caughtResponses.set(response, {stage, cause});
    }
  }
  return response;
}

export function caughtReconcileFence(response) {
  return caughtResponses.get(response);
}

export function reconcileFenceObservation(request, work, cause, stage, error) {
  let id, epoch;
  if (work) {
    stage ??= 'admitted_before_dispatch';
    try { [id, epoch] = work.tuple(); } catch { /* The failure still has a known stage. */ }
  } else {
    const opening = fenceOpeningObservation(error);
    stage = opening?.stage ?? 'before_registration';
    id = opening?.id;
    epoch = opening?.epoch;
  }
  const clientId = request.headers.get('X-BuriMunsi-Contract') === CONTRACT_VERSION
    ? request.headers.get('X-BuriMunsi-Request') : null;
  // A disabled or replaced reporter receives no request or admission identity.
  const observation = {};
  observations.set(observation, {stage, cause, id, epoch, clientId});
  return observation;
}

// This runs after the ordinary shared reporting budget has admitted an event.
// No headers, response bodies, input properties or raw IDs enter the output.
export async function reconcileFenceFields(observation) {
  const value = observations.get(observation);
  if (!value) return {};
  const {stage, cause, id, epoch, clientId} = value;
  if ((!openingStages.has(stage) && !admittedStages.has(stage)) || !causes.has(cause)) return {};
  const registered = stage === 'registered_before_work' || admittedStages.has(stage);
  const validAdmission = registered && typeof id === 'string' && id.length === 36 && admissionUuid.test(id) &&
    Number.isSafeInteger(epoch) && epoch > 0;
  const validClient = typeof clientId === 'string' && clientId.length === 36 && clientUuid.test(clientId);
  const [admissionHash, clientHash] = await Promise.all([
    validAdmission ? sha256(id).catch(() => null) : null,
    validClient ? sha256(clientId).catch(() => null) : null,
  ]);
  return {operation: 'native_reconcile_batch', stage, cause, admission_sha256: admissionHash,
    epoch: admissionHash ? epoch : null, request_sha256: clientHash};
}
