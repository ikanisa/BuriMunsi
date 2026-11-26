import {z} from 'zod';
import {AdminRequestError} from '../../api/client';
import {paymentDirection, paymentId} from '../operations/canonicalPaymentAnalysis';
import {isId, isObject, parseCoreRow, validateMemberStatus} from './contracts';
import {relatedPage, validateRelated} from './relatedRecordContract';
import type {AdminRequest} from './types';

export const memberStatementPath = (id: string) => '/admin/members/' + id + '/statement';
export const canReadMemberStatement = (permissions: readonly string[]) =>
  ['users.read', 'collections.read', 'payments.read'].every(permission => permissions.includes(permission));

export interface ProfileMembership {
  id: string | null;
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
  return {id: isId(row.id) ? row.id : null, recordNumber, groupId: row.user_id === memberId ? present(row.group_id) : null,
    groupTitle: present(row.group_title), collectId: present(row.public_id), memberName: present(row.display_name),
    role: present(row.role), status: present(row.status)};
}

export const memberStatementPageSize = 25;
export type MemberStatementPosition = {offset: number; revision?: string};
const revisionPattern = /^[0-9a-f]{64}$/;
const signedRwf = z.string().regex(/^(0|-?[1-9]\d{0,30})$/).transform(value => BigInt(value));
const balanceSummary = z.object({groupId: paymentId, memberId: paymentId, membershipId: paymentId, closingRwf: signedRwf}).strict();
const statementPage = z.object({
  groupId: paymentId, memberId: paymentId, membershipId: paymentId,
  totalCount: z.number().int().nonnegative().max(100_100), offset: z.number().int().nonnegative(),
  limit: z.literal(memberStatementPageSize), revision: z.string().regex(revisionPattern), closingRwf: signedRwf,
  items: z.array(z.object({
    id: paymentId, direction: paymentDirection, amountRwf: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    atRaw: z.string(), ftId: z.string().nullable(), balanceRwf: signedRwf,
  }).strict()).max(memberStatementPageSize),
}).strict();

export async function readMemberDetails(request: AdminRequest, signal: AbortSignal, memberId: string, include?: 'balance' | 'statement') {
  if (!isId(memberId)) throw new Error('Invalid member.');
  signal.throwIfAborted();
  const path = 'operations/members/' + memberId;
  if (!include) return request(path, {signal});
  try {
    const response = await request(path + '?include=' + include, {signal});
    if (!Object.hasOwn(response, 'member_' + include)) throw new Error('Missing member projection.');
    return response;
  } catch (error) {
    // Older servers explicitly reject the optional filter. Other failures retain their original meaning.
    if (!(error instanceof AdminRequestError) || error.statusCode !== 400 || error.code !== 'invalid_filter') throw error;
    signal.throwIfAborted();
    return request(path, {signal});
  }
}

export function readMemberBalanceProjection(raw: unknown, memberId: string, membership: ProfileMembership) {
  if (raw === null) return null;
  const result = balanceSummary.parse(raw);
  if (result.memberId !== memberId || result.groupId !== membership.groupId || result.membershipId !== membership.id) {
    throw new Error('The balance scope changed.');
  }
  return result.closingRwf;
}

export async function readMemberStatementPage(request: AdminRequest, signal: AbortSignal, memberId: string,
  membership: Pick<ProfileMembership, 'id' | 'groupId'>, {offset, revision}: MemberStatementPosition = {offset: 0}) {
  if (!isId(memberId) || !isId(membership.id) || !paymentId.safeParse(membership.groupId).success ||
      !Number.isSafeInteger(offset) || offset < 0 || offset >= 100_100 || offset % memberStatementPageSize !== 0 ||
      (revision === undefined ? offset > 0 : !revisionPattern.test(revision))) throw new Error('Invalid statement scope.');

  signal.throwIfAborted();
  const query = new URLSearchParams({statement: '1', memberId, offset: String(offset)});
  if (revision !== undefined) query.set('revision', revision);
  let raw;
  try {
    raw = await request('burimunsi/payments?' + query, {signal});
  } catch (error) {
    if (error instanceof AdminRequestError && error.code === 'member_statement_changed') {
      throw new AdminRequestError('The statement changed. Try again to review it from the first page.');
    }
    if (error instanceof AdminRequestError && error.code === 'member_statement_scope_too_large') {
      throw new AdminRequestError('This membership is too large to display a complete statement.');
    }
    throw error;
  }
  signal.throwIfAborted();
  return parseStatementPage(raw, memberId, membership, {offset, revision});
}

function parseStatementPage(raw: unknown, memberId: string, membership: Pick<ProfileMembership, 'id' | 'groupId'>,
  {offset, revision}: MemberStatementPosition) {
  const result = statementPage.parse(raw);
  const {items, totalCount, closingRwf} = result;
  if (result.memberId !== memberId || result.groupId !== membership.groupId || result.membershipId !== membership.id ||
      result.offset !== offset || revision !== undefined && result.revision !== revision ||
      (offset > 0 && offset >= totalCount) ||
      items.length !== Math.max(0, Math.min(result.limit, totalCount - offset)) ||
      new Set(items.map(item => item.id)).size !== items.length || (totalCount === 0 && closingRwf !== 0n)) {
    throw new Error('The statement scope changed.');
  }
  let priorBalance: bigint | undefined = offset === 0 ? 0n : undefined;
  for (const item of items) {
    const change = BigInt(item.amountRwf) * (item.direction === 'incoming' ? 1n : -1n);
    if (priorBalance !== undefined && priorBalance + change !== item.balanceRwf) throw new Error('The running balance could not be verified.');
    priorBalance = item.balanceRwf;
  }
  if (items.length && offset + items.length === totalCount && priorBalance !== closingRwf) throw new Error('The closing balance could not be verified.');
  return result;
}

export async function readMemberStatement(request: AdminRequest, signal: AbortSignal, memberId: string, actorId: string,
  expectedGroup: string | undefined, position: MemberStatementPosition) {
  const initial = position.offset === 0 && position.revision === undefined;
  const data = await readMemberDetails(request, signal, memberId, initial ? 'statement' : undefined);
  signal.throwIfAborted();
  if (data.current_actor_id !== actorId || data.resource_type !== 'members' || data.contract_version !== 2 ||
      data.model !== 'canonical_evidence_ledger' || typeof data.can_manage !== 'boolean') throw new Error('Invalid member response.');
  const member = parseCoreRow('users', 'canonical_evidence_ledger', data.resource);
  validateMemberStatus(member);
  if (member.id !== memberId) throw new Error('Member changed.');
  validateRelated(data, 'members');
  const membership = profileMembership(data, memberId, expectedGroup);
  if (!membership?.groupId || !membership.id) throw new Error('Membership could not be verified.');
  const statement = Object.hasOwn(data, 'member_statement') ? parseStatementPage(data.member_statement, memberId, membership, position) :
    await readMemberStatementPage(request, signal, memberId, membership, position);
  return {...statement, membership, name: present(member.display_name)};
}

const rwf = new Intl.NumberFormat('en-RW', {maximumFractionDigits: 0});
export function statementAmount(value: bigint | number | null, showCurrency = false) {
  if (value === null) return 'Unavailable';
  return (showCurrency ? 'RWF ' : '') + rwf.format(value);
}
