import {webcrypto} from 'node:crypto';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {AdminRequestError, AdminTransportError, type AdminRequest, type JsonObject} from '../../src/api/contracts';
import type {AdminUser} from '../../src/session/sessionResponses';
import {PaymentAllocationWizard} from '../../src/features/operations/PaymentAllocationWizard';
import {PENDING_KEY} from '../../src/features/core/pendingAttempt';

const session = vi.hoisted(() => ({read:vi.fn()}));
vi.mock('../../src/session/SessionProvider', () => ({useSession:session.read}));
const actor: AdminUser = {id:'actor',sessionId:'session-one',role:'staff',email:'',authMethod:'phone_passcode',permissions:['payments.read'],
  principalId:'principal',financialModel:'canonical_evidence_ledger',assuranceLevel:1,emailVerifiedAt:null,mfaAt:null,expiresAt:'2100-01-01T00:00:00Z'};
const payment = {id:'payment-one',groupId:'group-one',ftId:'FT1000',version:5,atRaw:'2026-11-24T08:22:11Z',
  direction:'incoming',amountRwf:10500,payerNameRaw:'Synthetic counterparty',state:'unallocated',memberId:null,memberName:null,canAllocate:true};
const first = {id:'member-one',name:'Sample member'}, second = {id:'member-two',name:'Sample member'};
const path = 'burimunsi/payments/' + payment.id;
const receipt = {paymentId:payment.id,memberId:second.id,state:'allocated',version:6};
const callbacks = () => ({onAllocated:vi.fn(),onStale:vi.fn(),onClose:vi.fn()});
function api(result: JsonObject = payment, members = [first,second]) {
  return vi.fn<AdminRequest>(async (url, options) => {
    if (url === path) return result;
    if (url.startsWith('burimunsi/payments/members?')) return {items:members};
    if (url === path + '/allocate' && options?.method === 'POST') return receipt;
    if (url === path + '/allocation-receipt') return {state:'unconfirmed',requestId:options!.idempotencyKey!};
    throw Error('Unexpected request');
  });
}
function open(request:AdminRequest, call = callbacks(), active = () => true) {
  session.read.mockReturnValue({user:actor,status:'authenticated',epoch:1,request,isCurrentAuthority:active});
  return {...render(<PaymentAllocationWizard id={payment.id} group={payment.groupId} {...call}/>), ...call};
}
async function review() {
  const select = await screen.findByRole('combobox',{name:'Member'});
  const dialog = within(screen.getByRole('dialog',{name:'Allocate payment'}));
  fireEvent.change(select,{target:{value:second.id}});
  fireEvent.click(dialog.getByRole('button',{name:'Review allocation'}));
  expect(await dialog.findByRole('heading',{name:'Review allocation'})).toHaveFocus();
  return dialog;
}
beforeEach(() => {
  Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
  sessionStorage.clear();
});

describe('payment allocation wizard', () => {
  it('shows the SMS payer and only the last three phone digits and lets the operator choose an exact name match', async () => {
    const matching = {id:second.id,name:'Élise Kayira'};
    const number = '+250 78 000 0419';
    const request = api({...payment,payerNameRaw:'E\u0301LISE   KAYIRA',payerPhoneRaw:number},[first,matching]);
    open(request);
    const hint = await screen.findByRole('button',{name:'Select suggested member Élise Kayira'});
    const dialog = within(screen.getByRole('dialog',{name:'Allocate payment'}));
    const choice = dialog.getByRole('combobox',{name:'Member'});
    expect(choice).toHaveValue('');
    expect(dialog.getByText('Payer name').nextElementSibling).toHaveTextContent('E\u0301LISE KAYIRA');
    expect(dialog.getByText('Payer MoMo ending').nextElementSibling).toHaveTextContent(/^419$/);
    expect(dialog.getByText('Time').nextElementSibling).toHaveTextContent('10:22:11');
    expect(dialog.queryByText(number)).not.toBeInTheDocument();
    expect(dialog.queryByText(/direction|time \(kigali\)|phone match/i)).not.toBeInTheDocument();
    expect(dialog.getByRole('button',{name:'Review allocation'})).toBeDisabled();
    fireEvent.click(hint);
    expect(choice).toHaveValue(second.id);
    fireEvent.click(dialog.getByRole('button',{name:'Review allocation'}));
    expect((await dialog.findByText('Member ID')).nextElementSibling).toHaveTextContent(second.id);
    expect(dialog.getByText('Payer MoMo ending').nextElementSibling).toHaveTextContent(/^419$/);
    expect(request.mock.calls.some(([,options]) => options?.method === 'POST')).toBe(false);
  });

  it('labels an outgoing SMS recipient, preserves a masked leading-zero suffix and handles a missing name', async () => {
    const request = api({...payment,direction:'outgoing',payerNameRaw:' ',payerPhoneRaw:'078***0007'});
    open(request);
    await screen.findByRole('combobox',{name:'Member'});
    expect(screen.getByText('Recipient name').nextElementSibling).toHaveTextContent('Not recorded');
    expect(screen.getByText('Recipient MoMo ending').nextElementSibling).toHaveTextContent(/^007$/);
    expect(screen.queryByRole('button',{name:/select suggested member/i})).not.toBeInTheDocument();
    expect(screen.queryByText('078***0007')).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(['000071','FT000071','071','***71','***071x',null])('does not infer phone digits from %s', async identifier => {
    open(api({...payment,payerPhoneRaw:identifier}));
    await screen.findByRole('combobox',{name:'Member'});
    expect(screen.getByText('Payer MoMo ending').nextElementSibling).toHaveTextContent('Not recorded');
  });

  it('keeps a number repeated in the SMS name field private and does not treat part of a name as an exact match', async () => {
    const number = '0780000419';
    const ui = open(api({...payment,payerNameRaw:number,payerPhoneRaw:number}));
    await screen.findByRole('combobox',{name:'Member'});
    expect(screen.getByText('Payer name').nextElementSibling).toHaveTextContent('Not recorded');
    expect(screen.queryByText(number)).not.toBeInTheDocument();
    ui.unmount();
    open(api({...payment,payerNameRaw:'Sample'},[first]));
    const choice=await screen.findByRole('combobox',{name:'Member'});
    expect(screen.queryByRole('button',{name:/select suggested member/i})).not.toBeInTheDocument();
    expect(choice).toHaveValue('');
  });

  it('keeps duplicate normalized names as manual choices and does not suggest a partial name', async () => {
    const request = api({...payment,payerNameRaw:'SAMPLE MEMBER',payerPhoneRaw:'xxx816'},
      [first,{id:second.id,name:'sample   member'},{id:'longer-member',name:'Sample Member Jones'}]);
    open(request);
    const choice = await screen.findByRole('combobox',{name:'Member'});
    expect(screen.getByText('Several group members match the SMS name. Choose the intended member.')).toBeVisible();
    expect(screen.queryByRole('button',{name:/select suggested member/i})).not.toBeInTheDocument();
    expect(within(choice).getByRole('option',{name:'Sample member · member-one'})).toBeInTheDocument();
    expect(within(choice).getByRole('option',{name:'sample member · member-two'})).toBeInTheDocument();
    expect(choice).toHaveValue('');
    expect(screen.getByRole('button',{name:'Review allocation'})).toBeDisabled();
  });

  it.each([false,true])('searches beyond the first 25 active members and avoids a single suggestion on a capped search (%s)', async capped => {
    const groupPage = Array.from({length:25},(_,i) => ({id:'group-'+i,name:'Group member '+i}));
    const name = 'Célestine A.', target = {id:'target',name};
    const base = api({...payment,payerNameRaw:name},groupPage);
    const request=vi.fn<AdminRequest>((url,options) => {
      if (url.startsWith('burimunsi/payments/members?') && new URLSearchParams(url.split('?')[1]).get('q') === 'célestine') {
        return Promise.resolve({items:capped ? [target,...groupPage.slice(0,24)] : [target]});
      }
      return base(url,options);
    });
    open(request);
    const choice=await screen.findByRole('combobox',{name:'Member'});
    await within(choice).findByRole('option',{name});
    expect(choice).toHaveValue('');
    if (capped) expect(screen.queryByRole('button',{name:/select suggested member/i})).not.toBeInTheDocument();
    else {
      fireEvent.click(screen.getByRole('button',{name:'Select suggested member ' + name}));
      expect(choice).toHaveValue(target.id);
    }
    expect(request.mock.calls.some(([,options]) => options?.method === 'POST')).toBe(false);
  });

  it('reads the scoped payment first, reviews the exact selected member, and makes no write on Back or Cancel', async () => {
    const request = api(), ui = open(request);
    const select = await screen.findByRole('combobox',{name:'Member'});
    expect(within(select).getByRole('option',{name:'Sample member · member-two'})).toBeInTheDocument();
    expect(request.mock.calls.map(([url]) => url)).toEqual([path,'burimunsi/payments/members?q=&limit=25']);
    expect(screen.getByRole('button',{name:'Review allocation'})).toBeDisabled();
    const dialog = await review();
    expect(dialog.getByText('RWF 10,500')).toBeVisible();
    expect(dialog.getByText('FT1000')).toBeVisible();
    expect(dialog.getByText(second.id)).toBeVisible();
    fireEvent.click(dialog.getByRole('button',{name:'Back'}));
    expect(await dialog.findByRole('textbox',{name:'Search group members'})).toHaveFocus();
    fireEvent.change(dialog.getByRole('textbox',{name:'Search group members'}),{target:{value:'Sample'}});
    fireEvent.click(dialog.getByRole('button',{name:'Search'}));
    await waitFor(() => expect(request).toHaveBeenCalledWith('burimunsi/payments/members?q=Sample&limit=25',{signal:expect.any(AbortSignal)}));
    fireEvent.click(dialog.getByRole('button',{name:'Cancel'}));
    expect(ui.onClose).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(([,opt]) => opt?.method === 'POST')).toBe(false);
  });

  it('preserves an unconfirmed allocation across close and reopens with the identical key, member and version', async () => {
    const original = api(), request = vi.fn<AdminRequest>(async (url,options) => {
      if (url === path + '/allocate' && original.mock.calls.every(([endpoint]) => endpoint !== url)) {
        await original(url,options);
        throw new AdminTransportError('Unconfirmed');
      }
      return original(url,options);
    });
    const ui = open(request);
    const dialog = await review();
    fireEvent.click(dialog.getByRole('button',{name:'Confirm allocation'}));
    expect(await dialog.findByText(/Allocation was not confirmed/)).toBeVisible();
    expect(dialog.queryByRole('button',{name:'Back'})).not.toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_KEY)).not.toContain(second.name);
    ui.unmount();
    const restored = open(request);
    const check = await screen.findByRole('button',{name:'Check request'});
    expect(screen.queryByRole('button',{name:'Retry allocation'})).not.toBeInTheDocument();
    expect(request.mock.calls.filter(([,options]) => options?.method === 'POST')).toHaveLength(1);
    fireEvent.click(check);
    fireEvent.click(await screen.findByRole('button',{name:'Retry allocation'}));
    await waitFor(() => expect(restored.onAllocated).toHaveBeenCalledOnce());
    const posts = request.mock.calls.filter(([,options]) => options?.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(posts[0]).toEqual([path+'/allocate',{method:'POST',idempotencyKey:expect.any(String),body:{memberId:second.id,expectedVersion:5}}]);
    expect(screen.getByText('Payment allocated.')).toBeVisible();
  });

  it.each([
    {reason:'assigned',data:{...payment,state:'allocated',memberId:first.id,memberName:first.name},message:'This payment is already allocated to Sample member.'},
    {reason:'read-only',data:{...payment,canAllocate:false},message:'Allocation is unavailable for this payment.'},
  ])('does not request candidates or offer a write for a $reason payment', async ({data,message}) => {
    const request = api(data), ui = open(request);
    expect(await screen.findByText(message)).toBeVisible();
    expect(request.mock.calls.map(([url]) => url)).toEqual([path]);
    expect(ui.onStale).toHaveBeenCalledOnce();
    expect(screen.getByRole('button',{name:'Close'})).toBeEnabled();
  });

  it('rejects a mismatched collection or payment identity without requesting members', async () => {
    for (const row of [{...payment,groupId:'different'},{...payment,id:'different'}]) {
      const request = api(row), ui = open(request);
      expect(await screen.findByRole('heading',{name:'Payment unavailable'})).toBeVisible();
      expect(request).toHaveBeenCalledTimes(1);
      expect(ui.onAllocated).not.toHaveBeenCalled();
      ui.unmount();
    }
  });

  it('stops a stale/version conflict without replaying the write or offering a different member', async () => {
    const original = api(), request = vi.fn<AdminRequest>((url,options) => {
      if (options?.method === 'POST') throw new AdminRequestError('Changed',{statusCode:409,code:'payment_changed'});
      return original(url,options);
    });
    const ui = open(request), dialog = await review();
    fireEvent.click(dialog.getByRole('button',{name:'Confirm allocation'}));
    expect(await dialog.findByText(/allocation access changed/)).toBeVisible();
    expect(ui.onStale).toHaveBeenCalledOnce();
    expect(ui.onAllocated).not.toHaveBeenCalled();
    expect(dialog.queryByRole('button',{name:'Retry allocation'})).not.toBeInTheDocument();
    expect(request.mock.calls.filter(([,options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it('does not issue a write after authority changes or publish another session’s late response', async () => {
    let current = true, complete!: (value:JsonObject) => void;
    const original = api(), request = vi.fn<AdminRequest>((url,options) => options?.method === 'POST'
      ? new Promise(resolve => {complete=resolve;}) : original(url,options));
    const ui = open(request,callbacks(),() => current), dialog = await review();
    current = false;
    fireEvent.click(dialog.getByRole('button',{name:'Confirm allocation'}));
    expect(request.mock.calls.some(([,options]) => options?.method === 'POST')).toBe(false);
    current = true;
    fireEvent.click(dialog.getByRole('button',{name:'Confirm allocation'}));
    await waitFor(() => expect(complete).toBeDefined());
    current = false;
    await act(async () => complete(receipt));
    expect(ui.onAllocated).not.toHaveBeenCalled();
    expect(ui.onStale).not.toHaveBeenCalled();
  });
});
