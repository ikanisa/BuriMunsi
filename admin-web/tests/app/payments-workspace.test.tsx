import {webcrypto} from 'node:crypto';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {Suspense} from 'react';
import {MemoryRouter, useLocation, useNavigate, useRoutes} from 'react-router';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {AdminUser} from '../../src/session/sessionResponses';
import {workspaceRoutes} from '../../src/app/WorkspaceRoutes';
import {canOpenAdminPath} from '../../src/app/route-access';
import {safePaymentListReturn} from '../../src/features/operations/paymentLocations';
import {AdminTransportError} from '../../src/api/contracts';
import coreFixture from '../core/canonical-core-fixtures.json';
import reconciliationFixture from '../core/canonical-reconciliation-fixture.json';

const mock = vi.hoisted(() => ({request:vi.fn(), permissions:[] as string[], status:'authenticated', role:'admin',
  authMethod:undefined as AdminUser['authMethod'], scoped:false}));
const currentActor = reconciliationFixture.detail.current_actor_id;
const currentPrincipal = reconciliationFixture.detail.current_principal_id;
const momoId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const momoRef = 'MOMO-FIXTURE-01';
const time = '2026-10-18T08:00:00.000Z';
const isCurrentAuthority = () => true;
const buriPayment = {id:momoId,groupId:'fixture-group',version:1,direction:'incoming',amountRwf:5000,atRaw:time,ftId:momoRef,
  payerNameRaw:'Fixture payer',payerPhoneRaw:'000071',memberId:null,memberName:null,memberPhone:null,state:'unallocated',sourceId:null};
const outgoing = {...buriPayment,id:accountId,direction:'outgoing',ftId:'MOMO-OUT-FIXTURE',
  state:'allocated',memberId:currentActor,memberName:'Fixture member'};
const buriPage = (items: object[]) => ({items,totalCount:items.length,offset:0,limit:100,nextOffset:null,asOf:time});
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
  permissions:mock.permissions,principalId:currentPrincipal,assuranceLevel:1,mfaAt:null,emailVerifiedAt:null,
  expiresAt:'2030-01-01T00:00:00Z',financialModel:'canonical_evidence_ledger',authMethod:mock.authMethod,
  ...(mock.scoped ? {accountId,adminIdentity:{schemaVersion:1,role:'admin',accountId,adminId:currentActor,principalId:currentPrincipal,
    collectionId:'fixture-group'}} : {})} satisfies AdminUser);
vi.mock('../../src/session/SessionProvider',async original => ({
  ...await original<typeof import('../../src/session/SessionProvider')>(),
  useSession:() => ({status:mock.status,epoch:1,user:sessionUser(),request:mock.request,isCurrentAuthority}),
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
afterEach(() => {mock.request.mockReset();mock.status='authenticated';mock.role='admin';mock.authMethod=undefined;mock.scoped=false;});

describe('consolidated Payments routes',()=>{
  it('makes the old payment list a guarded alias and returns through the new list with search preserved',async()=>{
    mock.request.mockImplementation(async (path: string) => path.startsWith('operations/transactions/')
      ? {contract_version:2,model:'canonical_evidence_ledger',resource_type:'transactions',resource:payment,
          current_actor_id:currentActor,can_manage:false,related:{},related_truncated:false}
      : {...coreFixture.transactions,rows:[payment]});
    visit('/admin/transactions?search='+paymentRef,['payments.read']);
    const record = await screen.findByRole('link',{name:paymentRef}, {timeout:5000});
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
    mock.authMethod = 'phone_passcode';
    mock.request.mockResolvedValue({contractVersion:1,asOf:time,items:[]});
    const sms=visit('/admin/payments?view=sms&source=android',['sms.read']);
    expect(await screen.findByText('No receiver collections are available for this account.')).toBeVisible();
    expect(screen.queryByRole('link',{name:'Member submitted'})).not.toBeInTheDocument();
    expect(screen.queryByRole('link',{name:'MoMo transactions'})).not.toBeInTheDocument();
    expect(called('momo/observations/collections')).toHaveLength(1);
    expect(called('gateway/receipts')).toHaveLength(0);
    sms.unmount();
    mock.authMethod = undefined;
    mock.request.mockClear().mockResolvedValue(emptyOperations);
    const payments=visit('/admin/payments?view=sms',['payments.read','sms.read'],'staff');
    expect(await screen.findByText('No records found')).toBeVisible();
    expect(called('gateway/receipts')).toHaveLength(1);
    expect(screen.getByRole('link',{name:'Member receipts'})).toHaveAttribute('aria-current','page');
    expect(screen.queryByRole('link',{name:'SMS & receipts'})).not.toBeInTheDocument();
    expect(screen.queryByRole('link',{name:'Android receiver'})).not.toBeInTheDocument();
    expect(screen.queryByRole('link',{name:'App uploads'})).not.toBeInTheDocument();
    expect(called('momo/observations')).toHaveLength(0);
    expect(canOpenAdminPath('/admin/member-receipts',sessionUser())).toBe(true);
    expect(canOpenAdminPath('/admin/member-receipts/'+momoId,sessionUser())).toBe(true);
    payments.unmount();
    mock.request.mockClear();
    visit('/admin/payments?view=sms&source=android',['payments.read','sms.read'],'staff');
    expect(await screen.findByText('Access unavailable')).toBeVisible();
    expect(mock.request).not.toHaveBeenCalled();
  });

  it.each([
    {role:'staff', permissions:['payments.read'], allowed:false},
    {role:'staff', permissions:['payments.read','sms.read'], allowed:false},
    {role:'admin', permissions:['payments.read'], allowed:false},
    {role:'admin', permissions:['payments.read','sms.read'], allowed:true},
  ])('aligns phone $role receipt links and deep links with the server ($permissions)', async ({role,permissions,allowed}) => {
    mock.authMethod = 'phone_passcode';
    mock.request.mockResolvedValue(buriPage([buriPayment]));
    const recorded=visit('/admin/payments',permissions,role);
    expect(await screen.findByRole('button',{name:momoRef})).toBeVisible();
    expect(screen.queryByRole('link',{name:'Member receipts'})).not.toBeInTheDocument();
    expect(Boolean(screen.queryByRole('button',{name:'M-Money SMS'}))).toBe(allowed);
    recorded.unmount();
    mock.request.mockClear();
    const compact=visit('/admin/payments?view=sms&source=member',permissions,role);
    expect(await screen.findByText('Payment view unavailable')).toBeVisible();
    expect(mock.request).not.toHaveBeenCalled();
    compact.unmount();
    const bookmarks=['/admin/member-receipts','/admin/member-receipts/'+momoId];
    for (const path of bookmarks) {
      expect(canOpenAdminPath(path,sessionUser())).toBe(false);
      mock.request.mockClear();
      const bookmark=visit(path,permissions,role);
      expect(screen.getByText('Direct route denied')).toBeVisible();
      expect(mock.request).not.toHaveBeenCalled();
      bookmark.unmount();
    }
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

describe('BuriMunsi phone Payments', () => {
  it('shows both directions together and links recent Home payments to the same workspace', async () => {
    mock.authMethod = 'phone_passcode';
    mock.request.mockImplementation(async (path: string) => path === 'burimunsi/home'
      ? {paymentCount:2,memberCount:5,unallocatedCount:1,recentPayments:[buriPayment,outgoing],asOf:time}
      : buriPage([buriPayment,outgoing]));
    visit('/admin', ['overview.read','payments.read','reconciliations.read','ledger.read','sms.read'], 'staff');
    expect(await screen.findByRole('heading',{name:'Recent payments'})).toBeVisible();
    expect(screen.getByText('Incoming')).toBeVisible();
    expect(screen.getByText('Outgoing')).toBeVisible();
    expect(screen.queryByRole('link',{name:'M-Money SMS'})).not.toBeInTheDocument();
    expect(called('momo/observations')).toHaveLength(0);
    fireEvent.click(screen.getByRole('link',{name:'View all payments'}));
    expect(await screen.findByRole('button',{name:'MOMO-OUT-FIXTURE'})).toBeVisible();
    expect(screen.getAllByRole('columnheader')).toHaveLength(7);
    expect(screen.getByRole('columnheader',{name:'Member number'})).toBeVisible();
    expect(screen.getByRole('columnheader',{name:'Member'})).toBeVisible();
    const outgoingRow = within(screen.getByRole('row',{name:/MOMO-OUT-FIXTURE/}));
    expect(outgoingRow.getByText('Fixture member')).toBeVisible();
    expect(outgoingRow.getByText('000071')).toBeVisible();
    expect(screen.queryByRole('columnheader',{name:/Counterparty|Member phone/})).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader',{name:'SMS evidence'})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Filter Allocation'}));
    const filters = within(screen.getByRole('dialog',{name:'Filter Allocation'}));
    expect(filters.getByRole('checkbox',{name:'Allocated'})).not.toBeChecked();
    expect(filters.getByRole('checkbox',{name:'Unallocated'})).not.toBeChecked();
    expect(called('core/overview')).toHaveLength(0);
    expect(canOpenAdminPath('/admin/ledgers',sessionUser())).toBe(false);
    expect(canOpenAdminPath('/admin/reconciliations',sessionUser())).toBe(false);
  });

  it('opens an old offset bookmark, sorts the complete set and opens a record from the last fetched page', async () => {
    mock.authMethod = 'phone_passcode';
    const rows = Array.from({length:105}, (_, i) => ({...buriPayment,id:'pay-' + i,ftId:'FT-' + i,amountRwf:105-i}));
    mock.request.mockImplementation(async (path: string) => {
      if (path === 'burimunsi/payments/pay-104') return rows[104];
      const offset = Number(new URLSearchParams(path.split('?')[1]).get('offset'));
      return {...buriPage(rows.slice(offset,offset+100)),offset,totalCount:rows.length,nextOffset:offset === 0 ? 100 : null};
    });
    visit('/admin/payments?offset=25',['payments.read'],'staff');
    expect(await screen.findByRole('button',{name:'FT-25'})).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'Sort Amount (RWF) ascending'}));
    fireEvent.click(await screen.findByRole('button',{name:'FT-104'}));
    const detail = within(await screen.findByRole('region',{name:'Payment details'}));
    expect(await detail.findByText('pay-104')).toBeVisible();
    expect(called('burimunsi/payments?').map(([path]) => path)).toEqual([
      'burimunsi/payments?limit=100&offset=0', 'burimunsi/payments?limit=100&offset=100',
    ]);
  });

  it('loads the scoped Admin SMS health independently of Home payments', async () => {
    mock.authMethod = 'phone_passcode';
    mock.scoped = true;
    let resolveHealth!: (value: unknown) => void;
    const health = new Promise(resolve => { resolveHealth = resolve; });
    mock.request.mockImplementation(async (path: string) => path === 'burimunsi/home'
      ? {paymentCount:1,memberCount:5,unallocatedCount:1,recentPayments:[buriPayment],asOf:time}
      : health);
    visit('/admin', ['overview.read','payments.read','sms.read']);
    expect(await screen.findByRole('heading',{name:'Recent payments'})).toBeVisible();
    expect(screen.getByText('Checking sync')).toBeVisible();
    expect(called('momo/observations').map(([path]) => path)).toEqual([
      'momo/observations?collectionId=fixture-group&limit=1&includeProcessing=1',
    ]);
    await act(async () => resolveHealth({contractVersion:1,collectionId:'fixture-group',nextCursor:null,asOf:time,items:[],
      inboxCheck:{state:'verified',checkedAt:time,candidateCount:0,missingCount:0,pendingCount:0,headsMatch:true}}));
    expect(screen.getByText('Last inbox check matched')).toBeVisible();
    expect(screen.getByRole('link',{name:'M-Money SMS'})).toHaveAttribute('href','/admin/payments?view=sms');
  });

  it.each([
    {payerStatus:'delivered', payerReason:null, label:'Reported delivered', reason:null},
    {payerStatus:'suppressed', payerReason:'preferences_disabled', label:'Suppressed', reason:'Payer opted out'},
    {payerStatus:null, payerReason:null, label:'No receipt recorded', reason:null},
  ])('opens the exact collection-bound linked SMS and shows its recorded outcome “$label” inline', async ({payerStatus,payerReason,label,reason}) => {
    mock.authMethod = 'phone_passcode';
    mock.scoped = true;
    const linked = {...buriPayment,sourceId:accountId};
    const evidence = (id: string, processing: string) => ({requestId:id,sourceId:id,admittedAt:time,retentionState:'retained',
      bodySha256:'a'.repeat(64),processing,paymentReference:null,payerStatus:null,payerReason:null});
    mock.request.mockImplementation(async (path: string) => {
      if (path.startsWith('burimunsi/payments?')) return buriPage([linked]);
      if (path === 'burimunsi/payments/'+momoId) return linked;
      if (path === 'momo/observations/collections') return {contractVersion:1,asOf:time,items:[]};
      const search = new URLSearchParams(path.split('?')[1]);
      if (path.startsWith('momo/observations?') && search.get('collectionId') === 'fixture-group') {
        const second = search.get('cursor') === 'next';
        return {contractVersion:1,collectionId:'fixture-group',asOf:time,nextCursor:second ? null : 'next',
          inboxCheck:{state:'unknown',checkedAt:null,candidateCount:null,missingCount:null,pendingCount:null,headsMatch:null},
          items:[second ? {...evidence(accountId,'parsed'),payerStatus,payerReason}
            : {...evidence(momoId,'held'),payerStatus:'failed',payerReason:'gateway_failed'}]};
      }
      throw new Error('Unexpected request');
    });
    visit('/admin/payments',['payments.read','sms.read']);
    expect(await screen.findByRole('button',{name:'Review linked SMS'})).toBeVisible();
    expect(called('momo/observations')).toHaveLength(0);
    expect(screen.getByRole('button',{name:'M-Money SMS'})).toHaveAttribute('aria-expanded','false');
    fireEvent.click(screen.getByRole('button',{name:'Review linked SMS'}));
    const evidenceRegion = within(await screen.findByRole('region',{name:'Linked SMS'}));
    expect(await evidenceRegion.findByText('Parsed')).toBeVisible();
    const payer = evidenceRegion.getByText('Payer SMS',{selector:'dt'}).nextElementSibling!;
    expect(payer).toHaveTextContent(label);
    if (reason) expect(payer).toHaveTextContent(reason);
    expect(evidenceRegion.queryByText('Gateway failed')).not.toBeInTheDocument();
    expect(evidenceRegion.queryByText('Held for review')).not.toBeInTheDocument();
    expect(called('momo/observations').map(([path]) => path)).toEqual([
      'momo/observations?collectionId=fixture-group&limit=25&includeProcessing=1',
      'momo/observations?collectionId=fixture-group&limit=25&includeProcessing=1&cursor=next',
    ]);
    fireEvent.click(screen.getByRole('button',{name:'M-Money SMS'}));
    expect(screen.queryByRole('region',{name:'Payment details'})).not.toBeInTheDocument();
    expect(await screen.findByText('No receiver collections are available for this account.')).toBeVisible();
  });

  it('keeps the allocation intent after an uncertain response and updates the same payment', async () => {
    mock.authMethod = 'phone_passcode';
    Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
    sessionStorage.clear();
    const changed = {...buriPayment,version:2,memberId:accountId,memberName:'Group member',state:'allocated'};
    let applied = false, attempts = 0;
    mock.request.mockImplementation(async (path: string) => {
      if (path.startsWith('burimunsi/payments/members?')) return {items:[{id:accountId,name:'Group member'}]};
      if (path.endsWith('/allocate')) {
        attempts++;
        if (attempts === 1) throw new AdminTransportError('Response unavailable');
        applied = true;
        return {paymentId:momoId,memberId:accountId,state:'allocated',version:2};
      }
      return path.endsWith(momoId) ? {...(applied ? changed : buriPayment),canAllocate:true}
        : {...buriPage([applied ? changed : buriPayment]),canAllocate:true};
    });
    visit('/admin/payments',['payments.read'],'staff');
    fireEvent.click(await screen.findByRole('link',{name:'Unallocated – allocate payment ' + momoRef}));
    expect(location()).toHaveTextContent('allocate=' + momoId);
    const dialog = within(await screen.findByRole('dialog',{name:'Allocate payment'}));
    fireEvent.change(await dialog.findByLabelText('Member'),{target:{value:accountId}});
    fireEvent.click(dialog.getByRole('button',{name:'Review allocation'}));
    expect(dialog.getByRole('heading',{name:'Review allocation'})).toBeVisible();
    expect(attempts).toBe(0);
    fireEvent.click(dialog.getByRole('button',{name:'Confirm allocation'}));
    fireEvent.click(await dialog.findByRole('button',{name:'Retry allocation'}));
    await waitFor(() => expect(screen.queryByRole('dialog',{name:'Allocate payment'})).not.toBeInTheDocument());
    const row = within(await screen.findByRole('row',{name:/MOMO-FIXTURE-01.*Group member/}));
    expect(row.getByText('Allocated')).toBeVisible();
    expect(location()).not.toHaveTextContent('allocate=');
    const writes = mock.request.mock.calls.filter(([path]) => path.endsWith('/allocate'));
    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual(writes[1]);
    expect(writes[0][1]).toMatchObject({method:'POST',body:{memberId:accountId,expectedVersion:1},idempotencyKey:expect.any(String)});
  });
});
