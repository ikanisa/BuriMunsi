import {act,render,screen,waitFor,within} from '@testing-library/react';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {OperationsLiveContext, operationsStreams} from '../../src/features/operations/operationsLiveContext';
import {SUPABASE_PROJECT_ORIGIN} from '../../src/config';
import {MemoryRouter} from 'react-router';
import {describe,expect,it,vi} from 'vitest';
import {MomoReceiptsPage} from '../../src/features/operations/MomoReceiptsPage';
import {receiverPage} from '../../src/features/operations/receiverSmsContract';

const fixture=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../../src/session/SessionProvider',async original=>({...await original<typeof import('../../src/session/SessionProvider')>(),
  useSession:()=>({request:fixture.request,status:'authenticated',epoch:1,user:{id:'owner',role:'owner',authMethod:'phone_passcode',permissions:['sms.read','payments.read']}})}));
const time='2026-11-22T10:00:00.000Z',group='first-group',source='11111111-1111-4111-8111-111111111111';
const page={contractVersion:1,collectionId:group,asOf:time,nextCursor:null,inboxCheck:{state:'verified',checkedAt:time,candidateCount:1,missingCount:0,pendingCount:0,headsMatch:true},
  items:[{requestId:source,sourceId:source,admittedAt:time,retentionState:'retained',bodySha256:'a'.repeat(64),processing:'posted',paymentReference:'100000000172',payerStatus:'delivered',payerReason:null}]};
describe('BuriMunsi receiver observations',()=>{
  it('opens the receiver collection for a phone-passcode operator and displays source, credit, payer and completeness outcomes',async()=>{
    fixture.request.mockImplementation(async path=>path==='momo/observations/collections'?{contractVersion:1,asOf:time,items:[{collectionId:group,label:'Test group'}]}:page);
    render(<MemoryRouter><MomoReceiptsPage /></MemoryRouter>);
    const records=await screen.findByRole('region',{name:'Android receiver observations'});
    expect(within(records).getByText('Credited')).toBeVisible();expect(within(records).getByText('100000000172')).toBeVisible();
    expect(within(records).getByText('Reported delivered')).toBeVisible();expect(screen.getByText(/Inbox matched at the last check/)).toBeVisible();
    expect(screen.queryByRole('button',{name:'Review source'})).not.toBeInTheDocument();
    expect(fixture.request.mock.calls[1][0]).toBe('momo/observations?collectionId=first-group&limit=25&includeProcessing=1');
  });
  it('refetches the same cursor for a matching event and coalesces changes during an in-flight read',async()=>{
    fixture.request.mockReset();
    let reads=0, finish!: (value: typeof page) => void;
    const path='momo/observations?collectionId=first-group&limit=25&includeProcessing=1&cursor=older';
    fixture.request.mockImplementation(async url=>{
      if(url==='momo/observations/collections')return {contractVersion:1,asOf:time,items:[{collectionId:group,label:'Test group'}]};
      if(url!==path)return {...page,nextCursor:'older'};
      reads++;
      if(reads===2)return new Promise<typeof page>(done=>{finish=done;});
      return page;
    });
    render(<MemoryRouter><MomoReceiptsPage /></MemoryRouter>);
    const next=await screen.findByRole('button',{name:'Next'});
    await act(async()=>next.click());
    await screen.findByText('Reported delivered');
    const update=(id:string)=>window.dispatchEvent(new CustomEvent('burimunsi-operations-changed',{detail:{collectionId:id}}));
    await act(async()=>{update('unrelated');}); expect(reads).toBe(1);
    await act(async()=>{update(group);}); expect(reads).toBe(2);
    await act(async()=>{update(group);update(group);}); expect(reads).toBe(2);
    await act(async()=>finish(page));
    await waitFor(()=>expect(reads).toBe(3));
    expect(fixture.request.mock.calls.at(-1)?.[0]).toBe(path);
  });
  it('renders the changed payer outcome through the private socket and the normal scoped HTTP list',async()=>{
    const {WebSocket,WebSocketServer}=createRequire(import.meta.url)('ws') as typeof import('ws');
    const server=new WebSocketServer({host:'127.0.0.1',port:0}); await once(server,'listening');
    const address=server.address();if(!address || typeof address==='string')throw Error('No local fixture port.');
    const port=address.port;
    const topic='buri:ops:'+'b'.repeat(64), issued=vi.fn(), changed=vi.fn();
    vi.stubGlobal('WebSocket',class extends WebSocket{
      constructor(url:string,protocols?:string | string[]){const target=new URL(url);super('ws://127.0.0.1:'+port+target.pathname+target.search,protocols);}
    });
    let delivered=false, reads=0;
    fixture.request.mockReset().mockImplementation(async(path,options)=>{
      if(path==='sync/live'){issued(options.body);return {topic,expiresAt:new Date(Date.now()+120000).toISOString()};}
      if(path==='momo/observations/collections')return {contractVersion:1,asOf:time,items:[{collectionId:group,label:'Test group'}]};
      expect(path).toContain('collectionId='+group);reads++;
      return {...page,items:[{...page.items[0],payerStatus:delivered?'delivered':'pending'}]};
    });
    server.on('connection',socket=>socket.on('message',raw=>{
      const frame=JSON.parse(raw.toString());if(frame.event!=='phx_join')return;
      expect(frame.topic).toBe('realtime:'+topic);expect(frame.payload.config.private).toBe(true);
      socket.send(JSON.stringify({topic:frame.topic,event:'phx_reply',ref:frame.ref,join_ref:frame.join_ref,payload:{status:'ok',response:{}}}));
      changed.mockImplementation(()=>socket.send(JSON.stringify({topic:frame.topic,event:'broadcast',ref:null,
        payload:{type:'broadcast',event:'operations_changed',payload:{changed:true}}})));
    }));
    const streams=operationsStreams({origin:SUPABASE_PROJECT_ORIGIN,publishableKey:'sb_publishable_synthetic_test_only',request:fixture.request});
    const view=render(<OperationsLiveContext.Provider value={streams}><MemoryRouter><MomoReceiptsPage /></MemoryRouter></OperationsLiveContext.Provider>);
    try{
      await screen.findByText('Pending');await waitFor(()=>expect(reads).toBeGreaterThanOrEqual(2));
      expect(issued).toHaveBeenCalledExactlyOnceWith({collectionId:group});expect(server.clients.size).toBe(1);
      delivered=true;changed();
      expect(await screen.findByText('Reported delivered')).toBeVisible();expect(screen.getByText('100000000172')).toBeVisible();
    }finally{view.unmount();server.clients.forEach(socket=>socket.terminate());await new Promise<void>(done=>server.close(()=>done()));vi.unstubAllGlobals();}
  });
  it('rejects mixed collection rows and an asserted match with a missing SMS',()=>{
    expect(()=>receiverPage(page,'another-group')).toThrow();
    expect(()=>receiverPage({...page,inboxCheck:{...page.inboxCheck,missingCount:1}},group)).toThrow();
  });
});
