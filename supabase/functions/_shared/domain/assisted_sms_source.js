import { ApiError } from './core.js';

export function assertReceiptSmsFields(body, allowed, message = 'The request contains unsupported fields.') {
  if (!body || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new ApiError(400, 'invalid_request', message);
  }
}

export function assistedSmsDestinationContext(collection, user, revision) {
  return `assisted-sms-destination:${collection}:${user}:${revision}`;
}

export const assistedSmsLivePaymentSql = `NOT EXISTS(SELECT 1 FROM momo_financial_links momo_link JOIN momo_transactions momo_transaction ON momo_transaction.id=momo_link.transaction_id WHERE momo_link.payment_id=p.id AND momo_transaction.mode='historical')`;

export async function assistedSmsSourceCapabilities(env) {
  const [result] = await env.DB.batch([
    env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN('contribution_posting_snapshots','momo_financial_links','momo_transactions')"),
  ]);
  const names = new Set(result.results.map((row) => row.name));
  return {
    snapshots: names.has('contribution_posting_snapshots'),
    momo: names.has('momo_financial_links') && names.has('momo_transactions'),
  };
}
