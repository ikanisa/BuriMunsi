import {describe, expect, it, vi} from 'vitest';
import {buriMunsiPayment, paymentInstant, paymentTime, readAllCanonicalPayments} from '../../src/features/operations/canonicalPaymentAnalysis';

const at = '2026-11-24T20:15:34.000Z';
const row = (i: number) => ({
  id: 'payment-' + i, groupId:'group-a', version:1, ftId:i === 1 ? null : 'FT' + i,
  direction:i % 2 ? 'outgoing' : 'incoming', amountRwf:i === 1 ? null : i, atRaw:at,
  payerNameRaw:'Counterparty', payerPhoneRaw:'000007', memberId:null, memberName:null, memberPhone:null,
  state:'unallocated', sourceId:null,
});
function page(offset: number, totalCount: number) {
  const items = Array.from({length:Math.min(100, Math.max(0, totalCount - offset))}, (_, i) => row(offset + i));
  return {offset, limit:100, totalCount, items, asOf:at, nextOffset:offset + items.length < totalCount ? offset + items.length : null};
}
function offsetOf(path: string) {
  return Number(new URLSearchParams(path.split('?')[1]).get('offset'));
}

describe('canonical payment analysis source', () => {
  it('admits unknown or safe whole RWF amounts and rejects imprecise, negative or fractional values', () => {
    for (const amountRwf of [null, 0, Number.MAX_SAFE_INTEGER]) {
      expect(buriMunsiPayment.safeParse({...row(0),amountRwf}).success).toBe(true);
    }
    for (const amountRwf of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      expect(buriMunsiPayment.safeParse({...row(0),amountRwf}).success).toBe(false);
    }
  });

  it('loads each page in the same collection, preserving real zero, unknown and identifier digits', async () => {
    const request = vi.fn(async (path: string) => page(offsetOf(path), 205));
    const signal = new AbortController().signal;
    const rows = await readAllCanonicalPayments(request, signal, 'FT reference', 'group-a');
    expect(rows).toHaveLength(205);
    expect(rows[0]).toMatchObject({amountRwf:0, payerPhoneRaw:'000007'});
    expect(rows[1]).toMatchObject({ftId:null, amountRwf:null});
    expect(rows[204].id).toBe('payment-204');
    expect(request.mock.calls).toEqual([0,100,200].map(offset =>
      ['burimunsi/payments?limit=100&offset=' + offset + '&q=FT+reference',{signal}]));
  });

  it('starts again from the first page on a changed total and never combines separate reads', async () => {
    let call = 0;
    const request = vi.fn(async (path: string) => page(offsetOf(path), ++call === 1 ? 102 : 101));
    const rows = await readAllCanonicalPayments(request, new AbortController().signal);
    expect(request.mock.calls.map(([path]) => offsetOf(path))).toEqual([0,100,0,100]);
    expect(rows.map(value => value.id)).toEqual(Array.from({length:101}, (_, i) => 'payment-' + i));
  });

  it('rejects persistent overlaps, a malformed next offset and cross-collection data', async () => {
    const overlapping = vi.fn(async (path: string) => {
      const value = page(offsetOf(path), 101);
      if (value.offset) value.items = [row(1)];
      return value;
    });
    const signal = new AbortController().signal;
    await expect(readAllCanonicalPayments(overlapping, signal)).rejects.toThrow();
    expect(overlapping).toHaveBeenCalledTimes(4);
    await expect(readAllCanonicalPayments(async () => ({...page(0,101),nextOffset:42}), signal)).rejects.toThrow();
    const foreign = vi.fn(async () => ({...page(0,1),items:[{...row(0),groupId:'another-group'}]}));
    await expect(readAllCanonicalPayments(foreign, signal, '', 'group-a')).rejects.toThrow();
    expect(foreign).toHaveBeenCalledTimes(1);
  });

  it('aborts between pages without retaining an incomplete result or restarting', async () => {
    const controller = new AbortController();
    const request = vi.fn(async (path: string) => {
      const offset = offsetOf(path);
      if (offset === 100) controller.abort();
      return page(offset, 205);
    });
    await expect(readAllCanonicalPayments(request, controller.signal)).rejects.toMatchObject({name:'AbortError'});
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('payment time in Kigali', () => {
  it('converts explicit offsets and keeps exact seconds and fractional precision when stated', () => {
    expect(paymentInstant('2026-11-24T23:15:34.125+03:00')).toBe(Date.parse('2026-11-24T20:15:34.125Z'));
    expect(paymentTime('2026-11-24T23:15:34.125+03:00')).toMatch(/24 Nov 2026.*22:15:34\.125/);
    expect(paymentTime('2026-11-24T23:30:29Z')).toMatch(/25 Nov 2026.*01:30:29/);
    expect(paymentTime('24/11/2026 22:15')).toMatch(/24 Nov 2026.*22:15$/);
    expect(paymentInstant('2026/11/24 22:15')).toBe(Date.parse('2026-11-24T20:15:00Z'));
  });

  it('preserves ambiguous, impossible or unsupported source dates for display and leaves those comparison values blank', () => {
    for (const original of ['04/05/2026 08:20','31/02/2026 16:29','2026-11-24','provider time unavailable','2026-11-24T24:00:00Z']) {
      expect(paymentInstant(original)).toBeNull();
      expect(paymentTime(original)).toBe(original);
    }
    expect(paymentInstant(null)).toBeNull();
    expect(paymentTime(null)).toBe('—');
  });
});
