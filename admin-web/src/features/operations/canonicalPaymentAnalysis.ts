import {z} from 'zod';
import type {AdminRequest} from '../../api/client';
import {paymentInstant, type PaymentAnalysisQuery} from '../../../../supabase/functions/_shared/domain/burimunsi/payment-analysis-shared.mjs';
export {paymentInstant};

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

const decimal = z.string().regex(/^(0|[1-9]\d{0,30})$/).transform(value => BigInt(value));
const analysisResponse = z.object({
  items: z.array(buriMunsiPayment).max(25), totalCount: count, matchingCount: count, offset: count, limit: z.literal(25),
  asOf: z.string().refine(value => Number.isFinite(Date.parse(value))), directionTotalsRwf: z.object({incoming:decimal.nullable(),outgoing:decimal.nullable()}), missing:count,
});
export async function readCanonicalPaymentAnalysis(request:AdminRequest, signal:AbortSignal, query:PaymentAnalysisQuery, expectedGroup:string|undefined, showSms:boolean) {
  signal.throwIfAborted();
  const response = await request('burimunsi/payments/analysis', {method:'POST',body:query,signal});
  signal.throwIfAborted();
  const result = analysisResponse.parse(response);
  const {items,totalCount,matchingCount,offset,missing,directionTotalsRwf:{incoming,outgoing}} = result;
  if (offset!==query.offset || matchingCount>totalCount || missing>matchingCount || items.length!==Math.min(25, Math.max(0,matchingCount-offset)) ||
      new Set(items.map(row=>row.id)).size!==items.length || items.some(row=>!row.groupId || row.groupId!==(expectedGroup ?? items[0].groupId) || !showSms && row.sourceId) ||
      (incoming===null || outgoing===null)!==(missing>0) || (matchingCount===0 && (incoming!==0n || outgoing!==0n))) {
    throw new Error('The matching payments could not be verified.');
  }
  const subtotals={incoming:0n,outgoing:0n};
  const pageMissing={incoming:0,outgoing:0};
  for (const row of items) {
    if (row.amountRwf===null) pageMissing[row.direction]++;
    else subtotals[row.direction]+=BigInt(row.amountRwf);
  }
  if (pageMissing.incoming+pageMissing.outgoing>missing || (['incoming','outgoing'] as const).some(direction=>{
    const sum=result.directionTotalsRwf[direction];
    return sum!==null && (pageMissing[direction]>0 || subtotals[direction]>sum ||
      offset===0 && items.length===matchingCount && subtotals[direction]!==sum);
  })) throw new Error('The payment totals did not match the verified page.');
  return result;
}

const kigaliClock: Intl.DateTimeFormatOptions = {
  timeZone: 'Africa/Kigali', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23',
};
const kigaliMinutes = new Intl.DateTimeFormat('en-GB', kigaliClock);
const kigaliSeconds = new Intl.DateTimeFormat('en-GB', {...kigaliClock, second: '2-digit'});

// Explicit offsets and unambiguous Rwanda wall-clock formats can be compared. Keep partial/ambiguous originals for display.
export function paymentTime(raw: string | null) {
  if (!raw?.trim()) return '—';
  const time = paymentInstant(raw);
  if (time === null) return raw;
  const seconds = /[T ]\d{2}:\d{2}:(\d{2})(\.\d+)?/.exec(raw);
  if (!seconds) return kigaliMinutes.format(time);
  const fraction = seconds[2] && /[1-9]/.test(seconds[2]) ? seconds[2] : '';
  return kigaliSeconds.format(time) + fraction;
}
