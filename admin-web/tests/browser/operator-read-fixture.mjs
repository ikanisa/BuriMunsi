// Synthetic read-only walkthrough records for the loopback browser harness.
// IDs, names, amounts, and evidence below are invented; this is not bank evidence.
import core from '../core/canonical-core-fixtures.json' with {type: 'json'};
import {createHash} from 'node:crypto';

export const fixtureMember = {
  ...core.members.rows[0], membership_status: 'active', title: '900001', public_id: '900001',
  subtitle: 'Synthetic member Ada', display_name: 'Synthetic member Ada',
  phone_e164: null, email: null, whatsapp_number: null, momo_number: null, phone_masked: null,
};
const inactiveId = '94949494-9494-4494-8494-909090909090';
export const fixtureInactiveMember = {...fixtureMember, id:inactiveId, person_id:inactiveId, collect_user_id:inactiveId,
  title:'900002', public_id:'900002', subtitle:'Synthetic member Eric', display_name:'Synthetic member Eric',
  membership_status:'inactive', active_groups:0, amount:'0 groups'};
export const fixtureMembers = {...core.members, rows:[fixtureMember, fixtureInactiveMember], total:2};
export function fixtureMembership(member) {
  return {id:member.id===fixtureMember.id?'93939393-9393-4393-8393-939393939393':'96969696-9696-4696-8696-969696969696',
    user_id:member.id, group_id:'fixture-group', group_title:'Synthetic group', role:'member',
    status:member.membership_status, membership_record_number:member.id===fixtureMember.id?'100000000001':'100000000002'};
}

const time = '2026-11-16T10:00:00.000Z';
const transactionId = '90909090-9090-4090-8090-909090909090';
const attemptId = '92929292-9292-4292-8292-929292929292';
export const fixtureSmsEvidenceId = '91919191-9191-4191-8191-919191919191';
const providerFacts = {
  provider_transaction_id: 'MOMO-SYNTHETIC-9001', event_kind: 'incoming_receipt', amount_minor: 5000,
  currency: 'RWF', currency_scale: 0, transaction_at: time, payer_name: fixtureMember.display_name, payer_last3: null,
};
const assertions = {provider_confirmation: false, settlement_status: 'not_asserted'};
export const fixtureMomoRecord = {
  ...providerFacts, ...assertions, id: transactionId, created_at: time, parse_attempt_id: attemptId,
  native_group_id: 'fixture-group', group_id: 'fixture-group', group_name: 'Synthetic group',
  member_name: null, payment_id: null, beneficiary_member_id: null, credited_amount_minor: 0, version: 1, has_conflict: 0,
  receiving_account_id: null, public_code: null, recipient_name: null, status: 'recorded', allocation_state: 'unallocated',
  receiving_context: {basis: 'unestablished', account_id: null, identifier_raw: null, identifier_kind: null, recipient_name: null},
  receipt_facts: {...providerFacts, ...assertions, contract_version: 1, kind: 'automatic_momo_extraction',
    transaction_id: transactionId, parse_attempt_id: attemptId, capture_id: fixtureSmsEvidenceId, source_body_sha256: 'b'.repeat(64),
    parser_version: 'synthetic.v1', profile_version: 'synthetic.profile.v1', parsed_at: time},
};

export const fixtureMomoDetail = {
  transaction: fixtureMomoRecord,
  sources: [{raw_sms_id: fixtureSmsEvidenceId, attempt_id: attemptId, relation: 'accepted', outcome: 'accepted',
    parser_version: fixtureMomoRecord.receipt_facts.parser_version, created_at: time}],
};

const {parse_attempt_id: _attemptId, receipt_facts: _fullFacts, ...paymentRow} = fixtureMomoRecord;
export const fixtureMomoPaymentsOnlyDetail = {
  transaction: {...paymentRow, source_history_available: false, receipt_facts: {
    ...providerFacts, ...assertions, contract_version: 1, kind: 'automatic_momo_extraction', transaction_id: transactionId,
    provider: 'mtn_momo', fee_minor: null, wallet_balance_after_minor: null, normalization_timezone: 'Africa/Kigali',
    transaction_time_source: 'sms_body_and_provider_profile', public_reference: null,
  }},
  sources: [],
  conflicting_attempt_ids: [],
  conflict_reviews: [],
};

export function readMemberList(params) {
  const search = (params.get('search') ?? '').toLowerCase(), status = params.get('status') ?? '';
  const offset = Number(params.get('offset') ?? 0);
  const rows = fixtureMembers.rows.filter(member => (!search || `${member.display_name} ${member.public_id}`.toLowerCase().includes(search)) &&
    (!status || member.membership_status === status));
  return {...fixtureMembers, rows: rows.slice(offset, offset + 25), total: rows.length};
}

export function readMomoList(params) {
  const search = (params.get('search') ?? '').toLowerCase(), status = params.get('status') ?? '';
  const offset = Number(params.get('offset') ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || Number(params.get('limit')) !== 25) return null;
  const matches = (!search || `${fixtureMomoRecord.provider_transaction_id} ${fixtureMomoRecord.payer_name}`.toLowerCase().includes(search)) &&
    (!status || status === 'recorded') && !params.get('receiving_account_id') &&
    (!params.get('group_id') || params.get('group_id') === fixtureMomoRecord.group_id) &&
    (!params.get('from') || Date.parse(params.get('from')) <= Date.parse(time)) &&
    (!params.get('to') || Date.parse(params.get('to')) >= Date.parse(time));
  return {contract_version: 1, currency: 'RWF', date_basis: 'provider_transaction_time', as_of: time,
    rows: matches && offset === 0 ? [fixtureMomoRecord] : [], total: matches ? 1 : 0, offset, limit: 25,
    totals: {received_minor: matches ? 5000 : 0, credited_minor: 0, unallocated_minor: matches ? 5000 : 0}};
}

export const fixturePayment = {
  id: transactionId, groupId: 'fixture-group', version: 1, direction: 'incoming', amountRwf: providerFacts.amount_minor, atRaw: time,
  ftId: providerFacts.provider_transaction_id, payerNameRaw: fixtureMember.display_name, payerPhoneRaw: '000071',
  memberId: null, memberName: null, memberPhone:null, state: 'unallocated', sourceId: fixtureSmsEvidenceId, canAllocate: false,
};
export const fixtureOutgoingPayment = {
  ...fixturePayment, id: '94949494-9494-4494-8494-949494949494', direction: 'outgoing', ftId: 'MOMO-SYNTHETIC-OUT', sourceId: null,
};
export function readMemberStatementFixture(params) {
  const member = fixtureMembers.rows.find(row => row.id === params.get('memberId'));
  if (!member) return {status:404, body:{error:{code:'member_statement_unavailable'}}};
  const membership = fixtureMembership(member), offset = Number(params.get('offset') ?? 0), limit = 25;
  if (params.get('statement') !== '1' || ![0,25].includes(offset) || offset && !params.get('revision')) {
    return {status:400, body:{error:{code:'invalid_fixture'}}};
  }
  // This statement scenario is independent of the two-payment list walkthrough.
  const movement = index => index === 25 ? {direction:'outgoing', amountRwf:1000, balanceRwf:'4000'} :
    {direction:'incoming', amountRwf:200, balanceRwf:String((index + 1) * 200)};
  const items = member.id === fixtureMember.id ? Array.from({length:26},(_,index) => ({
    id:'statement-' + index, atRaw:time, ftId:'STATEMENT-' + String(index + 1).padStart(2,'0'), ...movement(index),
  })) : [];
  const revision = createHash('sha256').update(JSON.stringify([membership.id,items])).digest('hex');
  if (params.has('revision') && params.get('revision') !== revision) return {status:409, body:{error:{code:'member_statement_changed'}}};
  return {status:200, body:{groupId:membership.group_id,memberId:member.id,membershipId:membership.id,totalCount:items.length,
    closingRwf:items.at(-1)?.balanceRwf ?? '0',revision,offset,limit,items:items.slice(offset,offset+limit)}};
}
export function readBuriMunsiPayments(params, sms) {
  const q = (params.get('q') ?? '').toLowerCase(), status = params.get('status'), direction = params.get('direction');
  const limit = Number(params.get('limit')), offset = Number(params.get('offset') ?? 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) return null;
  const matching = [fixturePayment, fixtureOutgoingPayment].filter(item =>
    (!status || item.state === status) && (!direction || item.direction === direction) &&
    (!q || `${item.ftId} ${item.payerNameRaw}`.toLowerCase().includes(q)));
  const items = matching.slice(offset, offset + limit).map(item => ({...item, sourceId:sms ? item.sourceId : null}));
  return {items,totalCount:matching.length,offset,limit,nextOffset:offset+items.length < matching.length ? offset+items.length : null,asOf:time};
}
