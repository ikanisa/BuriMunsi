import {webcrypto} from 'node:crypto';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {useState} from 'react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {makeAdminRouter} from '../../src/app/App';
import {ProtectedShell} from '../../src/app/SessionRoutes';
import {AdminSessionController, SessionProvider} from '../../src/session/SessionProvider';
import {Button, Dialog} from '../../src/ui';
import {hasActiveFocusScope} from '../../src/ui/useFocusScope';
import core from '../core/canonical-core-fixtures.json';

const config = {backend: 'supabase', phonePasscodeOnly: true, publishableKey: 'sb_publishable_' + 'a'.repeat(32),
  captchaEnabled: false, googleEnabled: false} as const;
const user = {id: 'admin-one', email: 'operator@example.test', role: 'admin', sessionId: 'session-one',
  permissions: ['overview.read', 'collections.read'], principalId: 'principal-one', assuranceLevel: 1, mfaAt: null,
  authMethod: 'phone_passcode', phone: '+250780000001', financialModel: 'canonical_evidence_ledger'};
const sessionPath = '/api/admin/auth/session';
const scheduledCheckMs = 120_000;
const verified = (permissions = user.permissions, expiresAt = Date.now() + 3_600_000) => Response.json({
  user: {...user, permissions, passcodeVerifiedAt: new Date(Date.now() - 1000).toISOString()},
  expiresAt: new Date(expiresAt).toISOString(), csrfToken: 'c'.repeat(64), ownerEmail: null,
});
const maintenance = () => Response.json({error: {code: 'service_unavailable'}}, {status: 503});
function interruptedBody(status = 200, signal?: AbortSignal | null) {
  const body = new ReadableStream<Uint8Array>({start(stream) {
    stream.enqueue(new TextEncoder().encode('{"user":'));
    if (signal) signal.addEventListener('abort', () => stream.error(signal.reason), {once: true});
    else stream.error(new TypeError('connection interrupted'));
  }});
  return new Response(body, {status});
}
function holdResponse() {
  let release!: (response: Response) => void;
  const promise = new Promise<Response>(resolve => {release = resolve;});
  return {promise, release};
}
let controller: AdminSessionController | undefined;
const openSession = (fetchImpl: typeof fetch) => (controller = new AdminSessionController({...config, fetchImpl}));

afterEach(() => {
  controller?.stop();
  controller = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('scheduled Admin session checks', () => {
  it.each([
    ['maintenance', () => Promise.resolve(maintenance())],
    ['network interruption', () => Promise.reject(new TypeError('connection lost'))],
    ['interrupted HTTP 200 response body', () => Promise.resolve(interruptedBody())],
  ] as const)('suspends protected actions during %s and automatically accepts the verified permissions', async (_, failure) => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(verified())
      .mockImplementationOnce(failure)
      .mockImplementationOnce(async () => verified(['overview.read']));
    const session = openSession(fetchImpl);
    await session.refresh();
    const {epoch} = session.getSnapshot();
    expect(session.isRecentSensitiveVerification(epoch, user.id, user.sessionId)).toBe(true);

    await vi.advanceTimersByTimeAsync(scheduledCheckMs - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.getSnapshot()).toMatchObject({status: 'rechecking', user: {id: user.id}});
    expect(session.isCurrentAuthority(epoch, user.id, user.sessionId)).toBe(false);
    expect(session.isRecentSensitiveVerification(epoch, user.id, user.sessionId)).toBe(false);
    await expect(session.request('core/groups', {body: {}})).rejects.toThrow(/rechecking/i);
    await expect(session.recheckSensitivePasscode()).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({status: 'authenticated', user: {permissions: ['overview.read']}}));
    expect(session.isCurrentAuthority(epoch, user.id, user.sessionId)).toBe(false);
    expect(fetchImpl.mock.calls.map(([path, init]) => [path, init?.method])).toEqual(Array(3).fill([sessionPath, 'GET']));
  });

  it.each([
    ['401', () => Response.json({error: 'unauthenticated'}, {status: 401}), 'anonymous'],
    ['403', () => Response.json({error: 'forbidden'}, {status: 403}), 'error'],
    ['403 with interrupted body', () => interruptedBody(403), 'error'],
    ['invalid identity', () => Response.json({user: {role: 'invalid'}}), 'error'],
    ['invalid JSON', () => new Response('{"user":'), 'error'],
    ['invalid UTF-8', () => new Response(Uint8Array.of(255)), 'error'],
    ['oversized response', () => new Response('{}', {headers: {'Content-Length': '4000000'}}), 'error'],
  ] as const)('closes immediately on %s', async (_, response, status) => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(verified()).mockImplementation(async () => response());
    const session = openSession(fetchImpl);
    await session.refresh();
    await vi.advanceTimersByTimeAsync(scheduledCheckMs);
    expect(session.getSnapshot()).toMatchObject({status, user: null});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('recovers when a timed-out HTTP 200 stream reports its abort after headers', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(verified())
      .mockImplementationOnce(async (_, init) => interruptedBody(200, init?.signal))
      .mockImplementationOnce(async () => verified());
    const session = openSession(fetchImpl);
    await session.refresh();
    await vi.advanceTimersByTimeAsync(scheduledCheckMs + 30_000);
    expect(session.getSnapshot().status).toBe('rechecking');
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(session.getSnapshot().status).toBe('authenticated'));
    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual([sessionPath, sessionPath, sessionPath]);
  });

  it('closes after the bounded retries and permits an explicit recovery', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(verified())
      .mockImplementationOnce(async () => maintenance()).mockImplementationOnce(async () => maintenance())
      .mockImplementationOnce(async () => maintenance()).mockImplementationOnce(async () => maintenance())
      .mockImplementation(async () => verified());
    const session = openSession(fetchImpl);
    await session.refresh();
    await vi.advanceTimersByTimeAsync(scheduledCheckMs + 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(session.getSnapshot()).toMatchObject({status: 'error', user: null});
    await session.refresh();
    expect(session.getSnapshot().status).toBe('authenticated');
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('closes at the recovery deadline even when a retry has not returned', async () => {
    vi.useFakeTimers();
    const held = holdResponse();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(verified())
      .mockImplementationOnce(async () => maintenance()).mockReturnValueOnce(held.promise);
    const session = openSession(fetchImpl);
    await session.refresh();
    await vi.advanceTimersByTimeAsync(scheduledCheckMs + 45_000);
    expect(session.getSnapshot()).toMatchObject({status: 'error', user: null});
    held.release(verified());
    await vi.advanceTimersByTimeAsync(100_000);
    expect(session.getSnapshot().status).toBe('error');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('ignores a delayed protected 401 from before recovery and accepts a new 401 for the recovered session', async () => {
    vi.useFakeTimers();
    const held = holdResponse();
    const denied = () => Response.json({error: 'unauthenticated'}, {status: 401});
    let checks = 0, reads = 0;
    const fetchImpl = vi.fn<typeof fetch>(async path => {
      if (path === sessionPath) return ++checks === 2 ? maintenance() : verified();
      if (path === '/api/admin/core/groups') return ++reads === 1 ? held.promise : denied();
      throw new Error('Unexpected request');
    });
    const session = openSession(fetchImpl);
    await session.refresh();
    const {epoch} = session.getSnapshot();
    const oldRead = session.request('core/groups');
    await vi.advanceTimersByTimeAsync(scheduledCheckMs + 2_000);
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({epoch, status: 'authenticated'}));
    expect(checks).toBe(3);
    held.release(denied());
    await expect(oldRead).rejects.toThrow(/session changed/i);
    expect(session.getSnapshot()).toMatchObject({epoch, status: 'authenticated'});
    await expect(session.request('core/groups')).rejects.toMatchObject({statusCode: 401});
    expect(session.getSnapshot().status).toBe('anonymous');
  });

  it.each(['sign-out', 'expiry'] as const)('discards an in-flight retry after %s', async (reason) => {
    vi.useFakeTimers();
    vi.stubGlobal('crypto', webcrypto);
    const held = holdResponse();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(verified(user.permissions, Date.now() + scheduledCheckMs + 3_000))
      .mockImplementationOnce(async () => maintenance()).mockReturnValueOnce(held.promise)
      .mockResolvedValueOnce(Response.json({ok: true}))
      .mockResolvedValueOnce(Response.json({user: null, expiresAt: null, csrfToken: null, ownerEmail: null}));
    const session = openSession(fetchImpl);
    await session.refresh();
    await vi.advanceTimersByTimeAsync(scheduledCheckMs + 2_000);
    expect(session.getSnapshot().status).toBe('rechecking');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    if (reason === 'sign-out') await session.signOut();
    else await vi.advanceTimersByTimeAsync(1_000);
    expect(session.getSnapshot().status).toBe('anonymous');
    held.release(verified());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(session.getSnapshot()).toMatchObject({status: 'anonymous', user: null});
    expect(fetchImpl.mock.calls.slice(3).map(([path]) => path)).toEqual(reason === 'sign-out' ? ['/api/admin/auth/logout', sessionPath] : []);
  });

  it('keeps the open Members page and its draft search through a temporary background failure', async () => {
    vi.useFakeTimers({shouldAdvanceTime: true});
    const member = {...core.members.rows[0], membership_status: 'active'};
    const rowName = new RegExp(member.display_name);
    const openRecord = {name: 'View ' + member.public_id};
    const {contract_version, model} = core.members;
    const recoveredSession = holdResponse();
    let checks = 0, detailReads = 0;
    const searches: string[] = [];
    const fetchImpl: typeof fetch = async input => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === sessionPath) {
        checks++;
        if (checks === 5) return recoveredSession.promise;
        return checks >= 2 && checks <= 4 ? maintenance() : verified(['overview.read', 'users.read']);
      }
      if (url.pathname === '/api/admin/core/members' && url.searchParams.get('directory') === 'roster') {
        const query = url.searchParams.get('search') ?? '';
        searches.push(query);
        const rows = member.display_name.toLowerCase().includes(query.toLowerCase()) ? [member] : [];
        return Response.json({contract_version, model, rows, total: rows.length});
      }
      if (url.pathname === '/api/admin/operations/members/' + member.id) {
        detailReads++;
        return Response.json({contract_version, model, resource_type: 'members', current_actor_id: user.id, can_manage: false,
          resource: member, related: {}, related_truncated: false});
      }
      throw new Error('Unexpected request');
    };
    window.history.replaceState(null, '', '/#/admin/members');
    const router = makeAdminRouter();
    const view = render(<SessionProvider config={{...config, fetchImpl}}><RouterProvider router={router} /></SessionProvider>);
    try {
      const originalRow = await screen.findByRole('row', {name: rowName});
      const search = screen.getByRole('textbox', {name: 'Search Members'});
      fireEvent.change(search, {target: {value: 'recorded'}});
      await act(async () => {await vi.advanceTimersByTimeAsync(scheduledCheckMs);});
      expect(screen.getByText('Rechecking account access…')).toBeInTheDocument();
      expect(search.closest('[inert]')).toBeInTheDocument();
      expect(originalRow).toBeVisible();
      expect(screen.queryByText('Workspace unavailable')).toBeNull();
      await act(async () => {await vi.advanceTimersByTimeAsync(28_000);});
      expect(screen.getByText('Rechecking account access…')).toBeInTheDocument();
      await act(async () => {await vi.advanceTimersByTimeAsync(3_000);});
      await waitFor(() => expect(checks).toBe(5));
      expect(search.closest('[inert]')).toBeInTheDocument();
      await act(async () => {recoveredSession.release(verified(['overview.read', 'users.read']));});
      await waitFor(() => expect(screen.queryByText('Rechecking account access…')).toBeNull());
      expect(search.closest('[inert]')).toBeNull();
      expect(screen.getByRole('textbox', {name: 'Search Members'})).toBe(search);
      expect(search).toHaveValue('recorded');
      expect(screen.getByRole('row', {name: rowName})).toBe(originalRow);
      expect(router.state.location.pathname).toBe('/admin/members');
      expect({checks, searches, detailReads}).toEqual({checks: 5, searches: [''], detailReads: 0});
      fireEvent.click(screen.getByRole('button', {name: 'Search'}));
      await screen.findByRole('button', openRecord);
      expect(router.state.location.search).toBe('?search=recorded');
      expect(searches).toEqual(['']);
      fireEvent.click(screen.getByRole('button', openRecord));
      await screen.findByRole('heading', {name: 'Record details'});
      expect(screen.getByText(member.display_name)).toBeVisible();
      expect(detailReads).toBe(1);
    } finally {
      view.unmount();
      router.dispose();
      window.history.replaceState(null, '', '/');
    }
  });
});

function DialogFixture() {
  const [open, setOpen] = useState(false);
  return <><Button onClick={() => setOpen(true)}>Open record dialog</Button>
    <Dialog open={open} onClose={() => setOpen(false)} title="Record dialog"><Button>Record action</Button></Dialog></>;
}

it.each(['dialog', 'compact navigation'] as const)('suspends an open %s and lets the operator sign out during recovery', async kind => {
  vi.useFakeTimers({shouldAdvanceTime: true});
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('matchMedia', () => ({matches: true}));
  let checks = 0, signedOut = false;
  const fetchImpl: typeof fetch = async input => {
    if (input === sessionPath) {
      if (signedOut) return Response.json({user: null, expiresAt: null, csrfToken: null, ownerEmail: null});
      return ++checks === 1 ? verified() : maintenance();
    }
    if (input !== '/api/admin/auth/logout') throw new Error('Unexpected request');
    signedOut = true;
    return Response.json({ok: true});
  };
  const router = createMemoryRouter([{path: '/admin', element: <ProtectedShell navigation={[
    {label: 'Home', path: '/admin'},
  ]} />, children: [{index: true, element: <DialogFixture />} ]}, {path: '/admin/login', element: <h1>Signed out</h1>}],
  {initialEntries: ['/admin']});
  const view = render(<SessionProvider config={{...config, fetchImpl}}><RouterProvider router={router} /></SessionProvider>);
  try {
    const trigger = await screen.findByRole('button', {name: kind === 'dialog' ? 'Open record dialog' : 'Open navigation'});
    fireEvent.click(trigger);
    expect(hasActiveFocusScope()).toBe(true);
    if (kind === 'dialog') expect(screen.getByRole('button', {name: 'Record action'})).toBeVisible();
    else expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await act(async () => {await vi.advanceTimersByTimeAsync(scheduledCheckMs);});
    expect(screen.getByText('Rechecking account access…')).toBeInTheDocument();
    expect(hasActiveFocusScope()).toBe(false);
    if (kind === 'dialog') expect(screen.queryByRole('button', {name: 'Record action', hidden: true})).toBeNull();
    else expect(trigger).toHaveAttribute('aria-expanded', 'false');
    const signOut = screen.getByRole('button', {name: 'Sign out'});
    signOut.focus();
    expect(signOut).toHaveFocus();
    expect(fireEvent.keyDown(signOut, {key: 'Tab'})).toBe(true);
    fireEvent.click(signOut);
    await screen.findByRole('heading', {name: 'Signed out'});
    expect(signedOut).toBe(true);
  } finally {view.unmount(); router.dispose();}
});
