import {Component, Suspense, useCallback, type ReactNode} from 'react';
import {Navigate, Outlet, useLocation, useNavigate, type RouteObject} from 'react-router';
import {LoginPage} from '../session/LoginPage';
import {publicSessionPaths, safeAdminReturnLocation} from '../session/returnLocation';
import {useSession, type SessionContextValue} from '../session/SessionProvider';
import {AdminShell, type AdminNavItem} from '../layout/AdminShell';
import {Button, ErrorState, LoadingState} from '../ui';
import {canOpenAdminPath} from './route-access';

export function SessionProblem({session}: {session: Pick<SessionContextValue, 'logoutUnconfirmed' | 'mfaRecoveryPending' | 'error' | 'signOut' | 'refresh'>}) {
  return <><ErrorState title={session.logoutUnconfirmed ? 'Sign-out not confirmed' : 'Workspace unavailable'}
    message={session.error ?? 'Account access could not be checked.'}
    onRetry={() => {void (session.logoutUnconfirmed ? session.signOut() : session.refresh()).catch(() => undefined);}} />
    {!session.logoutUnconfirmed && <Button onClick={() => {void session.signOut().catch(() => undefined);}}>Sign out of this session</Button>}
  </>;
}

export class ScreenBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() {return {failed: true};}
  render() {
    return this.state.failed ? <ErrorState title="Page unavailable" message="Finish work in other Admin tabs, then reopen this page online."
      onRetry={() => window.location.reload()} /> : this.props.children;
  }
}

export function ProtectedShell({navigation}: {navigation: readonly AdminNavItem[]}) {
  const session = useSession(), location = useLocation();
  if (session.status === 'loading') return <LoadingState label="Checking account access" />;
  if (session.status === 'error') return <SessionProblem session={session} />;
  if (!session.user) {
    const requested = safeAdminReturnLocation(`${location.pathname}${location.search}`);
    return <Navigate to={`/admin/login${requested ? `?${new URLSearchParams({returnTo: requested})}` : ''}`} replace />;
  }
  const user = session.user;
  const permitted = navigation.filter(item => canOpenAdminPath(item.path, user));
  return <AdminShell navigation={permitted} currentPath={`${location.pathname}${location.search}`}
    identity={{name: session.verificationMode === 'passcode' ? user.displayName ?? user.phone ?? 'BuriMunsi account' : user.email,
      role: user.role === 'owner' ? 'Owner' : user.role === 'admin' ? 'Admin' : 'Staff'}}
    onSignOut={() => {void session.signOut().catch(() => undefined);}}>
    {canOpenAdminPath(location.pathname, user) ? <ScreenBoundary key={location.pathname}><Suspense fallback={<LoadingState label="Opening workspace" />}><Outlet /></Suspense></ScreenBoundary> : <ErrorState title="Access unavailable"
      message="Your account cannot open this page." />}
  </AdminShell>;
}

function SessionState({children}: {children: ReactNode}) {
  const session = useSession();
  if (session.status === 'loading') return <LoadingState label="Checking account access" />;
  if (session.logoutUnconfirmed || session.status === 'error' && session.mfaRecoveryPending) return <SessionProblem session={session} />;
  return children;
}

function LoginRoute() {
  const go = useNavigate(), location = useLocation();
  const destination = safeAdminReturnLocation(new URLSearchParams(location.search).get('returnTo')) ?? '/admin';
  const onSignedIn = useCallback(() => go(destination, {replace: true}), [destination, go]);
  return <SessionState><LoginPage onSignedIn={onSignedIn} /></SessionState>;
}

export function SessionRedirectRoute() {
  const location = useLocation();
  const destination = safeAdminReturnLocation(new URLSearchParams(location.search).get('returnTo')) ?? '/admin';
  return <Navigate to={destination} replace />;
}

export function publicSessionRoutes(): RouteObject[] {
  return [
    {path: publicSessionPaths.login, element: <LoginRoute />},
    {path: publicSessionPaths.forgotPassword, element: <Navigate to={publicSessionPaths.login} replace />},
    {path: publicSessionPaths.setup, element: <Navigate to={publicSessionPaths.login} replace />},
    {path: publicSessionPaths.redirect, element: <SessionRedirectRoute />},
  ];
}
