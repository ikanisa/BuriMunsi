import {matchRoutes, type RouteObject} from 'react-router';
import type {AdminUser} from '../session/sessionResponses';
import {workspaceRoutes} from './WorkspaceRoutes';
import {retiredBuriMunsiRoutes} from './navigation';

const protectedRoutes: RouteObject[] = [{path: '/admin', caseSensitive: true, children: workspaceRoutes}];

export function redirectsToBuriMunsiHome(path: string, user: AdminUser): boolean {
  return user.authMethod === 'phone_passcode' && matchRoutes(retiredBuriMunsiRoutes, path) !== null;
}

/** Presentation guard only; every operation remains server-authorized. */
export function canOpenAdminPath(path: string, user: AdminUser): boolean {
  if (redirectsToBuriMunsiHome(path, user)) return false;
  const matches = matchRoutes(protectedRoutes, path);
  const access = matches?.at(-1)?.route.handle;
  return typeof access === 'function' && access(user) === true;
}
