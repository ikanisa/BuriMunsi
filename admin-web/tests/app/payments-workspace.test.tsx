import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {createHash, webcrypto} from 'node:crypto';
import {Suspense} from 'react';
import {MemoryRouter, useLocation, useNavigate, useRoutes} from 'react-router';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {AdminUser} from '../../src/session/sessionResponses';
import {workspaceRoutes} from '../../src/app/WorkspaceRoutes';
import {canOpenAdminPath} from '../../src/app/route-access';
import {safePaymentListReturn} from '../../src/features/operations/paymentLocations';
import {AdminRequestError, AdminTransportError} from '../../src/api/contracts';
import {ReceiverSmsPanel} from '../../src/features/operations/ReceiverSmsPanel';
import {InteractionSuspendedContext} from '../../src/ui/useFocusScope';
import {analyzeCanonicalPaymentRows, type PaymentAnalysisQuery} from '../../../supabase/functions/_shared/domain/burimunsi/payment-analysis-shared.mjs';
import coreFixture from '../core/canonical-core-fixtures.json';
import reconciliationFixture from '../core/canonical-reconciliation-fixture.json';

const mock = vi.hoisted(() => ({request:vi.fn(), permissions:[] as string[], status:'authenticated', role:'admin',
  authMethod:undefined as AdminUser['authMethod'], scoped:false, sessionId:'fixture-session', epoch:1, currentAuthority: true,
  recheck:vi.fn(async()=>true)}));
const currentActor = reconciliationFixture.detail.current_actor_id;
const currentPrincipal = reconciliationFixture.detail.current_principal_id;
const momoId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const momoRef = 'MOMO-FIXTURE-01';
const time = '2026-10-18T08:00:00.000Z';
const buriPayment = {id:momoId,groupId:'fixture-group',version:1,direction:'incoming',amountRwf:5000,atRaw:time,ftId:momoRef,
  payerNameRaw:'Fixture payer',payerPhoneRaw:'000071',memberId:null,memberName:null,memberPhone:null as string|null,state:'unallocated',
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
  useSession:() => ({status:mock.status,epoch:mock.epoch,user:sessionUser(),request:mock.request,isCurrentAuthority,
    ...(mock.authMethod==='phone_passcode' && {verificationMode:'passcode',recheckSensitivePasscode:mock.recheck,isRecentSensitiveVerification:isCurrentAuthority})}),
}));

function RouteHarness() {
  const location = useLocation(), go = useNavigate();
  const route = useRoutes([{path:'/admin',children:workspaceRoutes.map(entry => ({
    ...entry, element:entry.handle(sessionUser()) ? entry.element : <p>Direct route denied</p>,
  }))}]);
  return <><output aria-label="Current location">{location.pathname + location.search}</output>
    <button onClick={() => go(-1)}>Browser back</button><Suspense fallback={<p>Loading fixture route</p>}>{route}</Suspense></>;
}
const visit = (path: string, permissions: string[], role = 'admin', strict = false) => {
  mock.permissions=permissions;mock.role=role;
  return render(<MemoryRouter initialEntries={[path]}><RouteHarness /></MemoryRouter>, {reactStrictMode:strict});
};
const location = () => screen.getByLabelText('Current location');
const called = (prefix: string) => mock.request.mock.calls.filter(([path]) => path.startsWith(prefix));
function pendingRead() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const promise = new Promise<unknown>((done, fail) => {resolve = done; reject = fail;});
  return {promise, resolve, reject};
}
afterEach(() => {mock.request.mockReset();mock.recheck.mockReset().mockResolvedValue(true);mock.status='authenticated';mock.role='admin';mock.authMethod=undefined;mock.scoped=false;mock.sessionId='fixture-session';mock.epoch=1;mock.currentAuthority=true;vi.unstubAllGlobals();sessionStorage.clear();});

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

  it('reads the attested phone Admin collection directly and rejects an inbox tagged with another collection', async () => {
    mock.authMethod='phone_passcode';
    mock.scoped=true;
    let group='other-group';
    mock.request.mockImplementation(async()=>({contractVersion:1,collectionId:group,nextCursor:null,asOf:time,items:[],
      inboxCheck:{state:'incomplete',checkedAt:null,candidateCount:null,missingCount:null,pendingCount:null,headsMatch:null}}));
    visit('/admin/payments?view=sms',['sms.read']);
    expect(await screen.findByRole('alert')).toHaveTextContent('The MoMo records could not be verified.');
    expect(screen.queryByRole('region',{name:'Inbox completeness'})).not.toBeInTheDocument();
    const expected='momo/observations?collectionId=fixture-group&limit=25&includeProcessing=1';
    expect(mock.request.mock.calls.map(([path])=>path)).toEqual([expected]);
    group='fixture-group';
    fireEvent.click(screen.getByRole('button',{name:'Try again'}));
    const inbox=within(await screen.findByRole('region',{name:'Inbox completeness'}));
    expect(inbox.getByRole('status')).toHaveTextContent('SMS sync pending');
    expect(inbox.queryByText(/missing|pending ·/i)).not.toBeInTheDocument();
    expect(mock.request.mock.calls.map(([path])=>path)).toEqual([expected,expected]);
  });

  it('retains collection discovery and switching for Admin sessions without the phone collection proof', async () => {
    mock.permissions=['sms.read'];
    const scopes=[{collectionId:'first-group',label:'First group'},{collectionId:'second-group',label:'Second group'}];
    mock.request.mockImplementation(async (path:string)=>path==='momo/observations/collections'
      ? {contractVersion:1,asOf:time,items:scopes}
      : {contractVersion:1,collectionId:new URLSearchParams(path.split('?')[1]).get('collectionId'),nextCursor:null,asOf:time,items:[],
        inboxCheck:{state:'unknown',checkedAt:null,candidateCount:null,missingCount:null,pendingCount:null,headsMatch:null}});
    render(<MemoryRouter><ReceiverSmsPanel /></MemoryRouter>);
    const selector=await screen.findByRole('combobox',{name:'Collection'});
    expect(selector).toHaveValue('first-group');
    await screen.findByRole('heading',{name:'Receiver SMS'});
    fireEvent.change(selector,{target:{value:'second-group'}});
    await screen.findByRole('heading',{name:'Receiver SMS'});
    expect(mock.request.mock.calls.map(([path])=>path)).toEqual(['momo/observations/collections',
      'momo/observations?collectionId=first-group&limit=25&includeProcessing=1',
      'momo/observations?collectionId=second-group&limit=25&includeProcessing=1']);
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
      paymentTotals:{incomingRwf:'9007199254740993',outgoingRwf:'5000',latestSmsBalanceRwf:0,
        walletGapRwf:'9007199254735993'}});
    const admin = visit('/admin', ['overview.read','payments.read','sms.read']);
    expect(await screen.findByRole('link',{name:/Cumulative incoming payments.*RWF 9,007,199,254,740,993/}))
      .toHaveAttribute('href','/admin/payments?direction=incoming');
    expect(screen.getByRole('link',{name:/Cumulative outgoing payments.*RWF 5,000/}))
      .toHaveAttribute('href','/admin/payments?direction=outgoing');
    const balance = screen.getByRole('button',{name:'Latest MoMo SMS balance · RWF 0'});
    const difference = screen.getByRole('button',{name:'Wallet difference · RWF 9,007,199,254,735,993'});
    for (const trigger of [balance,difference]) {
      expect(trigger).toHaveAttribute('aria-haspopup','dialog');
      trigger.focus();
      fireEvent.click(trigger);
      const details = within(screen.getByRole('dialog',{name:'Wallet details'}));
      for (const [label,amount] of [
        ['Cumulative incoming payments','RWF 9,007,199,254,740,993'],
        ['Cumulative outgoing payments','RWF 5,000'],['Latest verified SMS balance','RWF 0'],
        ['Wallet difference','RWF 9,007,199,254,735,993'],
      ]) expect(details.getByText(label,{selector:'dt'}).nextElementSibling).toHaveTextContent(amount);
      expect(details.queryByRole('link',{name:'Open SMS inbox'})).not.toBeInTheDocument();
      fireEvent.keyDown(document,{key:'Escape'});
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    }
    expect(called('burimunsi/home')).toHaveLength(1);
    admin.unmount();
    visit('/admin', ['overview.read','payments.read','sms.read'], 'staff');
    expect(await screen.findByRole('link',{name:/Cumulative incoming payments/})).toBeVisible();
    expect(screen.queryByText('Latest MoMo SMS balance')).not.toBeInTheDocument();
    expect(screen.queryByText(/Wallet difference/)).not.toBeInTheDocument();
  });

  it('keeps unknown SMS balance distinct from zero cumulative movements', async () => {
    mock.authMethod = 'phone_passcode';
    mock.request.mockResolvedValue({paymentCount:0,memberCount:0,unallocatedCount:0,recentPayments:[],asOf:time,
      paymentTotals:{incomingRwf:'0',outgoingRwf:'0',latestSmsBalanceRwf:null}});
    visit('/admin', ['overview.read','payments.read','sms.read']);
    expect(await screen.findByRole('link',{name:/Cumulative incoming payments.*RWF 0/})).toBeVisible();
    const balance = screen.getByRole('button',{name:'Latest MoMo SMS balance · Unavailable'});
    expect(balance).toBeVisible();
    expect(screen.queryByText(/Wallet difference/)).not.toBeInTheDocument();
    fireEvent.click(balance);
    const details = within(screen.getByRole('dialog',{name:'Wallet details'}));
    for (const label of ['Latest verified SMS balance','Wallet difference']) {
      expect(details.getByText(label,{selector:'dt'}).nextElementSibling).toHaveTextContent('Unavailable');
    }
  });

  it('keeps the verified Home snapshot until the requested refresh settles', async () => {
    mock.authMethod = 'phone_passcode';
    const home = {paymentCount:0,memberCount:0,unallocatedCount:0,recentPayments:[],asOf:time};
    const totals = {incomingRwf:'9007199254740992',outgoingRwf:'9007199254740993',latestSmsBalanceRwf:0};
    mock.request.mockResolvedValue({...home,paymentTotals:{...totals,walletGapRwf:'-1'}});
    visit('/admin', ['overview.read','payments.read','sms.read']);
    expect(await screen.findByText('Wallet difference · RWF -1')).toBeVisible();
    const snapshot = screen.getByRole('region',{name:'Group snapshot'}), refresh = screen.getByRole('button',{name:'Refresh Home'});
    const held = pendingRead();
    mock.request.mockReturnValueOnce(held.promise);
    fireEvent.click(refresh);
    expect(screen.getByRole('region',{name:'Group snapshot'})).toBe(snapshot);
    expect(snapshot).toHaveAttribute('aria-busy','true');
    expect(refresh).toBeDisabled();
    expect(refresh).toHaveAttribute('aria-busy','true');
    expect(screen.getByText('Wallet difference · RWF -1')).toBeVisible();
    expect(screen.queryByText('Loading Home')).not.toBeInTheDocument();
    fireEvent.click(refresh);
    expect(called('burimunsi/home')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button',{name:'Wallet difference · RWF -1'}));
    const details = within(screen.getByRole('dialog',{name:'Wallet details'}));
    expect(details.getByText('Wallet difference',{selector:'dt'}).nextElementSibling).toHaveTextContent('RWF -1');
    await act(async () => held.resolve({...home,paymentTotals:{...totals,outgoingRwf:totals.incomingRwf,walletGapRwf:'0'}}));
    expect(details.getByText('Wallet difference',{selector:'dt'}).nextElementSibling).toHaveTextContent('RWF 0');
    fireEvent.click(details.getByRole('button',{name:'Close dialog'}));
    expect(await screen.findByRole('link',{name:/Cumulative outgoing payments.*RWF 9,007,199,254,740,992/})).toBeVisible();
    expect(screen.queryByText(/Wallet difference/)).not.toBeInTheDocument();
    expect(refresh).toBeEnabled();
    expect(snapshot).not.toHaveAttribute('aria-busy');
  });

  it('removes a retained wallet balance immediately when the session loses SMS access', async () => {
    mock.authMethod = 'phone_passcode';
    mock.scoped = true;
    const home = {paymentCount:0,memberCount:1,unallocatedCount:0,recentPayments:[],asOf:time};
    const totals = {incomingRwf:'10',outgoingRwf:'0'};
    const prior = pendingRead(), current = pendingRead();
    mock.request.mockResolvedValueOnce({...home,paymentTotals:{...totals,latestSmsBalanceRwf:10}})
      .mockReturnValueOnce(prior.promise).mockReturnValueOnce(current.promise);
    const app = visit('/admin',['overview.read','payments.read','sms.read']);
    const balance = await screen.findByRole('button',{name:/Latest MoMo SMS balance.*RWF 10/});
    fireEvent.click(screen.getByRole('button',{name:'Refresh Home'}));
    expect(balance).toBeVisible();
    fireEvent.click(balance);
    expect(screen.getByRole('dialog',{name:'Wallet details'})).toBeVisible();
    mock.permissions = ['overview.read','payments.read'];
    app.rerender(<MemoryRouter initialEntries={['/admin']}><RouteHarness /></MemoryRouter>);
    expect(balance).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog',{name:'Wallet details'})).not.toBeInTheDocument();
    expect(screen.queryByRole('region',{name:'Group snapshot'})).not.toBeInTheDocument();
    const reads = called('burimunsi/home');
    await waitFor(() => expect(reads[1][1].signal.aborted).toBe(true));
    await act(async () => prior.resolve({...home,paymentTotals:{...totals,latestSmsBalanceRwf:99}}));
    expect(screen.queryByText('Latest MoMo SMS balance')).not.toBeInTheDocument();
    await act(async () => current.resolve({...home,paymentTotals:totals}));
    expect(screen.getByRole('region',{name:'Group snapshot'})).toBeVisible();
    expect(screen.queryByText('Latest MoMo SMS balance')).not.toBeInTheDocument();
    expect(called('burimunsi/home')).toHaveLength(3);
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
    expect(screen.getByRole('columnheader',{name:/^Member phone$/})).toBeVisible();
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
    const detail = within(await screen.findByRole('region',{name:'Payment details',description:'FT-104'}));
    expect(detail.queryByText('FT-104')).not.toBeInTheDocument();
    expect(detail.queryByText('pay-104')).not.toBeInTheDocument();
    expect(called('burimunsi/payments/analysis').map(([,options]) => [options.method,options.body.offset,options.body.sort])).toEqual([
      ['POST',25,{key:'time',direction:'desc'}], ['POST',0,{key:'amount',direction:'asc'}],
    ]);
    expect(screen.getByRole('region',{name:'Totals for matching payments'})).toHaveTextContent('RWF 5,565');
  });

  it.each([403,503])('keeps the Payments page during refresh and stops loading on a %i without reporting a zero balance', async status => {
    mock.authMethod = 'phone_passcode';
    // Equal canonical event times are returned in descending payment ID order by the database.
    const rows = Array.from({length:26}, (_, i) => {
      const suffix=String(25-i).padStart(2,'0');
      return {...buriPayment,id:'pay-'+suffix,ftId:'FT-'+suffix,occurredAt:time};
    });
    const page = buriPage(rows,{...query99,offset:25});
    const held = pendingRead();
    mock.request.mockResolvedValueOnce(page).mockReturnValueOnce(held.promise).mockResolvedValueOnce(page);
    visit('/admin/payments?offset=25',['payments.read'],'staff');
    const record = await screen.findByRole('button',{name:'FT-00'});
    record.focus();
    const totals = screen.getByRole('region',{name:'Totals for matching payments'});
    const table = screen.getByRole('table',{name:'Payments'}), refresh = screen.getByRole('button',{name:'Refresh'});
    const asOf = screen.getByText(/Payment totals as of/).querySelector('time');
    fireEvent.click(refresh);
    expect(screen.getByRole('button',{name:'FT-00'})).toBe(record);
    expect(record).toHaveFocus();
    expect(screen.getByRole('region',{name:'Totals for matching payments'})).toBe(totals);
    expect(asOf).toHaveAttribute('dateTime',time);
    expect(totals).toHaveTextContent('RWF 130,000');
    expect(table).toHaveAttribute('aria-busy','true');
    expect(refresh).toBeDisabled();
    expect(refresh).toHaveAttribute('aria-busy','true');
    expect(screen.queryByText('Loading payments')).not.toBeInTheDocument();
    fireEvent.click(refresh);
    expect(called('burimunsi/payments/analysis')).toHaveLength(2);

    await act(async () => held.reject(new AdminRequestError('The payment view is unavailable.',{statusCode: status})));
    expect(screen.getByRole('alert')).toHaveTextContent('The payment view is unavailable.');
    expect(table).not.toHaveAttribute('aria-busy');
    expect(refresh).toBeEnabled();
    expect(record).not.toBeInTheDocument();
    expect(asOf).not.toBeInTheDocument();
    expect(totals).not.toBeInTheDocument();
    expect(screen.queryByText(/^(Loading payments|0 records|No (?:matching )?records\.)/)).not.toBeInTheDocument();
    expect(location()).toHaveTextContent('/admin/payments?offset=25');
    fireEvent.click(screen.getByRole('button',{name:'Try again'}));
    expect(await screen.findByRole('button',{name:'FT-00'})).toBeVisible();
    expect(location()).toHaveTextContent('/admin/payments?offset=25');
    expect(called('burimunsi/payments/analysis').map(([,options]) => options.body.offset)).toEqual([25,25,25]);
  });

  it('restarts a revision-bound page only after the operator retries a changed payment snapshot', async () => {
    mock.authMethod='phone_passcode';
    const rows=Array.from({length:26},(_,i)=>({...buriPayment,id:'pay-'+i,ftId:'FT-'+i}));
    const first=buriPage(rows), revision='a'.repeat(64);
    mock.request.mockResolvedValueOnce({...first,revision}).mockRejectedValueOnce(
      new AdminRequestError('Conflict',{statusCode:409,code:'payment_analysis_changed'}),
    ).mockResolvedValueOnce({...first,revision:'b'.repeat(64)});
    visit('/admin/payments',['payments.read'],'staff');
    fireEvent.click(await screen.findByRole('button',{name:'Next page'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Payments changed between pages. Refresh to return to the first page.');
    expect(location()).toHaveTextContent('/admin/payments?offset=25');
    expect(called('burimunsi/payments/analysis')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button',{name:'Try again'}));
    expect(await screen.findByRole('button',{name:'FT-0'})).toBeVisible();
    expect(location()).toHaveTextContent(/^\/admin\/payments$/);
    expect(called('burimunsi/payments/analysis').map(([,options])=>[options.body.offset,options.body.revision])).toEqual([
      [0,undefined],[25,revision],[0,undefined],
    ]);
  });

  it('drops a retained payment on criteria or session changes and ignores late responses from each previous scope', async () => {
    mock.authMethod = 'phone_passcode';
    const refresh = pendingRead(), sorted = pendingRead(), newSession = pendingRead();
    mock.request.mockResolvedValueOnce(buriPage([buriPayment])).mockReturnValueOnce(refresh.promise)
      .mockReturnValueOnce(sorted.promise).mockReturnValueOnce(newSession.promise);
    const url = '/admin/payments';
    const app = visit(url,['payments.read'],'staff');
    const record = await screen.findByRole('button',{name:momoRef});
    fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
    expect(record).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'Sort Amount ascending'}));
    expect(record).not.toBeInTheDocument();
    expect(screen.queryByRole('region',{name:'Totals for matching payments'})).not.toBeInTheDocument();
    expect(screen.getByText('Loading payments')).toBeVisible();
    const calls = called('burimunsi/payments/analysis');
    expect(calls[2][1].body.sort).toEqual({key:'amount',direction:'asc'});
    await waitFor(() => expect(calls[1][1].signal.aborted).toBe(true));
    await act(async () => refresh.resolve(buriPage([buriPayment])));
    expect(screen.queryByRole('button',{name:momoRef})).not.toBeInTheDocument();

    mock.sessionId = 'other-session';
    app.rerender(<MemoryRouter initialEntries={[url]}><RouteHarness /></MemoryRouter>);
    await waitFor(() => expect(calls[2][1].signal.aborted).toBe(true));
    await act(async () => sorted.resolve(buriPage([outgoing])));
    expect(screen.queryByRole('button',{name:outgoing.ftId})).not.toBeInTheDocument();
    expect(screen.getByText('Loading payments')).toBeVisible();
    await act(async () => newSession.resolve(buriPage([])));
    expect(screen.getByText('0 records')).toBeVisible();
    expect(screen.getByText('No records.')).toBeVisible();
    expect(screen.getByRole('button',{name:'Refresh'})).toBeEnabled();
    expect(called('burimunsi/payments/analysis')).toHaveLength(4);
  });

  it('loads sync status when opening the SMS inbox from Home', async () => {
    mock.authMethod = 'phone_passcode';
    mock.scoped = true;
    mock.request.mockImplementation(async (path: string) => {
      if (path === 'burimunsi/home') return {
        paymentCount:1,memberCount:5,unallocatedCount:1,recentPayments:[buriPayment],asOf:time,
        paymentTotals:{incomingRwf:'5000',outgoingRwf:'0',latestSmsBalanceRwf:1000},
      };
      if (path === 'burimunsi/payments/analysis') return buriPage([buriPayment]);
      return {contractVersion:1,collectionId:'fixture-group',nextCursor:null,asOf:time,items:[],
        inboxCheck:{state:'incomplete',checkedAt:time,candidateCount:4,missingCount:0,pendingCount:1,headsMatch:false}};
    });
    visit('/admin', ['overview.read','payments.read','sms.read']);
    expect(await screen.findByRole('heading',{name:'Recent payments'})).toBeVisible();
    expect(screen.queryByRole('link',{name:'M-Money SMS'})).not.toBeInTheDocument();
    expect(screen.queryByText(/sync pending/i)).not.toBeInTheDocument();
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh Home'})));
    expect(called('burimunsi/home')).toHaveLength(2);
    expect(called('momo/observations')).toHaveLength(0);

    fireEvent.click(await screen.findByRole('button',{name:/Latest MoMo SMS balance/}));
    const details = within(screen.getByRole('dialog',{name:'Wallet details'}));
    const openInbox = details.getByRole('link',{name:'Open SMS inbox'});
    expect(openInbox).toHaveAttribute('href','/admin/payments?view=sms');
    expect(called('momo/observations')).toHaveLength(0);
    fireEvent.click(openInbox);
    expect(location()).toHaveTextContent('/admin/payments?view=sms');
    const inbox=within(await screen.findByRole('region',{name:'Inbox completeness'}));
    expect(inbox.getByRole('status')).toHaveTextContent('SMS sync pending');
    expect(called('momo/observations').map(([path])=>path)).toEqual([
      'momo/observations?collectionId=fixture-group&limit=25&includeProcessing=1',
    ]);
  });

  it('expires an SMS inbox check and keeps the same check expired after reload', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T06:00:00.000Z'));
    mock.authMethod='phone_passcode'; mock.scoped=true; mock.permissions=['sms.read'];
    let asOf='2026-10-18T08:04:59.999Z', checkedAt=time;
    const groupId='fixture-group';
    mock.request.mockImplementation(async()=>({contractVersion:1,collectionId:groupId,nextCursor:null,asOf,items:[],
      inboxCheck:{state:'verified',checkedAt,candidateCount:0,missingCount:0,pendingCount:0,headsMatch:true}}));
    const openInbox=()=>render(<MemoryRouter><ReceiverSmsPanel simplePayments /></MemoryRouter>);
    let view=openInbox();
    const status=()=>within(screen.getByRole('region',{name:'Inbox completeness'})).getByRole('status');
    try {
      await act(async()=>{});
      expect(status()).toHaveTextContent(/inboxes matched/i);
      await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
      expect(status()).toHaveTextContent(/out of date/i);

      view.unmount();
      asOf='2026-10-18T08:05:00.000Z';
      view=openInbox();
      await act(async()=>{});
      expect(status()).toHaveTextContent(/out of date/i);
      asOf='2026-10-18T08:05:01.000Z'; checkedAt=asOf;
      await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh receiver'})));
      expect(status()).toHaveTextContent(/inboxes matched/i);
    } finally {view.unmount();vi.useRealTimers();}
  });

  const evidencePath = (id:string) => 'burimunsi/payments/'+id+'/sms-evidence';
  const bodyPath = 'momo/observations/'+accountId+'/content?collectionId=fixture-group';
  const original = 'You received RWF 5,000. Synthetic reference MOMO-FIXTURE-01.';
  const digest = createHash('sha256').update(original).digest('hex');
  const content = {contractVersion:1,collectionId:'fixture-group',sourceKind:'observation',retentionState:'retained',
    sourceId:accountId,rawSender:'Fixture M-Money',rawBody:original,bodySha256:digest};
  const evidence = (sourceId: string, processing = 'parsed') => ({requestId:sourceId,sourceId,admittedAt:time,retentionState:'retained',
    bodySha256:digest,processing,paymentReference:null,payerStatus:null,payerReason:null});
  const linked = {...buriPayment,sourceId:accountId};
  const envelope = (paymentId:string, item:object|null) => ({paymentId,groupId:'fixture-group',evidence:item});
  const originalGrants = ['payments.read','sms.read','sms.reveal'];

  it('keeps the reference, amount, time and available allocation action together for an off-page selection',async()=>{
    mock.authMethod='phone_passcode'; mock.scoped=true;
    const selected={...buriPayment,canAllocate:true};
    mock.request.mockImplementation(async(path:string)=>path==='burimunsi/payments/'+momoId?selected:buriPage([outgoing]));
    visit('/admin/payments?payment='+momoId,['payments.read']);
    const details=within(await screen.findByRole('region',{name:'Payment details',description:momoRef}));
    expect(details.getByRole('heading',{name:momoRef})).toBeVisible();
    const summary=within(details.getByRole('group',{name:'Payment summary'}));
    expect(summary.getByText('RWF 5,000')).toBeVisible();
    expect(summary.getByTitle('Incoming')).toBeVisible();
    expect(summary.getByText(/18 Oct 2026/)).toBeVisible();
    expect(summary.getByRole('link',{name:'Allocate to member'})).toHaveAttribute('href',expect.stringContaining('allocate='+momoId));
    expect(details.queryByRole('region',{name:'Original SMS'})).not.toBeInTheDocument();
  });

  it('keeps only distinct recorded counterparty details and recovery on an inline payment without SMS',async()=>{
    mock.authMethod='phone_passcode'; mock.scoped=true;
    const selected={...outgoing,memberPhone:'+250780000987',canAllocate:true};
    mock.request.mockImplementation(async(path:string)=>path==='burimunsi/payments/'+selected.id?selected:buriPage([selected]));
    visit('/admin/payments',['payments.read']);
    const opener=await screen.findByRole('button',{name:selected.ftId});
    fireEvent.click(opener);
    const details=within(await screen.findByRole('region',{name:'Payment details',description:selected.ftId}));
    expect(details.queryByText(selected.ftId)).not.toBeInTheDocument();
    expect(details.queryByText(selected.memberName)).not.toBeInTheDocument();
    expect(details.getByRole('link',{name:'Review allocation request'})).toBeVisible();
    fireEvent.click(details.getByText('Recorded counterparty details'));
    expect(details.getByText(selected.payerNameRaw)).toBeVisible();
    expect(details.getByText(selected.payerPhoneRaw)).toBeVisible();
    fireEvent.click(details.getByRole('button',{name:'Close'}));
    expect(opener).toHaveFocus();
    expect(called('momo/observations')).toHaveLength(0);
  });

  it('automatically opens only the verified original SMS on expanding its payment, with one audited request under StrictMode', async () => {
    vi.stubGlobal('crypto',webcrypto); mock.authMethod='phone_passcode'; mock.scoped=true;
    mock.request.mockImplementation(async (path:string) => {
      if (path==='burimunsi/payments/analysis') return buriPage([linked,outgoing]);
      if (path==='burimunsi/payments/'+momoId) return linked;
      if (path==='burimunsi/payments/'+outgoing.id) return outgoing;
      if (path===evidencePath(momoId)) return envelope(momoId,evidence(accountId));
      if (path===bodyPath) return content;
      throw new Error('Unexpected request');
    });
    visit('/admin/payments',originalGrants,'admin',true);
    const row = await screen.findByRole('button',{name:'Review linked SMS'});
    expect(called(evidencePath(momoId))).toHaveLength(0);
    expect(called('momo/observations')).toHaveLength(0);
    fireEvent.click(row);
    const details = await screen.findByRole('region',{name:'Payment details',description:momoRef});
    const shown = within(details);
    const sms=within(await screen.findByRole('region',{name:'Original SMS'}));
    expect(await sms.findByText(original)).toBeVisible();
    expect(row).toHaveAttribute('aria-controls',details.id);
    const heading=shown.getByRole('heading',{name:'Original SMS'});
    expect(heading.parentElement).toContainElement(shown.getByRole('button',{name:'Close'}));
    expect(shown.getAllByRole('heading')).toHaveLength(1);
    for (const value of [momoRef,'Unallocated','RWF 5,000','IN/OUT','Time','Member','Fixture payer','000071']) {
      expect(shown.queryByText(value,{exact:true})).not.toBeInTheDocument();
    }
    expect(sms.queryByRole('textbox')).not.toBeInTheDocument();
    expect(sms.queryByRole('button')).not.toBeInTheDocument();
    expect(sms.queryByText(/processing|payer SMS|parsed|retained/i)).not.toBeInTheDocument();
    expect(mock.recheck).toHaveBeenCalledOnce();
    expect(called(evidencePath(momoId))).toHaveLength(1);
    expect(called('momo/observations')).toEqual([[bodyPath,{reviewReason:'View SMS from payment details',signal:expect.any(AbortSignal)}]]);
    fireEvent.click(screen.getByRole('button',{name:outgoing.ftId}));
    expect(await screen.findByRole('region',{name:'Payment details',description:outgoing.ftId})).toBeVisible();
    expect(screen.queryByText(original)).not.toBeInTheDocument();
    expect(called('momo/observations')).toHaveLength(1);
  });

  it.each([
    {reply:envelope(momoId,null), message:/original SMS is unavailable/, test:'missing'},
    {reply:envelope(momoId,{...evidence(accountId),retentionState:'unresolved',bodySha256:null}),message:/original SMS is unavailable/,test:'unresolved'},
    {reply:envelope(accountId,evidence(accountId)),message:/original SMS could not be verified/,test:'wrong payment'},
    {reply:{...envelope(momoId,evidence(accountId)),groupId:'another-group'},message:/original SMS could not be verified/,test:'wrong group'},
    {reply:envelope(momoId,evidence(momoId)),message:/original SMS could not be verified/,test:'wrong source'},
    {reply:envelope(momoId,{...evidence(accountId),rawBody:'Unexpected raw evidence'}),message:/original SMS could not be verified/,test:'body in metadata'},
  ])('withholds the original SMS without accessing content for $test', async ({reply,message}) => {
    mock.authMethod='phone_passcode'; mock.scoped=true;
    mock.request.mockImplementation(async(path:string)=>path===evidencePath(momoId)?reply:
      path==='burimunsi/payments/'+momoId?linked:buriPage([linked]));
    visit('/admin/payments?payment='+momoId,originalGrants);
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.queryByText('Unexpected raw evidence')).not.toBeInTheDocument();
    expect(called('momo/observations')).toHaveLength(0);
    expect(called(evidencePath(momoId))).toHaveLength(1);
  });

  const selectedPaymentPath = 'burimunsi/payments/'+momoId;
  const selectedPaymentUrl = '/admin/payments?payment='+momoId;
  const detailRegion = () => screen.queryByRole('region',{name:'Payment details'});

  it.each(['detail','analysis'] as const)('starts Staff Home detail with analysis and verifies it when %s finishes first', async first => {
    mock.authMethod='phone_passcode';
    const analysis=pendingRead(), detail=pendingRead();
    const record={...linked,ftId:'Scoped detail reference'};
    mock.request.mockImplementation((path:string) => {
      if (path==='burimunsi/home') return Promise.resolve({
        paymentCount:1,memberCount:1,unallocatedCount:1,recentPayments:[buriPayment],asOf:time,
      });
      if (path==='burimunsi/payments/analysis') return analysis.promise;
      if (path===selectedPaymentPath) return detail.promise;
      throw new Error('Unexpected request');
    });
    visit('/admin',['overview.read','payments.read','sms.read'],'staff');
    fireEvent.click(await screen.findByRole('link',{name:momoRef}));
    await waitFor(() => {
      expect(called('burimunsi/payments/analysis')).toHaveLength(1);
      expect(called(selectedPaymentPath)).toHaveLength(1);
    });
    if (first==='detail') {
      await act(async()=>detail.resolve(record));
      expect(detailRegion()).not.toBeInTheDocument();
      expect(screen.queryByText(record.ftId)).not.toBeInTheDocument();
      await act(async()=>analysis.resolve(buriPage([buriPayment])));
    } else {
      await act(async()=>analysis.resolve(buriPage([buriPayment])));
      expect(called(selectedPaymentPath)[0][1].signal.aborted).toBe(false);
      expect(screen.queryByText(record.ftId)).not.toBeInTheDocument();
      await act(async()=>detail.resolve(record));
    }
    expect(await within(detailRegion()!).findByText(record.ftId,{exact:true})).toBeVisible();
    expect(called(selectedPaymentPath)).toHaveLength(1);
    expect(called(evidencePath(momoId))).toHaveLength(0);
    expect(screen.queryByRole('region',{name:'Linked SMS'})).not.toBeInTheDocument();
  });

  it.each([
    {case:'foreign collection', delta:{groupId:'different-collection'}},
    {case:'different payment', delta:{id:accountId}},
  ])('withholds a prefetched Staff detail from a $case', async ({delta}) => {
    mock.authMethod='phone_passcode';
    const analysis=pendingRead();
    mock.request.mockImplementation((path:string)=>path===selectedPaymentPath
      ? Promise.resolve({...linked,...delta,ftId:'Unverified detail reference'}) : analysis.promise);
    visit(selectedPaymentUrl,['payments.read','sms.read'],'staff');
    await waitFor(()=>expect(called(selectedPaymentPath)).toHaveLength(1));
    expect(detailRegion()).not.toBeInTheDocument();
    await act(async()=>analysis.resolve(buriPage([buriPayment])));
    expect(await within(detailRegion()!).findByRole('alert')).toHaveTextContent('The workspace response could not be verified.');
    expect(screen.queryByText('Unverified detail reference')).not.toBeInTheDocument();
    expect(called(selectedPaymentPath)).toHaveLength(1);
    expect(called(evidencePath(momoId))).toHaveLength(0);
  });

  it.each(['denied','mixed groups'] as const)('drops Staff detail when analysis is %s', async failure => {
    mock.authMethod='phone_passcode';
    const analysis=pendingRead(), detail=pendingRead();
    mock.request.mockImplementation((path:string)=>path===selectedPaymentPath ? detail.promise : analysis.promise);
    visit(selectedPaymentUrl,['payments.read'],'staff');
    await waitFor(()=>expect(called(selectedPaymentPath)).toHaveLength(1));
    const signal=called(selectedPaymentPath)[0][1].signal;
    await act(async()=>{
      if (failure==='denied') analysis.reject(new AdminRequestError('Payment access changed.',{statusCode:403}));
      else analysis.resolve(buriPage([buriPayment,{...outgoing,groupId:'different-collection'}]));
    });
    expect(await screen.findByRole('alert')).toBeVisible();
    await waitFor(()=>expect(signal.aborted).toBe(true));
    await act(async()=>detail.resolve({...linked,ftId:'Late unverified record'}));
    expect(detailRegion()).not.toBeInTheDocument();
    expect(screen.queryByText('Late unverified record')).not.toBeInTheDocument();
    expect(called(selectedPaymentPath)).toHaveLength(1);
  });

  it('retries failed Staff analysis without reviving the retired detail', async () => {
    mock.authMethod='phone_passcode';
    const firstAnalysis=pendingRead(), retryAnalysis=pendingRead(), firstDetail=pendingRead(), retryDetail=pendingRead();
    let analyses=0, details=0;
    mock.request.mockImplementation((path:string)=>path===selectedPaymentPath
      ? (++details===1 ? firstDetail.promise : retryDetail.promise)
      : (++analyses===1 ? firstAnalysis.promise : retryAnalysis.promise));
    visit(selectedPaymentUrl,['payments.read'],'staff');
    await waitFor(()=>expect(called(selectedPaymentPath)).toHaveLength(1));
    const retired=called(selectedPaymentPath)[0][1].signal;
    await act(async()=>firstAnalysis.reject(new AdminRequestError('Analysis temporarily unavailable.',{statusCode:503})));
    const error=await screen.findByRole('alert');
    expect(error).toHaveTextContent('Analysis temporarily unavailable.');
    expect(detailRegion()).not.toBeInTheDocument();
    expect(screen.queryByText('Loading payment')).not.toBeInTheDocument();
    fireEvent.click(within(error).getByRole('button',{name:'Try again'}));
    await waitFor(()=>{
      expect(retired.aborted).toBe(true);
      expect(called('burimunsi/payments/analysis')).toHaveLength(2);
      expect(called(selectedPaymentPath)).toHaveLength(2);
    });
    await act(async()=>firstDetail.resolve({...linked,ftId:'Retired attempt'}));
    await act(async()=>retryAnalysis.resolve(buriPage([buriPayment])));
    expect(screen.queryByText('Retired attempt')).not.toBeInTheDocument();
    await act(async()=>retryDetail.resolve({...buriPayment,ftId:'Current attempt'}));
    expect(await within(detailRegion()!).findByText('Current attempt',{exact:true})).toBeVisible();
    expect(called(selectedPaymentPath)).toHaveLength(2);
  });

  it.each([2,1])('checks version after Staff scope is known and qualifies a single retry returning v%i', async nextVersion => {
    mock.authMethod='phone_passcode';
    const analysis=pendingRead(), newer=pendingRead();
    const first={...buriPayment,ftId:'Old detail'};
    let reads=0;
    mock.request.mockImplementation((path:string)=>path!==selectedPaymentPath ? analysis.promise :
      ++reads===1 ? Promise.resolve(first) : newer.promise);
    visit(selectedPaymentUrl,['payments.read'],'staff');
    await waitFor(()=>expect(called(selectedPaymentPath)).toHaveLength(1));
    await act(async()=>analysis.resolve(buriPage([{...buriPayment,version:2}])));
    await waitFor(()=>expect(called(selectedPaymentPath)).toHaveLength(2));
    expect(screen.queryByText(first.ftId)).not.toBeInTheDocument();
    await act(async()=>newer.resolve({...first,ftId:'Retry detail',version:nextVersion}));
    const confirmed=within(detailRegion()!);
    if (nextVersion===2) expect(await confirmed.findByText('Retry detail',{exact:true})).toBeVisible();
    else {
      expect(await confirmed.findByRole('alert')).toHaveTextContent('The payment changed.');
      expect(confirmed.queryByText('Retry detail')).not.toBeInTheDocument();
    }
    expect(called(selectedPaymentPath)).toHaveLength(2);
  });

  it.each([['off-page',[outgoing]],['empty',[]]] as const)('keeps the exact Staff detail on an %s page', async (_case,rows) => {
    mock.authMethod='phone_passcode';
    const analysis=pendingRead();
    mock.request.mockImplementation((path:string)=>path===selectedPaymentPath ? Promise.resolve(buriPayment) : analysis.promise);
    visit(selectedPaymentUrl,['payments.read'],'staff');
    await waitFor(()=>expect(called(selectedPaymentPath)).toHaveLength(1));
    expect(detailRegion()).not.toBeInTheDocument();
    await act(async()=>analysis.resolve(buriPage([...rows])));
    expect(await within(detailRegion()!).findByText(momoRef,{exact:true})).toBeVisible();
    expect(called(selectedPaymentPath)).toHaveLength(1);
  });

  it('leaves the serial route for legacy sessions without a scope attestation', async () => {
    mock.authMethod='phone_passcode';
    const analysis=pendingRead();
    mock.request.mockImplementation((path:string)=>path===selectedPaymentPath ? Promise.resolve(buriPayment) : analysis.promise);
    visit(selectedPaymentUrl,['payments.read']);
    await waitFor(()=>expect(called('burimunsi/payments/analysis')).toHaveLength(1));
    expect(called(selectedPaymentPath)).toHaveLength(0);
    await act(async()=>analysis.resolve(buriPage([outgoing])));
    expect(await within(detailRegion()!).findByText(momoRef,{exact:true})).toBeVisible();
    expect(called(selectedPaymentPath)).toHaveLength(1);
  });

  it.each(['epoch','permission'] as const)('retires the in-flight Staff detail when %s changes', async change => {
    mock.authMethod='phone_passcode';
    const old=pendingRead(), current=pendingRead();
    let reads=0;
    mock.request.mockImplementation((path:string)=>path===selectedPaymentPath
      ? ++reads===1 ? old.promise : current.promise : Promise.resolve(buriPage([buriPayment])));
    const app=visit(selectedPaymentUrl,['payments.read'],'staff');
    await waitFor(()=>expect(called(selectedPaymentPath)).toHaveLength(1));
    const signal=called(selectedPaymentPath)[0][1].signal;
    if (change==='epoch') mock.epoch++;
    else mock.permissions=[];
    app.rerender(<MemoryRouter initialEntries={[selectedPaymentUrl]}><RouteHarness /></MemoryRouter>);
    await waitFor(()=>expect(signal.aborted).toBe(true));
    await act(async()=>old.resolve({...linked,ftId:'Retired detail'}));
    expect(screen.queryByText('Retired detail')).not.toBeInTheDocument();
    if (change==='epoch') {
      await waitFor(()=>expect(called(selectedPaymentPath)).toHaveLength(2));
      await act(async()=>current.resolve({...buriPayment,ftId:'Current detail'}));
      expect(await within(detailRegion()!).findByText('Current detail',{exact:true})).toBeVisible();
    } else {
      expect(detailRegion()).not.toBeInTheDocument();
      expect(called(selectedPaymentPath)).toHaveLength(1);
    }
  });

  it.each(['missing reveal grant','missing scoped Admin','missing SMS grant','missing payments grant'])('never reads original text with %s', async missing => {
    mock.authMethod='phone_passcode'; mock.scoped=missing!=='missing scoped Admin';
    const absent = {'missing reveal grant':'sms.reveal','missing SMS grant':'sms.read','missing payments grant':'payments.read'}[missing];
    const grants=originalGrants.filter(x=>x!==absent);
    mock.request.mockImplementation(async(path:string)=>path==='burimunsi/payments/'+momoId?linked:buriPage([linked]));
    const view=visit('/admin/payments?payment='+momoId,grants);
    if (grants.includes('payments.read')) await screen.findByRole('region',{name:'Payment details',description:momoRef});
    else await waitFor(()=>expect(view.container.textContent).not.toContain('Loading fixture route'));
    expect(screen.queryByRole('region',{name:'Original SMS'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Review linked SMS'})).not.toBeInTheDocument();
    expect(called(evidencePath(momoId))).toHaveLength(0);
    expect(mock.request.mock.calls.filter(([path])=>path.includes('/content'))).toHaveLength(0);
  });

  it.each(['incorrect digest','wrong group','failed response','failed passcode proof'])('requires an explicit retry after %s and never displays the unverified text', async mode => {
    vi.stubGlobal('crypto',webcrypto); mock.authMethod='phone_passcode'; mock.scoped=true;
    let repaired=false;
    if (mode==='failed passcode proof') mock.recheck.mockResolvedValueOnce(false);
    mock.request.mockImplementation(async(path:string)=>{
      if (path==='burimunsi/payments/'+momoId) return linked;
      if (path===evidencePath(momoId)) return envelope(momoId,evidence(accountId));
      if (path!==bodyPath) return buriPage([linked]);
      if (repaired) return content;
      if (mode==='failed response') throw new Error('Unconfirmed audit');
      return mode==='wrong group' ? {...content,collectionId:'foreign'} : {...content,rawBody:'Invalid raw text'};
    });
    const url='/admin/payments?payment='+momoId;
    const view=visit(url,originalGrants,'admin',true);
    expect(await screen.findByText(/original SMS could not be verified/)).toBeVisible();
    const reads=mode==='failed passcode proof'?0:1;
    view.rerender(<MemoryRouter initialEntries={[url]}><RouteHarness /></MemoryRouter>);
    expect(called(bodyPath)).toHaveLength(reads);
    expect(screen.queryByText(/Invalid raw text|Unconfirmed audit/)).not.toBeInTheDocument();
    repaired=true;
    fireEvent.click(within(screen.getByRole('region',{name:'Original SMS'})).getByRole('button',{name:'Try again'}));
    expect(await screen.findByText(original)).toBeVisible();
    expect(called(bodyPath)).toHaveLength(reads+1);
  });

  it('discards an in-flight content response when permission is revoked', async () => {
    vi.stubGlobal('crypto',webcrypto); mock.authMethod='phone_passcode'; mock.scoped=true;
    const held=pendingRead();
    mock.request.mockImplementation(async(path:string)=>path==='burimunsi/payments/'+momoId?linked:
      path===evidencePath(momoId)?envelope(momoId,evidence(accountId)):path===bodyPath?held.promise:buriPage([linked]));
    const url='/admin/payments?payment='+momoId, app=visit(url,originalGrants);
    await waitFor(()=>expect(called(bodyPath)).toHaveLength(1));
    mock.permissions=['payments.read','sms.read'];
    app.rerender(<MemoryRouter initialEntries={[url]}><RouteHarness /></MemoryRouter>);
    await waitFor(()=>expect(called(bodyPath)[0][1].signal.aborted).toBe(true));
    await act(async()=>held.resolve(content));
    expect(screen.queryByRole('region',{name:'Original SMS'})).not.toBeInTheDocument();
    expect(screen.queryByText(original)).not.toBeInTheDocument();
  });

  it('never replays an interrupted audit when the same open payment resumes after an account check', async () => {
    vi.stubGlobal('crypto',webcrypto); mock.authMethod='phone_passcode'; mock.scoped=true; mock.permissions=originalGrants;
    const held=pendingRead();
    mock.request.mockImplementation(async(path:string)=>path==='burimunsi/payments/'+momoId?linked:
      path===evidencePath(momoId)?envelope(momoId,evidence(accountId)):path===bodyPath?held.promise:buriPage([linked]));
    const page = (suspended:boolean) => <MemoryRouter initialEntries={['/admin/payments?payment='+momoId]}>
      <InteractionSuspendedContext.Provider value={suspended}><RouteHarness /></InteractionSuspendedContext.Provider></MemoryRouter>;
    const view=render(page(false));
    await waitFor(()=>expect(called(bodyPath)).toHaveLength(1));
    mock.status='rechecking'; mock.currentAuthority=false; view.rerender(page(true));
    expect(screen.queryByRole('region',{name:'Original SMS'})).not.toBeInTheDocument();
    await act(async()=>held.resolve(content));
    mock.status='authenticated'; mock.currentAuthority=true; view.rerender(page(false));
    expect(await screen.findByText(/original SMS could not be verified/)).toBeVisible();
    expect(screen.queryByText(original)).not.toBeInTheDocument();
    expect(called(bodyPath)).toHaveLength(1);
  });

  it('does not request linked evidence for Staff even if stale detail includes a link', async () => {
    mock.authMethod='phone_passcode';
    mock.request.mockImplementation(async(path:string)=>path==='burimunsi/payments/'+momoId?linked:buriPage([buriPayment]));
    visit('/admin/payments?payment='+momoId,['payments.read','sms.read','sms.reveal'],'staff');
    expect(await screen.findByRole('region',{name:'Payment details',description:momoRef})).toBeVisible();
    expect(screen.queryByRole('region',{name:'Original SMS'})).not.toBeInTheDocument();
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
    const app=visit(url,originalGrants);
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
    expect(screen.queryByRole('region',{name:'Original SMS'})).not.toBeInTheDocument();
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
    expect(await screen.findByText(/original SMS could not be verified/)).toBeVisible();
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
    fireEvent.click(await screen.findByRole('button',{name:'Choose member'}));
    fireEvent.click(await screen.findByRole('button',{name:'Group member'}));
    const dialog = within(screen.getByRole('dialog',{name:'Allocate payment'}));
    fireEvent.click(dialog.getByRole('button',{name:'Review allocation'}));
    expect(attempts).toBe(0);
    fireEvent.click(dialog.getByRole('button',{name:'Confirm allocation'}));
    expect(await dialog.findByText(/Allocation was not confirmed/)).toBeVisible();
    expect(dialog.queryByRole('button',{name:'Retry allocation'})).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button',{name:'Check request'}));
    fireEvent.click(await dialog.findByRole('button',{name:'Retry allocation'}));
    await waitFor(() => expect(within(screen.getByRole('row',{name:/MOMO-FIXTURE-01/})).getByTitle('Allocated')).toBeVisible());
    expect(within(await screen.findByRole('region',{name:'Payment details'})).getByRole('link',{name:'Review allocation request'})).toBeVisible();
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
    fireEvent.click(await screen.findByRole('button',{name:'Choose member'}));
    fireEvent.click(await screen.findByRole('button',{name:'Group member'}));
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
