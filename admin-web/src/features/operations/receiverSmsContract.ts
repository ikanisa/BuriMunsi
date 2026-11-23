import {z} from 'zod';
import {reasonLabels, receiptLabels} from '../overview/smsOversightContract';

export const processingLabels = {pending: 'Awaiting processing', held: 'Held for review', historical: 'Historical import', retrying: 'Retrying', blocked: 'Needs review', duplicate: 'Duplicate receipt',
  excluded: 'Excluded message', reversed: 'Credit reversed', posted: 'Credited', non_payment: 'Non-payment', unmatched: 'Unmatched payer'} as const;
const groupId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const instant = z.iso.datetime();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const accounts = z.object({contractVersion: z.literal(1), asOf: instant, items: z.array(z.object({collectionId: groupId,label: z.string().min(1).max(200)}).strict()).max(500)}).strict();
const inbox = z.object({state: z.enum(['unknown','checking','incomplete','verified']),checkedAt: instant.nullable(),candidateCount: count.nullable(),
  missingCount: count.nullable(),pendingCount: count.nullable(),headsMatch: z.boolean().nullable()}).strict().refine(check => check.state !== 'verified' ||
    (check.checkedAt !== null && check.candidateCount !== null && check.missingCount === 0 && check.pendingCount === 0 && check.headsMatch === true));
const row = z.object({requestId: z.uuid(),sourceId: z.uuid(),admittedAt: instant,retentionState: z.enum(['retained','unresolved']),bodySha256: hash.nullable(),
  processing: z.enum(Object.keys(processingLabels) as (keyof typeof processingLabels)[]),paymentReference: z.string().regex(/^\d{12}$/).nullable(),
  payerStatus: z.enum(Object.keys(receiptLabels) as (keyof typeof receiptLabels)[]).nullable(),payerReason: z.enum(Object.keys(reasonLabels) as (keyof typeof reasonLabels)[]).nullable()}).strict();
const pageSchema = z.object({contractVersion:z.literal(1),collectionId:groupId,items:z.array(row).max(25),nextCursor:z.string().min(1).max(2048).nullable(),asOf:instant,inboxCheck:inbox}).strict();
export function receiverCollections(value: unknown) {
  const {items} = accounts.parse(value);
  if (new Set(items.map(item => item.collectionId)).size !== items.length) throw Error('Duplicate collection.');
  return items;
}
export function receiverPage(value: unknown, collection: string) {
  const page = pageSchema.parse(value);
  if (page.collectionId !== collection || new Set(page.items.map(item => item.sourceId)).size !== page.items.length ||
      page.items.some(item => (item.retentionState === 'retained') !== !!item.bodySha256)) throw Error('Invalid receiver observations.');
  return page;
}
