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
function api(result: JsonObject = payment) {
  return vi.fn<AdminRequest>(async (url, options) => {
    if (url === path) return result;
    if (url.startsWith('burimunsi/payments/members?')) return {items:[first,second]};
    if (url === path + '/allocate' && options?.method === 'POST') return receipt;
    throw Error('Unexpected request');
  });
}
function open(request:AdminRequest, call = callbacks(), active = () => true) {
  session.read.mockReturnValue({user:actor,status:'authenticated',epoch:1,request,isCurrentAuthority:active});
  return {...render(<PaymentAllocationWizard id={payment.id} group={payment.groupId} {...call}/>), ...call};
}
async function review() {
  const dialog = within(await screen.findByRole('dialog',{name:'Allocate payment'}));
  const select = await dialog.findByRole('combobox',{name:'Member'});
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
    const retry = await screen.findByRole('button',{name:'Retry allocation'});
    expect(request.mock.calls.filter(([,options]) => options?.method === 'POST')).toHaveLength(1);
    fireEvent.click(retry);
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
