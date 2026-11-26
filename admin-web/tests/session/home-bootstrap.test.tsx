import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AdminApp} from '../../src/app/App';
import {AdminSessionController} from '../../src/session/AdminSessionController';

const config = {backend:'supabase',phonePasscodeOnly:true,publishableKey:'sb_publishable_'+'a'.repeat(32),
  captchaEnabled:false,googleEnabled:false} as const;
const sessionPath='/api/admin/auth/session', homePath='/api/admin/burimunsi/home';
const homeHeader='X-BuriMunsi-Session-Home';
const group='approved-group', accountId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const permissions=['overview.read','payments.read'];
const member = {id:'browser-actor',sessionId:'browser-session',accountId,principalId:'browser-principal',
  phone:'+250780000001',authMethod:'phone_passcode',financialModel:'canonical_evidence_ledger',permissions};
const home = (reference: string, collectionId = group) => ({
  paymentCount:1, memberCount:4, unallocatedCount:1, asOf:new Date().toISOString(), recentPayments:[{
    id:'payment-fixture',groupId:collectionId,version:1,direction:'incoming',state:'unallocated',amountRwf:42,atRaw:null,
    ftId:reference,payerNameRaw:null,memberId:null,memberName:null,sourceId:null,
  }], paymentTotals:{incomingRwf:'42',outgoingRwf:'0'},
});
function session(role: 'admin' | 'staff' = 'admin') {
  return {user:{...member,role,passcodeVerifiedAt:new Date(Date.now()-1000).toISOString()},
    expiresAt:new Date(Date.now()+60_000).toISOString(),csrfToken:'c'.repeat(64),ownerEmail:null,
    ...(role==='admin' && {adminIdentity:{schemaVersion:1,role,accountId,adminId:member.id,principalId:member.principalId,collectionId:group}}),
    homeCollectionId:group,homeBootstrap:{version:1,actorId:member.id,sessionId:member.sessionId,collectionId:group,home:home('BOOT-HOME')},
  };
}

function navigate(path: string) {
  window.history.replaceState({},'',`/#${path}`);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
  navigate('/');
});

describe('authenticated initial Home projection', () => {
  it.each(['admin','staff'] as const)('renders the %s Home from one request and takes it only once',async role=>{
    navigate('/admin');
    const fetchImpl=vi.fn<typeof fetch>(async input=>Response.json(input===sessionPath?session(role):home('FRESH-HOME')));
    render(<AdminApp config={{...config,fetchImpl}} />);
    expect(await screen.findByRole('link',{name:'BOOT-HOME'})).toBeVisible();
    expect(fetchImpl.mock.calls.map(([path,options])=>[path,new Headers(options?.headers).get(homeHeader)])).toEqual([[sessionPath,'1']]);
    fireEvent.click(screen.getByRole('button',{name:'Refresh Home'}));
    expect(await screen.findByRole('link',{name:'FRESH-HOME'})).toBeVisible();
    expect(fetchImpl.mock.calls.map(([path,options])=>[path,new Headers(options?.headers).get(homeHeader)])).toEqual([[sessionPath,'1'],[homePath,null]]);
  });

  it.each(['legacy','actor','session','staff-collection','admin-collection','row-collection','shape','staff-SMS','missing-totals','missing-wallet'])('uses a fresh ordinary Home after %s bootstrap', async fault=>{
    navigate('/admin');
    const baseline=session(fault.startsWith('staff')?'staff':'admin');
    const boot = {...baseline.homeBootstrap};
    const payload: Record<string, unknown> = {...baseline,homeBootstrap:boot};
    if (fault==='legacy') {delete payload.homeBootstrap;delete payload.homeCollectionId;}
    if (fault==='actor') boot.actorId='former-actor';
    if (fault==='session') boot.sessionId='former-session';
    if (fault==='staff-collection') boot.collectionId='other-group';
    if (fault==='admin-collection') {boot.collectionId='other-group';payload.homeCollectionId='other-group';}
    if (fault==='row-collection') boot.home=home('BOOT-HOME','other-group');
    if (fault==='shape') boot.home.paymentCount=-1;
    if (fault==='missing-totals') {
      const {paymentTotals:_,...partial}=boot.home;
      payload.homeBootstrap={...boot,home:partial};
    }
    if (fault==='missing-wallet') payload.user={...baseline.user,permissions:[...permissions,'sms.read']};
    if (fault==='staff-SMS') {
      payload.homeBootstrap={...boot,home:{...boot.home,recentPayments:[{...boot.home.recentPayments[0],sourceId:'foreign-SMS'}]}};
    }
    const fetchImpl=vi.fn<typeof fetch>(async input=>Response.json(input===sessionPath?payload:home('FRESH-HOME')));
    render(<AdminApp config={{...config,fetchImpl}} />);
    expect(await screen.findByRole('link',{name:'FRESH-HOME'})).toBeVisible();
    expect(screen.queryByRole('link',{name:'BOOT-HOME'})).not.toBeInTheDocument();
    expect(fetchImpl.mock.calls.map(([path])=>path)).toEqual([sessionPath,homePath]);
  });

  it('accepts an explicitly unavailable wallet balance along with the current totals',async()=>{
    navigate('/admin');
    const payload=session();
    payload.user.permissions=[...permissions,'sms.read'];
    const boot=payload.homeBootstrap;
    const fetchImpl=vi.fn<typeof fetch>(async()=>Response.json({...payload,
      homeBootstrap:{...boot,home:{...boot.home,paymentTotals:{...boot.home.paymentTotals,latestSmsBalanceRwf:null,walletGapRwf:null}}}}));
    render(<AdminApp config={{...config,fetchImpl}} />);
    expect(await screen.findByRole('link',{name:'BOOT-HOME'})).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:/Latest MoMo SMS balance.*Unavailable/}));
    expect(screen.getByRole('dialog',{name:'Wallet details'})).toBeVisible();
    expect(screen.getByText('Latest verified SMS balance',{exact:true}).nextElementSibling).toHaveTextContent('Unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('starts the ordinary session path on another route and discards the unsolicited projection on re-entry', async()=>{
    navigate('/admin/payments');
    const fetchImpl=vi.fn<typeof fetch>(async input=>{
      if(input===sessionPath)return Response.json(session());
      if(input===homePath)return Response.json(home('FRESH-HOME'));
      return Response.json({items:[],totalCount:0,matchingCount:0,offset:0,limit:25,asOf:new Date().toISOString(),missing:0,
        directionTotalsRwf:{incoming:'0',outgoing:'0'}});
    });
    render(<AdminApp config={{...config,fetchImpl}} />);
    await screen.findByRole('heading',{name:'Payments'});
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get(homeHeader)).toBeNull();
    fireEvent.click(screen.getByRole('link',{name:'Home'}));
    expect(await screen.findByRole('link',{name:'FRESH-HOME'})).toBeVisible();
    expect(fetchImpl.mock.calls.filter(([path])=>path===homePath)).toHaveLength(1);
  });

  it.each(['route exit','session refresh','role change','local sign-out','expiry'])('retires unconsumed startup data after %s',async change=>{
    vi.useFakeTimers();
    const inScope=session(), downgraded=session('staff');
    downgraded.user.permissions=['overview.read'];
    let stillHome=true;
    const fetchImpl=vi.fn<typeof fetch>()
      .mockImplementationOnce(async()=>Response.json(inScope))
      .mockImplementation(async()=>Response.json(change==='role change'?downgraded:inScope));
    const controller=new AdminSessionController({...config,fetchImpl});
    try {
      await controller.start(()=>stillHome);
      expect(controller.getSnapshot().status).toBe('authenticated');
      if (change==='route exit') stillHome=false;
      if (change==='session refresh' || change==='role change') await controller.refresh();
      if (change==='local sign-out') controller.clearLocalSession();
      if (change==='expiry') await vi.advanceTimersByTimeAsync(10_001);
      expect(controller.takeStartupHome()).toBeNull();
      expect(fetchImpl.mock.calls.map(([,options])=>new Headers(options?.headers).get(homeHeader)))
        .toEqual(change==='session refresh' || change==='role change'?['1',null]:['1']);
    } finally {controller.stop();}
  });

  it('does not publish the old response after the startup request loses its browser session', async()=>{
    let finish!:(response:Response)=>void;
    const fetchImpl=vi.fn<typeof fetch>()
      .mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}))
      .mockImplementation(async()=>Response.json({user:null,expiresAt:null,csrfToken:null,ownerEmail:null}));
    const controller=new AdminSessionController({...config,fetchImpl});
    try {
      const startup=controller.start(()=>true);
      controller.clearLocalSession();
      await controller.refresh();
      finish(Response.json(session()));
      await act(async()=>{await startup;});
      expect(controller.getSnapshot().user).toBeNull();
      expect(controller.takeStartupHome()).toBeNull();
    } finally {controller.stop();}
  });
});
