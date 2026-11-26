import {useCallback, useMemo} from 'react';
import {createHashRouter, Navigate, RouterProvider} from 'react-router';
import {ProtectedShell, publicSessionRoutes} from './SessionRoutes';
import {UnavailablePage} from './UnavailablePage';
import {workspaceRoutes} from './WorkspaceRoutes';
import {adminAccountNavigation, primaryAdminNavigation} from './navigation';
import type {AdminClientConfig} from '../api/client';
import {SessionProvider} from '../session/SessionProvider';
import './transaction-view.css';

export function makeAdminRouter() {
  return createHashRouter([
    {path: '/', element: <Navigate to="/admin" replace />},
    ...publicSessionRoutes(),
    {path: '/admin', caseSensitive: true, element: <ProtectedShell navigation={primaryAdminNavigation} accountNavigation={adminAccountNavigation} />, children: workspaceRoutes},
    {path: '*', element: <UnavailablePage title="Page unavailable" />},
  ]);
}

export function AdminApp({config}: {config: AdminClientConfig}) {
  const router = useMemo(() => makeAdminRouter(), []);
  const resolveHomeStart = useCallback(() => {
    const initial = router.state.location;
    return initial.pathname === '/admin' && !initial.search && !initial.hash ? () => router.state.location === initial : undefined;
  }, [router]);
  return <SessionProvider config={config} resolveHomeStart={resolveHomeStart}><RouterProvider router={router} /></SessionProvider>;
}
