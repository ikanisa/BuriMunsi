import {fireEvent, render, screen, within} from '@testing-library/react';
import {MemoryRouter} from 'react-router';
import {describe, expect, it, vi} from 'vitest';
import {AdminRequestError} from '../../src/api/client';
import {MemberMemberships} from '../../src/features/core/MemberMemberships';
import {MemberStatementPage} from '../../src/features/core/MemberStatementPage';
import {profileMembership, readMemberStatement, readMemberStatementPage} from '../../src/features/core/memberStatement';
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

  it.each([internal, 'foreign-membership'])('shows a joined balance only for the verified membership %s', async membershipId => {
    const request = vi.fn();
    render(<MemoryRouter><MemberMemberships detail={{...detail, member_balance: {
      groupId:group, memberId:person.id, membershipId, closingRwf:'25',
    }}} memberId={person.id} expectedGroup={group} authorityKey="staff" permissions={grants}
      request={request} returnTo="/admin/members" /></MemoryRouter>);
    expect(screen.getByRole('link', {name:'Open member statement, total balance ' + (membershipId===internal?'RWF 25':'Unavailable')})).toBeVisible();
    expect(request).not.toHaveBeenCalled();
  });

  it('shows the issued record number and makes a fully scoped balance available to a permitted Staff reader', async () => {
    const request = source([payment(1, true, 25), payment(2, false, 5)]);
    const view = render(<MemoryRouter><MemberMemberships detail={detail} memberId={person.id} expectedGroup={group}
      authorityKey="staff" permissions={grants} request={request} returnTo="/admin/members" /></MemoryRouter>);
    const records = within(screen.getByRole('region', {name: 'Memberships records'}));
    const balance = await records.findByRole('link', {name: /Open member statement.*RWF 20/});
    expect(balance).toHaveAttribute('href', '/admin/members/' + person.id + '/statement');
    expect(records.getByRole('cell', {name: number})).toBeVisible();
    expect(records.queryByText(internal)).not.toBeInTheDocument();
    expect(profileMembership({...detail, related: {memberships: [{...membership, membership_record_number: undefined}]}},
      person.id, group)?.recordNumber).toBeNull();
    view.unmount();
    request.mockClear();
    render(<MemoryRouter><MemberMemberships detail={detail} memberId={person.id} expectedGroup={group}
      authorityKey="read-only" permissions={['users.read', 'collections.read']} request={request} returnTo="/admin/members" /></MemoryRouter>);
    expect(screen.queryByRole('columnheader', {name: 'Total balance'})).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
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
