import {webcrypto} from 'node:crypto';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {listPending, retainPending} from '../../src/features/core/pendingAttempt';
import {SessionProvider, useSession} from '../../src/session/SessionProvider';
import {TeamPage} from '../../src/session/TeamPage';

const ownerId = 'cdd3c1c0-c124-4c8a-9719-bd2435d198d1', memberId = '53c51330-f311-4519-977b-30f67b47c1f1', sessionId = '0f689afa-5a45-4fb5-a147-9aff36f137dd';
const expiresAt = new Date(Date.now() + 3_600_000).toISOString(), csrf = 'c'.repeat(64), publishableKey = 'sb_publishable_' + 'a'.repeat(32);
const verifiedAt = new Date(Date.now() - 1000).toISOString();
const user = {id: ownerId, email: 'owner@example.com', role: 'owner', sessionId, principalId: 'owner-principal', permissions: ['admin_users.read', 'admin_users.manage'], assuranceLevel: 1, mfaAt: null, financialModel: 'canonical_evidence_ledger'};
const receipt = {contractVersion: 2, id: memberId, requestId: '6ea1b44a-25b7-4f2a-9d20-5829675211bc', messageKind: 'auth_invite', emailStatus: 'accepted', accessStatus: 'invited', operation: 'invite', replayed: false, duplicate: false, sourceRequestId: null};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
const emailProof = {contractVersion: 1, sessionId, emailVerifiedAt: verifiedAt};
const managedSession = (actor = user) => ({user: actor, expiresAt, csrfToken: csrf, ownerEmail: user.email,
  ownerIdentity: {schemaVersion: 1, adminId: user.id, principalId: user.principalId, email: user.email}});
const team = {contractVersion: 2, currentEmail: user.email, canManage: true, permissionsByRole: {owner: ['admin_users.manage'], staff: ['admin_users.read']}, members: [{id: memberId, email: 'staff@example.com', role: 'staff', status: 'invited', displayName: 'Staff member', publicId: null, invitation: receipt}]};
beforeEach(() => {Object.defineProperty(globalThis, 'crypto', {value: webcrypto, configurable: true}); sessionStorage.clear();});

function makeTransport() {
  const keys: string[] = [];
  const removals: RequestInit[] = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/auth/session')) return reply(managedSession());
    if (path.endsWith('/auth/email-verification')) return reply(emailProof);
    if (path.endsWith('/team/v2')) return reply(team);
    if (path.endsWith('/team/v2/invitation-status')) return reply({ok: true, contractVersion: 2, found: false});
    if (path.endsWith('/team/v2/invite')) {
      keys.push((options?.headers as Record<string, string>)['Idempotency-Key']);
      if (keys.length === 1) throw new TypeError('connection lost');
      return reply({ok: true, outcome: 'accepted', ...receipt});
    }
    if (path.endsWith(`/team/${memberId}/revoke`)) {removals.push(options ?? {}); return reply({ok: true});}
    return reply({error: {code: 'not_found'}}, 404);
  });
  return {fetchImpl, keys, removals};
}
function mounted(fetchImpl: typeof fetch, enabled = false) {
  return render(<SessionProvider config={{backend: 'supabase', publishableKey, captchaEnabled: false, googleEnabled: false, fetchImpl}}><TeamPage onVerify={() => undefined} {...(enabled ? {allowMutations: true} : {})} /></SessionProvider>);
}
function makeV1Transport() {
  const keys: string[] = [], historyId = '6ea1b44a-25b7-4f2a-9d20-5829675211bc';
  const member = {id: memberId, email: 'staff@example.com', role: 'staff', status: 'invited', displayName: 'Staff member', emailStatus: 'accepted', invitationRequestId: historyId, invitationOperation: 'invite'};
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/auth/session')) return reply(managedSession());
    if (path.endsWith('/auth/email-verification')) return reply(emailProof);
    if (path.endsWith('/team')) return reply({currentEmail: user.email, canManage: true, permissionsByRole: {}, members: [member]});
    if (path.endsWith('/team/invitation-status')) return reply({ok: true, found: false});
    if (path.endsWith('/team/invite')) {
      keys.push((options?.headers as Record<string, string>)['Idempotency-Key']);
      if (keys.length === 1) throw new TypeError('connection lost');
      return reply({ok: true, outcome: 'accepted', id: memberId, requestId: historyId, emailStatus: 'accepted', accessStatus: 'invited', operation: 'invite', replayed: false, duplicate: false});
    }
    return reply({error: {code: 'not_found'}}, 404);
  });
  return {fetchImpl, keys};
}

describe('team management controls', () => {
  it('starts a clean team read when a different session replaces the previous account', async () => {
    const next = {...user, id: memberId, role: 'staff', email: 'staff@example.com',
      sessionId: '9e9c15e2-36ff-4024-814b-15b48302dfa8', permissions: ['admin_users.read']};
    let actor = user;
    let finishDirectory!: (value: Response) => void;
    const newDirectory = new Promise<Response>(resolve => { finishDirectory = resolve; });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path.endsWith('/auth/session')) return reply(managedSession(actor));
      if (path.endsWith('/auth/email-verification')) return reply({
        contractVersion: 1, sessionId: actor.sessionId, emailVerifiedAt: actor === user ? verifiedAt : null,
      });
      if (path.endsWith('/team/v2')) return reply({error: 'unavailable'}, 503);
      if (path.endsWith('/team')) return newDirectory;
      return reply({error: 'not_found'}, 404);
    });
    function RefreshSession() {
      const {refresh} = useSession();
      return <button type="button" onClick={() => {void refresh();}}>Refresh account session</button>;
    }
    render(<SessionProvider config={{backend: 'supabase', publishableKey, captchaEnabled: false, googleEnabled: false, fetchImpl}}>
      <RefreshSession />
      <TeamPage onVerify={() => undefined} />
    </SessionProvider>);
    expect(await screen.findByText('Team access unavailable')).toBeInTheDocument();

    actor = next;
    fireEvent.click(screen.getByRole('button', {name: 'Refresh account session'}));
    expect(await screen.findByText('Loading team access')).toBeInTheDocument();
    expect(screen.queryByText('Team access unavailable')).not.toBeInTheDocument();
    finishDirectory(reply({currentEmail: next.email, canManage: false, members: [], permissionsByRole: {}}));
    expect(await screen.findByText('No team members')).toBeInTheDocument();
  });

  it('keeps the live review limited to team reads', async () => {
    const {fetchImpl} = makeTransport();
    const verify = vi.fn();
    render(<SessionProvider config={{backend: 'supabase', publishableKey, captchaEnabled: false, googleEnabled: false, fetchImpl}}>
      <TeamPage onVerify={verify} allowRecovery={false} showVerification={false} />
    </SessionProvider>);
    expect(await screen.findByText('Staff member')).toBeInTheDocument();
    expect(screen.queryByRole('button', {name: /verify|review pending|add teammate|remove access/i})).not.toBeInTheDocument();
    expect(fetchImpl.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it('does not expose invitation or removal controls without an explicit gate', async () => {
    const {fetchImpl} = makeTransport();
    mounted(fetchImpl);
    expect(await screen.findByText('Staff member')).toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Add teammate'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Remove access'})).not.toBeInTheDocument();
    expect(fetchImpl.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  });

  it('removes older rows and controls when a refreshed directory fails', async () => {
    const {fetchImpl} = makeTransport();
    let failing = false;
    const fetchTeam: typeof fetch = (url, options) => {
      if (failing && String(url).endsWith('/team/v2')) return Promise.resolve(reply({error: 'unavailable'}, 503));
      return fetchImpl(url, options);
    };
    mounted(fetchTeam, true);
    expect(await screen.findByRole('row', {name: /staff@example.com/})).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Remove access'})).toBeInTheDocument();
    failing = true;
    fireEvent.click(screen.getByRole('button', {name: 'Refresh'}));
    expect(await screen.findByText('Team access unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('row', {name: /staff@example.com/})).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: /remove access|add teammate|review pending requests/i})).not.toBeInTheDocument();
  });

  it('drops a protected directory reply if the verification has expired before the timer runs', async () => {
    const {fetchImpl} = makeTransport();
    let readStarted = false, finishRead!: (response: Response) => void;
    const protectedRead = new Promise<Response>(resolve => {finishRead = resolve;});
    const fetchTeam: typeof fetch = (url, options) => {
      if (String(url).endsWith('/team/v2')) {
        readStarted = true;
        return protectedRead;
      }
      return fetchImpl(url, options);
    };
    mounted(fetchTeam, true);
    await waitFor(() => expect(readStarted).toBe(true));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(verifiedAt) + 300_001);
    try {
      await act(async () => {finishRead(reply(team));});
      expect(screen.queryByRole('row', {name: /staff@example.com/})).not.toBeInTheDocument();
      expect(screen.queryByRole('button', {name: /remove access|add teammate|review pending requests/i})).not.toBeInTheDocument();
    } finally {
      clock.mockRestore();
    }
  });

  it('invalidates an invitation still awaiting verification when the directory is refreshed', async () => {
    const {fetchImpl, keys} = makeTransport();
    let checkStarted = false, finishCheck!: (response: Response) => void;
    const recheck = new Promise<Response>(resolve => {finishCheck = resolve;});
    let reads = 0;
    const fetchTeam: typeof fetch = (url, options) => {
      if (String(url).endsWith('/auth/email-verification') && ++reads > 1) {
        checkStarted = true;
        return recheck;
      }
      return fetchImpl(url, options);
    };
    mounted(fetchTeam, true);
    fireEvent.change(await screen.findByLabelText('Email address'), {target: {value: 'newstaff@example.com'}});
    fireEvent.click(screen.getByRole('button', {name: 'Add teammate'}));
    await waitFor(() => expect(checkStarted).toBe(true));
    fireEvent.click(screen.getByRole('button', {name: 'Refresh'}));
    await screen.findByRole('button', {name: 'Add teammate'});
    await act(async () => {finishCheck(reply(emailProof));});
    expect(keys).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });

  it('checks a legacy managed checkpoint without offering writes or clearing its original reference', async () => {
    const legacy = {...user, role: 'owner' as const, email: 'info@ikanisa.com'};
    const identity = {...legacy, expiresAt};
    await retainPending(identity, 'team-invitation', 'invite', sessionId, 'admin_users.manage', {
      operation: 'invite', path: 'team/invite', staff_id: null, prior_request_id: null, prior_operation: null,
      body: {email: 'staff@example.com', role: 'staff', displayName: ''},
    });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, _options?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/auth/session')) return reply({user: legacy, expiresAt, csrfToken: csrf});
      if (path.endsWith('/auth/email-verification')) return reply(emailProof);
      if (path.endsWith('/team')) return reply({currentEmail: legacy.email, canManage: true, permissionsByRole: {}, members: []});
      if (path.endsWith('/team/invitation-status')) return reply({ok: true, found: false});
      return reply({error: 'not_found'}, 404);
    });
    mounted(fetchImpl, true);
    fireEvent.click(await screen.findByRole('button', {name: 'Review pending requests'}));
    fireEvent.click(await screen.findByRole('button', {name: 'Check original request'}));
    expect(await screen.findByText(/no matching original request/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', {name: /add teammate|invite teammate|retry the same request/i})).not.toBeInTheDocument();
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/team/v2'))).toBe(false);
    const lookup = fetchImpl.mock.calls.find(([url]) => String(url).endsWith('/team/invitation-status'));
    expect(lookup?.[1]?.method).toBe('GET');
    expect((lookup?.[1]?.headers as Record<string, string>)['Idempotency-Key']).toBe(sessionId);
    expect(await listPending(identity, 'team-invitation', 'admin_users.manage')).toHaveLength(1);
  });

  it('requires an explicit retry after an unknown result and not-found lookup, preserving the key', async () => {
    const {fetchImpl, keys} = makeTransport();
    mounted(fetchImpl, true);
    const email = await screen.findByLabelText('Email address');
    fireEvent.change(email, {target: {value: 'newstaff@example.com'}});
    fireEvent.click(screen.getByRole('button', {name: 'Add teammate'}));
    expect(await screen.findByText(/invitation result is not confirmed/i)).toBeInTheDocument();
    expect(keys).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', {name: 'Review pending requests'}));
    fireEvent.click(await screen.findByRole('button', {name: 'Check original request'}));
    fireEvent.click(await screen.findByRole('button', {name: 'Retry the same request'}));
    const dialog = screen.getByRole('dialog', {name: 'Retry the original invitation?'});
    expect(within(dialog).getByText(/newstaff@example.com/)).toBeInTheDocument();
    expect(keys).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', {name: 'Retry same request'}));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
    expect(await screen.findByText('Invitation accepted for sending. Inbox delivery is not confirmed.')).toBeInTheDocument();
  });

  it('asks before removing access and never sends a fabricated idempotency key', async () => {
    const {fetchImpl, removals} = makeTransport();
    mounted(fetchImpl, true);
    fireEvent.click(await screen.findByRole('button', {name: 'Remove access'}));
    const dialog = screen.getByRole('dialog', {name: 'Remove team access?'});
    expect(within(dialog).getByText(/staff@example.com will lose access/)).toBeInTheDocument();
    expect(removals).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', {name: 'Remove access'}));
    expect(await screen.findByText('Access removed for staff@example.com.')).toBeInTheDocument();
    expect(removals).toHaveLength(1);
    expect((removals[0].headers as Record<string, string>)['Idempotency-Key']).toBeUndefined();
  });

  it('keeps managed v1 changes hidden until explicitly enabled', async () => {
    const {fetchImpl} = makeV1Transport();
    render(<SessionProvider config={{backend: 'supabase', publishableKey, captchaEnabled: false, googleEnabled: false, fetchImpl}}><TeamPage onVerify={() => undefined} managedInvitationVersion={1} /></SessionProvider>);
    expect(await screen.findByText('Staff member')).toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Invite teammate'})).not.toBeInTheDocument();
    expect(fetchImpl.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  });

  it('checks and explicitly retries the same managed v1 request after a lost reply', async () => {
    const {fetchImpl, keys} = makeV1Transport();
    render(<SessionProvider config={{backend: 'supabase', publishableKey, captchaEnabled: false, googleEnabled: false, fetchImpl}}><TeamPage onVerify={() => undefined} managedInvitationVersion={1} allowMutations /></SessionProvider>);
    fireEvent.change(await screen.findByLabelText('Email address'), {target: {value: 'newstaff@example.com'}});
    expect(screen.getByText('Access removal is currently unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Remove access'})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: 'Invite teammate'}));
    expect(await screen.findByText(/invitation result is not confirmed/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: 'Review pending requests'}));
    fireEvent.click(await screen.findByRole('button', {name: 'Check original request'}));
    fireEvent.click(await screen.findByRole('button', {name: 'Retry the same request'}));
    expect(keys).toHaveLength(1);
    fireEvent.click(within(screen.getByRole('dialog', {name: 'Retry the original invitation?'})).getByRole('button', {name: 'Retry same request'}));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
    expect(await screen.findByText('Invitation accepted for sending. Inbox delivery is not confirmed.')).toBeInTheDocument();
  });

  it('does not expose the unrecoverable Cloudflare legacy invitation or removal paths', async () => {
    const cloudflareUser = {...user, email: 'info@ikanisa.com', assuranceLevel: 2, mfaAt: new Date().toISOString()};
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, _options?: RequestInit) => {
      if (String(url).endsWith('/auth/session')) return reply({user: cloudflareUser, expiresAt});
      if (String(url).endsWith('/team')) return reply({currentEmail: cloudflareUser.email, canManage: true, permissionsByRole: {}, members: [{id: memberId, email: 'staff@example.com', role: 'staff', status: 'invited', displayName: 'Staff member', emailStatus: 'accepted'}]});
      return reply({error: {code: 'not_found'}}, 404);
    });
    render(<SessionProvider config={{backend: 'cloudflare', captchaEnabled: false, googleEnabled: false, fetchImpl}}><TeamPage onVerify={() => undefined} managedInvitationVersion={1} allowMutations /></SessionProvider>);
    expect(await screen.findByText('Staff member')).toBeInTheDocument();
    expect(screen.queryByRole('button', {name: /Invite teammate|Resend email|Remove access/})).not.toBeInTheDocument();
    expect(fetchImpl.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  });
});
