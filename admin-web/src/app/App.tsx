import {useMemo} from 'react';
import {createHashRouter, Navigate, RouterProvider} from 'react-router';
import {ProtectedShell, publicSessionRoutes} from './SessionRoutes';
import {UnavailablePage} from './UnavailablePage';
import {workspaceRoutes} from './WorkspaceRoutes';
import {adminAccountNavigation, primaryAdminNavigation} from './navigation';
import './transaction-view.css';

export function makeAdminRouter() {
  return createHashRouter([
    {path: '/', element: <Navigate to="/admin" replace />},
    ...publicSessionRoutes(),
    {path: '/admin', caseSensitive: true, element: <ProtectedShell navigation={primaryAdminNavigation} accountNavigation={adminAccountNavigation} />, children: workspaceRoutes},
    {path: '*', element: <UnavailablePage title="Page unavailable" />},
  ]);
}

export function AdminApp() {
  const router = useMemo(() => makeAdminRouter(), []);
  return <RouterProvider router={router} />;
}
