import {describe, expect, it, vi} from 'vitest';
import {buriMunsiPayment, paymentInstant, paymentTime, readCanonicalPaymentAnalysis, readAllCanonicalPayments, paymentCounterpartyEvidence, paymentMemberName, paymentMemberNumber} from '../../src/features/operations/canonicalPaymentAnalysis';
import {analyzeCanonicalPaymentRows,parsePaymentAnalysisQuery,type PaymentAnalysisQuery}
  from '../../../supabase/functions/_shared/domain/burimunsi/payment-analysis-shared.mjs';

const at = '2026-11-24T20:15:34.000Z';
const row = (i: number) => ({
  id: 'payment-' + i, groupId:'group-a', version:1, ftId:i === 1 ? null : 'FT' + i,
  direction:i % 2 ? 'outgoing' : 'incoming', amountRwf:i === 1 ? null : i, atRaw:at,
  payerNameRaw:'Counterparty', payerPhoneRaw:'000007', memberId:null, memberName:null, memberPhone:null,
  state:'unallocated', sourceId:null,
});
const input:PaymentAnalysisQuery={q:'FT reference',offset:0,limit:25,filters:[],sort:{key:'time',direction:'desc'}};
const response={items:[row(0),row(1),...Array.from({length:23},(_,i)=>row(i+2))],totalCount:105,matchingCount:27,offset:0,limit:25,asOf:at,missing:1,
  directionTotalsRwf:{incoming:'9007199254740993',outgoing:null}};
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

  it('reads one page and totals in one body-only request with exact decimal handling', async () => {
    const request=vi.fn(async()=>response), signal=new AbortController().signal;
    const value=await readCanonicalPaymentAnalysis(request,signal,input,'group-a',false);
    expect(request.mock.calls).toEqual([['burimunsi/payments/analysis',{method:'POST',body:input,signal}]]);
    expect(value.items).toHaveLength(25);
    expect(value.items[0]).toMatchObject({amountRwf:0,payerPhoneRaw:'000007'});
    expect(value.directionTotalsRwf).toEqual({incoming:9007199254740993n,outgoing:null});
  });

  it('rejects bad counts, duplicate rows, wrong scope, forbidden evidence, and inaccurate totals representations', async () => {
    const signal=new AbortController().signal;
    for (const bad of [
      {...response,matchingCount:1}, {...response,missing:0}, {...response,items:[row(0),row(0),...response.items.slice(2)]},
      {...response,items:[row(0),{...row(1),groupId:'wrong'},...response.items.slice(2)]},
      {...response,items:[row(0),{...row(1),sourceId:'restricted'},...response.items.slice(2)]},
      {...response,directionTotalsRwf:{incoming:'1.0',outgoing:null}},
      {...response,directionTotalsRwf:{incoming:'1',outgoing:null}},
    ]) await expect(readCanonicalPaymentAnalysis(async()=>bad,signal,input,'group-a',false)).rejects.toThrow();
  });

  it('suppresses a superseded response and does not retry or publish old totals', async () => {
    const controller=new AbortController();
    const request=vi.fn(async()=>{controller.abort(); return response;});
    await expect(readCanonicalPaymentAnalysis(request,controller.signal,input,'group-a',false)).rejects.toMatchObject({name:'AbortError'});
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('uses shared accent/date/category predicates with AND, literal text, and role-fenced SMS columns', () => {
    const base={presence:'any',text:'',min:'',max:'',choices:[]} as const;
    const filters=[
      {...base,key:'counterparty',text:'eLo%_'},
      {...base,key:'time',min:'2026-11-24',max:'2026-11-24'},
      {...base,key:'direction',choices:['incoming','outgoing']},
    ];
    const query=parsePaymentAnalysisQuery({...input,filters},false);
    const rows=[
      {...row(0),payerNameRaw:' Élo%_ ',atRaw:'2026-11-23T22:00:00Z'},
      {...row(1),payerNameRaw:'elo%_',atRaw:'2026-11-24T22:00:00Z'},
      {...row(2),payerNameRaw:'ElO-%_',atRaw:'2026-11-24T10:00:00Z'},
      {...row(3),payerNameRaw:'elo%_',atRaw:'04/05/2026 08:20'},
    ];
    expect(analyzeCanonicalPaymentRows(rows,query.filters,query.sort,false)).toEqual([rows[0]]);
    expect(()=>parsePaymentAnalysisQuery({...input,sort:{key:'sms',direction:'asc'}},false)).toThrow(TypeError);
    expect(()=>parsePaymentAnalysisQuery({...input,filters:[{...base,key:'sms',choices:['linked']}]},false)).toThrow(TypeError);
    expect(()=>parsePaymentAnalysisQuery({...input,filters:[filters[0],filters[0]]},true)).toThrow(TypeError);
    expect(()=>parsePaymentAnalysisQuery({...input,filters:[{...base,key:'time',min:'2026-02-31'}]},true)).toThrow(TypeError);
    for(const min of ['9007199254740993','9007199254740991.1','1e-999','0x10']) {
      expect(()=>parsePaymentAnalysisQuery({...input,filters:[{...base,key:'amount',min}]},true)).toThrow(TypeError);
    }
    expect(parsePaymentAnalysisQuery({...input,filters:[{...base,key:'amount',min:'1.1e3'}]},true).filters[0].min).toBe('1.1e3');
  });
});

describe('complete payment statement source', () => {
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

  it.each([
    [true, true, true], [true, false, false], [false, true, false], [true, undefined, false],
    [undefined, true, false], [undefined, undefined, false],
  ] as const)('attaches only an allocation grant confirmed on every page (%s, %s)', async (first, last, expected) => {
    const request = async (path: string) => {
      const offset = offsetOf(path), data = page(offset, 101);
      return {...data, canAllocate: offset === 0 ? first : last,
        items: data.items.map(item => ({...item, canAllocate: !expected}))};
    };
    const rows = await readAllCanonicalPayments(request, new AbortController().signal);
    expect(rows).toHaveLength(101);
    expect(rows.every(item => item.canAllocate === expected)).toBe(true);
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

describe('member and counterparty presentation', () => {
  const assigned = buriMunsiPayment.parse({...row(1), state: 'allocated', memberId: 'member-a',
    memberName: 'Élise  A.', memberPhone: '+250781234567', payerNameRaw: 'E\u0301LISE A.', payerPhoneRaw: '(078) 123-4567'});

  it('shows the assigned values once when the recorded name and Rwanda number differ only in formatting', () => {
    expect(paymentMemberName(assigned)).toBe('Élise  A.');
    expect(paymentMemberNumber(assigned)).toBe('+250781234567');
    for (const format of ['(078) 123-4567', '250781234567', '00250 781 234 567']) {
      expect(paymentCounterpartyEvidence({...assigned, payerPhoneRaw: format})).toEqual({name: null, number: null});
    }
    expect(assigned.payerPhoneRaw).toBe('(078) 123-4567');
  });

  it('keeps a distinct recorded name or number as supplied, including masks and identifiers', () => {
    const distinct = {...assigned, payerNameRaw: 'Elise A.', payerPhoneRaw: '078***4567'};
    expect(paymentCounterpartyEvidence(distinct)).toEqual({name: 'Elise A.', number: '078***4567'});
    expect(paymentCounterpartyEvidence({...assigned, memberPhone: '000007', payerPhoneRaw: '007'}))
      .toEqual({name: null, number: '007'});
    expect(paymentCounterpartyEvidence({...assigned, memberPhone: '078***4567', payerPhoneRaw: '078***4567'}))
      .toEqual({name: null, number: null});
  });

  it('falls back independently to recorded values and preserves absent or unassigned contacts', () => {
    const unassigned = buriMunsiPayment.parse({...row(1), memberPhone: '+250781234567',
      payerNameRaw: 'Recorded Name', payerPhoneRaw: '000007'});
    expect(paymentMemberName(unassigned)).toBe('Recorded Name');
    expect(paymentMemberNumber(unassigned)).toBe('000007');
    expect(paymentCounterpartyEvidence(unassigned)).toEqual({name: null, number: null});
    const partial = {...assigned, memberName: '  ', payerNameRaw: 'Original Name', memberPhone: null, payerPhoneRaw: '07***89'};
    expect(paymentMemberName(partial)).toBe('Original Name');
    expect(paymentMemberNumber(partial)).toBe('07***89');
    expect(paymentCounterpartyEvidence(partial)).toEqual({name: null, number: null});
    expect(paymentMemberName({...unassigned, payerNameRaw: null})).toBeNull();
    expect(paymentMemberNumber({...unassigned, payerPhoneRaw: '  '})).toBeNull();
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
