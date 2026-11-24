import type {AdminNavItem, AdminAccountDestination} from '../layout/AdminShell';

export const primaryAdminNavigation: readonly AdminNavItem[] = [
  {label: 'Home', path: '/admin', icon: 'home'},
  {label: 'Members', path: '/admin/members', icon: 'users', relatedPaths: ['/admin/users']},
  {label: 'Payments', path: '/admin/payments', icon: 'swap', relatedPaths: [
    '/admin/transactions', '/admin/reconciliations', '/admin/ledgers', '/admin/ledger-accounts',
    '/admin/momo-receipts', '/admin/sms-receipts', '/admin/member-receipts',
  ]},
];

// These are entry points, not grants. ProtectedShell runs the same existing
// route-policy filter for both groups before presenting anything.
export type AccountNavigationItem = AdminAccountDestination & {contextualPath?: string};
export const adminAccountNavigation: readonly AccountNavigationItem[] = [
  {label: 'Account security', path: '/admin/security', icon: 'lock'},
  {label: 'Team', path: '/admin/admin-users', icon: 'users'},
  {label: 'Workspace', path: '/admin/groups', icon: 'settings'},
  {label: 'Privacy requests', path: '/admin/privacy-requests', icon: 'lock'},
  {label: 'Activity', path: '/admin/requests', icon: 'clock'},
  {label: 'Open-source notices', path: '/admin/licenses', icon: 'file', group: 'help'},
  {label: 'Receiving accounts', path: '/admin/payees', group: 'advanced', contextualPath: '/admin/groups'},
  {label: 'Profile access', path: '/admin/burimunsi', group: 'advanced', contextualPath: '/admin/admin-users'},
  {label: 'Ledger history', path: '/admin/ledgers', group: 'advanced', contextualPath: '/admin/transactions'},
  {label: 'Legacy gateway devices', path: '/admin/gateway', group: 'advanced'},
  {label: 'Assisted SMS', path: '/admin/notification-operator', group: 'advanced'},
  {label: 'SMS controls', path: '/admin/notification-settings', group: 'advanced'},
  {label: 'Email notifications', path: '/admin/email', group: 'advanced'},
];
