import {fireEvent, render, screen, within} from '@testing-library/react';
import {MemoryRouter} from 'react-router';
import {describe, expect, it, vi} from 'vitest';
import {MemberMemberships} from '../../src/features/core/MemberMemberships';
import {MemberStatementPage} from '../../src/features/core/MemberStatementPage';
import {profileMembership, readMemberStatement, readMembershipMovements} from '../../src/features/core/memberStatement';
import fixture from './canonical-core-fixtures.json';

const person = {...fixture.members.rows[0], membership_status: 'active', momo_pay_code: '003314'};
const group = 'group-a', actor = 'account-a', internal = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', number = '010000020003';
const membership = {id: internal, user_id: person.id, group_id: group, group_title: 'Member group',
  public_id: person.public_id, role: 'member', status: 'active', membership_record_number: number};
const detail = {contract_version: 2, model: 'canonical_evidence_ledger', current_actor_id: actor,
  resource_type: 'members', can_manage: false, resource: person, related: {memberships: [membership]}, related_truncated: false};
const grants = ['users.read', 'collections.read', 'payments.read'];
const time = '2026-11-24T12:00:00Z';
function payment(n: number, incoming = true, amount: number | null = n) {
  return {id: 'p-' + n, groupId: group, version: 1, direction: incoming ? 'incoming' : 'outgoing',
    amountRwf: amount, atRaw: time, ftId: 'FT-' + String(n).padStart(4, '0'), payerNameRaw: null,
    memberId: person.id, memberName: person.display_name, state: 'allocated', sourceId: null};
}
function source(rows: ReturnType<typeof payment>[], profile: Record<string, unknown> = detail) {
  return vi.fn(async (path: string) => {
    if (path === 'operations/members/' + person.id) return profile;
    const [resource, search] = path.split('?'), q = new URLSearchParams(search);
    expect(resource).toBe('burimunsi/payments');
    expect(q.get('memberId')).toBe(person.id);
    expect(q.get('limit')).toBe('100');
    const offset = Number(q.get('offset')), items = rows.slice(offset, offset + 100);
    return {items, offset, limit: 100, totalCount: rows.length, asOf: time,
      nextOffset: offset + items.length < rows.length ? offset + items.length : null};
  });
}
const props = {id: person.id, expectedGroup: group, permissions: grants, actorId: actor, principalId: null,
  role: 'staff' as const, authorityKey: 'signed-in-staff', financialModel: 'canonical_evidence_ledger' as const, navigate: vi.fn()};

describe('scoped member statement', () => {
  it('reads only allocated member rows in the exact group and carries exact running amounts across server pages', async () => {
    const rows = Array.from({length: 105}, (_, i) => payment(i, i % 2 === 0, 100)).reverse();
    const api = source(rows);
    const result = await readMemberStatement(api, new AbortController().signal, person.id, actor, group);
    expect(api.mock.calls.map(([path]) => path)).toEqual(['operations/members/' + person.id, ...[0, 100].map(offset =>
      'burimunsi/payments?limit=100&offset=' + offset + '&memberId=' + person.id)]);
    expect(result.movements).toHaveLength(105);
    expect(result.movements[0]).toMatchObject({payment: {ftId: 'FT-0000', atRaw: time}, balance: 100n});
    expect(result.movements[100].balance).toBe(100n);
    expect(result.closing).toBe(100n);
    expect((await readMembershipMovements(source([payment(2, true, Number.MAX_SAFE_INTEGER),
      payment(1, true, Number.MAX_SAFE_INTEGER)]), new AbortController().signal, person.id, group)).closing)
      .toBe(2n * BigInt(Number.MAX_SAFE_INTEGER));
  });

  it('distinguishes a verified empty result from unknown amounts, including later known transactions', async () => {
    const read = (rows: ReturnType<typeof payment>[]) => readMembershipMovements(source(rows), new AbortController().signal, person.id, group);
    expect(await read([])).toEqual({movements: [], closing: 0n});
    const mixed = await read([payment(3, false, 5), payment(2, false, null), payment(1, true, 0)]);
    expect(mixed.movements.map(row => row.balance)).toEqual([0n, null, null]);
    expect(mixed.movements.at(-1)?.payment.amountRwf).toBe(5);
    expect(mixed.closing).toBeNull();
  });

  it('rejects foreign group and member responses and never issues a financial read without a verified membership', async () => {
    for (const bad of [{...membership, group_id: 'other-group'}, {...membership, user_id: 'other-user'},
      {...membership, group_id: undefined}, {...membership, user_id: undefined}]) {
      const api = source([], {...detail, related: {memberships: [bad]}});
      await expect(readMemberStatement(api, new AbortController().signal, person.id, actor, group)).rejects.toThrow();
      expect(api).toHaveBeenCalledTimes(1);
    }
    for (const bad of [{...payment(1), groupId: 'other-group'}, {...payment(1), memberId: 'other-user'},
      {...payment(1), memberId: null, memberName: null, state: 'unallocated'}]) {
      const api = vi.fn().mockResolvedValue({items: [bad], offset: 0, limit: 100, totalCount: 1, nextOffset: null, asOf: time});
      await expect(readMembershipMovements(api, new AbortController().signal, person.id, group)).rejects.toThrow();
    }
  });

  it('shows the issued record number and makes a fully scoped balance available to a permitted Staff reader', async () => {
    const request = source([payment(2, false, 5), payment(1, true, 25)]);
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
    const request = source(Array.from({length: 26}, (_, i) => payment(i, i !== 25, 4)).reverse());
    render(<MemoryRouter><MemberStatementPage {...props} request={request} /></MemoryRouter>);
    const table = within(await screen.findByRole('table', {name: 'Member transactions'}));
    expect(screen.getByText('Closing balance').nextElementSibling).toHaveTextContent('RWF 96');
    const first = within(table.getByRole('row', {name: /FT-0000/}));
    expect(first.getByText(time)).toBeVisible();
    expect(first.getAllByRole('cell').map(cell => cell.textContent).slice(2)).toEqual(['—', '4', '4']);
    fireEvent.click(screen.getByRole('button', {name: 'Next'}));
    expect(table.getAllByRole('row')).toHaveLength(2);
    expect(within(table.getByRole('row', {name: /FT-0025/})).getAllByRole('cell').map(cell => cell.textContent).slice(2))
      .toEqual(['4', '—', '96']);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
