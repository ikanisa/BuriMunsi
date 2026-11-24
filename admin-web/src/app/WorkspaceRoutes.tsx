import {accountRoutes} from './workspace/account-routes';
import {financialActionRoutes, ledgerAccountRoutes, reconciliationRoutes} from './workspace/financial-routes';
import {operatorRoutes, OverviewRoute, requestHistoryRoute} from './workspace/operator-routes';
import {groupRecordRoutes, recordRoutes} from './workspace/record-routes';
import {collectWorkspaceOnly, requiresPermissions, type WorkspaceRoute} from './workspace/routePolicy';
import {verificationRoutes} from './workspace/verification-routes';

export const workspaceRoutes: WorkspaceRoute[] = [
  {index: true, element: <OverviewRoute />, handle: requiresPermissions('overview.read')},
  ...recordRoutes,
  ...groupRecordRoutes,
  requestHistoryRoute,
  ...verificationRoutes,
  ...accountRoutes,
  ...operatorRoutes,
  ...[...reconciliationRoutes, ...financialActionRoutes, ...ledgerAccountRoutes]
    .map(route => ({...route, handle: collectWorkspaceOnly(route.handle)})),
];
