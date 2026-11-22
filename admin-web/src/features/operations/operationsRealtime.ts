import {isAdminPublishableKey, isJsonObject, type AdminRequest, type JsonObject} from '../../api/contracts';
import {SUPABASE_PROJECT_ORIGIN} from '../../config';

export interface OperationsSubscription {
  origin: string;
  publishableKey: string;
  request: AdminRequest;
}
interface Capability {topic: string; expires: number}
const broadcastId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isOperationsChange(payload: unknown) {
  if (!isJsonObject(payload) || payload.changed !== true) return false;
  const keys = Object.keys(payload);
  // realtime.send may append its own UUID. Consumers only receive an invalidation.
  return keys.length === 1 || (keys.length === 2 && typeof payload.id === 'string' && broadcastId.test(payload.id));
}

export function operationsCapability(value: JsonObject, now: number): Capability {
  const {topic, expiresAt} = value;
  const expires = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  if (Object.keys(value).length !== 2 || typeof topic !== 'string' || !/^buri:ops:[a-f0-9]{64}$/.test(topic) ||
      !Number.isFinite(expires) || new Date(expires).toISOString() !== expiresAt || expires <= now + 1000) {
    throw new Error('The live subscription could not be verified.');
  }
  return {topic, expires};
}

/** Supabase supplies the anonymous role from the public key on the WebSocket upgrade.
 * Only the BFF issues the random, expiring channel capability. Record reads stay on the BFF. */
export async function openOperationsBroadcast(options: OperationsSubscription, topic: string, changed: () => void, failed: () => void, ready: () => void, signal: AbortSignal) {
  if (options.origin !== SUPABASE_PROJECT_ORIGIN || !isAdminPublishableKey(options.publishableKey) ||
      !/^buri:ops:[a-f0-9]{64}$/.test(topic)) throw new Error('Invalid live subscription.');
  const {RealtimeClient} = await import('@supabase/realtime-js');
  if (signal.aborted) return () => {};
  const socket = new RealtimeClient(options.origin.replace('https:', 'wss:') + '/realtime/v1',
    {params: {apikey: options.publishableKey}, vsn: '1.0.0'});
  let active = true;
  const channel = socket.channel(topic, {config: {private: true, broadcast: {self: false}, presence: {enabled: false}}});
  channel.on('broadcast', {event: 'operations_changed'}, message => {
    if (active && message.event === 'operations_changed' && isOperationsChange(message.payload)) changed();
  }).subscribe(state => {
    if (!active) return;
    if (state === 'SUBSCRIBED') {ready(); changed();} // Recover changes missed while joining or reconnecting.
    if (state === 'TIMED_OUT' || state === 'CHANNEL_ERROR' || state === 'CLOSED') failed();
  });
  return () => {active = false; channel.teardown(); void socket.disconnect();};
}

/** A page owns one private channel. An expired session, hidden tab, or route change releases it. */
export function watchOperations(options: OperationsSubscription, collectionId: string | undefined, connected: (value: boolean) => void, subscribe = openOperationsBroadcast) {
  let running = true, retryMs = 1000;
  let controller: AbortController | undefined, close: (() => void) | undefined, timer: number | undefined;
  const visible = () => document.visibilityState === 'visible' && navigator.onLine;
  function stop() {
    connected(false);
    controller?.abort(); controller = undefined;
    close?.(); close = undefined;
    window.clearTimeout(timer); timer = undefined;
  }
  function retry() {
    stop();
    if (!running || !visible()) return;
    timer = window.setTimeout(() => {timer = undefined; void start();}, retryMs);
    retryMs = Math.min(60000, retryMs * 2);
  }
  async function start() {
    if (!running || !visible() || controller || timer !== undefined) return;
    const owner = new AbortController(); controller = owner;
    try {
      const response = await options.request('sync/live', {method:'POST', body:collectionId ? {collectionId} : {},
        authenticated:true, expectedStatus:200, signal:owner.signal});
      if (owner.signal.aborted) return;
      const {topic, expires} = operationsCapability(response, Date.now());
      const ttl = expires - Date.now();
      timer = window.setTimeout(() => {stop(); void start();}, Math.max(1000, ttl - Math.min(10000, ttl / 5)));
      const disconnect = await subscribe(options, topic, () => {
        if (owner.signal.aborted || !visible() || Date.now() >= expires) return;
        retryMs = 1000;
        window.dispatchEvent(new CustomEvent('burimunsi-operations-changed', {detail: collectionId ? {collectionId} : {}}));
      }, () => {if (!owner.signal.aborted) retry();}, () => {if (!owner.signal.aborted) connected(true);}, owner.signal);
      if (owner.signal.aborted) disconnect();
      else close = disconnect;
    } catch {if (!owner.signal.aborted) retry();}
  }
  function visibility() {if (visible()) void start(); else stop();}
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('online', visibility);
  window.addEventListener('offline', stop);
  void start();
  return () => {
    running = false; stop();
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('online', visibility);
    window.removeEventListener('offline', stop);
  };
}
