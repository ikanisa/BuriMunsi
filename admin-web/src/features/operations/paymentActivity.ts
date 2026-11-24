import {z} from 'zod';
import {canReadSmsEvidence} from '../../session/sessionContext';
import type {AdminUser} from '../../session/sessionResponses';
import {containsControl} from '../core/contracts';
import {canReadMemberReceipts} from './paymentLocations';

export const activityScopes = ['all', 'payments', 'momo', 'sms', 'android', 'captures', 'attention'] as const;
export type ActivityScope = typeof activityScopes[number];
type Access = Pick<AdminUser, 'role' | 'permissions' | 'authMethod'>;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.uuid();
const state = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const field = z.string().min(1).max(200).refine(value => !containsControl(value));
const group = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const receipt = z.object({kind: z.enum(['receiver_sms', 'capture']), id, status: state, collectionId: group.nullable(),
  bodySha256: z.string().regex(/^[0-9a-f]{64}$/).nullish(), paymentReference: field.nullish(), payerStatus: state.nullish(), payerReason: state.nullish()}).strict();
const row = z.object({kind: z.enum(['payment','momo','capture','receiver_sms']), id, occurredAt: z.iso.datetime({offset: true}),
  reference: field.nullable(), payer: field.nullable(), amountRwf: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
  status: state, attention: z.boolean(), paymentId: id.nullable(), reconciliationId: id.nullable(), momoIds: z.array(id), receipts: z.array(receipt)}).strict();
const page = z.object({contractVersion: z.literal(1), asOf: z.iso.datetime({offset: true}), limit: count, offset: count,
  total: count, items: z.array(row).max(25)}).strict();
export type PaymentActivity = z.infer<typeof row>;
export type ActivityReceipt = z.infer<typeof receipt>;
export const ACTIVITY_LIMIT = 25;

function invalid(): never {throw new Error('The payment activity could not be verified.');}
export const activityKey = (row: Pick<PaymentActivity, 'kind' | 'id'>) => row.kind + ':' + row.id;

export function parsePaymentActivity(raw: unknown, offset: number, user: Access) {
  const value = page.parse(raw), {items} = value;
  const financial = user.permissions.includes('payments.read'), sms = canReadSmsEvidence(user);
  const review = user.permissions.includes('reconciliations.read') && user.permissions.includes('users.read');
  const payments = new Set<string>(), transactions = new Set<string>(), receipts = new Set<string>();
  const unique = (refs: Set<string>, id: string) => {if (refs.has(id)) invalid(); refs.add(id);};
  if (value.limit !== ACTIVITY_LIMIT || value.offset !== offset || items.length !== Math.min(value.limit, Math.max(0, value.total - offset)) ||
      new Set(items.map(activityKey)).size !== items.length) return invalid();
  for (const item of items) {
    if (item.kind === 'payment' && !financial && !review || item.kind === 'momo' && (!financial || !item.momoIds.includes(item.id)) ||
        (item.kind === 'receiver_sms' || item.kind === 'capture') && !sms ||
        !financial && (item.paymentId !== null || item.momoIds.length) || !review && item.reconciliationId !== null ||
        item.paymentId && (item.kind !== 'payment' || item.paymentId !== item.id) ||
        item.reconciliationId && (item.kind !== 'payment' || item.reconciliationId !== item.id) ||
        !sms && item.receipts.length) return invalid();
    if ((item.kind === 'receiver_sms' || item.kind === 'capture') && (item.receipts.length !== 1 ||
        item.receipts[0].kind !== item.kind || item.receipts[0].id !== item.id)) return invalid();
    if (item.paymentId) unique(payments, item.paymentId);
    for (const id of item.momoIds) unique(transactions, id);
    for (const proof of item.receipts) {
      if (!financial && (proof.paymentReference || proof.payerStatus || proof.payerReason) ||
          proof.bodySha256 && (!user.permissions.includes('sms.reveal') || proof.kind !== 'receiver_sms')) return invalid();
      unique(receipts, activityKey(proof));
    }
  }
  return value;
}

const scopes = new Set<string>(activityScopes);
const selectors = ['view','dataset','scope','source','search','status','page','offset','sort','account','group','from','to','payment','extraction','duplicates'];
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
}
export function activityQuery(params: URLSearchParams, user: Access) {
  const get = (key: string) => params.get(key) ?? '';
  if ([...params.keys()].some(key => !selectors.includes(key) || params.getAll(key).length > 1)) return null;
  let scope = get('scope') || 'all';
  const view = get('view'), source = get('source'), dataset = get('dataset');
  if (get('scope') && (view || source || dataset) || view && !['recorded','momo','sms','attention'].includes(view) ||
      dataset && (!['momo','collect'].includes(dataset) || view && view !== 'recorded') ||
      source && (view !== 'sms' || !['android','app','member','capture'].includes(source))) return null;
  if (view === 'sms') scope = source === 'android' ? 'android' : source ? 'captures' : 'sms';
  if (view === 'recorded' || dataset === 'collect') scope = 'payments';
  if (view === 'momo' || dataset === 'momo') scope = 'momo';
  if (view === 'attention') scope = 'attention';
  if (!scopes.has(scope)) return null;
  const financial = user.permissions.includes('payments.read'), sms = canReadSmsEvidence(user), attention = user.permissions.includes('reconciliations.read');
  if (!financial && !sms && !(attention && user.permissions.includes('users.read')) || (scope === 'payments' || scope === 'momo') && !financial ||
      ['sms','android','captures'].includes(scope) && !sms || source === 'member' && !canReadMemberReceipts(user) ||
      scope === 'attention' && !attention) return null;
  const search = get('search').trim(), status = get('status'), from = get('from'), to = get('to'), selected = get('payment');
  if (search.length > 200 || containsControl(get('search')) || status && !state.safeParse(status).success ||
      get('sort') && get('sort') !== 'created_at_desc' || get('extraction') && get('extraction') !== 'not_extracted' ||
      get('duplicates') && get('duplicates') !== 'all' || from && !validDate(from) || to && !validDate(to) || from && to && from > to ||
      selected && (!financial || !id.safeParse(selected).success)) return null;
  for (const [key, permission] of [['account','receivers.read'], ['group','collections.read']]) {
    if (get(key) && (!user.permissions.includes(permission) || !id.safeParse(get(key)).success)) return null;
  }
  const ordinal = get('page'), rawOffset = get('offset');
  if (ordinal && rawOffset || ordinal && !/^[1-9]\d{0,8}$/.test(ordinal) || rawOffset && !/^(?:0|[1-9]\d{0,9})$/.test(rawOffset)) return null;
  const offset = ordinal ? (Number(ordinal) - 1) * ACTIVITY_LIMIT : Number(rawOffset || 0);
  if (offset > 2147483647 || offset % ACTIVITY_LIMIT !== 0) return null;
  const query = new URLSearchParams({limit: String(ACTIVITY_LIMIT), offset: String(offset)});
  if (scope !== 'all') query.set('scope', scope);
  if (search) query.set('search', search);
  if (status && status !== 'all') query.set('status', status);
  for (const key of ['account','group','from','to']) if (get(key)) query.set(key, get(key));
  return {scope: scope as ActivityScope, search, status: status === 'all' ? '' : status, offset, selected, path: 'core/payment-activity?' + query};
}
