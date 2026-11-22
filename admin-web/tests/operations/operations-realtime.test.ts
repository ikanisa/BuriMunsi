import {afterEach, expect, it, vi} from 'vitest';
import {operationsCapability, watchOperations, type openOperationsBroadcast} from '../../src/features/operations/operationsRealtime';
import {SUPABASE_PROJECT_ORIGIN} from '../../src/config';
const group='test-group', topic='buri:ops:'+'a'.repeat(64), key='sb_publishable_synthetic_test_only';
afterEach(()=>vi.useRealTimers());

it('rotates expired capabilities, coalesces reconnects and cancels the previous authority when hidden or unmounted', async()=>{
  vi.useFakeTimers(); const time=Date.parse('2026-11-22T12:00:00Z'); vi.setSystemTime(time);
  const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
  const change=vi.fn(), connected=vi.fn(), close=vi.fn(), request=vi.fn(async()=>({topic,expiresAt:new Date(Date.now()+30000).toISOString()}));
  const subscribe=vi.fn<typeof openOperationsBroadcast>().mockResolvedValue(close);
  window.addEventListener('burimunsi-operations-changed',change);
  const stop=watchOperations({origin:SUPABASE_PROJECT_ORIGIN,publishableKey:key,request},group,connected,subscribe);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledWith('sync/live',expect.objectContaining({method:'POST',body:{collectionId:group},authenticated:true}));
    expect(subscribe).toHaveBeenCalledTimes(1);
    const first=subscribe.mock.calls[0]; first[4](); first[2]();expect(change.mock.calls[0][0].detail).toEqual({collectionId:group});
    await vi.advanceTimersByTimeAsync(24000);expect(close).toHaveBeenCalledTimes(1);expect(subscribe).toHaveBeenCalledTimes(2);
    first[2]();expect(change).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('hidden');document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(60000);expect(subscribe).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue('visible');document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);expect(subscribe).toHaveBeenCalledTimes(3);
    stop(); subscribe.mock.calls[2][2]();await vi.advanceTimersByTimeAsync(60000);
    expect(change).toHaveBeenCalledTimes(1);expect(request).toHaveBeenCalledTimes(3);
  } finally {stop();window.removeEventListener('burimunsi-operations-changed',change);}
});
it('does not subscribe to malformed, expired or unexpected credentials, and recovers after a BFF outage',async()=>{
  vi.useFakeTimers();const now=Date.now(), expiry=new Date(now+30000).toISOString();
  for(const cap of [{topic:'public',expiresAt:expiry},{topic,expiresAt:new Date(now).toISOString()},{topic,expiresAt:expiry,bearer:'unexpected'}]){
    expect(()=>operationsCapability(cap,now)).toThrow();
  }
  const request=vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue({topic,expiresAt:expiry});
  const subscribe=vi.fn<typeof openOperationsBroadcast>().mockResolvedValue(()=>{});
  const stop=watchOperations({origin:SUPABASE_PROJECT_ORIGIN,publishableKey:key,request},undefined,vi.fn(),subscribe);
  try{await vi.advanceTimersByTimeAsync(0);expect(subscribe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);expect(subscribe).toHaveBeenCalledOnce();expect(request.mock.calls[1][1].body).toEqual({});
  }finally{stop();}
});
