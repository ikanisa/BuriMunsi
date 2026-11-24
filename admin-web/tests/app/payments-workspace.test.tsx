import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {Suspense} from 'react';
import {MemoryRouter, useLocation, useNavigate, useRoutes} from 'react-router';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {AdminUser} from '../../src/session/sessionResponses';
import {workspaceRoutes} from '../../src/app/WorkspaceRoutes';
import {canOpenAdminPath} from '../../src/app/route-access';
import {safePaymentListReturn} from '../../src/features/operations/paymentLocations';
import coreFixture from '../core/canonical-core-fixtures.json';
import reconciliationFixture from '../core/canonical-reconciliation-fixture.json';

const mock = vi.hoisted(() => ({request:vi.fn(), permissions:[] as string[], status:'authenticated', role:'admin'}));
const currentActor = reconciliationFixture.detail.current_actor_id;
const momoId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const momoRef = 'MOMO-FIXTURE-01';
const time = '2026-10-18T08:00:00.000Z';
const paymentRef = '100000000123';
const payment = {...coreFixture.transactions.rows[0],payment_reference:paymentRef};
const momo = {id:momoId,receiving_account_id:accountId,provider_transaction_id:momoRef,recipient_name:'Fixture receiver',public_code:'123456',payer_name:'Fixture payer',
  payer_last3:'007',member_name:null,group_name:null,group_id:null,beneficiary_member_id:null,payment_id:null,amount_minor:5000,has_conflict:0,credited_amount_minor:0,
  version:1,currency:'RWF',status:'needs_allocation',transaction_at:time,created_at:time,provider_confirmation:false,settlement_status:'not_asserted'};
const momoPage = {contract_version:1,currency:'RWF',date_basis:'provider_transaction_time',rows:[momo],total:1,offset:0,limit:25,
  totals:{received_minor:5000,credited_minor:0,unallocated_minor:5000},as_of:time};
const emptyOperations = {rows:[],total:0};
const emptyReconciliation = {...reconciliationFixture.queue, rows:[], total:0, next_offset:null};
const sessionUser = () => ({id:currentActor,sessionId:'fixture-session',email:'fixture@example.test',role:mock.role as AdminUser['role'],
  permissions:mock.permissions,principalId:reconciliationFixture.detail.current_principal_id,assuranceLevel:1,mfaAt:null,emailVerifiedAt:null,
  expiresAt:'2030-01-01T00:00:00Z',financialModel:'canonical_evidence_ledger',authMethod:'phone_passcode'} satisfies AdminUser);
vi.mock('../../src/session/SessionProvider',async original => ({
  ...await original<typeof import('../../src/session/SessionProvider')>(),
  useSession:() => ({status:mock.status,epoch:1,user:sessionUser(),request:mock.request,isCurrentAuthority:() => true}),
}));

function RouteHarness() {
  const location = useLocation(), go = useNavigate();
  const route = useRoutes([{path:'/admin',children:workspaceRoutes.map(entry => ({
    ...entry, element:entry.handle(sessionUser()) ? entry.element : <p>Direct route denied</p>,
  }))}]);
  return <><output aria-label="Current location">{location.pathname + location.search}</output>
    <button onClick={() => go(-1)}>Browser back</button><Suspense fallback={<p>Loading fixture route</p>}>{route}</Suspense></>;
}
const visit = (path: string, permissions: string[], role = 'admin') => {
  mock.permissions=permissions;mock.role=role;
  return render(<MemoryRouter initialEntries={[path]}><RouteHarness /></MemoryRouter>);
};
const location = () => screen.getByLabelText('Current location');
const called = (prefix: string) => mock.request.mock.calls.filter(([path]) => path.startsWith(prefix));
afterEach(() => {mock.request.mockReset();mock.status='authenticated';mock.role='admin';});

describe('consolidated Payments routes',()=>{
  it('makes the old payment list a guarded alias and returns through the new list with search preserved',async()=>{
    mock.request.mockImplementation(async (path: string) => path.startsWith('operations/transactions/')
      ? {contract_version:2,model:'canonical_evidence_ledger',resource_type:'transactions',resource:payment,
          current_actor_id:currentActor,can_manage:false,related:{},related_truncated:false}
      : {...coreFixture.transactions,rows:[payment]});
    visit('/admin/transactions?search='+paymentRef,['payments.read']);
    const record = await screen.findByRole('link',{name:paymentRef});
    expect(location()).toHaveTextContent('/admin/payments?search='+paymentRef);
    expect(screen.getByRole('textbox',{name:'Search payments'})).toHaveValue(paymentRef);
    fireEvent.click(record);
    expect(await screen.findByText('Record details')).toBeVisible();
    expect(called('operations/transactions/')[0][0]).toBe('operations/transactions/'+payment.id);
    expect(screen.queryByRole('button',{name:/approve|record payment/i})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Back to payments'}));
    expect(await screen.findByRole('link',{name:paymentRef})).toBeVisible();
    expect(location()).toHaveTextContent('/admin/payments?search='+paymentRef);
  });

  it.each(['/admin/transactions?view=momo','/admin/momo-receipts'])('mounts the same canonical MoMo list through %s',async path=>{
    mock.request.mockImplementation(async (target:string) => target.startsWith('momo/transactions/') ?
      {transaction:momo,sources:[],conflicting_attempt_ids:[]} : momoPage);
    visit(path,['payments.read'],'staff');
    const reference=await screen.findByRole('button',{name:momoRef});
    const records=within(screen.getByRole('region',{name:'MoMo transactions'}));
    expect(records.getAllByRole('columnheader').map(item => item.textContent)).toEqual(['MoMo TX ID','Amount','Status','Time · Kigali']);
    expect(records.getByRole('table')).toHaveClass('operations-receipt-table');
    expect(records.queryByText('Fixture payer')).not.toBeInTheDocument();
    expect(location()).toHaveTextContent('/admin/payments?dataset=momo');
    expect(screen.getByText(/Provider confirmation and settlement are not asserted/)).toBeVisible();
    expect(called('core/transactions')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Search MoMo TX ID or counterparty'),{target:{value:momoRef}});
    fireEvent.click(screen.getByRole('button',{name:'Apply filters'}));
    await waitFor(()=>expect(location()).toHaveTextContent('search='+momoRef));
    fireEvent.click(await screen.findByRole('button',{name:reference.getAttribute('aria-label') ?? momoRef}));
    await waitFor(()=>expect(location()).toHaveTextContent('payment='+momoId));
    await waitFor(()=>expect(called('momo/transactions/').some(([target])=>target==='momo/transactions/'+momoId)).toBe(true));
    expect(await within(screen.getByRole('dialog',{name:'Transaction details'})).findByText('Fixture payer')).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'Browser back'}));
    expect(location()).not.toHaveTextContent('payment=');
    expect(screen.getByLabelText('Search MoMo TX ID or counterparty')).toHaveValue(momoRef);
    expect(screen.queryByText(/Incoming SMS/)).not.toBeInTheDocument();
  });

  it.each([['account','receivers.read'],['group','collections.read']])(
    'does not substitute a broader query for an unavailable %s scope', async (key, permission) => {
      const view=visit('/admin/payments?dataset=momo&'+key+'='+accountId,['payments.read'],'staff');
      expect(await screen.findByText('This filter isn’t available')).toBeVisible();
      expect(mock.request).not.toHaveBeenCalled();
      view.unmount();
      mock.request.mockResolvedValue({...momoPage,rows:[],total:0,
        totals:{received_minor:0,credited_minor:0,unallocated_minor:0}});
      visit('/admin/payments?dataset=momo&'+key+'='+accountId,['payments.read',permission],'staff');
      await waitFor(()=>expect(called('momo/transactions?')).toHaveLength(1));
      const query=new URLSearchParams(called('momo/transactions?')[0][0].split('?')[1]);
      expect(query.get(key==='account'?'receiving_account_id':'group_id')).toBe(accountId);
    });

  it('preserves separate SMS and payment permissions, including direct URL source selection',async()=>{
    mock.request.mockResolvedValue({contractVersion:1,asOf:time,items:[]});
    const sms=visit('/admin/momo-receipts',['sms.read']);
    expect(await screen.findByText('No receiver collections are available for this account.')).toBeVisible();
    expect(screen.queryByRole('link',{name:'Member submitted'})).not.toBeInTheDocument();
    expect(screen.queryByRole('link',{name:'MoMo transactions'})).not.toBeInTheDocument();
    expect(called('momo/observations/collections')).toHaveLength(1);
    expect(called('gateway/receipts')).toHaveLength(0);
    sms.unmount();
    mock.request.mockClear().mockResolvedValue(emptyOperations);
    const payments=visit('/admin/payments?view=sms',['payments.read','sms.read'],'staff');
    expect(await screen.findByText('No records found')).toBeVisible();
    expect(called('gateway/receipts')).toHaveLength(1);
    expect(screen.getByRole('link',{name:'Member receipts'})).toHaveAttribute('aria-current','page');
    expect(screen.queryByRole('link',{name:'SMS & receipts'})).not.toBeInTheDocument();
    expect(screen.queryByRole('link',{name:'Android receiver'})).not.toBeInTheDocument();
    expect(screen.queryByRole('link',{name:'App uploads'})).not.toBeInTheDocument();
    expect(called('momo/observations')).toHaveLength(0);
    payments.unmount();
    mock.request.mockClear();
    visit('/admin/payments?view=sms&source=android',['payments.read','sms.read'],'staff');
    expect(await screen.findByText('Access unavailable')).toBeVisible();
    expect(mock.request).not.toHaveBeenCalled();
  });

  it('opens one source at a time and restores the upload search across ordinary Back',async()=>{
    mock.request.mockImplementation(async (path: string) => path.startsWith('sms/receipts?') ?
      {...emptyOperations,offset:0,limit:25,next_offset:null} : emptyOperations);
    visit('/admin/payments?view=sms&source=app&search=known-receipt',['sms.read','payments.read']);
    expect(await screen.findByText('No matching records')).toBeVisible();
    expect(screen.getByRole('link',{name:'SMS & receipts'})).toHaveAttribute('aria-current','page');
    expect(screen.getByRole('link',{name:'Recorded'})).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link',{name:'App uploads'})).toHaveAttribute('aria-current','page');
    expect(screen.getByRole('link',{name:'Member submitted'})).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('textbox',{name:'Search incoming SMS'})).toHaveValue('known-receipt');
    expect(called('sms/receipts?')[0][0]).toContain('source_kind=capture');
    expect(called('gateway/receipts')).toHaveLength(0);
    fireEvent.click(screen.getByRole('link',{name:'Member submitted'}));
    expect(await screen.findByText('No records found')).toBeVisible();
    expect(called('gateway/receipts')).toHaveLength(1);
    expect(called('momo/observations')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button',{name:'Browser back'}));
    expect(screen.getByRole('textbox',{name:'Search incoming SMS'})).toHaveValue('known-receipt');
    expect(location()).toHaveTextContent('source=app&search=known-receipt');
  });

  it('keeps reconciliation permission independent and starts with exceptions rather than approvals',async()=>{
    mock.request.mockResolvedValue(emptyReconciliation);
    visit('/admin/payments?view=attention',['reconciliations.read']);
    expect(await screen.findByText('Payment evidence exceptions')).toBeVisible();
    expect(screen.queryByRole('link',{name:'Recorded'})).not.toBeInTheDocument();
    expect(screen.queryByRole('link',{name:'SMS & receipts'})).not.toBeInTheDocument();
    await waitFor(()=>expect(called('reconciliations?')).toHaveLength(1));
    expect(new URLSearchParams(called('reconciliations?')[0][0].split('?')[1]).get('status')).toBe('ambiguous');
    fireEvent.change(screen.getByLabelText('Status'),{target:{value:''}});
    await waitFor(()=>expect(location()).toHaveTextContent('view=attention&status=all'));
    expect(called('core/transactions')).toHaveLength(0);
    expect(screen.queryByRole('button',{name:/approve/i})).not.toBeInTheDocument();
  });

  it('preserves all-status reconciliation history through its old link',async()=>{
    mock.request.mockResolvedValue(emptyReconciliation);
    visit('/admin/reconciliations?search=fixture',['reconciliations.read']);
    expect(await screen.findByText('Payment evidence exceptions')).toBeVisible();
    await waitFor(()=>expect(called('reconciliations?')).toHaveLength(1));
    expect(location()).toHaveTextContent('/admin/payments?view=attention&status=all&search=fixture');
    const query = new URLSearchParams(called('reconciliations?')[0][0].split('?')[1]);
    expect(query.get('status')).toBe('');
    expect(query.get('search')).toBe('fixture');
  });

  it('retains old route gates and only allows appropriate canonical return paths',()=>{
    mock.permissions=['sms.read'];
    expect(canOpenAdminPath('/admin/payments',sessionUser())).toBe(true);
    expect(canOpenAdminPath('/admin/transactions',sessionUser())).toBe(false);
    expect(canOpenAdminPath('/admin/transactions/'+payment.id,sessionUser())).toBe(false);
    expect(canOpenAdminPath('/admin/member-receipts/'+momoId,sessionUser())).toBe(false);
    expect(canOpenAdminPath('/admin/sms-receipts/capture/'+momoId,sessionUser())).toBe(true);
    expect(safePaymentListReturn('/admin/payments?view=sms&source=app&search=fixture','sms','app')).toBeTruthy();
    for (const target of ['/admin/payments?view=sms&source=member','/admin/payments?view=sms&source=app&source=member',
      '/admin/payments?view=sms&source=app&returnTo=%2Felsewhere','//admin.invalid/admin/payments?view=sms&source=app']) {
      expect(safePaymentListReturn(target,'sms','app')).toBeNull();
    }
  });
  it('keeps Staff financial details while hiding lineage from a retained full response',async()=>{
    const smsId='33333333-3333-4333-8333-333333333333';
    mock.request.mockImplementation(async (path: string) => path.startsWith('momo/transactions?') ? momoPage :
      {transaction:momo,sources:[{raw_sms_id:smsId,relation:'accepted',outcome:'accepted',parser_version:'synthetic.v1',created_at:time}]});
    visit('/admin/payments?dataset=momo',['payments.read','sms.read','gateway.read','assisted_sms.read'],'staff');
    fireEvent.click(await screen.findByRole('button',{name:momoRef}));
    const detail = within(await screen.findByRole('dialog',{name:'Transaction details'}));
    await detail.findByText(momoRef);
    expect(detail.getByText('RWF 5,000')).toBeVisible();
    expect(detail.queryByText(smsId)).not.toBeInTheDocument();
    expect(detail.queryByRole('heading',{name:'Source and processing history'})).not.toBeInTheDocument();
    expect(called('momo/transactions/')[0][0]).toBe('momo/transactions/'+momo.id);
    for (const path of ['/admin/sms-receipts','/admin/sms-receipts/capture/'+smsId,'/admin/gateway','/admin/notification-operator']) {
      expect(canOpenAdminPath(path,sessionUser())).toBe(false);
    }
  });
  it('fences a direct workspace with no relevant permission without fetching records',async()=>{
    visit('/admin/payments?view=sms&source=member',[]);
    expect(await screen.findByText('Direct route denied')).toBeVisible();
    await act(async()=>{});
    expect(mock.request).not.toHaveBeenCalled();
  });
});
