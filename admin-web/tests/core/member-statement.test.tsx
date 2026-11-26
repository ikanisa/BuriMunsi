import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MemoryRouter} from 'react-router';
import {describe, expect, it, vi} from 'vitest';
import {AdminRequestError} from '../../src/api/client';
import {CoreRecordPage} from '../../src/features/core/CoreRecordPage';
import {MemberStatementPage} from '../../src/features/core/MemberStatementPage';
import {readMemberStatement, readMemberStatementPage} from '../../src/features/core/memberStatement';
import {memberStatementCsv} from '../../src/features/core/memberStatementDownload';
import type {AdminRequest} from '../../src/features/core/types';
import fixture from './canonical-core-fixtures.json';

const person = {...fixture.members.rows[0], membership_status: 'active', momo_pay_code: '003314'};
const group = 'group-a', actor = 'account-a', internal = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', number = '010000020003';
const membership = {id: internal, user_id: person.id, group_id: group, group_title: 'Member group',
  public_id: person.public_id, role: 'member', status: 'active', membership_record_number: number};
const detail = {contract_version: 2, model: 'canonical_evidence_ledger', current_actor_id: actor,
  resource_type: 'members', can_manage: false, resource: person, related: {memberships: [membership]}, related_truncated: false};
const grants = ['users.read', 'collections.read', 'payments.read'];
const profilePath = 'operations/members/' + person.id;
const time = '2026-11-24T12:00:00Z';
const revision = 'c'.repeat(64);
function payment(n: number, incoming = true, amount = n + 1) {
  return {id: 'p-' + n, direction: incoming ? 'incoming' : 'outgoing', amountRwf: amount,
    atRaw: time, ftId: 'FT-' + String(n).padStart(4, '0')};
}
function statement(rows: ReturnType<typeof payment>[], offset = 0) {
  let running = 0n;
  const items = rows.map(row => ({...row,
    balanceRwf: String(running += BigInt(row.amountRwf) * (row.direction === 'incoming' ? 1n : -1n))}));
  return {groupId: group, memberId: person.id, membershipId: internal, offset, limit: 25,
    totalCount: rows.length, revision, closingRwf: String(running), items: items.slice(offset, offset + 25)};
}
function source(rows: ReturnType<typeof payment>[], profile: Record<string, unknown> = detail) {
  return vi.fn(async (path: string) => {
    if (path === profilePath + '?include=statement') return {...profile, member_statement: statement(rows)};
    if (path === profilePath) return profile;
    const [resource, search] = path.split('?'), q = new URLSearchParams(search);
    expect(resource).toBe('burimunsi/payments');
    expect(q.get('memberId')).toBe(person.id);
    expect(q.get('statement')).toBe('1');
    const offset = Number(q.get('offset'));
    if (offset > 0) expect(q.get('revision')).toBe(revision);
    return statement(rows, offset);
  });
}
const props = {id: person.id, expectedGroup: group, permissions: grants, actorId: actor, principalId: null,
  role: 'staff' as const, authorityKey: 'signed-in-staff', financialModel: 'canonical_evidence_ledger' as const, navigate: vi.fn()};

describe('scoped member statement', () => {
  it('opens an inline credit by keyboard, preserves the balance link and returns focus without another request', async () => {
    const user = userEvent.setup(), request = source([payment(1, true, 1250), payment(2, false, 100)]);
    render(<MemoryRouter><CoreRecordPage {...props} area="members" scopedMember request={request} /></MemoryRouter>);
    const reference = await screen.findByRole('button', {name:'View transaction FT-0001'});
    expect(reference).toHaveAttribute('aria-haspopup', 'dialog');
    reference.focus();
    await user.keyboard('{Enter}');
    const dialog = within(screen.getByRole('dialog', {name:'Transaction details'}));
    expect(dialog.getByText('Credit').nextElementSibling).toHaveTextContent('RWF 1,250');
    expect(dialog.getByText('Running balance').nextElementSibling).toHaveTextContent('RWF 1,250');
    expect(dialog.getByText('Reference').nextElementSibling).toHaveTextContent('FT-0001');
    expect(dialog.getByText('Date (Kigali)').nextElementSibling).toHaveTextContent('24 Nov 2026, 14:00:00');
    expect(dialog.getByRole('button', {name:'Close dialog'})).toHaveFocus();
    await user.tab();
    expect(dialog.getByRole('button', {name:'Close dialog'})).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(reference).toHaveFocus();
    expect(screen.getByRole('link', {name:'Open member statement, total balance RWF 1,150'})).toBeVisible();
    expect(request.mock.calls.map(([path]) => path)).toEqual([profilePath + '?include=statement']);
  });

  it('selects an unreferenced debit on the standalone view without leaking record IDs or keeping it open after access changes', async () => {
    const raw = statement([payment(1, false, 10)]);
    const request = vi.fn(async () => ({...detail, member_statement:{...raw, items:[{...raw.items[0], ftId:null, atRaw:'provider time unknown'}]}}));
    const view = render(<MemoryRouter><MemberStatementPage {...props} request={request} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', {name:'View transaction, Debit, RWF 10, provider time unknown'}));
    const dialog = within(screen.getByRole('dialog', {name:'Transaction details'}));
    expect(dialog.getByText('Debit').nextElementSibling).toHaveTextContent('RWF 10');
    expect(dialog.getByText('Running balance').nextElementSibling).toHaveTextContent('RWF -10');
    expect(dialog.getByText('Reference').nextElementSibling).toHaveTextContent('Not recorded');
    expect(dialog.queryByText('p-1')).not.toBeInTheDocument();
    expect(dialog.queryByText(internal)).not.toBeInTheDocument();
    view.rerender(<MemoryRouter><MemberStatementPage {...props} permissions={['users.read']} request={request} /></MemoryRouter>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name:'Download statement'})).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('downloads the whole pinned statement from a later page with literal text, exact debits, credits and balances', async () => {
    const rows = Array.from({length: 51}, (_, index) => payment(index, index !== 50, 4));
    rows[0].ftId = '=first,"quoted"';
    rows[1].ftId = 'FT-line1\nline2';
    const request = source(rows);
    const signal = new AbortController().signal;
    const first = await readMemberStatement(request, signal, person.id, actor, group, {offset:0});
    const middle = await readMemberStatementPage(request, signal, person.id, first.membership, {offset:25, revision});
    request.mockClear();
    const csv = await memberStatementCsv(middle, first.membership, request, signal);
    expect(csv).toContain('Opening balance,,,,,0\r\nTransaction,"24 Nov 2026, 14:00:00","\'=first,""quoted""",,4,4');
    expect(csv).toContain('"FT-line1\nline2",,4,8');
    expect(csv).toContain('Transaction,"24 Nov 2026, 14:00:00","FT-0050",4,,196\r\nClosing balance,,,,,196\r\n');
    expect(csv.match(/^Transaction,/gm)).toHaveLength(51);
    for (const hidden of [internal, person.id, 'p-25', person.phone_e164, person.momo_number]) if (hidden) expect(csv).not.toContain(hidden);
    expect(request.mock.calls.map(([path])=>path)).toEqual([0,50].map(offset =>
      'burimunsi/payments?statement=1&memberId=' + person.id + '&offset=' + offset + '&revision=' + revision));
  });

  it('offers no partial file if another page repeats a payment or the revision changes, and can refresh the statement', async () => {
    const rows = Array.from({length: 26}, (_, index) => payment(index));
    const data = source(rows);
    const request = vi.fn(async (path: string) => {
      if (!path.includes('offset=25')) return data(path);
      const page = statement(rows, 25);
      return {...page, items:[{...page.items[0], id:rows[0].id}]};
    });
    render(<MemoryRouter><CoreRecordPage {...props} area="members" scopedMember request={request} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', {name:'Download statement'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not prepare the complete statement');
    expect(screen.queryByRole('link',{name:'Download statement'})).not.toBeInTheDocument();
    expect(screen.getByRole('table',{name:'Member transactions'})).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'Refresh statement'}));
    expect(await screen.findByRole('button',{name:'Download statement'})).toBeVisible();
    expect(request.mock.calls.at(-1)?.[0]).toMatch(/offset=0$/);
    const signal = new AbortController().signal;
    const first = await readMemberStatement(data, signal, person.id, actor, group, {offset:0});
    const stale = vi.fn(async () => {throw new AdminRequestError('Changed', {code:'member_statement_changed',statusCode:409});});
    await expect(memberStatementCsv(first, first.membership, stale, signal)).rejects.toThrow('The statement changed');
  });

  it('starts a real CSV download for a verified empty statement and revokes the link when the view closes', async () => {
    const create = vi.fn<typeof URL.createObjectURL>(() => 'blob:https://example.test/statement'), revoke = vi.fn<typeof URL.revokeObjectURL>();
    vi.stubGlobal('URL', class extends URL {static createObjectURL = create; static revokeObjectURL = revoke;});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const request = source([]);
    const view = render(<MemoryRouter><MemberStatementPage {...props} request={request} /></MemoryRouter>);
    try {
      fireEvent.click(await screen.findByRole('button', {name:'Download statement'}));
      const link = await screen.findByRole('link', {name:'Download statement'});
      expect(link).toHaveAttribute('download','burimunsi-member-statement.csv');
      expect(link).toHaveAttribute('href','blob:https://example.test/statement');
      expect(click.mock.instances).toEqual([link]);
      const file = create.mock.calls[0][0] as Blob;
      expect(file.type).toBe('text/csv;charset=utf-8');
      const csv = await new Response(await file.arrayBuffer()).text();
      expect(csv).toContain('Opening balance,,,,,0\r\nClosing balance,,,,,0');
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      expect(revoke).toHaveBeenCalledWith('blob:https://example.test/statement');
      vi.unstubAllGlobals();
    }
  });

  it('aborts a running export on authority loss and discards any late page', async () => {
    const rows = Array.from({length:26}, (_, i) => payment(i));
    const regular = source(rows);
    let signal: AbortSignal | undefined, release: (() => void) | undefined;
    const request: AdminRequest = async (path, options) => {
      if (!path.includes('offset=25')) return regular(path);
      signal = options?.signal;
      await new Promise<void>(resolve => {release = resolve;});
      return statement(rows, 25);
    };
    const view = render(<MemoryRouter><MemberStatementPage {...props} request={request} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', {name:'Download statement'}));
    await waitFor(() => expect(signal).toBeDefined());
    view.rerender(<MemoryRouter><MemberStatementPage {...props} authorityKey="new-session" permissions={['users.read']} request={request} /></MemoryRouter>);
    expect(signal?.aborted).toBe(true);
    await act(async () => {release?.();});
    expect(screen.queryByRole('link',{name:'Download statement'})).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('cannot open this member statement');
  });
  it('opens the inline transaction history from one scoped profile read, then pages on the original revision', async () => {
    const rows = Array.from({length: 26}, (_, index) => payment(index, index !== 25, 4));
    const request = source(rows);
    render(<MemoryRouter><CoreRecordPage {...props} role="admin" permissions={[...grants,'users.manage']} area="members"
      scopedMember simplePayments request={request} returnTo="/admin/members?status=inactive" /></MemoryRouter>);
    const table = within(await screen.findByRole('table', {name:'Member transactions'}));
    expect(table.getByRole('row', {name:/FT-0000/})).toBeVisible();
    expect(table.queryByText(time)).not.toBeInTheDocument();
    expect(screen.getByText('Record ID').nextElementSibling).toHaveTextContent(number);
    expect(screen.getByText('Closing balance').nextElementSibling).toHaveTextContent('RWF 96');
    expect(screen.getByRole('link', {name:'Open member statement, total balance RWF 96'})).toHaveAttribute('href',
      '/admin/members/' + person.id + '/statement?returnTo=' + encodeURIComponent('/admin/members?status=inactive'));
    expect(screen.queryByText('MoMo provider')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name:'Check person change request'})).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', {name:'Memberships'})).not.toBeInTheDocument();
    expect(request.mock.calls.map(([path]) => path)).toEqual([profilePath + '?include=statement']);
    fireEvent.click(screen.getByRole('button', {name:'Next'}));
    expect(await screen.findByRole('row', {name:/FT-0025/})).toBeVisible();
    expect(screen.getByText('Record ID').nextElementSibling).toHaveTextContent(number);
    expect(request.mock.calls.map(([path]) => path)).toEqual([profilePath + '?include=statement',
      'burimunsi/payments?statement=1&memberId=' + person.id + '&offset=25&revision=' + revision]);
  });

  it('keeps the record number visible with membership access but never reads money without all statement permissions', async () => {
    const request = source([]);
    render(<MemoryRouter><CoreRecordPage {...props} area="members" scopedMember permissions={['users.read','collections.read']}
      request={request} /></MemoryRouter>);
    expect((await screen.findByText('Record ID')).nextElementSibling).toHaveTextContent(number);
    expect(screen.queryByText('Closing balance')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', {name:'Member statement'})).not.toBeInTheDocument();
    expect(request.mock.calls.map(([path]) => path)).toEqual([profilePath]);
  });

  it('keeps the profile available after a statement failure and independently retries the first scoped payment page', async () => {
    const regular = source([payment(1, false, 5)]);
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('?include=statement')) throw new AdminRequestError('Unavailable', {statusCode:503,code:'operation_unavailable'});
      return regular(path);
    });
    render(<MemoryRouter><CoreRecordPage {...props} area="members" scopedMember request={request} /></MemoryRouter>);
    expect(await screen.findByRole('heading', {name:'Member statement unavailable'})).toBeVisible();
    expect(screen.getByText('Record ID').nextElementSibling).toHaveTextContent(number);
    expect(screen.queryByText('Closing balance')).not.toBeInTheDocument();
    expect(request.mock.calls.map(([path]) => path)).toEqual([profilePath + '?include=statement',profilePath]);
    fireEvent.click(screen.getByRole('button',{name:'Try again'}));
    expect(await screen.findByRole('table',{name:'Member transactions'})).toBeVisible();
    expect(screen.getByText('Closing balance').nextElementSibling).toHaveTextContent('RWF -5');
    expect(request.mock.calls.map(([path]) => path)).toEqual([profilePath + '?include=statement',profilePath,
      'burimunsi/payments?statement=1&memberId=' + person.id + '&offset=0']);
  });

  it('withholds a mismatched inline statement and never shows or reads a foreign membership', async () => {
    const request = vi.fn(async () => ({...detail, member_statement:{...statement([payment(1)]),groupId:'foreign'}}));
    const ui = render(<MemoryRouter><CoreRecordPage {...props} area="members" scopedMember request={request} /></MemoryRouter>);
    expect(await screen.findByRole('heading', {name:'Member statement unavailable'})).toBeVisible();
    expect(screen.getByText('Record ID').nextElementSibling).toHaveTextContent(number);
    expect(screen.queryByText('FT-0001')).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
    ui.unmount();
    const foreign = source([], {...detail,related:{memberships:[{...membership,group_id:'foreign'}]}});
    render(<MemoryRouter><CoreRecordPage {...props} area="members" scopedMember request={foreign} /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('The record could not be verified');
    expect(screen.queryByText(number)).not.toBeInTheDocument();
    expect(foreign).toHaveBeenCalledTimes(1);
  });

  it('reads one scoped page with exact balances even when the statement totals exceed JavaScript integer precision', async () => {
    const rows = Array.from({length: 105}, (_, i) => payment(i, i % 2 === 0, 100));
    const api = source(rows);
    const signal = new AbortController().signal;
    const result = await readMemberStatement(api, signal, person.id, actor, group, {offset: 0});
    expect(api.mock.calls.map(([path]) => path)).toEqual([profilePath + '?include=statement']);
    expect(result.items).toHaveLength(25);
    expect(result.items[0]).toMatchObject({ftId: 'FT-0000', atRaw: time, balanceRwf: 100n});
    expect(result.closingRwf).toBe(100n);
    expect((await readMemberStatementPage(source([payment(1, true, Number.MAX_SAFE_INTEGER),
      payment(2, true, Number.MAX_SAFE_INTEGER)]), signal, person.id, {id: internal, groupId: group})).closingRwf)
      .toBe(2n * BigInt(Number.MAX_SAFE_INTEGER));
  });

  it('distinguishes a verified zero from a negative balance and rejects a malformed or restricted transaction projection', async () => {
    const signal = new AbortController().signal;
    const scope = {id: internal, groupId: group};
    expect(await readMemberStatementPage(source([]), signal, person.id, scope)).toMatchObject({items: [], closingRwf: 0n});
    expect((await readMemberStatementPage(source([payment(1, false, 5)]), signal, person.id, scope)).closingRwf).toBe(-5n);
    const base = statement([payment(1)]);
    for (const item of [{...base.items[0], amountRwf: null}, {...base.items[0], balanceRwf: '999'},
      {...base.items[0], sourceId: 'restricted'}, {...base.items[0], amountRwf: 1.5}]) {
      await expect(readMemberStatementPage(async () => ({...base, items: [item]}), signal, person.id, scope)).rejects.toThrow();
    }
  });

  it('rejects foreign group and member responses and never issues a financial read without a verified membership', async () => {
    for (const bad of [{...membership, group_id: 'other-group'}, {...membership, user_id: 'other-user'},
      {...membership, group_id: undefined}, {...membership, user_id: undefined}]) {
      const api = source([], {...detail, related: {memberships: [bad]}});
      await expect(readMemberStatement(api, new AbortController().signal, person.id, actor, group, {offset: 0})).rejects.toThrow();
      expect(api).toHaveBeenCalledTimes(1);
    }
    const base = statement([payment(1)]);
    for (const bad of [{...base, groupId: 'other-group'}, {...base, memberId: 'other-user'}, {...base, membershipId: 'other-membership'}]) {
      const api = vi.fn().mockResolvedValue(bad);
      await expect(readMemberStatementPage(api, new AbortController().signal, person.id, {id: internal, groupId: group})).rejects.toThrow();
    }
  });

  it('falls back only for an older server’s explicit unsupported filter and still proves membership before requesting money', async () => {
    const current = source([payment(1)]);
    const signal = new AbortController().signal;
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('?include=statement')) throw new AdminRequestError('Unsupported', {statusCode: 400, code: 'invalid_filter'});
      return current(path);
    });
    expect((await readMemberStatement(request, signal, person.id, actor, group, {offset: 0})).closingRwf).toBe(2n);
    expect(request.mock.calls.map(([path]) => path)).toEqual([profilePath + '?include=statement', profilePath,
      'burimunsi/payments?statement=1&memberId=' + person.id + '&offset=0']);
    const denied = vi.fn(async () => {throw new AdminRequestError('Denied', {statusCode: 403, code:'access_denied'});});
    await expect(readMemberStatement(denied, signal, person.id, actor, group, {offset: 0})).rejects.toThrow('Denied');
    expect(denied).toHaveBeenCalledTimes(1);
    await expect(readMemberStatement(async () => ({...detail, member_statement: {...statement([]), membershipId:'foreign'}}),
      signal, person.id, actor, group, {offset: 0})).rejects.toThrow('The statement scope changed.');
  });

  it('shows an unavailable record number without disclosing an internal identifier for older membership records', async () => {
    const request = source([], {...detail,related:{memberships:[{...membership,membership_record_number:undefined}]}});
    render(<MemoryRouter><CoreRecordPage {...props} area="members" scopedMember request={request} /></MemoryRouter>);
    expect((await screen.findByText('Record ID')).nextElementSibling).toHaveTextContent('Unavailable');
    expect(screen.queryByText(internal)).not.toBeInTheDocument();
    expect(await screen.findByRole('heading',{name:'No member transactions'})).toBeVisible();
  });

  it('shows original times and references, debit and credit, and whole-statement running balances on later display pages', async () => {
    const request = source(Array.from({length: 26}, (_, i) => payment(i, i !== 25, 4)));
    render(<MemoryRouter><MemberStatementPage {...props} request={request} /></MemoryRouter>);
    const table = within(await screen.findByRole('table', {name: 'Member transactions'}));
    expect(screen.getByText('Closing balance').nextElementSibling).toHaveTextContent('RWF 96');
    const first = within(table.getByRole('row', {name: /FT-0000/}));
    expect(first.getByText(time)).toBeVisible();
    expect(first.getAllByRole('cell').map(cell => cell.textContent).slice(2)).toEqual(['—', '4', '4']);
    fireEvent.click(screen.getByRole('button', {name: 'Next'}));
    const last = await screen.findByRole('row', {name: /FT-0025/});
    expect(within(screen.getByRole('table', {name: 'Member transactions'})).getAllByRole('row')).toHaveLength(2);
    expect(within(last).getAllByRole('cell').map(cell => cell.textContent).slice(2))
      .toEqual(['4', '—', '96']);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith('burimunsi/payments?statement=1&memberId=' + person.id + '&offset=25&revision=' + revision,
      {signal: expect.any(AbortSignal)});
  });

  it('clears a stale later page and retries from the first page without the old revision', async () => {
    const rows = Array.from({length: 26}, (_, i) => payment(i, true, 4));
    const request = vi.fn(async (path: string) => {
      if (path.includes('offset=25')) throw new AdminRequestError('Conflict', {code: 'member_statement_changed', statusCode: 409});
      if (path === profilePath + '?include=statement') return {...detail, member_statement: statement(rows)};
      throw new Error('Unexpected read');
    });
    render(<MemoryRouter><MemberStatementPage {...props} request={request} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', {name: 'Next'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('The statement changed.');
    expect(screen.queryByRole('table', {name: 'Member transactions'})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: 'Try again'}));
    expect(await screen.findByText('Page 1 of 2')).toBeInTheDocument();
    const next = request.mock.calls.at(-1)?.[0];
    expect(next).toBe(profilePath + '?include=statement');
    expect(next).not.toContain('revision');
  });
});
