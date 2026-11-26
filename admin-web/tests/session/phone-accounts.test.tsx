import {webcrypto} from 'node:crypto';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {RouterProvider} from 'react-router';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {makeAdminRouter} from '../../src/app/App';
import {SessionProvider} from '../../src/session/SessionProvider';
import {parsePhoneTeam, type PhoneTeamMember} from '../../src/session/phoneTeam';
import {parsePhoneLoginSession, parseSessionUser} from '../../src/session/sessionResponses';
import {hasScopedAdminAuthority} from '../../src/session/ownerIdentity';
import {sensitiveVerificationDeadline} from '../../src/session/sessionPolicy';
import {directory, provisioning, scopes, staffPrincipal} from '../burimunsi/fixture';
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
  it('binds negotiated phone sessions to the requested number and the account role', () => {
    const adminSession = {...cookie(), sessionContract: 2};
    const staffSession = {...cookie(staff), sessionContract: 2};
    expect(parsePhoneLoginSession(adminSession, admin.phone).user.adminIdentity).toEqual(adminSession.adminIdentity);
    expect(parsePhoneLoginSession(staffSession, staff.phone).user.role).toBe('staff');
    expect(() => parsePhoneLoginSession(adminSession, staff.phone)).toThrow();
    expect(() => parsePhoneLoginSession({...adminSession, adminIdentity: null}, admin.phone)).toThrow();
    expect(() => parsePhoneLoginSession({...staffSession, adminIdentity: adminSession.adminIdentity}, staff.phone)).toThrow();
  });

  it.each([
    {sharedRole: 'staff', sharedStatus: 'active', assignedRole: 'admin', active: true, label: 'Admin', hiddenLabel: 'Staff', status: 'Enabled'},
    {sharedRole: 'admin', sharedStatus: 'revoked', assignedRole: 'staff', active: false, label: 'Staff', hiddenLabel: 'Admin', status: 'Disabled'},
    {sharedRole: 'owner', sharedStatus: 'active', assignedRole: null, active: false, label: 'Unassigned', hiddenLabel: 'Admin', status: 'No approval recorded'},
  ] as const)('shows $label for an operator with shared $sharedRole authority', ({sharedRole, sharedStatus, assignedRole, active, label, hiddenLabel, status}) => {
    const operator: BuriSharedOperator = {adminId, principalId, displayName: 'Test operator', role: sharedRole, email: ''};
    const directory = {collectionId: 'group-one', configured: true, team: [operator],
      approvals: assignedRole ? [{operator, phone: assignedRole === 'admin' ? admin.phone : staff.phone, role: assignedRole,
        active, version: 1, sharedStatus, capabilities: ['records.read']}] : []};
    render(<BuriDirectoryView directory={directory} provisioning={null} provisioningError={false} phoneAccounts />);
    const row = within(screen.getByRole('row', {name: /Test operator/}));
    expect(row.getByRole('cell', {name: label})).toBeVisible();
    expect(row.queryByRole('cell', {name: hiddenLabel})).toBeNull();
    expect(row.getByText(status)).toBeVisible();
    if (assignedRole) {
      expect(row.getByText('Account ' + sharedStatus)).toBeVisible();
      expect(row.getByText('View records')).toBeVisible();
      expect(row.queryByText(/records\.read|Collect status/)).toBeNull();
    }
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

  it.each([true, false])('shows Profile access in Team only with the existing route authority (%s)', async allowed => {
    const body = cookie();
    if (!allowed) body.user.permissions = body.user.permissions.filter(permission => permission !== 'receivers.manage');
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const path = String(input);
      if (path === '/api/admin/auth/session') return Response.json(body);
      if (path === '/api/admin/momo/native-setup') return Response.json(scopes);
      return Response.json({error: 'unavailable'}, {status: 503});
    });
    open('/admin/admin-users', fetchImpl);
    await screen.findByRole('heading', {name: 'Team access'});
    if (allowed) expect(screen.getByRole('link', {name: 'Profile access'})).toHaveAttribute('href', '#/admin/burimunsi');
    else expect(screen.queryByRole('link', {name: 'Profile access'})).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: /^Account:/}));
    const advanced = screen.queryByText('Advanced', {selector: 'summary'});
    if (advanced) fireEvent.click(advanced);
    expect(screen.getAllByRole('link', {name: 'Team'})).toHaveLength(1);
    if (!allowed) {
      expect(screen.queryByRole('link', {name: 'Profile access'})).toBeNull();
      expect(fetchImpl.mock.calls.some(([path]) => String(path).includes('/native-setup'))).toBe(false);
      return;
    }
    expect(screen.getAllByRole('link', {name: 'Profile access'})).toHaveLength(1);
    fireEvent.click(screen.getByRole('link', {name: 'Profile access'}));
    await screen.findByRole('heading', {name: 'BuriMunsi access'});
    expect(screen.getByRole('button', {name: 'Back to team'})).toBeVisible();
  });

  it('keeps the permitted profile fallback when Team is unavailable', async () => {
    const body = cookie();
    body.user.permissions = body.user.permissions.filter(permission => permission !== 'admin_users.read');
    const fetchImpl = vi.fn<typeof fetch>(async input => Response.json(String(input) === '/api/admin/auth/session' ? body : scopes));
    open('/admin/burimunsi', fetchImpl);
    await screen.findByRole('heading', {name: 'BuriMunsi access'});
    expect(screen.queryByRole('button', {name: 'Back to team'})).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: /^Account:/}));
    fireEvent.click(screen.getByText('Advanced', {selector: 'summary'}));
    expect(screen.queryByRole('link', {name: 'Team'})).toBeNull();
    expect(screen.getByRole('link', {name: 'Profile access'})).toHaveAttribute('href', '#/admin/burimunsi');
  });

  it('opens scoped Admin group access and omits legacy SMS controls after the old five-minute deadline', async () => {
    const groups = ['group-one', 'another-group'];
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const path = String(input);
      if (path === '/api/admin/auth/session') return Response.json(cookie());
      if (path === '/api/admin/momo/native-setup') return Response.json({...scopes,
        collections: groups.map(id => ({...scopes.collections[0], id, title: id})),
        scopes: groups.map(collectionId => ({...scopes.scopes[0], collectionId}))});
      if (path.startsWith('/api/admin/burimunsi/operators?')) return Response.json({...directory, collectionId:'group-one', approvalContract:2});
      if (path.startsWith('/api/admin/burimunsi/provisioning?')) return Response.json({...provisioning, collectionId:'group-one', scopeEnabled:false, configured:false});
      return Response.json({error: 'unavailable'}, {status: 503});
    });
    open('/admin/burimunsi', fetchImpl);
    fireEvent.click(await screen.findByRole('button', {name: 'Load BuriMunsi access'}, {timeout: 5000}));
    expect(await screen.findByText('group-one')).toBeVisible();
    expect(await screen.findByRole('heading', {name:'Android app access'})).toBeVisible();
    expect(screen.getByText('Group access is disabled.')).toBeVisible();
    expect(screen.getByText('Android app setup is incomplete.')).toBeVisible();
    expect(screen.queryByText(/Recorded scope|Group access is enabled/)).toBeNull();
    fireEvent.change(screen.getByRole('combobox', {name:'Account'}), {target:{value:staffPrincipal}});
    fireEvent.click(screen.getByRole('button', {name:'Review access'}));
    const preview = within(await screen.findByRole('region', {name:'Access preview'}));
    expect(preview.getByText(/View records.*Enroll members/)).toBeVisible();
    expect(preview.queryByText(/records\.read|members\.enroll/)).toBeNull();
    expect(screen.queryByText('another-group')).toBeNull();
    expect(fetchImpl.mock.calls.some(([path]) => String(path).includes('collectionId=another-group'))).toBe(false);
    expect(screen.queryByText('Owner verification')).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: /^Account:/}));
    expect(screen.queryByRole('link', {name: 'SMS controls'})).toBeNull();
    expect(fetchImpl.mock.calls.some(([path]) => path === '/api/admin/notification-operator/access')).toBe(false);
    expect(screen.queryByText(/Verify your passcode to open these controls/)).toBeNull();
    expect(fetchImpl.mock.calls.filter(([path]) => String(path).includes('/auth/') && path !== '/api/admin/auth/session')).toHaveLength(0);
  }, 12_000);

  it('creates only Staff using the configured passcode and manages access without promoting the account', async () => {
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
    const adminRow = await screen.findByRole('row', {name: /Group administrator/});
    const staffRow = screen.getByRole('row', {name: /Group operator/});
    expect(within(adminRow).getByRole('cell', {name: 'Admin'})).toBeVisible();
    expect(within(staffRow).getByRole('cell', {name: 'Staff'})).toBeVisible();
    expect(screen.queryByRole('cell', {name: 'Owner'})).toBeNull();
    expect(screen.queryByRole('heading', {name: 'Role permissions'})).toBeNull();
    expect(screen.queryByText(/admin_users\.manage|overview\.read/)).toBeNull();
    expect(screen.queryByRole('button', {name: /Manage Group administrator|verify|invit/i})).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'Create account'}));
    fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'New operator'}});
    fireEvent.change(screen.getByLabelText('Mobile number'), {target: {value: '0780 000 003'}});
    expect(screen.queryByLabelText('Role')).toBeNull();
    expect(screen.getByText('Role: Staff')).toBeVisible();
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
    expect(screen.queryByLabelText('Role')).toBeNull();
    expect(screen.getByText('Role: Staff')).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name: 'Review account'}));
    expect(screen.queryByRole('button', {name: 'Confirm access change'})).toBeNull();
    expect(writes).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Access'), {target: {value: 'disabled'}});
    fireEvent.click(screen.getByRole('button', {name: 'Review account'}));
    fireEvent.click(screen.getByRole('button', {name: 'Confirm access change'}));
    expect(await screen.findByRole('row', {name: /New operator.*Staff Disabled/})).toBeVisible();
    expect(writes[2].body).toEqual({requestId: expect.any(String), expectedVersion: 1, role: 'staff', active: false});
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
