import {act, fireEvent, render, screen} from '@testing-library/react';
import {createMemoryRouter, RouterProvider, useLocation} from 'react-router';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {DesktopLaunch} from '../../src/app/DesktopLaunch';
import {primaryAdminNavigation} from '../../src/app/navigation';
import {AdminShell} from '../../src/layout/AdminShell';
import {readDesktopDestination} from '../../src/session/operatorBookmarks';
import {safeAdminReturnLocation} from '../../src/session/returnLocation';

function View() {
  const {pathname} = useLocation();
  return <main><h1>{pathname}</h1><input aria-label="Current work" /></main>;
}

function setup(initial = '/admin', supported = true) {
  const router = createMemoryRouter([{path: '*', element: <View />}], {initialEntries: [initial]});
  let consumer: ((launch: {targetURL?: string | null}) => void) | undefined;
  if (supported) vi.stubGlobal('launchQueue', {setConsumer(callback: typeof consumer) {consumer = callback;}});
  const view = render(<><DesktopLaunch router={router} /><RouterProvider router={router} /></>);
  const send = async (targetURL?: string | null) => {await act(() => consumer?.({targetURL}));};
  const shortcut = (path: string) => send(window.location.origin + '/#' + path);
  return {router, send, shortcut, ...view};
}

afterEach(() => vi.unstubAllGlobals());

describe('installed desktop shortcut navigation', () => {
  it.each(['/admin', '/admin/members', '/admin/payments'])('opens the exact advertised %s target', async target => {
    const {router, shortcut} = setup(target === '/admin' ? '/admin/members' : '/admin');
    await shortcut(target);
    expect(router.state.location.pathname).toBe(target);
    const key = router.state.location.key;
    await shortcut(target);
    expect(router.state.location.key).toBe(key);
  });

  it('ignores icon launches, malformed and foreign URLs, unknown queries, credentials and action destinations', async () => {
    const {router, send} = setup('/admin/members/new');
    const key = router.state.location.key;
    for (const target of [undefined, null, '', location.origin + '/', '/#/admin', 'https://other.example/#/admin',
      location.origin + '/other#/admin', location.origin + '/?tracking=1#/admin', location.origin + '/#/admin?extra=1',
      location.origin + '/#/%61dmin', location.origin + '/#/admin/security/verify-passcode', location.origin + '/#/admin/members/new',
      location.origin + '/admin/payments?allocate=record', location.origin + '/admin/members?access_token=secret',
      location.origin + '/api/admin/burimunsi/payments', location.origin + '/privacy/account-deletion/assets/style.css',
      location.origin + '/#/privacy', location.origin + '/privacy?code=secret',
      location.origin.replace('://', '://operator@') + '/#/admin']) await send(target);
    expect(router.state.location.key).toBe(key);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('preserves an open edit and its focus, allows keyboard dismissal and opens a later explicit destination', async () => {
    const {router, shortcut, send} = setup('/admin/members/new');
    const field = screen.getByRole('textbox');
    field.focus();
    fireEvent.input(field, {target: {value: 'Unsubmitted fixture'}});
    await send(location.origin + '/');
    expect(screen.queryByRole('button')).toBeNull();
    await shortcut('/admin/payments');
    await shortcut('/admin/payments');
    expect(screen.getAllByRole('button', {name: 'Open Payments'})).toHaveLength(1);
    expect(field).toHaveFocus();
    expect(field).toHaveValue('Unsubmitted fixture');
    fireEvent.click(screen.getByRole('button', {name: 'Dismiss'}));
    expect(field).toHaveFocus();
    expect(router.state.location.pathname).toBe('/admin/members/new');
    await shortcut('/admin');
    await shortcut('/admin/payments');
    expect(screen.queryByRole('button', {name: 'Open Home'})).toBeNull();
    await act(() => screen.getByRole('button', {name: 'Open Payments'}).click());
    expect(router.state.location.pathname).toBe('/admin/payments');
    await act(() => router.navigate(-1));
    expect(router.state.location.pathname).toBe('/admin/members/new');
    await act(() => router.navigate(1));
    expect(router.state.location.pathname).toBe('/admin/payments');
  });

  it('keeps unsubmitted list input, filters and local selection intact on a same-section shortcut', async () => {
    const {router, shortcut} = setup('/admin/payments?status=unallocated');
    const key = router.state.location.key;
    await shortcut('/admin/payments');
    expect(router.state.location.key).toBe(key);
    await shortcut('/admin/members');
    expect(screen.getByRole('button', {name: 'Open Members'})).toBeVisible();
    await act(() => router.navigate('/admin/payments'));
    expect(screen.queryByRole('button')).toBeNull();
    fireEvent.input(screen.getByRole('textbox'), {target: {value: 'unapplied search'}});
    await shortcut('/admin/members');
    expect(router.state.location.pathname).toBe('/admin/payments');
    expect(screen.getByRole('textbox')).toHaveValue('unapplied search');
    expect(screen.getByRole('button', {name: 'Open Members'})).toBeVisible();
  });

  it('replaces only the sign-in destination while preserving typed input, focused control and history', async () => {
    const {router, shortcut} = setup('/admin/login?returnTo=%2Fadmin%2Fmembers');
    const field = screen.getByRole('textbox');
    field.focus();
    fireEvent.input(field, {target: {value: 'fixture sign-in draft'}});
    const key = router.state.location.key;
    await shortcut('/admin/members');
    expect(router.state.location.key).toBe(key);
    await shortcut('/admin/payments');
    expect(router.state.location.pathname).toBe('/admin/login');
    expect(new URLSearchParams(router.state.location.search).get('returnTo')).toBe('/admin/payments');
    expect(router.state.historyAction).toBe('REPLACE');
    expect(field).toHaveValue('fixture sign-in draft');
    expect(field).toHaveFocus();
  });

  it('leaves the ordinary route active when the platform omits the queue or a removed consumer receives a late launch', async () => {
    const fallback = setup('/admin/members', false);
    expect(fallback.router.state.location.pathname).toBe('/admin/members');
    fallback.unmount();
    const active = setup('/admin');
    active.unmount();
    await active.shortcut('/admin/payments');
    expect(active.router.state.location.pathname).toBe('/admin');
  });

  it.each([false, true])('does not transfer focus from a different navigation or a modified activation (modified=%s)', modified => {
    const shell = (path: string) => <div onClick={event => event.preventDefault()}>
      <AdminShell currentPath={path} navigation={primaryAdminNavigation}><input aria-label="Workspace control" /></AdminShell>
    </div>;
    const view = render(shell('/admin'));
    fireEvent.click(screen.getByRole('link', {name: 'Members'}), {detail: 0, ctrlKey: modified});
    if (!modified) view.rerender(shell('/admin/payments'));
    const control = screen.getByRole('textbox');
    control.focus();
    view.rerender(shell('/admin/members'));
    expect(control).toHaveFocus();
  });
});

const memberId = '11111111-1111-4111-8111-111111111111';
const roster = '/admin/members?search=Member%20%26%20Co&status=active';
const member = '/admin/members/' + memberId;
const nested = '?' + new URLSearchParams({returnTo: roster});
describe('captured read-only bookmarks', () => {
  it.each([
    [roster, 'Members'], ['/admin/users?sort=full_name_desc&page=2', 'Members'],
    [member + nested, 'Member details'], [member + '/statement' + nested, 'Member statement'],
    ['/admin/transactions/' + memberId, 'Payment details'], ['/admin/payments?payment=payment_2', 'Payment details'],
    ['/admin/payments?direction=incoming&offset=25&q=Member%20A', 'Payments'],
    ['/admin/security','Account security'], ['/admin/admin-users','Team'], ['/admin/licenses','Open-source notices'],
  ])('accepts both document-path and hash forms of %s with a fixed public label', (path, label) => {
    for (const prefix of [location.origin, location.origin + '/#']) {
      expect(readDesktopDestination(prefix + path, location.origin)).toEqual({kind:'workspace', path, label});
    }
  });

  it.each(['/admin/members/', '/admin/payments/', member + '/statement/'])('accepts the supported trailing slash on %s', path => {
    expect(readDesktopDestination(location.origin + path, location.origin)?.path).toBe(path.slice(0,-1));
  });

  it.each([member + '/edit', '/admin/payments?payment=../other', '/admin/payments?payment=a&payment=b',
    member + '?returnTo=https%3A%2F%2Fother.example', member + '?returnTo=%2Fadmin%2Fsecurity',
    '/admin/members?search=a%0Ab', '/admin/payments/new', '/admin/members/not-a-record', '/admin//members',
    '/admin/members?token=private', '/admin/members?unknown=1', '/privacy?tracking=1', '/admin/members/' + memberId + '/anything',
    '/admin/security?returnTo=%2Fadmin','/admin/admin-users?role=admin','/admin/licenses?download=1','/admin/admin-users/new',
  ])('rejects unsupported path, query or nested return %s', path => {
    expect(readDesktopDestination(location.origin + path, location.origin)).toBeNull();
  });

  it('preserves a real long percent-encoded roster filter through sign-in without extending general or credential return URLs', () => {
    const filters = JSON.stringify([['full_name','any','界'.repeat(180)], ['phone','any','É'.repeat(150)]]);
    const path = '/admin/members?' + new URLSearchParams({filters});
    expect(path.length).toBeGreaterThan(2000);
    expect(safeAdminReturnLocation(path)).toBe(path);
    const detail = member + '?' + new URLSearchParams({returnTo:path});
    expect(safeAdminReturnLocation(detail)).toBe(detail);
    expect(safeAdminReturnLocation('/admin/security?private=' + 'x'.repeat(2000))).toBeNull();
    expect(safeAdminReturnLocation('/admin/members?search=' + 'x'.repeat(2000))).toBeNull();
  });

  it('keeps a filtered list or signed-in edit until a different same-section record is explicitly chosen', async () => {
    const {router, send, shortcut} = setup(roster);
    await shortcut('/admin/members');
    const initial = router.state.location.key;
    await send(location.origin + member + nested);
    expect(screen.getByRole('region', {name:'Desktop shortcut'})).not.toHaveTextContent(memberId);
    expect(router.state.location.key).toBe(initial);
    await act(() => screen.getByRole('button', {name:'Open Member details'}).click());
    expect(router.state.location.pathname + router.state.location.search).toBe(member + nested);
    await shortcut('/admin/members?status=inactive');
    await act(() => screen.getByRole('button',{name:'Open Members'}).click());
    expect(router.state.location.search).toBe('?status=inactive');
  });

  it.each([['/privacy', 'Privacy and data use'], ['/privacy/account-deletion/', 'Account deletion']])(
    'offers the real %s document in a separate tab while preserving current work', async (path, label) => {
      const {router, send} = setup('/admin/members/new');
      const field = screen.getByRole('textbox');
      field.focus();
      fireEvent.input(field, {target:{value:'Unsubmitted fixture'}});
      await send(location.origin + path);
      const link = screen.getByRole('link', {name:`Open ${label} (opens in a new tab)`});
      expect(link).toHaveAttribute('href', path.replace(/\/$/,''));
      expect(link).toHaveAttribute('target','_blank');
      expect(link).toHaveAttribute('rel','noopener noreferrer');
      expect(field).toHaveFocus();
      expect(field).toHaveValue('Unsubmitted fixture');
      expect(router.state.location.pathname).toBe('/admin/members/new');
    });
});
