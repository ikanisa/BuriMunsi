import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {Suspense} from 'react';
import {MemoryRouter, useLocation, useNavigate, useRoutes} from 'react-router';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {AdminUser} from '../../src/session/sessionResponses';
import {workspaceRoutes} from '../../src/app/WorkspaceRoutes';
import {canOpenAdminPath} from '../../src/app/route-access';
import {safePaymentListReturn} from '../../src/features/operations/paymentLocations';
import {AdminRequestError, AdminTransportError} from '../../src/api/contracts';
import {ReceiverSmsPanel} from '../../src/features/operations/ReceiverSmsPanel';
import {BuriMunsiHome} from '../../src/features/overview/BuriMunsiHome';
import {analyzeCanonicalPaymentRows, type PaymentAnalysisQuery} from '../../../supabase/functions/_shared/domain/burimunsi/payment-analysis-shared.mjs';
import coreFixture from '../core/canonical-core-fixtures.json';
import reconciliationFixture from '../core/canonical-reconciliation-fixture.json';

const mock = vi.hoisted(() => ({request:vi.fn(), permissions:[] as string[], status:'authenticated', role:'admin',
  authMethod:undefined as AdminUser['authMethod'], scoped:false, sessionId:'fixture-session', currentAuthority: true}));
const currentActor = reconciliationFixture.detail.current_actor_id;
const currentPrincipal = reconciliationFixture.detail.current_principal_id;
const momoId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const momoRef = 'MOMO-FIXTURE-01';
const time = '2026-10-18T08:00:00.000Z';
const buriPayment = {id:momoId,groupId:'fixture-group',version:1,direction:'incoming',amountRwf:5000,atRaw:time,ftId:momoRef,
  payerNameRaw:'Fixture payer',payerPhoneRaw:'000071',memberId:null,memberName:null,memberPhone:null,state:'unallocated',
  sourceId:null as string|null,canAllocate:false};
const outgoing = {...buriPayment,id:accountId,direction:'outgoing',ftId:'MOMO-OUT-FIXTURE',
  state:'allocated',memberId:currentActor,memberName:'Fixture member'};
const query99:PaymentAnalysisQuery={q:'',filters:[],sort:{key:'time',direction:'desc'},offset:0,limit:25};
const buriPage = (items: (typeof buriPayment|typeof outgoing)[], query:PaymentAnalysisQuery=query99) => {
  const matching=analyzeCanonicalPaymentRows(items,query.filters,query.sort,mock.role==='admin');
  const totals={incoming:0n,outgoing:0n};
  for (const item of matching) totals[item.direction as 'incoming'|'outgoing']+=BigInt(item.amountRwf);
  return {items:matching.slice(query.offset,query.offset+25),totalCount:items.length,matchingCount:matching.length,offset:query.offset,limit:25,
    missing:0,directionTotalsRwf:{incoming:String(totals.incoming),outgoing:String(totals.outgoing)},asOf:time};
};
const paymentRef = '100000000123';
const payment = {...coreFixture.transactions.rows[0],payment_reference:paymentRef};
const momo = {id:momoId,receiving_account_id:accountId,provider_transaction_id:momoRef,recipient_name:'Fixture receiver',public_code:'123456',payer_name:'Fixture payer',
  payer_last3:'007',member_name:null,group_name:null,group_id:null,beneficiary_member_id:null,payment_id:null,amount_minor:5000,has_conflict:0,credited_amount_minor:0,
  version:1,currency:'RWF',status:'needs_allocation',transaction_at:time,created_at:time,provider_confirmation:false,settlement_status:'not_asserted'};
const momoPage = {contract_version:1,currency:'RWF',date_basis:'provider_transaction_time',rows:[momo],total:1,offset:0,limit:25,
  totals:{received_minor:5000,credited_minor:0,unallocated_minor:5000},as_of:time};
const emptyOperations = {rows:[],total:0};
const emptyReconciliation = {...reconciliationFixture.queue, rows:[], total:0, next_offset:null};
const sessionUser = () => ({id:currentActor,sessionId:mock.sessionId,email:'fixture@example.test',role:mock.role as AdminUser['role'],
  permissions:mock.permissions,principalId:currentPrincipal,assuranceLevel:1,mfaAt:null,emailVerifiedAt:null,
  expiresAt:'2030-01-01T00:00:00Z',financialModel:'canonical_evidence_ledger',authMethod:mock.authMethod,
  ...(mock.scoped ? {accountId,adminIdentity:{schemaVersion:1,role:'admin',accountId,adminId:currentActor,principalId:currentPrincipal,
    collectionId:'fixture-group'}} : {})} satisfies AdminUser);
const isCurrentAuthority = () => mock.currentAuthority;
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
afterEach(() => {mock.request.mockReset();mock.status='authenticated';mock.role='admin';mock.authMethod=undefined;mock.scoped=false;mock.sessionId='fixture-session';mock.currentAuthority=true;sessionStorage.clear();});

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
  it('shows cumulative incoming and outgoing plus the latest authorized SMS balance, including real zero', async () => {
    mock.authMethod = 'phone_passcode';
    mock.request.mockResolvedValue({paymentCount:2,memberCount:5,unallocatedCount:1,recentPayments:[buriPayment,outgoing],asOf:time,
      paymentTotals:{incomingRwf:'9007199254740993',outgoingRwf:'5000',latestSmsBalanceRwf:0}});
    const admin = visit('/admin', ['overview.read','payments.read','sms.read']);
    expect(await screen.findByRole('link',{name:/Cumulative incoming payments.*RWF 9,007,199,254,740,993/}))
      .toHaveAttribute('href','/admin/payments?direction=incoming');
    expect(screen.getByRole('link',{name:/Cumulative outgoing payments.*RWF 5,000/}))
      .toHaveAttribute('href','/admin/payments?direction=outgoing');
    expect(screen.getByText('Latest MoMo SMS balance',{selector:'dt span'}).closest('dl')).toHaveTextContent('RWF 0');
    admin.unmount();
    visit('/admin', ['overview.read','payments.read','sms.read'], 'staff');
    expect(await screen.findByText('Cumulative incoming payments')).toBeVisible();
    expect(screen.queryByText('Latest MoMo SMS balance')).not.toBeInTheDocument();
  });

  it('keeps unknown SMS balance distinct from zero cumulative movements', async () => {
    mock.authMethod = 'phone_passcode';
    mock.request.mockResolvedValue({paymentCount:0,memberCount:0,unallocatedCount:0,recentPayments:[],asOf:time,
      paymentTotals:{incomingRwf:'0',outgoingRwf:'0',latestSmsBalanceRwf:null}});
    visit('/admin', ['overview.read','payments.read','sms.read']);
    expect(await screen.findByRole('link',{name:/Cumulative incoming payments.*RWF 0/})).toBeVisible();
    expect(await screen.findByText('Unavailable',{selector:'dd'})).toBeVisible();
  });

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
    expect(screen.getByRole('columnheader',{name:'Member'})).toBeVisible();
    expect(screen.getByRole('columnheader',{name:'Member phone',exact:true})).toBeVisible();
    expect(screen.getAllByRole('columnheader')).toHaveLength(7);
    expect(screen.queryByRole('columnheader',{name:/Counterparty|Member number/})).not.toBeInTheDocument();
    expect(within(screen.getByRole('row',{name:/MOMO-FIXTURE-01/})).getByText('Fixture payer')).toBeVisible();
    expect(within(screen.getByRole('row',{name:/MOMO-OUT-FIXTURE/})).getByText('000071')).toBeVisible();
    expect(screen.queryByRole('link',{name:/Unallocated.*allocate payment/})).not.toBeInTheDocument();
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
    mock.request.mockImplementation(async (path: string, options: {body:PaymentAnalysisQuery}) => {
      if (path === 'burimunsi/payments/pay-104') return rows[104];
      return buriPage(rows,options.body);
    });
    visit('/admin/payments?offset=25',['payments.read'],'staff');
    expect(await screen.findByRole('button',{name:'FT-25'})).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'Sort Amount ascending'}));
    fireEvent.click(await screen.findByRole('button',{name:'FT-104'}));
    const detail = within(await screen.findByRole('region',{name:'Payment details'}));
    expect(await detail.findByText('pay-104')).toBeVisible();
    expect(called('burimunsi/payments/analysis').map(([,options]) => [options.method,options.body.offset,options.body.sort])).toEqual([
      ['POST',25,{key:'time',direction:'desc'}], ['POST',0,{key:'amount',direction:'asc'}],
    ]);
    expect(screen.getByRole('region',{name:'Totals for matching payments'})).toHaveTextContent('RWF 5,565');
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

  it('ages Home inbox proof from server time and request start, preserves prior time on failure, and rejects replay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T07:15:00.000Z')); // Browser intentionally differs from server.
    mock.authMethod='phone_passcode'; mock.scoped=true; mock.permissions=['overview.read','payments.read','sms.read'];
    const base={contractVersion:1,collectionId:'fixture-group',nextCursor:null,asOf:'2026-10-18T08:04:58.000Z',items:[],
      inboxCheck:{state:'verified',checkedAt:time,candidateCount:0,missingCount:0,pendingCount:0,headsMatch:true}};
    let resolveOld!:(value:unknown)=>void;
    let response:()=>Promise<unknown>=()=>new Promise(resolve=>{resolveOld=resolve;});
    const home={paymentCount:1,memberCount:5,unallocatedCount:1,recentPayments:[buriPayment],asOf:time};
    mock.request.mockImplementation((path:string)=>path==='burimunsi/home' ? Promise.resolve(home):response());
    const view=render(<MemoryRouter><BuriMunsiHome /></MemoryRouter>);
    const refresh=()=>act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh Home'})));
    try {
      await act(async()=>{});
      expect(screen.getByText('Checking sync')).toBeVisible();
      await act(async()=>{await vi.advanceTimersByTimeAsync(2000);resolveOld(base);});
      expect(screen.getByText('Last inbox check is out of date')).toBeVisible();
      expect(view.container.querySelector('time')).toHaveAttribute('dateTime',time);
      expect(screen.queryByText('Last inbox check matched')).not.toBeInTheDocument();

      response=async()=>{throw new AdminTransportError('Network interruption');};
      await refresh();
      expect(screen.getByText('Inbox status unavailable')).toBeVisible();
      expect(view.container.querySelector('time')).toHaveAttribute('dateTime',time);

      response=async()=>({...base,asOf:time}); // Same proof must not be renewed after failure.
      await refresh();
      expect(screen.getByText('Last inbox check is out of date')).toBeVisible();
      expect(screen.queryByText('Last inbox check matched')).not.toBeInTheDocument();

      const next='2026-10-18T08:05:01.000Z';
      response=async()=>({...base,asOf:next,inboxCheck:{...base.inboxCheck,checkedAt:next}});
      await refresh();
      expect(screen.getByText('Last inbox check matched')).toBeVisible();
      expect(view.container.querySelector('time')).toHaveAttribute('dateTime',next);
      // Simulate a browser which resumes before its scheduled timeout fires.
      vi.setSystemTime(Date.now()+300_000);
      await act(async()=>window.dispatchEvent(new Event('pageshow')));
      expect(screen.getByText('Last inbox check is out of date')).toBeVisible();
      expect(screen.getByRole('status')).not.toHaveTextContent(/offline/i);
      vi.setSystemTime(Date.now()-300_000);
      await act(async()=>window.dispatchEvent(new Event('focus')));
      expect(screen.getByText('Last inbox check is out of date')).toBeVisible();
    } finally {view.unmount();vi.useRealTimers();}
  });

  it('expires the same server proof simultaneously on Home and SMS and keeps it expired after reload',async()=>{
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T06:00:00.000Z'));
    mock.authMethod='phone_passcode';mock.scoped=true;mock.permissions=['overview.read','payments.read','sms.read'];
    let asOf='2026-10-18T08:04:59.999Z', checkedAt=time;
    const groupId='fixture-group';
    mock.request.mockImplementation(async(path:string)=>{
      if(path==='burimunsi/home')return {paymentCount:1,memberCount:5,unallocatedCount:1,recentPayments:[buriPayment],asOf};
      if(path==='momo/observations/collections')return {contractVersion:1,asOf,items:[{collectionId:groupId,label:'Fixture group'}]};
      return {contractVersion:1,collectionId:groupId,nextCursor:null,asOf,items:[],
        inboxCheck:{state:'verified',checkedAt,candidateCount:0,missingCount:0,pendingCount:0,headsMatch:true}};
    });
    const renderBoth=()=>render(<MemoryRouter><BuriMunsiHome /><ReceiverSmsPanel simplePayments /></MemoryRouter>);
    let view=renderBoth();
    const inbox=()=>within(screen.getByRole('region',{name:'Inbox completeness'})).getByRole('status');
    try {
      await act(async()=>{});
      expect(screen.getByText('Last inbox check matched')).toBeVisible();
      expect(inbox()).toHaveTextContent(/inboxes matched/i);
      await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
      expect(screen.getByText('Last inbox check is out of date')).toBeVisible();
      expect(inbox()).toHaveTextContent(/out of date/i);
      view.unmount();
      asOf='2026-10-18T08:05:00.000Z'; // Same proof, served again after browser reload.
      view=renderBoth();
      await act(async()=>{});
      expect(screen.getByText('Last inbox check is out of date')).toBeVisible();
      expect(inbox()).toHaveTextContent(/out of date/i);
      const newest='2026-10-18T08:05:01.000Z';
      asOf=newest;checkedAt=newest;
      await act(async()=>{
        fireEvent.click(screen.getByRole('button',{name:'Refresh Home'}));
        window.dispatchEvent(new CustomEvent('burimunsi-operations-changed',{detail:{collectionId:groupId}}));
      });
      expect(screen.getByText('Last inbox check matched')).toBeVisible();
      expect(inbox()).toHaveTextContent(/inboxes matched/i);
    } finally {view.unmount();vi.useRealTimers();}
  });

  it('hides Home SMS health immediately on permission loss and waits for a new read on regrant', async () => {
    mock.authMethod='phone_passcode'; mock.scoped=true; mock.permissions=['overview.read','payments.read','sms.read'];
    const base={contractVersion:1,collectionId:'fixture-group',nextCursor:null,asOf:time,items:[],
      inboxCheck:{state:'verified',checkedAt:time,candidateCount:0,missingCount:0,pendingCount:0,headsMatch:true}};
    let finish!:(value:unknown)=>void, healthReads=0;
    mock.request.mockImplementation(async(path:string)=>path==='burimunsi/home' ?
      {paymentCount:1,memberCount:5,unallocatedCount:1,recentPayments:[buriPayment],asOf:time} :
      ++healthReads===1 ? base : new Promise(resolve=>{finish=resolve;}));
    const view=render(<MemoryRouter><BuriMunsiHome /></MemoryRouter>);
    expect(await screen.findByText('Last inbox check matched')).toBeVisible();
    mock.permissions=['overview.read','payments.read'];
    view.rerender(<MemoryRouter><BuriMunsiHome /></MemoryRouter>);
    expect(screen.queryByRole('link',{name:'M-Money SMS'})).not.toBeInTheDocument();
    mock.permissions=['overview.read','payments.read','sms.read'];
    view.rerender(<MemoryRouter><BuriMunsiHome /></MemoryRouter>);
    expect(screen.getByText('Checking sync')).toBeVisible();
    expect(screen.queryByText('Last inbox check matched')).not.toBeInTheDocument();
    await act(async()=>finish({...base,inboxCheck:{state:'unknown',checkedAt:null,candidateCount:null,missingCount:null,pendingCount:null,headsMatch:null}}));
    expect(screen.getByText('Inbox status unknown')).toBeVisible();
  });

  const evidencePath = (id:string) => 'burimunsi/payments/'+id+'/sms-evidence';
  const evidence = (sourceId: string, processing = 'parsed') => ({requestId:sourceId,sourceId,admittedAt:time,retentionState:'retained',
    bodySha256:'a'.repeat(64),processing,paymentReference:null,payerStatus:null,payerReason:null});
  const linked = {...buriPayment,sourceId:accountId};
  const envelope = (paymentId:string, item:object|null) => ({paymentId,groupId:'fixture-group',evidence:item});

  it.each([
    {payerStatus:'delivered', payerReason:null, label:'Reported delivered', reason:null},
    {payerStatus:'suppressed', payerReason:'preferences_disabled', label:'Suppressed', reason:'Payer opted out'},
    {payerStatus:null, payerReason:null, label:'No receipt recorded', reason:null},
  ])('does one exact payment-bound lookup and shows its recorded outcome “$label” inline', async ({payerStatus,payerReason,label,reason}) => {
    mock.authMethod = 'phone_passcode';
    mock.scoped = true;
    mock.request.mockImplementation(async (path: string) => {
      if (path === 'burimunsi/payments/analysis') return buriPage([linked]);
      if (path === 'burimunsi/payments/'+momoId) return linked;
      if (path === evidencePath(momoId)) return envelope(momoId,{...evidence(accountId),payerStatus,payerReason});
      if (path === 'momo/observations/collections') return {contractVersion:1,asOf:time,items:[]};
      throw new Error('Unexpected request');
    });
    visit('/admin/payments',['payments.read','sms.read']);
    const link=await screen.findByRole('button',{name:'Review linked SMS'});
    expect(called(evidencePath(momoId))).toHaveLength(0);
    expect(called('momo/observations')).toHaveLength(0);
    expect(screen.getByRole('button',{name:'M-Money SMS'})).toHaveAttribute('aria-expanded','false');
    fireEvent.click(link);
    const evidenceRegion = within(await screen.findByRole('region',{name:'Linked SMS'}));
    expect(await evidenceRegion.findByText('Parsed')).toBeVisible();
    const payer = evidenceRegion.getByText('Payer SMS',{selector:'dt'}).nextElementSibling!;
    expect(payer).toHaveTextContent(label);
    if (reason) expect(payer).toHaveTextContent(reason);
    expect(called('momo/observations')).toHaveLength(0);
    expect(called(evidencePath(momoId))).toEqual([[evidencePath(momoId),{signal:expect.any(AbortSignal)}]]);
    expect(evidenceRegion.queryByRole('region',{name:'Original source access'})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'M-Money SMS'}));
    expect(screen.queryByRole('region',{name:'Payment details'})).not.toBeInTheDocument();
    expect(await screen.findByText('No receiver collections are available for this account.')).toBeVisible();
  });

  it.each([
    {reply:envelope(momoId,null), message:/linked SMS is unavailable/, test:'missing'},
    {reply:envelope(accountId,evidence(accountId)),message:/linked SMS could not be verified/,test:'wrong payment'},
    {reply:{...envelope(momoId,evidence(accountId)),groupId:'another-group'},message:/linked SMS could not be verified/,test:'wrong group'},
    {reply:envelope(momoId,evidence(momoId)),message:/linked SMS could not be verified/,test:'wrong source'},
    {reply:envelope(momoId,{...evidence(accountId),rawBody:'Unexpected raw evidence'}),message:/linked SMS could not be verified/,test:'unexpected body'},
  ])('fails closed without reading the inbox for $test', async ({reply,message}) => {
    mock.authMethod='phone_passcode'; mock.scoped=true;
    mock.request.mockImplementation(async(path:string)=>path===evidencePath(momoId)?reply:
      path==='burimunsi/payments/'+momoId?linked:buriPage([linked]));
    visit('/admin/payments?payment='+momoId,['payments.read','sms.read','sms.reveal']);
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.queryByText('Unexpected raw evidence')).not.toBeInTheDocument();
    expect(screen.queryByRole('region',{name:'Original source access'})).not.toBeInTheDocument();
    expect(called('momo/observations')).toHaveLength(0);
    expect(called(evidencePath(momoId))).toHaveLength(1);
  });

  it('does not request linked evidence for Staff even if stale detail includes a link', async () => {
    mock.authMethod='phone_passcode';
    mock.request.mockImplementation(async(path:string)=>path==='burimunsi/payments/'+momoId?linked:buriPage([buriPayment]));
    visit('/admin/payments?payment='+momoId,['payments.read','sms.read','sms.reveal'],'staff');
    expect(await within(await screen.findByRole('region',{name:'Payment details'})).findByText(momoRef)).toBeVisible();
    expect(screen.queryByRole('region',{name:'Linked SMS'})).not.toBeInTheDocument();
    expect(called(evidencePath(momoId))).toHaveLength(0);
    expect(called('momo/observations')).toHaveLength(0);
  });

  it('aborts the old linkage on selection, then discards in-flight evidence after authority changes',async()=>{
    mock.authMethod='phone_passcode'; mock.scoped=true;
    const second={...outgoing,sourceId:momoId};
    let resolveFirst!:(outcome:unknown)=>void,resolveSecond!:(outcome:unknown)=>void;
    const first=new Promise(resolve=>{resolveFirst=resolve;}), next=new Promise(resolve=>{resolveSecond=resolve;});
    mock.request.mockImplementation(async(path:string)=>{
      if (path===evidencePath(momoId)) return first;
      if (path===evidencePath(accountId)) return next;
      if (path==='burimunsi/payments/'+momoId) return linked;
      if (path==='burimunsi/payments/'+accountId) return second;
      return buriPage([linked,second]);
    });
    const url='/admin/payments?payment='+momoId;
    const app=visit(url,['payments.read','sms.read']);
    await waitFor(()=>expect(called(evidencePath(momoId))).toHaveLength(1));
    const firstAbort = called(evidencePath(momoId))[0][1].signal;
    fireEvent.click(screen.getByRole('button',{name:second.ftId}));
    await waitFor(()=>expect(called(evidencePath(accountId))).toHaveLength(1));
    expect(firstAbort.aborted).toBe(true);
    await act(async()=>resolveFirst(envelope(momoId,evidence(accountId,'held'))));
    expect(screen.queryByText('Held for review')).not.toBeInTheDocument();
    const secondAbort = called(evidencePath(accountId))[0][1].signal;
    mock.currentAuthority=false; mock.status='rechecking'; mock.permissions=['payments.read'];
    app.rerender(<MemoryRouter initialEntries={[url]}><RouteHarness /></MemoryRouter>);
    await waitFor(()=>expect(secondAbort.aborted).toBe(true));
    await act(async()=>resolveSecond(envelope(accountId,evidence(momoId,'parsed'))));
    expect(screen.queryByRole('region',{name:'Linked SMS'})).not.toBeInTheDocument();
    expect(screen.queryByText('Parsed')).not.toBeInTheDocument();
    expect(called('momo/observations')).toHaveLength(0);
  });

  it('never restores old payment evidence after an Admin session changes and the new session is denied', async () => {
    mock.authMethod='phone_passcode'; mock.scoped=true;
    let finishOld!:(value:unknown)=>void;
    const first=new Promise(resolve=>{finishOld=resolve;});
    let evidenceReads=0;
    mock.request.mockImplementation(async(path:string)=>{
      if (path===evidencePath(momoId)) {
        if (++evidenceReads===1) return first;
        throw new AdminRequestError('Permission removed',{statusCode:403,code:'permission_required'});
      }
      if (path==='burimunsi/payments/'+momoId) return linked;
      return buriPage([linked]);
    });
    const url='/admin/payments?payment='+momoId;
    const app=visit(url,['payments.read','sms.read','sms.reveal']);
    await waitFor(()=>expect(called(evidencePath(momoId))).toHaveLength(1));
    const previous=called(evidencePath(momoId))[0][1].signal;
    mock.sessionId='different-session';
    app.rerender(<MemoryRouter initialEntries={[url]}><RouteHarness /></MemoryRouter>);
    await waitFor(()=>expect(previous.aborted).toBe(true));
    await waitFor(()=>expect(called(evidencePath(momoId))).toHaveLength(2));
    await act(async()=>finishOld(envelope(momoId,evidence(accountId,'held'))));
    expect(await screen.findByText("Permission removed")).toBeVisible();
    expect(screen.queryByText('Held for review')).not.toBeInTheDocument();
    expect(screen.queryByRole('region',{name:'Original source access'})).not.toBeInTheDocument();
    expect(called('momo/observations')).toHaveLength(0);
  });

  it('keeps the allocation intent after an uncertain response and updates the same payment', async () => {
    mock.authMethod = 'phone_passcode';
    const changed = {...buriPayment,version:2,memberId:accountId,memberName:'Group member',state:'allocated'};
    let applied = false, attempts = 0;
    mock.request.mockImplementation(async (path: string, options?: {idempotencyKey:string}) => {
      if (path.startsWith('burimunsi/payments/members?')) return {items:[{id:accountId,name:'Group member'}]};
      if (path.endsWith('/allocation-receipt')) return {state:'unconfirmed',requestId:options!.idempotencyKey};
      if (path.endsWith('/allocate')) {
        attempts++;
        if (attempts === 1) throw new AdminTransportError('Response unavailable');
        applied = true;
        return {paymentId:momoId,memberId:accountId,state:'allocated',version:2};
      }
      return path.endsWith(momoId) ? {...(applied ? changed : buriPayment),canAllocate:true}
        : buriPage([{...(applied ? changed : buriPayment),canAllocate:true}]);
    });
    visit('/admin/payments?payment='+momoId,['payments.read'],'staff');
    const row = await screen.findByRole('row',{name:/MOMO-FIXTURE-01/});
    fireEvent.click(within(row).getByRole('link',{name:'Unallocated – allocate payment '+momoRef}));
    const member = await screen.findByRole('combobox',{name:'Member'});
    const dialog = within(screen.getByRole('dialog',{name:'Allocate payment'}));
    fireEvent.change(member,{target:{value:accountId}});
    fireEvent.click(dialog.getByRole('button',{name:'Review allocation'}));
    expect(attempts).toBe(0);
    fireEvent.click(dialog.getByRole('button',{name:'Confirm allocation'}));
    expect(await dialog.findByText(/Allocation was not confirmed/)).toBeVisible();
    expect(dialog.queryByRole('button',{name:'Retry allocation'})).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button',{name:'Check request'}));
    fireEvent.click(await dialog.findByRole('button',{name:'Retry allocation'}));
    await waitFor(() => expect(within(screen.getByRole('region',{name:'Payment details'})).getByText('Allocated')).toBeVisible());
    const writes = mock.request.mock.calls.filter(([path]) => path.endsWith('/allocate'));
    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual(writes[1]);
    expect(writes[0][1]).toMatchObject({method:'POST',body:{memberId:accountId,expectedVersion:1},idempotencyKey:expect.any(String)});
  });
  it('retains the original across reload, checks its exact committed receipt even when allocated, and never replays', async () => {
    mock.authMethod = 'phone_passcode';
    const detailPath = 'burimunsi/payments/'+momoId;
    const changed = {...buriPayment,version:2,memberId:accountId,memberName:'Group member',state:'allocated'};
    let applied = false, receiptSupported = false;
    mock.request.mockImplementation(async (path: string, options?: {idempotencyKey:string}) => {
      if (path.startsWith('burimunsi/payments/members?')) return {items:[{id:accountId,name:'Group member'}]};
      if (path === detailPath+'/allocate') {applied = true; throw new AdminTransportError('Lost acknowledgement');}
      if (path === detailPath+'/allocation-receipt') {
        if (!receiptSupported) throw new Error('Endpoint unavailable');
        return {state:'committed',requestId:options!.idempotencyKey,receipt:{paymentId:momoId,memberId:accountId,version:2}};
      }
      return path === detailPath ? {...(applied ? changed : buriPayment),canAllocate:true} : buriPage([applied ? changed : buriPayment]);
    });
    const path = '/admin/payments?payment='+momoId+'&allocate='+momoId;
    const initial = visit(path,['payments.read'],'staff');
    fireEvent.change(await screen.findByRole('combobox',{name:'Member'}),{target:{value:accountId}});
    fireEvent.click(screen.getByRole('button',{name:'Review allocation'}));
    fireEvent.click(screen.getByRole('button',{name:'Confirm allocation'}));
    expect(await screen.findByText(/Allocation was not confirmed/)).toBeVisible();
    const ref = mock.request.mock.calls.find(([target]) => target === detailPath+'/allocate')![1].idempotencyKey;
    initial.unmount();
    const reloaded = visit(path,['payments.read'],'staff');
    expect(await screen.findByText(ref)).toBeVisible();
    expect(screen.queryByRole('button',{name:'Allocate'})).not.toBeInTheDocument();
    expect(called(detailPath+'/allocate')).toHaveLength(1);
    expect(called(detailPath+'/allocation-receipt')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button',{name:'Check request'}));
    expect(await screen.findByText(/original request could not be checked/)).toBeVisible();
    expect(screen.getByText(ref)).toBeVisible();
    expect(screen.queryByRole('button',{name:'Retry allocation'})).not.toBeInTheDocument();
    reloaded.unmount();
    mock.sessionId='different-session';
    const differentSession=visit(path,['payments.read'],'admin');
    expect(await screen.findByText(/original allocation reference could not be checked/)).toBeVisible();
    expect(screen.queryByText(ref)).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Check request'})).not.toBeInTheDocument();
    differentSession.unmount();
    mock.sessionId='fixture-session'; receiptSupported = true;
    visit(path,['payments.read'],'staff');
    fireEvent.click(await screen.findByRole('button',{name:'Check request'}));
    await waitFor(() => expect(screen.queryByText(ref)).not.toBeInTheDocument());
    expect(called(detailPath+'/allocation-receipt').at(-1)![1]).toEqual({idempotencyKey:ref});
    expect(called(detailPath+'/allocate')).toHaveLength(1);
  });

});
