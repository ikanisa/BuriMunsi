import {paymentId, readAllCanonicalPayments, type BuriMunsiPayment} from '../operations/canonicalPaymentAnalysis';
import {isId, isObject, parseCoreRow, validateMemberStatus} from './contracts';
import {relatedPage, validateRelated} from './relatedRecordContract';
import type {AdminRequest} from './types';

export const memberStatementPath = (id: string) => '/admin/members/' + id + '/statement';
export const canReadMemberStatement = (permissions: readonly string[]) =>
  ['users.read', 'collections.read', 'payments.read'].every(permission => permissions.includes(permission));

export interface ProfileMembership {
  recordNumber: string | null;
  groupId: string | null;
  groupTitle: string | null;
  collectId: string | null;
  memberName: string | null;
  role: string | null;
  status: string | null;
}

const present = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;

export function profileMembership(data: Record<string, unknown>, memberId: string, expectedGroup?: string): ProfileMembership | null {
  if (!isObject(data.related) || !Array.isArray(data.related.memberships)) throw new Error('Missing membership.');
  const rows = data.related.memberships, page = relatedPage(data, 'memberships', rows);
  if (rows.length > 1 || page && (page.offset !== 0 || page.total !== rows.length)) throw new Error('Unexpected membership scope.');
  if (!rows.length) return null;
  const row: unknown = rows[0];
  if (!isObject(row) || row.user_id !== undefined && row.user_id !== memberId ||
      row.group_id !== undefined && (!paymentId.safeParse(row.group_id).success || expectedGroup && row.group_id !== expectedGroup)) {
    throw new Error('Membership scope changed.');
  }
  const recordNumber = typeof row.membership_record_number === 'string' && /^\d{12}$/.test(row.membership_record_number)
    ? row.membership_record_number : null;
  return {recordNumber, groupId: row.user_id === memberId ? present(row.group_id) : null,
    groupTitle: present(row.group_title), collectId: present(row.public_id), memberName: present(row.display_name),
    role: present(row.role), status: present(row.status)};
}

export interface StatementMovement {
  payment: BuriMunsiPayment;
  balance: bigint | null;
}

export async function readMembershipMovements(request: AdminRequest, signal: AbortSignal, memberId: string, groupId: string) {
  const newestFirst = await readAllCanonicalPayments(request, signal, '', groupId, memberId);
  const movements: StatementMovement[] = [];
  let closing: bigint | null = 0n;
  // SQL orders by occurrence (or creation), then the record ID. Reverse the complete sequence, including ties.
  for (let index = newestFirst.length - 1; index >= 0; index--) {
    const payment = newestFirst[index];
    if (closing !== null && payment.amountRwf !== null) {
      const amount = BigInt(payment.amountRwf);
      closing = payment.direction === 'incoming' ? closing + amount : closing - amount;
    } else closing = null;
    movements.push({payment, balance: closing});
  }
  return {movements, closing};
}

export async function readMemberStatement(request: AdminRequest, signal: AbortSignal, memberId: string, actorId: string, expectedGroup?: string) {
  if (!isId(memberId)) throw new Error('Invalid member.');
  const data = await request('operations/members/' + memberId, {signal});
  if (data.current_actor_id !== actorId || data.resource_type !== 'members' || data.contract_version !== 2 ||
      data.model !== 'canonical_evidence_ledger' || typeof data.can_manage !== 'boolean') throw new Error('Invalid member response.');
  const member = parseCoreRow('users', 'canonical_evidence_ledger', data.resource);
  validateMemberStatus(member);
  if (member.id !== memberId) throw new Error('Member changed.');
  validateRelated(data, 'members');
  const membership = profileMembership(data, memberId, expectedGroup);
  if (!membership?.groupId) throw new Error('Membership could not be verified.');
  const statement = await readMembershipMovements(request, signal, memberId, membership.groupId);
  return {...statement, membership, name: present(member.display_name)};
}

const rwf = new Intl.NumberFormat('en-RW', {maximumFractionDigits: 0});
export function statementAmount(value: bigint | number | null, showCurrency = false) {
  if (value === null) return 'Unavailable';
  return (showCurrency ? 'RWF ' : '') + rwf.format(value);
}
