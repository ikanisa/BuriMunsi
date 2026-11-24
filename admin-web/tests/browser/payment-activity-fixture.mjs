import {fixtureMomoRecord as transaction, fixtureSmsEvidenceId} from './operator-read-fixture.mjs';
import core from '../core/canonical-core-fixtures.json' with {type: 'json'};

export const fixtureActivityPayment = {...core.transactions.rows[0], payment_reference: '100000001234'};

// Only used by the authenticated loopback harness; financial and SMS grants are separate.
export function readPaymentActivity(params, captures, {payments, sms, attention}) {
  const {created_at: time, native_group_id: groupId} = transaction;
  const source = {kind: 'receiver_sms', id: fixtureSmsEvidenceId, collectionId: groupId, status: 'unmatched'};
  const unlinked = {kind: 'receiver_sms', id: '94949494-9494-4494-8494-949494949494', collectionId: groupId, status: 'unmatched'};
  const empty = {amountRwf: null, reference: null, payer: null, paymentId: null, reconciliationId: null, momoIds: [], receipts: []};
  const items = [];
  if (payments) {
    const record = fixtureActivityPayment;
    items.push({...empty, kind:'payment', id:record.id, occurredAt:record.observed_at, status:record.status, reference:record.payment_reference,
      amountRwf:record.amount_rwf, payer:record.payer_name, paymentId:record.id, attention:false});
  }
  if (payments) items.push({...empty, kind: 'momo', id: transaction.id, occurredAt: time, reference: transaction.provider_transaction_id,
    payer: transaction.payer_name, amountRwf: transaction.amount_minor, status: transaction.status, attention: false,
    momoIds: [transaction.id], receipts: sms ? [source] : []});
  if (sms) {
    for (const record of payments ? [unlinked] : [unlinked, source]) items.push({...empty, id: record.id,
      kind: 'receiver_sms', occurredAt: time, status: record.status, attention, receipts: [record]});
    for (const record of captures) items.push({...empty, kind: 'capture', id: record.id, occurredAt: new Date(record.received_at * 1000).toISOString(),
      status: record.status, attention: false, receipts: [{kind: 'capture', id: record.id, status: record.status, collectionId: groupId}]});
  }
  const scope = params.get('scope') || 'all', search = (params.get('search') || '').toLowerCase(), status = params.get('status');
  const matching = items.filter(item => (!status || status === item.status) && (!search ||
    [item.id, item.reference, item.payer].some(value => value?.toLowerCase().includes(search))) &&
    (scope === 'all' || scope === 'momo' && item.momoIds.length || scope === 'payments' && !!item.paymentId ||
      scope === 'attention' && item.attention || scope === 'sms' && item.receipts.length ||
      scope === 'android' && item.receipts.some(source => source.kind === 'receiver_sms') ||
      scope === 'captures' && item.receipts.some(source => source.kind === 'capture')));
  matching.sort((first, second) => Date.parse(second.occurredAt) - Date.parse(first.occurredAt) ||
    first.kind.localeCompare(second.kind) || first.id.localeCompare(second.id));
  const offset = Number(params.get('offset') || 0), limit = 25;
  return {contractVersion: 1, asOf: time, limit, offset, total: matching.length, items: matching.slice(offset, offset + limit)};
}
