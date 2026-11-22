import {isObject, isSafeCount} from '../core/contracts';

export const assistedLabels = {queued: 'Queued receipts', claimed: 'Claimed receipts', send_started: 'Send started', uncertain: 'Send outcome unknown'} as const;
export const nativeLabels = {pending: 'Pending', retrying: 'Retrying', blocked: 'Blocked', unmatched: 'Unmatched', posted: 'Internally credited'} as const;
export const payerLabels = {pending: 'Pending', gateway_accepted: 'Gateway accepted', sent: 'Sent', delivered: 'Reported delivered', failed: 'Failed', unknown: 'Outcome unknown', suppressed: 'Suppressed'} as const;
export const reasonLabels = {historical: 'Historical receipt', preferences_disabled: 'Payer opted out', unverified_destination: 'Payer number unverified',
  reversed: 'Credit reversed', ineligible: 'Payment or recipient ineligible', authority_changed: 'Recipient authority changed', before_activation: 'Before activation',
  prior_posting: 'Prior posting', window_elapsed: 'Send window elapsed', claim_suppressed: 'Send withheld', gateway_failed: 'Gateway failed',
  gateway_expired: 'Gateway expired', gateway_cancelled: 'Gateway cancelled', gateway_unconfirmed: 'Gateway outcome unconfirmed'} as const;
export const receiptLabels = {...payerLabels, expired: 'Expired'} as const;
type CountKey = keyof typeof assistedLabels;
type NativeCountKey = keyof typeof nativeLabels;
type PayerCountKey = keyof typeof payerLabels;
export interface Oversight {
  checkedAt: string;
  counts: Record<CountKey, number>;
  oldestQueuedSeconds?: number | null;
  oldestUnobservedSendSeconds?: number | null;
  native: {counts: Record<NativeCountKey, number>; oldestPendingSeconds: number | null} | null;
  payer: Record<PayerCountKey, number> | null;
  operations: {payer: Record<keyof typeof receiptLabels, number>; reasons: Partial<Record<keyof typeof reasonLabels, number>>; oldest: number | null;
    cronActive: boolean; cronIntervalSeconds: 1 | 60 | null; unresolvedDispatches: number; gatewayHeartbeat: 'not_recorded' | 'recent' | 'stale'; schedulerEnabled: boolean; lastConfirmedAt: string | null; lastConfirmedDigest: string | null; gatewayLastSeenAt: string | null} | null;
  managed: string;
  parsing: string;
  ledger: string;
}
function invalid(): never {throw new Error('The SMS oversight sample could not be verified.');}

function age(value: unknown): number | null {
  if (value === null || isSafeCount(value)) return value;
  return invalid();
}

function parseCounts<Key extends string>(data: Record<string, unknown>, keys: readonly Key[]): Record<Key, number> {
  const counts = {} as Record<Key, number>;
  for (const key of keys) {
    if (!isSafeCount(data[key])) return invalid();
    counts[key] = data[key];
  }
  return counts;
}

function parseNativeQueue(value: unknown): Oversight['native'] {
  if (value === undefined) return null;
  const keys = Object.keys(nativeLabels) as NativeCountKey[];
  if (!isObject(value) || Object.keys(value).length !== keys.length + 1) return invalid();
  return {counts: parseCounts(value, keys), oldestPendingSeconds: age(value.oldest_pending_seconds)};
}

function parsePayerQueue(value: unknown): Oversight['payer'] {
  if (value === undefined) return null;
  const keys = Object.keys(payerLabels) as PayerCountKey[];
  if (!isObject(value) || Object.keys(value).length !== keys.length) return invalid();
  return parseCounts(value, keys);
}

function parseOperations(value: unknown): Oversight['operations'] {
  if (value === undefined) return null;
  const timestamp = (v: unknown): string | null => v === null || typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v ? v : invalid();
  if (!isObject(value) || Object.keys(value).length !== (Object.hasOwn(value,'cron_interval_seconds') ? 11 : 10) ||
      !(value.cron_interval_seconds == null || value.cron_interval_seconds === 1 || value.cron_interval_seconds === 60) || typeof value.cron_active !== 'boolean' || !isSafeCount(value.unresolved_dispatches) ||
      !(value.gateway_heartbeat === 'not_recorded' || value.gateway_heartbeat === 'recent' || value.gateway_heartbeat === 'stale') ||
      (value.gateway_last_seen_at === null) !== (value.gateway_heartbeat === 'not_recorded') || !isObject(value.payer) || Object.keys(value.payer).length !== Object.keys(receiptLabels).length ||
      !isObject(value.reasons) || typeof value.scheduler_enabled !== 'boolean' ||
      !(value.last_confirmed_sha256 === null || typeof value.last_confirmed_sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.last_confirmed_sha256)) ||
      (value.last_confirmed_at === null) !== (value.last_confirmed_sha256 === null)) return invalid();
  const reasons: Partial<Record<keyof typeof reasonLabels, number>> = {};
  for (const [key, n] of Object.entries(value.reasons)) {
    if (!Object.hasOwn(reasonLabels, key) || !isSafeCount(n)) return invalid();
    reasons[key as keyof typeof reasonLabels] = n;
  }
  return {payer: parseCounts(value.payer, Object.keys(receiptLabels) as (keyof typeof receiptLabels)[]), reasons, oldest: age(value.oldest_pending_seconds),
    schedulerEnabled: value.scheduler_enabled, cronActive: value.cron_active, cronIntervalSeconds: value.cron_interval_seconds ?? null, unresolvedDispatches: value.unresolved_dispatches, gatewayHeartbeat: value.gateway_heartbeat, lastConfirmedAt: timestamp(value.last_confirmed_at), lastConfirmedDigest: value.last_confirmed_sha256,
    gatewayLastSeenAt: timestamp(value.gateway_last_seen_at)};
}

export function parseSmsOversight(value: unknown): Oversight {
  if (!isObject(value) || value.contract_version !== 1 || value.scope !== 'admin_operational_health' ||
      value.metrics_scope !== 'all_retained_rows' || !['not_recorded','confirmed_dispatch'].includes(String(value.worker_heartbeat)) || value.external_services_checked !== false ||
      typeof value.checked_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value.checked_at) ||
      !Number.isFinite(Date.parse(value.checked_at)) || new Date(value.checked_at).toISOString().slice(0, 19) !== value.checked_at.slice(0, 19) ||
      !isObject(value.queues) || !isObject(value.queues.assisted_sms) || value.queues.assisted_sms.automatic_retry !== false ||
      (value.configuration !== undefined && value.configuration !== null && !isObject(value.configuration))) return invalid();
  const sms = value.queues.assisted_sms, configuration = isObject(value.configuration) ? value.configuration : {};
  const operations = parseOperations(value.queues.burimunsi_sms_operations);
  if ((value.worker_heartbeat === 'confirmed_dispatch') !== !!operations?.lastConfirmedAt) return invalid();
  const counts = parseCounts(sms, Object.keys(assistedLabels) as CountKey[]);
  function setting(key: string, allowed: string[]): string {
    const result = configuration[key];
    if (result === null || result === undefined) return 'unknown';
    if (typeof result !== 'string' || !allowed.includes(result)) return invalid();
    return result;
  }
  return {
    checkedAt: value.checked_at, counts, operations,
    oldestQueuedSeconds: sms.oldest_queued_seconds === undefined ? undefined : age(sms.oldest_queued_seconds),
    oldestUnobservedSendSeconds: sms.oldest_unobserved_send_seconds === undefined ? undefined : age(sms.oldest_unobserved_send_seconds),
    native: parseNativeQueue(value.queues.burimunsi_sms), payer: parsePayerQueue(value.queues.burimunsi_payer_sms), managed: setting('momo_processing', ['enabled', 'paused']),
    parsing: setting('native_auto_processing', ['enabled', 'disabled']), ledger: setting('native_sms_ledger', ['enabled', 'disabled']),
  };
}
