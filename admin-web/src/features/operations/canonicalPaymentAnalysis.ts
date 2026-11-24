import {z} from 'zod';
import type {AdminRequest} from '../../api/client';

export const paymentId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/);
export const paymentDirection = z.enum(['incoming', 'outgoing']);
export const paymentAllocation = z.enum(['allocated', 'unallocated']);
const count = z.number().int().nonnegative();
export const buriMunsiPayment = z.object({
  id: paymentId, groupId: paymentId.optional(), version: count.min(1), direction: paymentDirection,
  amountRwf: count.nullable(), atRaw: z.string().nullable(), ftId: z.string().nullable(),
  payerNameRaw: z.string().nullable(), payerPhoneRaw: z.string().nullish(), memberId: paymentId.nullable(),
  memberName: z.string().nullable(), memberPhone: z.string().nullish(), state: paymentAllocation, sourceId: paymentId.nullish(), canAllocate: z.boolean().optional(),
}).refine(row => (row.state === 'allocated') === (row.memberId !== null) && (row.memberId !== null || row.memberName === null));
export type BuriMunsiPayment = z.infer<typeof buriMunsiPayment>;

const batchSize = 100;
const pageSchema = z.object({items: z.array(buriMunsiPayment).max(batchSize), totalCount: count,
  offset: count, limit: z.literal(batchSize), nextOffset: count.nullable(), asOf: z.string().refine(value => Number.isFinite(Date.parse(value)))});
class PaymentListChanged extends Error {}

async function readPages(request: AdminRequest, signal: AbortSignal, query: string, expectedGroup?: string) {
  const rows: BuriMunsiPayment[] = [], seen = new Set<string>();
  let total: number | undefined, offset = 0, firstGroup: string | undefined;
  for (;;) {
    signal.throwIfAborted();
    const search = new URLSearchParams({limit: String(batchSize), offset: String(offset)});
    if (query) search.set('q', query);
    const page = pageSchema.parse(await request('burimunsi/payments?' + search, {signal}));
    signal.throwIfAborted();
    total ??= page.totalCount;
    const more = offset + page.items.length < total;
    if (page.totalCount !== total || page.offset !== offset || page.items.length !== Math.min(batchSize, total - offset) ||
        page.nextOffset !== (more ? offset + batchSize : null)) throw new PaymentListChanged();
    for (const row of page.items) {
      if (expectedGroup && row.groupId !== expectedGroup) throw new Error('Payment collection changed.');
      if (!rows.length) firstGroup = row.groupId;
      if (row.groupId !== firstGroup || seen.has(row.id)) throw new PaymentListChanged();
      rows.push(row); seen.add(row.id);
    }
    if (page.nextOffset === null) return rows;
    if (page.nextOffset > 100_000) throw new Error('The complete set exceeds the supported payment offset.');
    offset = page.nextOffset;
  }
}

export async function readAllCanonicalPayments(request: AdminRequest, signal: AbortSignal, query = '', expectedGroup?: string) {
  try { return await readPages(request, signal, query, expectedGroup); }
  catch (error) {
    if (!(error instanceof PaymentListChanged) || signal.aborted) throw error;
    return readPages(request, signal, query, expectedGroup);
  }
}

const kigaliClock: Intl.DateTimeFormatOptions = {
  timeZone: 'Africa/Kigali', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23',
};
const kigaliMinutes = new Intl.DateTimeFormat('en-GB', kigaliClock);
const kigaliSeconds = new Intl.DateTimeFormat('en-GB', {...kigaliClock, second: '2-digit'});

// Explicit offsets and unambiguous Rwanda wall-clock formats can be compared. Keep partial/ambiguous originals for display.
export function paymentInstant(raw: string | null): number | null {
  const text = raw?.trim();
  if (!text) return null;
  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  const ymd = /^(\d{4})([-/])(\d{2})\2(\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(text);
  const dmy = /^(\d{2})([-/])(\d{2})\2(\d{4})[T ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(text);
  let day: string, clock: string, seconds: string, fraction = '', zone = '+02:00';
  if (iso) {
    [,day,clock] = iso; seconds = iso[3] ?? '00'; fraction = iso[4] ?? ''; zone = iso[5];
  } else if (ymd) {
    day = [ymd[1],ymd[3],ymd[4]].join('-'); clock = ymd[5]; seconds = ymd[6] ?? '00';
  } else if (dmy && (Number(dmy[1]) > 12 || dmy[1] === dmy[3])) {
    day = [dmy[4],dmy[3],dmy[1]].join('-'); clock = dmy[5]; seconds = dmy[6] ?? '00';
  } else return null;
  const wall = day + 'T' + clock + ':' + seconds + '.' + fraction.slice(1,4).padEnd(3,'0');
  const check = Date.parse(wall + 'Z');
  if (!Number.isFinite(check) || new Date(check).toISOString().slice(0,23) !== wall) return null;
  const value = Date.parse(wall + zone);
  return Number.isFinite(value) ? value : null;
}

export function paymentTime(raw: string | null) {
  if (!raw?.trim()) return '—';
  const time = paymentInstant(raw);
  if (time === null) return raw;
  const seconds = /[T ]\d{2}:\d{2}:(\d{2})(\.\d+)?/.exec(raw);
  if (!seconds) return kigaliMinutes.format(time);
  const fraction = seconds[2] && /[1-9]/.test(seconds[2]) ? seconds[2] : '';
  return kigaliSeconds.format(time) + fraction;
}
