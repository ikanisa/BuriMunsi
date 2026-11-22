// @vitest-environment node
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {expect, it, vi} from 'vitest';
import {openOperationsBroadcast} from '../../src/features/operations/operationsRealtime';
import {SUPABASE_PROJECT_ORIGIN} from '../../src/config';

it('joins only the leased private Broadcast channel over WebSocket and accepts only its change signal', async () => {
  const server = new WebSocketServer({host:'127.0.0.1', port:0});
  await once(server, 'listening');
  const address=server.address();
  if (!address || typeof address === 'string') throw Error('No local fixture port.');
  const upgrade: URL[] = [], joins: {topic:string; payload:{config:{private:boolean;postgres_changes:unknown[]};access_token?:string}}[] = [];
  const localAddress='ws://127.0.0.1:'+address.port, topic='buri:ops:'+'a'.repeat(64);
  const providerId = 'df7f1e54-8301-4bef-bb97-1da1b1ef81f0';
  const NativeWebSocket=globalThis.WebSocket;
  vi.stubGlobal('WebSocket', class extends NativeWebSocket {
    constructor(value: string, protocols?: string | string[]) {
      const url=new URL(value); upgrade.push(url); super(localAddress+url.pathname+url.search,protocols);
    }
  });
  server.on('connection', ws=>ws.on('message', raw=>{
    const frame=JSON.parse(raw.toString());
    if (frame.event !== 'phx_join') return;
    joins.push(frame);
    ws.send(JSON.stringify({topic:frame.topic,event:'phx_reply',ref:frame.ref,join_ref:frame.join_ref,payload:{status:'ok',response:{}}}));
    for (const [wireTopic,event,body] of [
      ['realtime:'+topic+'other','operations_changed',{changed:true}],
      [frame.topic,'another_event',{changed:true}],
      [frame.topic,'operations_changed',{changed:true,text:'unexpected'}],
      [frame.topic,'operations_changed',{changed:true,id:'not-a-provider-uuid'}],
      [frame.topic,'operations_changed',{changed:true,id:providerId,text:'unexpected'}],
      [frame.topic,'operations_changed',{changed:false,id:providerId}],
      [frame.topic,'operations_changed',{changed:true}],
      [frame.topic,'operations_changed',{changed:true,id:providerId}],
    ]) ws.send(JSON.stringify({topic:wireTopic,event:'broadcast',ref:null,payload:{type:'broadcast',event,payload:body}}));
  }));
  let close: (()=>void) | undefined;
  try {
    const key='sb_publishable_synthetic_test_only', changed=vi.fn(), failed=vi.fn(), ready=vi.fn();
    close=await openOperationsBroadcast({origin:SUPABASE_PROJECT_ORIGIN,publishableKey:key,request:vi.fn()},topic,changed,failed,ready,new AbortController().signal);
    await vi.waitFor(()=>expect(changed.mock.calls).toEqual([[],[],[]]));
    expect(ready).toHaveBeenCalledOnce();expect(failed).not.toHaveBeenCalled();
    expect(upgrade).toHaveLength(1);expect(upgrade[0].origin).toBe(SUPABASE_PROJECT_ORIGIN.replace('https:','wss:'));
    expect(upgrade[0].pathname).toBe('/realtime/v1/websocket');expect(upgrade[0].searchParams.get('apikey')).toBe(key);
    expect(upgrade[0].href).not.toContain(topic);expect(joins).toHaveLength(1);
    expect(joins[0].topic).toBe('realtime:'+topic);expect(joins[0].payload.config.private).toBe(true);
    expect(joins[0].payload.config.postgres_changes).toEqual([]);expect(joins[0].payload.access_token).toBeUndefined();
  } finally {
    close?.(); server.clients.forEach(ws=>ws.terminate()); await new Promise<void>(resolve=>server.close(()=>resolve())); vi.unstubAllGlobals();
  }
});
