import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {RouterProvider} from 'react-router';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {AdminBackend} from '../../src/api/client';
import {makeAdminRouter} from '../../src/app/App';
import {SessionProvider, type AdminOwnerIdentity} from '../../src/session/SessionProvider';
import core from '../core/canonical-core-fixtures.json';

const account = {
  id: 'staff-one', email: 'staff@example.com', role: 'staff', sessionId: 'session-one',
  permissions: ['overview.read', 'collections.read'], assuranceLevel: 1, mfaAt: null,
  financialModel: 'canonical_evidence_ledger',
};
const reply = (body: unknown, status = 200) => Response.json(body, {status});
let router: ReturnType<typeof makeAdminRouter>;

type SessionFixture = {user: typeof account & {accountId?: string; phone?: string; authMethod?: 'phone_passcode'; passcodeVerifiedAt?: string}; ownerIdentity?: AdminOwnerIdentity; ownerEmail?: string};
const phoneIdentity = () => ({accountId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', phone:'+250780000001',
  authMethod:'phone_passcode' as const, passcodeVerifiedAt:new Date().toISOString()});

function openAdmin(path: string, {backend = 'supabase', failFirstCheck = false, session = {user: account}, phonePasscodeOnly, read}:
  {backend?: AdminBackend; failFirstCheck?: boolean; session?: SessionFixture; phonePasscodeOnly?: boolean; read?: (url: URL) => Response | undefined} = {}) {
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input), window.location.origin);
    requests.push(url.pathname);
    if (url.pathname.endsWith('/auth/session')) {
      if (failFirstCheck) {failFirstCheck = false; return reply({error: {code: 'service_unavailable'}}, 503);}
      return reply({...session, expiresAt, csrfToken: 'c'.repeat(64)});
    }
    if (url.pathname.endsWith('/auth/email-verification')) {
      return reply({contractVersion: 1, sessionId: session.user.sessionId, emailVerifiedAt: null});
    }
    return read?.(url) ?? reply({error: {code: 'not_found'}}, 404);
  };
  window.history.replaceState(null, '', '/#' + path);
  router = makeAdminRouter();
  render(<SessionProvider config={{backend, publishableKey: backend === 'supabase' ? 'sb_publishable_' + 'a'.repeat(32) : undefined,
    captchaEnabled: false, googleEnabled: false, phonePasscodeOnly:phonePasscodeOnly || undefined, fetchImpl}}><RouterProvider router={router} /></SessionProvider>);
  return {requests, expiresAt};
}

afterEach(() => {
  router?.dispose();
  window.history.replaceState(null, '', '/');
});

describe('Admin session recovery through the router', () => {
  it.each(['/unavailable-bookmark', '/admin/unavailable-bookmark'])('offers a single main landmark on %s', async path => {
    openAdmin(path);
    const main = screen.getByRole('main');
    expect(await within(main).findByRole('heading', {level:1, name:'Page unavailable'})).toBeVisible();
    expect(within(main).getByRole('button', {name:'Go to overview'})).toBeVisible();
  });
  it('keeps a waiting PWA update out of the signed-in workspace', async () => {
    const scriptURL = new URL('/custom-sw.js', location.origin).href;
    const active = Object.assign(new EventTarget(), {scriptURL, state: 'activated'});
    const waiting = Object.assign(new EventTarget(), {scriptURL, state: 'installed'});
    const registration = Object.assign(new EventTarget(), {active, waiting, installing: null, scope: location.origin + '/'});
    const serviceWorker = Object.assign(new EventTarget(), {controller: active, ready: Promise.resolve(registration)});
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', Object.create(navigator, {serviceWorker: {value: serviceWorker}}));
    try {
      openAdmin('/admin/licenses');
      expect(await screen.findByRole('heading', {name: 'Open-source licenses'})).toBeVisible();
      expect(screen.queryByText(/Admin update ready/i)).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['supabase', 'authenticator', 'verify-email', 'Verify your email'],
    ['cloudflare', 'verify-email', 'authenticator', 'Authenticator'],
  ] as const)('preserves a safe destination when %s switches verification method, then rechecks access', async (backend, start, target, heading) => {
    const query = new URLSearchParams({returnTo: '/admin/burimunsi?draft=private'});
    const {requests} = openAdmin(`/admin/security/${start}?${query}`, {backend});
    await screen.findByRole('heading', {name: heading}, {timeout: 4_000});
    expect(router.state.location.pathname).toBe(`/admin/security/${target}`);
    expect(new URLSearchParams(router.state.location.search).get('returnTo')).toBe('/admin/burimunsi');

    fireEvent.click(screen.getByRole('button', {name: 'Back'}));
    await within(screen.getByRole('main')).findByRole('heading', {level: 1, name: 'Access unavailable'});
    expect(router.state.location.pathname).toBe('/admin/burimunsi');
    expect(router.state.location.search).toBe('');
    expect(requests.filter(path => !path.includes('/auth/'))).toEqual([]);
  });

  it('returns a resumed expired tab to sign-in before the selected feature can read', async () => {
    const {requests, expiresAt} = openAdmin('/admin/licenses');
    await screen.findByRole('heading', {name: 'Open-source licenses'});
    const now = Date.now.bind(Date);
    const elapsed = Date.parse(expiresAt) - now() + 1;
    vi.spyOn(Date, 'now').mockImplementation(() => now() + elapsed);

    fireEvent.click(screen.getByRole('button', {name: /^Account:/}));
    fireEvent.click(screen.getByRole('link', {name: 'Workspace'}));
    await screen.findByRole('heading', {name: 'Welcome to BuriMunsi'}, {timeout: 4_000});
    expect(router.state.location.pathname).toBe('/admin/login');
    expect(new URLSearchParams(router.state.location.search).get('returnTo')).toBe('/admin/groups');
    expect(requests.filter(path => !path.includes('/auth/'))).toEqual([]);
  });

  it('rechecks a failed session in place before opening the original destination', async () => {
    const {requests} = openAdmin('/admin/licenses', {failFirstCheck: true});
    await screen.findByRole('heading', {name: 'Workspace unavailable'});
    expect(screen.queryByRole('heading', {name: 'Open-source licenses'})).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'Try again'}));
    await screen.findByRole('heading', {name: 'Open-source licenses'});
    await waitFor(() => expect(requests.filter(path => path.endsWith('/auth/session'))).toHaveLength(2));
    expect(router.state.location.pathname).toBe('/admin/licenses');
  });
});

describe('Admin navigation for the current session', () => {
  it.each(['/admin/groups','/admin/groups/group-one/edit','/admin/groups/group-one/members/member-one/edit','/admin/requests?key=example-key','/admin/privacy-requests'])(
    'replaces the BuriMunsi bookmark %s with Home before reading the retired feature', async path => {
      const {requests} = openAdmin(path, {phonePasscodeOnly:true,session:{user:{...account,...phoneIdentity(),
        permissions:['overview.read','collections.read','collections.manage','users.read','users.manage','account.manage','privacy.review']}}});
      await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe('/admin'));
      expect(router.state.historyAction).toBe('REPLACE');
      expect(requests.some(url => /\/(?:groups|requests|privacy)(?:\/|$)/.test(url))).toBe(false);
      fireEvent.click(await screen.findByRole('button', {name:/^Account:/}));
      expect(screen.queryByText('Help', {selector:'summary'})).toBeNull();
      expect(screen.queryByRole('link', {name:/^(?:Workspace|Activity|Privacy requests|Open-source notices)$/})).toBeNull();
      expect(screen.getByRole('link', {name:'Account security'})).toBeVisible();
    });
  it('takes old People list bookmarks to the same filtered member roster', async () => {
    const {requests} = openAdmin('/admin/users?search=Group+One&sort=public_id_asc&status=suspended&unknown=drop',
      {phonePasscodeOnly:true, session: {user: {...account, ...phoneIdentity(), permissions: ['users.read']}},
        read:url => url.pathname.endsWith('/core/members') ? reply({...core.members,rows:[],total:0}) : undefined});
    await screen.findByRole('heading', {name: 'Members'});
    expect(router.state.location.pathname + router.state.location.search).toBe('/admin/members?search=Group+One&sort=public_id_asc');
    expect(await screen.findByRole('textbox', {name: 'Search Members'})).toHaveValue('Group One');
    fireEvent.click(screen.getByRole('button',{name:'Filter Status'}));
    const picker = within(screen.getByRole('dialog',{name:'Filter Status'}));
    expect(picker.getByRole('checkbox',{name:'Active'})).not.toBeChecked();
    expect(picker.getByRole('checkbox',{name:'Inactive'})).not.toBeChecked();
    fireEvent.click(picker.getByRole('button',{name:'Cancel'}));
    expect(screen.queryByRole('link', {name: 'All people'})).not.toBeInTheDocument();
    expect(screen.queryByRole('link', {name: 'Group members'})).not.toBeInTheDocument();
    expect(screen.queryByRole('link', {name: 'Add member'})).not.toBeInTheDocument();
    expect(requests).toContain('/api/admin/core/members');
    expect(requests).not.toContain('/api/admin/core/users');
  });

  it.each([
    {name:'phone identity', phone:true, passcode:false, journals:false, scoped:true},
    {name:'passcode deployment', phone:false, passcode:true, journals:false, scoped:true},
    {name:'managed canonical session', phone:false, passcode:false, journals:false, scoped:false},
    {name:'transaction journals on a passcode deployment', phone:false, passcode:true, journals:true, scoped:false},
  ])('opens the member list and detail using the $name contract', async ({phone, passcode, journals, scoped}) => {
    const status = scoped ? 'inactive' : journals ? 'closed' : 'suspended';
    const model = journals ? 'transaction_journals' : 'canonical_evidence_ledger';
    const common = core.members.rows[0], accountStatus = scoped ? 'active' : status;
    const row = {...common, status:accountStatus, account_status:accountStatus,
      ...(scoped ? {active_groups:0, amount:'0 groups', membership_status:status} : {}),
      ...(journals ? {posted_contributed_rwf:0, contribution_basis:'confirmation_recorded_allocations'} : {})};
    const metadata = journals ? {} : {contract_version:2, model};
    const resource = scoped ? 'members' : 'users', calls: URL[] = [];
    const {requests} = openAdmin('/admin/members?status=' + status, {phonePasscodeOnly:passcode,
      session:{user:{...account, financialModel:model, permissions:['users.read'], ...(phone || passcode ? phoneIdentity() : {})}},
      read(url) {
        calls.push(url);
        if (url.pathname === '/api/admin/core/members' && url.searchParams.get('status') === (scoped ? null : status) &&
            url.searchParams.get('directory') === (scoped ? 'roster' : null)) return reply({...metadata, rows:[row], total:1});
        if (url.pathname === '/api/admin/operations/' + resource + '/' + row.id) return reply({...metadata,
          current_actor_id:account.id, resource_type:resource, resource:row, can_manage:false, related:{}, related_truncated:false});
        return reply({error:{code:'unexpected_directory_contract'}},403);
      }});
    const member = await screen.findByRole('row', {name:new RegExp(row.public_id)});
    if (scoped) {
      fireEvent.click(screen.getByRole('button',{name:'Filter Status'}));
      const picker = within(screen.getByRole('dialog',{name:'Filter Status'}));
      expect(picker.getByRole('checkbox',{name:'Inactive'})).toBeChecked();
      expect(picker.getByRole('checkbox',{name:'Active'})).not.toBeChecked();
      fireEvent.click(picker.getByRole('button',{name:'Cancel'}));
    } else {
      const options = within(screen.getByRole('combobox',{name:'Status'})).getAllByRole('option').map(option => option.textContent);
      expect(options).toEqual(journals ? ['All statuses','Invited','Active','Suspended','Closed'] : ['All statuses','Active','Suspended','Deleted']);
    }
    fireEvent.click(within(member).getByRole('button',{name:'View ' + row.public_id}));
    await screen.findByRole('heading',{name:'Record details'});
    expect(screen.getByText('Status',{selector:'dt'}).nextElementSibling).toHaveTextContent(status[0].toUpperCase()+status.slice(1));
    expect(requests).not.toContain('/api/admin/operations/' + (scoped ? 'users' : 'members') + '/' + row.id);
    fireEvent.click(screen.getByRole('button',{name:'Back to members'}));
    await screen.findByRole('row',{name:new RegExp(row.public_id)});
    expect(router.state.location.search).toBe('?status=' + status);
    expect(calls.filter(url => url.pathname.endsWith('/core/members'))).toHaveLength(2);
  });

  it('keeps a generic People bookmark and its account-status filter on the existing people service', async () => {
    const {requests} = openAdmin('/admin/users?status=suspended', {session:{user:{...account, permissions:['users.read']}},
      read(url) {
        if (url.pathname === '/api/admin/core/users' && !url.searchParams.has('directory') && url.searchParams.get('status') === 'suspended') {
          return reply({...core.members, rows:[],total:0});
        }
      }});
    await screen.findByText('No records found');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/admin/users');
      expect(screen.getByRole('link', {name: 'All people'})).toHaveAttribute('aria-current', 'page');
    }, {timeout: 4_000});
    expect(requests).not.toContain('/api/admin/core/members');
  });

  it('keeps the group selector available to a non-phone manager from an existing membership bookmark', async () => {
    const {requests} = openAdmin('/admin/members/new',{session:{user:{...account,role:'admin',
      permissions:['users.read','users.manage','collections.read']}}});
    expect(await screen.findByRole('textbox',{name:'Search groups'})).toBeVisible();
    expect(requests).not.toContain('/api/admin/burimunsi/members/enrollment');
  });

  it('does not read directory records or expose directory views without user permission', async () => {
    const {requests} = openAdmin('/admin/users', {session: {user: account}});
    await screen.findByRole('heading', {name: 'Access unavailable'});
    expect(screen.queryByRole('navigation', {name: 'Member directory views'})).toBeNull();
    expect(screen.queryByRole('link', {name: 'Members'})).toBeNull();
    expect(requests.filter(path => path.startsWith('/api/admin/core/'))).toEqual([]);
  });

  it.each([
    {permissions: ['collections.read', 'receivers.read'], route: '/admin/groups', contextual: true, fallback: false},
    {permissions: ['collections.read'], route: '/admin/groups', contextual: false, fallback: false},
    {permissions: ['receivers.read'], route: '/admin/licenses', contextual: false, fallback: true},
  ])('keeps Receiving accounts discoverable without widening access ($permissions)', async ({permissions, route, contextual, fallback}) => {
    const {requests} = openAdmin(route, {session: {user: {...account, permissions}}});
    await screen.findByRole('heading', {name: route.endsWith('/groups') ? 'Groups' : 'Open-source licenses'});
    expect(Boolean(screen.queryByRole('navigation', {name: 'Group workspace'}))).toBe(contextual);
    fireEvent.click(screen.getByRole('button', {name: /^Account:/}));
    const advanced = screen.queryByText('Advanced', {selector: 'summary'});
    if (advanced) fireEvent.click(advanced);
    const links = screen.queryAllByRole('link', {name: 'Receiving accounts'});
    expect(links).toHaveLength(contextual || fallback ? 1 : 0);
    if (links.length) expect(links[0]).toHaveAttribute('href', '#/admin/payees');
    expect(requests).not.toContain('/api/admin/core/payees');
  });

  it.each([
    {permissions: ['ledger.read'], route: '/admin/licenses', fallback: true, contextual: false},
    {permissions: ['ledger.read', 'sms.read'], route: '/admin/payments?view=sms', fallback: true, contextual: false, denied: true},
    {permissions: ['ledger.read', 'reconciliations.read'], route: '/admin/payments?view=attention', fallback: true, contextual: false},
    {permissions: ['ledger.read', 'payments.read'], route: '/admin/payments', fallback: false, contextual: true},
    {permissions: ['payments.read'], route: '/admin/payments', fallback: false, contextual: false},
  ])('keeps ledger history discoverable with its own permission ($permissions)', async ({permissions, route, fallback, contextual, denied}) => {
    const {requests} = openAdmin(route, {session: {user: {...account, permissions}}});
    const heading = denied ? 'Access unavailable' : route === '/admin/licenses' ? 'Open-source licenses' : 'Payments';
    await screen.findByRole('heading', {name: heading}, {timeout: 4_000});
    const inRecorded = screen.queryByRole('link', {name: 'Ledger and reversals history'});
    expect(Boolean(inRecorded)).toBe(contextual);
    if (inRecorded) expect(inRecorded).toHaveAttribute('href', '#/admin/ledgers');

    fireEvent.click(screen.getByRole('button', {name: /^Account:/}));
    const advanced = screen.queryByText('Advanced', {selector: 'summary'});
    if (advanced) fireEvent.click(advanced);
    const fromMenu = screen.queryByRole('link', {name: 'Ledger history'});
    expect(Boolean(fromMenu)).toBe(fallback);
    if (fromMenu) expect(fromMenu).toHaveAttribute('href', '#/admin/ledgers');
    expect(requests).not.toContain('/api/admin/core/ledgers');

    const link = fromMenu ?? inRecorded;
    if (link) {
      fireEvent.click(link);
      await screen.findByRole('heading', {name: 'Ledgers'});
      expect(router.state.location.pathname).toBe('/admin/ledgers');
      await waitFor(() => expect(requests).toContain('/api/admin/core/ledgers'));
    }
  });

  it('blocks a direct ledger link without the original ledger permission', async () => {
    const {requests} = openAdmin('/admin/ledgers', {session: {user: {...account, permissions: ['payments.read']}}});
    await screen.findByRole('heading', {name: 'Access unavailable'});
    expect(requests.filter(path => path.startsWith('/api/admin/core/'))).toEqual([]);
  });

  it.each([
    {description: 'managed staff', role: 'staff', model: 'canonical_evidence_ledger', attested: false, accountAccess: false, smsControls: false, requests: false, buri: false},
    {description: 'unattested managed owner', role: 'owner', model: 'canonical_evidence_ledger', attested: false, accountAccess: true, smsControls: true, requests: true, buri: false},
    {description: 'attested managed owner', role: 'owner', model: 'canonical_evidence_ledger', attested: true, accountAccess: true, smsControls: true, requests: true, buri: true},
    {description: 'legacy owner', role: 'owner', model: 'transaction_journals', attested: true, accountAccess: false, smsControls: true, requests: true, buri: false},
  ])('shows the permitted links for a $description', async ({role, model, attested, accountAccess, smsControls, requests, buri}) => {
    const permissions = ['overview.read', 'payments.read', 'admin_users.manage', 'receivers.read', 'receivers.manage'];
    if (accountAccess) permissions.push('account.manage');
    const user = {...account, role, financialModel: model, principalId: 'principal-one', permissions};
    const session: SessionFixture = {user};
    if (attested) {
      session.ownerIdentity = {schemaVersion: 1, adminId: user.id, principalId: user.principalId, email: user.email};
      session.ownerEmail = user.email;
    }
    openAdmin('/admin/licenses', {session});
    await screen.findByRole('heading', {name: 'Open-source licenses'});
    const links = within(screen.getByRole('navigation', {name: 'Admin sections'}));
    expect(links.getByRole('link', {name: 'Home'})).toHaveAttribute('href', '#/admin');
    expect(links.queryByRole('link', {name: 'MoMo receipts'})).toBeNull();
    expect(links.queryByRole('link', {name: 'SMS receipts'})).toBeNull();
    expect(links.queryByRole('link', {name: 'SMS controls'})).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: /^Account:/}));
    expect(Boolean(screen.queryByRole('link', {name: 'Account security'}))).toBe(accountAccess);
    expect(Boolean(screen.queryByRole('link', {name: 'Activity'}))).toBe(requests);
    const advanced = screen.queryByText('Advanced', {selector: 'summary'});
    if (advanced) fireEvent.click(advanced);
    expect(Boolean(screen.queryByRole('link', {name: 'SMS controls'}))).toBe(smsControls);
    expect(Boolean(screen.queryByRole('link', {name: 'Profile access'}))).toBe(buri);
  });
});
