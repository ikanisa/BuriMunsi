import {webcrypto} from 'node:crypto';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {createMemoryRouter, RouterProvider, useNavigate} from 'react-router';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ProtectedShell} from '../../src/app/SessionRoutes';
import {BuriMunsiPayments} from '../../src/features/operations/BuriMunsiPayments';
import {PENDING_KEY} from '../../src/features/core/pendingAttempt';
import {SessionProvider,useSession} from '../../src/session/SessionProvider';

const config={backend:'supabase',phonePasscodeOnly:true,publishableKey:'sb_publishable_'+'a'.repeat(32),
  captchaEnabled:false,googleEnabled:false} as const;
const now=Date.now();
const time=new Date(now-1000).toISOString();
const paymentRoute='/admin/payments', api='/api/admin/burimunsi/payments';
const group='synthetic-group';
const sessionPath='/api/admin/auth/session';
const oldPayment={id:'first-payment',groupId:group,version:1,direction:'incoming',amountRwf:5000,atRaw:time,
  ftId:'PRIVILEGED-FIXTURE-FIRST',payerNameRaw:'Privileged fixture payer',memberId:null,memberName:null,state:'unallocated',sourceId:null};
const latePayment={...oldPayment,id:'late-payment',ftId:'PRIVILEGED-FIXTURE-LATE',amountRwf:9010};
const newPayment={...oldPayment,id:'new-payment',ftId:'RESTRICTED-FIXTURE',payerNameRaw:'Safe fixture payer',amountRwf:31};
const memberId='synthetic-member';
const who={id:'admin-one',sessionId:'session-one',email:'synthetic-admin@example.test',role:'admin',principalId:'principal-one',
  permissions:['payments.read','sms.read'],assuranceLevel:1,mfaAt:null,authMethod:'phone_passcode',phone:'+250780000001',accountId:'20202020-2020-4020-8020-202020202020',
  passcodeVerifiedAt:time,financialModel:'canonical_evidence_ledger'};
const restricted={...who,role:'staff',permissions:['payments.read']};
const replacement={...restricted,id:'staff-two',sessionId:'session-two',email:'synthetic-staff@example.test',principalId:'principal-two',
  accountId:'10101010-1010-4010-8010-101010101010',phone:'+250780000002'};
const session=(user:object|null, contract?:2)=>Response.json({user,expiresAt:user===null?null:new Date(now+3_600_000).toISOString(),
  csrfToken:user===null?null:'c'.repeat(64),ownerEmail:null,...(contract&&{sessionContract:contract}),
  ...(user===who&&{adminIdentity:{schemaVersion:1,role:'admin',collectionId:group,accountId:who.accountId,adminId:who.id,principalId:who.principalId}})});
const page=(item:typeof oldPayment)=>Response.json({items:[item],totalCount:1,matchingCount:1,offset:0,limit:25,asOf:time,
  missing:0,directionTotalsRwf:{incoming:String(item.amountRwf),outgoing:'0'}});

function holdResponse() {
  let release!:(value:Response)=>void;
  const promise=new Promise<Response>(resolve=>{release=resolve;});
  return {promise,release};
}

function FixtureControls() {
  const auth=useSession(), go=useNavigate();
  return <>
    <button onClick={()=>void auth.refresh()}>Refresh account access</button>
    <button onClick={()=>void auth.signOut()}>End fixture session</button>
    <button onClick={()=>void auth.signInWithPhonePasscode?.(replacement.phone,'1234').then(()=>go(paymentRoute))}>Use restricted fixture</button>
  </>;
}

afterEach(()=>{
  vi.unstubAllGlobals(); sessionStorage.clear(); localStorage.clear();
});

describe('Payments authority changes with a slow privileged response',()=>{
  it.each(['same-session downgrade','confirmed sign-out and replacement session'] as const)('discards old records and allocation custody after %s',async(mode)=>{
    vi.stubGlobal('crypto',webcrypto);
    let live:object|null=who;
    let initial=true, previousRoleReads=0, oldSignal:AbortSignal|null|undefined;
    let allocationKey:string|null=null;
    const held=holdResponse();
    const fetchImpl=vi.fn<typeof fetch>(async(input,init)=>{
      const path=String(input);
      if (path===sessionPath) return session(live);
      if (path==='/api/admin/auth/logout') {live=null; return Response.json({ok:true});}
      if (path==='/api/admin/auth/phone-passcode') {live=replacement; return session(live,2);}
      if (path===api+'/analysis') {
        if (live!==who) return page(newPayment);
        previousRoleReads++;
        if (initial) {initial=false; return page(oldPayment);}
        oldSignal=init?.signal;
        return held.promise; // Deliberately ignore the AbortSignal and deliver the response last.
      }
      if (path===api+'/'+oldPayment.id) return Response.json({...oldPayment,canAllocate:true});
      if (path.startsWith(api+'/members?')) return Response.json({items:[{id:memberId,name:'Synthetic member'}]});
      if (path===api+'/'+oldPayment.id+'/allocate') {
        allocationKey=new Headers(init?.headers).get('Idempotency-Key');
        return Response.json({error:{code:'proxy_outcome_unknown'}},{status:503});
      }
      throw new Error('Unexpected fixture request.');
    });
    const router=createMemoryRouter([
      {path:'/admin',element:<><FixtureControls /><ProtectedShell navigation={[{label:'Payments',path:paymentRoute}]} /></>,
        children:[{path:'payments',element:<BuriMunsiPayments />}]},
      {path:'/admin/login',element:<><h1>Fixture signed out</h1><FixtureControls /></>},
    ],{initialEntries:[paymentRoute]});
    const view=render(<SessionProvider config={{...config,fetchImpl}}><RouterProvider router={router} /></SessionProvider>);
    try {
      fireEvent.click(await screen.findByRole('link',{name:'Unallocated – allocate payment '+oldPayment.ftId}));
      fireEvent.change(await screen.findByRole('combobox',{name:'Member'}),{target:{value:memberId}});
      fireEvent.click(screen.getByRole('button',{name:'Review allocation'}));
      fireEvent.click(screen.getByRole('button',{name:'Confirm allocation'}));
      await screen.findByText(/Allocation was not confirmed/);
      expect(allocationKey).toMatch(/^[0-9a-f-]{36}$/);
      expect(sessionStorage.getItem(PENDING_KEY)).toContain(allocationKey);
      fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
      await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Allocate payment'})).not.toBeInTheDocument());
      expect(screen.queryByRole('region',{name:'Payment details'})).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
      await waitFor(()=>expect(previousRoleReads).toBe(2));

      if (mode==='same-session downgrade') {
        live=restricted;
        fireEvent.click(screen.getByRole('button',{name:'Refresh account access'}));
      } else {
        fireEvent.click(screen.getByRole('button',{name:'End fixture session'}));
        await screen.findByRole('heading',{name:'Fixture signed out'});
        expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
        expect(screen.queryByRole('table',{name:'Payments'})).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button',{name:'Use restricted fixture'}));
      }
      expect(await screen.findByRole('button',{name:newPayment.ftId})).toBeVisible();
      expect(oldSignal?.aborted).toBe(true);
      await act(async()=>{held.release(page(latePayment));});
      expect(screen.queryByText(oldPayment.ftId)).not.toBeInTheDocument();
      expect(screen.queryByText(latePayment.ftId)).not.toBeInTheDocument();
      expect(screen.queryByText('RWF 9,010')).not.toBeInTheDocument();
      expect(screen.getByRole('button',{name:newPayment.ftId})).toBeVisible();
      expect(screen.queryByRole('columnheader',{name:'SMS evidence'})).not.toBeInTheDocument();
      expect(screen.queryByText(allocationKey!)).not.toBeInTheDocument();
      expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
      expect(fetchImpl.mock.calls.filter(([path])=>String(path).endsWith('/allocate'))).toHaveLength(1);
      expect(fetchImpl.mock.calls.filter(([path])=>String(path).endsWith('/allocation-receipt'))).toHaveLength(0);
    } finally {view.unmount();router.dispose();}
  });
});
