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
  publicId?:string | null;
  groupId: string | null;
  groupTitle: string | null;
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
  const person = isObject(data.resource) && data.resource.id===memberId ? data.resource : null;
  const publicId = [row.public_id,person?.public_id].find((id):id is string => typeof id==='string' && /^\d{6}$/.test(id));
  return {id: isId(row.id) ? row.id : null, recordNumber, publicId:publicId ?? null, groupId: row.user_id === memberId ? present(row.group_id) : null,
    groupTitle: present(row.group_title)};
}

export const memberStatementPageSize = 25;
export type MemberStatementPosition = {offset: number; revision?: string};
const revisionPattern = /^[0-9a-f]{64}$/;
const signedRwf = z.string().regex(/^(0|-?[1-9]\d{0,30})$/).transform(value => BigInt(value));
const statementPage = z.object({
  groupId: paymentId, memberId: paymentId, membershipId: paymentId,
  totalCount: z.number().int().nonnegative().max(100_100), offset: z.number().int().nonnegative(),
  limit: z.literal(memberStatementPageSize), asOf:z.iso.datetime().optional(), revision: z.string().regex(revisionPattern), closingRwf: signedRwf,
  items: z.array(z.object({
    id: paymentId, direction: paymentDirection, amountRwf: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    atRaw: z.string(), occurredAt:z.iso.datetime({offset:true}).nullable().optional(), ftId: z.string().nullable(), balanceRwf: signedRwf,
  }).strict()).max(memberStatementPageSize),
}).strict();

async function loadMemberDetails(request: AdminRequest, signal: AbortSignal, memberId: string, includeStatement: boolean,
  keepProfile = false) {
  if (!isId(memberId)) throw new Error('Invalid member.');
  signal.throwIfAborted();
  const path = 'operations/members/' + memberId;
  if (!includeStatement) return {data: await request(path, {signal}), statementUnavailable: false};
  try {
    const data = await request(path + '?include=statement', {signal});
    const missing = !Object.hasOwn(data, 'member_statement');
    if (missing && !keepProfile) throw new Error('Missing member projection.');
    return {data, statementUnavailable: missing};
  } catch (error) {
    const unsupported = error instanceof AdminRequestError && error.statusCode === 400 && error.code === 'invalid_filter';
    const profileDenied = error instanceof AdminRequestError && (error.statusCode === 401 || error.code === 'not_found');
    if (!unsupported && (!keepProfile || profileDenied)) throw error;
    signal.throwIfAborted();
    // A plain member read has its own authority check. A failed financial read
    // stays unavailable until requested again; older servers use the separate reader.
    return {data: await request(path, {signal}), statementUnavailable: !unsupported};
  }
}

export const readProfileWithStatement = (request: AdminRequest, signal: AbortSignal, memberId: string) =>
  loadMemberDetails(request, signal, memberId, true, true);

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

export function parseStatementPage(raw: unknown, memberId: string, membership: Pick<ProfileMembership, 'id' | 'groupId'>,
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

export type StatementPage = ReturnType<typeof parseStatementPage>;
export type StatementPayment = StatementPage['items'][number];

export function statementGroupTitle(groupId:string, title:string|null) {
  const value=title?.trim();
  return value && value!==groupId ? value : null;
}

export async function readCompleteMemberStatement(current: StatementPage, membership: ProfileMembership, request: AdminRequest, signal: AbortSignal) {
  if (current.groupId!==membership.groupId || current.membershipId!==membership.id) throw new Error('The statement membership changed.');
  const items: StatementPayment[] = [], ids = new Set<string>();
  let running = 0n;
  for (let offset = 0; offset < current.totalCount; offset += memberStatementPageSize) {
    signal.throwIfAborted();
    const page = offset === current.offset ? current : await readMemberStatementPage(request, signal, current.memberId, membership,
      {offset, revision: current.revision});
    if (page.totalCount !== current.totalCount || page.closingRwf !== current.closingRwf) throw new Error('The statement changed.');
    for (const payment of page.items) {
      running += BigInt(payment.amountRwf) * (payment.direction === 'incoming' ? 1n : -1n);
      if (ids.has(payment.id) || running !== payment.balanceRwf) throw new Error('The transaction history could not be verified.');
      ids.add(payment.id);
      items.push(payment);
    }
  }
  signal.throwIfAborted();
  if (items.length !== current.totalCount || running !== current.closingRwf) throw new Error('The closing balance could not be verified.');
  return {groupTitle:statementGroupTitle(current.groupId,membership.groupTitle),publicId:membership.publicId ?? null,
    recordNumber:membership.recordNumber, asOf:current.asOf, revision:current.revision, transactions:items, closingRwf:current.closingRwf};
}
export type CompleteMemberStatement = Awaited<ReturnType<typeof readCompleteMemberStatement>>;

export async function readMemberStatement(request: AdminRequest, signal: AbortSignal, memberId: string, actorId: string,
  expectedGroup: string | undefined, position: MemberStatementPosition) {
  const initial = position.offset === 0 && position.revision === undefined;
  const {data} = await loadMemberDetails(request, signal, memberId, initial);
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
