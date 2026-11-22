import {webcrypto} from 'node:crypto';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {RouterProvider} from 'react-router';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {makeAdminRouter} from '../../src/app/App';
import {SessionProvider} from '../../src/session/SessionProvider';
import {parsePhoneTeam, type PhoneTeamMember} from '../../src/session/phoneTeam';
import {parseSessionUser} from '../../src/session/sessionResponses';
import {hasScopedAdminAuthority} from '../../src/session/ownerIdentity';
import {sensitiveVerificationDeadline} from '../../src/session/sessionPolicy';
import {scopes} from '../burimunsi/fixture';
import {BuriDirectoryView} from '../../src/features/burimunsi/BuriDirectoryView';
import type {BuriSharedOperator} from '../../src/features/burimunsi/contracts';

const adminId = '10000000-0000-4000-8000-000000000001', principalId = '20000000-0000-4000-8000-000000000001';
const sessionId = '30000000-0000-4000-8000-000000000001';
const admin: PhoneTeamMember = {id: '40000000-0000-4000-8000-000000000001', phone: '+250780000001', displayName: 'Group administrator', role: 'admin', active: true, version: 3};
const staff: PhoneTeamMember = {id: '40000000-0000-4000-8000-000000000002', phone: '+250780000002', displayName: 'Group operator', role: 'staff', active: true, version: 1};
const config = {backend: 'supabase', phonePasscodeOnly: true, captchaEnabled: false, googleEnabled: false,
  publishableKey: 'sb_publishable_' + 'a'.repeat(32)} as const;
const csrfToken = 'c'.repeat(64);
const grants = {admin: ['account.manage','admin_users.read','admin_users.manage','receivers.read','receivers.manage'], staff: ['overview.read']};
const signedInAt = new Date(Date.now() - 600_000).toISOString();
function cookie(actor = admin) {
  return {user: {id: adminId, accountId: actor.id, principalId, sessionId, role: actor.role, phone: actor.phone, displayName: actor.displayName,
    authMethod: 'phone_passcode', passcodeVerifiedAt: signedInAt, financialModel: 'canonical_evidence_ledger',
    permissions: grants[actor.role]}, csrfToken, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), ownerEmail: null,
    ...(actor.role === 'admin' ? {adminIdentity: {schemaVersion: 1, role: 'admin', accountId: actor.id, adminId, principalId, collectionId: 'group-one'}} : {})};
}
const anonymous = {user: null, expiresAt: null, csrfToken: null, ownerEmail: null};
const cleanups: (() => void)[] = [];
function open(path: string, fetchImpl: typeof fetch) {
  window.history.replaceState(null, '', '/#' + path);
  const router = makeAdminRouter();
  const view = render(<SessionProvider config={{...config, fetchImpl}}><RouterProvider router={router} /></SessionProvider>);
  cleanups.push(() => {view.unmount(); router.dispose();});
}
beforeEach(() => {vi.stubGlobal('crypto', webcrypto);});
afterEach(() => {cleanups.splice(0).forEach(cleanup => cleanup()); window.history.replaceState(null, '', '/'); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear();});

describe('dedicated phone accounts', () => {
  it('shows the assigned BuriMunsi role for an operator whose underlying shared role differs', () => {
    const operator: BuriSharedOperator = {adminId, principalId, displayName: 'Test operator', role: 'staff', email: ''};
    const directory = {collectionId: 'group-one', configured: true, team: [operator],
      approvals: [{operator, phone: admin.phone, role: 'admin' as const, active: true, version: 1,
        sharedStatus: 'active' as const, capabilities: ['records.read']}]};
    render(<BuriDirectoryView directory={directory} provisioning={null} provisioningError={false} phoneAccounts />);
    expect(screen.getByRole('cell', {name: 'Admin'})).toBeVisible();
    expect(screen.queryByRole('cell', {name: 'Staff'})).toBeNull();
  });

  it('binds the two-role directory and scoped administrator to the authenticated native account', () => {
    const body = cookie(), actor = parseSessionUser(body, Date.now());
    expect(hasScopedAdminAuthority(actor)).toBe(true);
    expect(sensitiveVerificationDeadline(actor, 'supabase')).toBe(Date.parse(actor.expiresAt));
    const directory = {contractVersion: 1, currentAccountId: actor.accountId, members: [admin, staff], canManage: true, permissionsByRole: grants};
    expect(parsePhoneTeam(directory, actor).members).toHaveLength(2);
    expect(() => parsePhoneTeam({...directory, currentAccountId: staff.id}, actor)).toThrow();
    expect(() => parsePhoneTeam({...directory, permissionsByRole: {...grants, owner: []}}, actor)).toThrow();
    expect(() => parsePhoneTeam({...directory, members: [{...admin, phone: staff.phone}]}, actor)).toThrow();
    expect(hasScopedAdminAuthority(parseSessionUser({...body, adminIdentity: {...body.adminIdentity, principalId: adminId}}, Date.now()))).toBe(false);
    expect(hasScopedAdminAuthority(parseSessionUser({...cookie(staff), adminIdentity: body.adminIdentity}, Date.now()))).toBe(false);
  });

  it('opens the scoped Admin group and SMS controls with the current session after the old five-minute deadline', async () => {
    const groups = ['group-one', 'another-group'];
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const path = String(input);
      if (path === '/api/admin/auth/session') return Response.json(cookie());
      if (path === '/api/admin/momo/native-setup') return Response.json({...scopes,
        collections: groups.map(id => ({...scopes.collections[0], id, title: id})),
        scopes: groups.map(collectionId => ({...scopes.scopes[0], collectionId}))});
      return Response.json({error: 'unavailable'}, {status: 503});
    });
    open('/admin/burimunsi', fetchImpl);
    fireEvent.click(await screen.findByRole('button', {name: 'Load groups'}, {timeout: 5000}));
    expect(await screen.findByText('group-one', {exact: true})).toBeInTheDocument();
    expect(screen.queryByText('another-group', {exact: true})).toBeNull();
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('collectionId=another-group'))).toBe(false);
    expect(screen.queryByText('Owner verification')).toBeNull();
    fireEvent.click(screen.getByRole('link', {name: 'SMS controls'}));
    await waitFor(() => expect(fetchImpl.mock.calls.some(([path]) => path === '/api/admin/notification-operator/access')).toBe(true), {timeout: 5000});
    expect(screen.queryByText(/Verify your passcode to open these controls/)).toBeNull();
    expect(fetchImpl.mock.calls.filter(([path]) => String(path).includes('/auth/') && path !== '/api/admin/auth/session')).toHaveLength(0);
  }, 12_000);

  it('creates an account using the configured passcode and changes its role and access through the authenticated Team route', async () => {
    const members = [{...admin}, {...staff}], writes: {path: string; body: Record<string, unknown>; headers: Headers}[] = [];
    let loseFirst = true;
    const accountId = '40000000-0000-4000-8000-000000000003';
    const fetchImpl = vi.fn<typeof fetch>(async (input, options) => {
      const path = String(input);
      if (path === '/api/admin/auth/session') return Response.json(cookie());
      if (path === '/api/admin/team') return Response.json({contractVersion: 1, currentAccountId: admin.id, canManage: true, members, permissionsByRole: grants});
      const body = JSON.parse(String(options?.body)), headers = new Headers(options?.headers);
      writes.push({path, body, headers});
      if (path === '/api/admin/team/accounts') {
        if (loseFirst) {loseFirst = false; throw new TypeError('connection lost');}
        members.push({id: accountId, displayName: body.displayName, phone: body.phone, role: body.role, active: true, version: 1});
        return Response.json({applied: true, id: accountId, version: 1});
      }
      if (path === '/api/admin/team/accounts/' + accountId + '/access') {
        Object.assign(members[2], {role: body.role, active: body.active, version: 2});
        return Response.json({applied: true, id: accountId, version: 2});
      }
      throw new Error('Unexpected request');
    });
    open('/admin/admin-users', fetchImpl);
    await screen.findByRole('row', {name: /Group administrator/});
    expect(screen.getByRole('heading', {name: 'Admin'})).toBeVisible();
    expect(screen.getByRole('heading', {name: 'Staff'})).toBeVisible();
    expect(screen.queryByRole('heading', {name: 'Owner'})).toBeNull();
    expect(screen.queryByRole('button', {name: /Manage Group administrator|verify|invit/i})).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'Create account'}));
    fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'New operator'}});
    fireEvent.change(screen.getByLabelText('Mobile number'), {target: {value: '0780 000 003'}});
    expect(screen.getByLabelText('Role')).toHaveValue('staff');
    expect(screen.queryByLabelText(/passcode|email|whatsapp/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'Review account'}));
    fireEvent.click(screen.getByRole('button', {name: 'Confirm account creation'}));
    fireEvent.click(await screen.findByRole('button', {name: 'Retry original request'}));
    const newRow = await screen.findByRole('row', {name: /New operator/});
    expect(writes[0].body).toEqual({requestId: expect.any(String), displayName: 'New operator', phone: '+250780000003', role: 'staff'});
    expect(writes[1].body).toEqual(writes[0].body);
    expect(writes[1].headers.get('Idempotency-Key')).toBe(writes[0].body.requestId);
    expect(writes[1].headers.get('X-Collect-CSRF')).toBe(csrfToken);
    fireEvent.click(within(newRow).getByRole('button', {name: /Manage/}));
    fireEvent.change(screen.getByLabelText('Role'), {target: {value: 'admin'}});
    fireEvent.change(screen.getByLabelText('Access'), {target: {value: 'disabled'}});
    fireEvent.click(screen.getByRole('button', {name: 'Review account'}));
    fireEvent.click(screen.getByRole('button', {name: 'Confirm access change'}));
    expect(await screen.findByRole('row', {name: /New operator.*Admin Disabled/})).toBeVisible();
    expect(writes[2].body).toEqual({requestId: expect.any(String), expectedVersion: 1, role: 'admin', active: false});
    expect(fetchImpl.mock.calls.filter(([path]) => String(path).includes('/auth/')).map(([path]) => path)).toEqual(['/api/admin/auth/session']);
  });

  it('admits Staff after the same-account phone sign-in and allows optional own passcode change without Admin grants or a verification code', async () => {
    let authenticated = false;
    const writes: {path: string; body: unknown}[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, options) => {
      const path = String(input);
      if (path === '/api/admin/auth/session') return Response.json(authenticated ? cookie(staff) : anonymous);
      const body = JSON.parse(String(options?.body)); writes.push({path, body});
      if (path === '/api/admin/auth/phone-passcode') {authenticated = true; return Response.json(cookie(staff));}
      if (path === '/api/admin/auth/passcode/change') {authenticated = false; return Response.json({ok: true});}
      throw new Error('Unexpected request');
    });
    open('/admin/security/verify-email?returnTo=%2Fadmin%2Fsecurity', fetchImpl);
    await screen.findByRole('button', {name: 'Sign in'});
    fireEvent.change(screen.getByLabelText('Mobile number'), {target: {value: staff.phone}});
    fireEvent.change(screen.getByLabelText('Four-digit passcode'), {target: {value: '1234'}});
    fireEvent.click(screen.getByRole('button', {name: 'Sign in'}));
    await screen.findByRole('heading', {name: 'Account security'});
    expect(writes).toHaveLength(1);
    expect(screen.queryByRole('button', {name: /verif|one-time|e-?mail|invite/i})).toBeNull();
    fireEvent.change(screen.getByLabelText('Current passcode'), {target: {value: '1234'}});
    fireEvent.change(screen.getByLabelText('New passcode'), {target: {value: '5678'}});
    fireEvent.change(screen.getByLabelText('Confirm new passcode'), {target: {value: '2222'}});
    fireEvent.click(screen.getByRole('button', {name: 'Change passcode'}));
    expect(writes).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Confirm new passcode'), {target: {value: '5678'}});
    fireEvent.click(screen.getByRole('button', {name: 'Change passcode'}));
    await waitFor(() => expect(screen.getByRole('button', {name: 'Sign in'})).toBeVisible());
    expect(writes).toEqual([{path: '/api/admin/auth/phone-passcode', body: {phone: staff.phone, pin: '1234'}},
      {path: '/api/admin/auth/passcode/change', body: {current: '1234', newPin: '5678', confirm: '5678'}}]);
  });
});
