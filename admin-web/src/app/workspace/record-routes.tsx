import {lazy, type ReactElement} from 'react';
import {Link, Navigate, useLocation, useParams} from 'react-router';
import {canOpenPaymentView, paymentViews, paymentsPath} from '../../features/operations/paymentLocations';
import {CORE_PERMISSIONS, type CoreArea} from '../../features/core/types';
import {canAddMember} from '../../features/core/addMemberAccess';
import {listLocation, readFilters} from '../../features/core/coreListFilters';
import {MemberDirectoryActions} from '../../features/core/MemberDirectory';
import {useSession} from '../../session/SessionProvider';
import {usesPhoneCanonicalRecords} from '../../session/sessionContext';
import {UnavailablePage} from '../UnavailablePage';
import {useAccess, useCurrentAuthority, useSensitiveAccess} from './access';
import {LegacyJournalCreateRoute, LegacyJournalEditRoute, TransactionEvidenceRoute} from './financial-routes';
import {requiresAdminRole, requiresPermissions, workspaceRoute, type WorkspaceAccess} from './routePolicy';

const CoreListPage = lazy(() => import('../../features/core/CoreListPage').then(m => ({default: m.CoreListPage})));
const CoreRecordPage = lazy(() => import('../../features/core/CoreRecordPage').then(m => ({default: m.CoreRecordPage})));
const GroupCreatePage = lazy(() => import('../../features/core/GroupCreatePage').then(m => ({default: m.GroupCreatePage})));
const GroupEditPage = lazy(() => import('../../features/core/GroupEditPage').then(m => ({default: m.GroupEditPage})));
const UserCreatePage = lazy(() => import('../../features/core/UserCreatePage').then(m => ({default: m.UserCreatePage})));
const AddMemberPage = lazy(() => import('../../features/core/AddMemberPage').then(m => ({default: m.AddMemberPage})));
const UserEditPage = lazy(() => import('../../features/core/UserEditPage').then(m => ({default: m.UserEditPage})));
const MembershipCreatePage = lazy(() => import('../../features/core/MembershipCreatePage').then(m => ({default: m.MembershipCreatePage})));
const MembershipEditPage = lazy(() => import('../../features/core/MembershipEditPage').then(m => ({default: m.MembershipEditPage})));
const LegacyPayeeCreatePage = lazy(() => import('../../features/core/LegacyPayeeCreatePage').then(m => ({default: m.LegacyPayeeCreatePage})));
const PayeeEditPage = lazy(() => import('../../features/core/PayeeEditPage').then(m => ({default: m.PayeeEditPage})));
const LegacyPayeeEditPage = lazy(() => import('../../features/legacy-payees/LegacyPayeeEditPage').then(m => ({default: m.LegacyPayeeEditPage})));
const LegacyLedgerAccountCreatePage = lazy(() => import('../../features/legacy-ledger-accounts/LegacyLedgerAccountCreatePage').then(m => ({default: m.LegacyLedgerAccountCreatePage})));
const GroupSelectionPage = lazy(() => import('../../features/route-compat/GroupSelectionPage').then(m => ({default: m.GroupSelectionPage})));

function CoreListRoute({area}: {area: CoreArea}) {
  const access = useAccess(), location = useLocation();
  return <CoreListPage key={`${access.authorityKey}:${area}`} {...access} area={area} locationSearch={location.search} />;
}

function PeopleListRoute() {
  const {search} = useLocation();
  const session = useSession();
  if (!usesPhoneCanonicalRecords(session)) return <CoreListRoute area="users" />;
  return <Navigate replace to={listLocation('members', readFilters(search, 'members', 'canonical_evidence_ledger', true))} />;
}

function MemberListRoute() {
  const access = useAccess(), {identity} = useSensitiveAccess(), session = useSession(), {search} = useLocation();
  const scopedMember = usesPhoneCanonicalRecords(session);
  return <CoreListPage key={access.authorityKey} {...access} area="members" locationSearch={search}
    scopedMember={scopedMember} memberActions={scopedMember && session.user && <MemberDirectoryActions user={session.user} identity={identity} />} />;
}

function MemberCreateRoute() {
  const session = useSession();
  return usesPhoneCanonicalRecords(session) ? <AddMemberPage /> : <GroupSelectionRoute action="member" />;
}

function CoreDetailRoute({area}: {area: CoreArea}) {
  const access = useAccess(), sensitive = useSensitiveAccess(), isCurrent = useCurrentAuthority(), {id = ''} = useParams(), location = useLocation();
  const scopedMember = usesPhoneCanonicalRecords(useSession()) && (area === 'members' || area === 'users');
  return <CoreRecordPage key={`${access.authorityKey}:${area}:${id}`} {...access} identity={sensitive.identity} area={area} id={id}
    scopedMember={scopedMember} isCurrent={isCurrent} returnTo={new URLSearchParams(location.search).get('returnTo')} />;
}

function GroupEditRoute() {
  const access = useAccess(), sensitive = useSensitiveAccess(), {id = ''} = useParams();
  return <GroupEditPage key={`${access.authorityKey}:${id}`} {...access} id={id}
    {...sensitive} allowMutations={false} allowStatusChanges={false} />;
}

function PayeeEditRoute() {
  const access = useAccess(), sensitive = useSensitiveAccess(), {id = ''} = useParams();
  return access.financialModel === 'transaction_journals' ?
    <LegacyPayeeEditPage key={`${access.authorityKey}:${id}`} {...access} id={id} {...sensitive} allowMutations={false} /> :
    <PayeeEditPage key={`${access.authorityKey}:${id}`} {...access} id={id} {...sensitive} allowMutations={false} />;
}

function UserEditRoute({returnArea = 'users'}: {returnArea?: 'users' | 'members'}) {
  const access = useAccess(), sensitive = useSensitiveAccess(), {id = ''} = useParams();
  return <UserEditPage key={`${access.authorityKey}:${returnArea}:${id}`} {...access} id={id} returnArea={returnArea} {...sensitive} allowMutations={false} />;
}

function MembershipCreateRoute() {
  const access = useAccess(), sensitive = useSensitiveAccess(), {id = ''} = useParams();
  return <MembershipCreatePage key={`${access.authorityKey}:${id}`} {...access} id={id} {...sensitive} allowMutations={false} />;
}

function MembershipEditRoute() {
  const access = useAccess(), sensitive = useSensitiveAccess(), {groupId = '', userId = ''} = useParams();
  return <MembershipEditPage key={`${access.authorityKey}:${groupId}:${userId}`} {...access} groupId={groupId} userId={userId} {...sensitive} allowMutations={false} />;
}

function LegacyPayeeCreateRoute() {
  const access = useAccess(), sensitive = useSensitiveAccess(), {groupId = ''} = useParams();
  return <LegacyPayeeCreatePage key={`${access.authorityKey}:${groupId}`} {...access} groupId={groupId} identity={sensitive.identity} allowMutations={false} />;
}

function LegacyLedgerAccountCreateRoute() {
  const access = useAccess(), sensitive = useSensitiveAccess(), {groupId = ''} = useParams();
  return <LegacyLedgerAccountCreatePage key={`${access.authorityKey}:${groupId}`} {...access} groupId={groupId} identity={sensitive.identity} allowMutations={false} />;
}

function GroupCreateRoute() {
  const access = useAccess(), sensitive = useSensitiveAccess();
  return <GroupCreatePage key={access.authorityKey} {...access} {...sensitive} allowMutations={false} />;
}

function UserCreateRoute() {
  const access = useAccess(), sensitive = useSensitiveAccess();
  return <UserCreatePage key={access.authorityKey} {...access} {...sensitive} allowMutations={false} />;
}

function GroupSelectionRoute({action}: {action: 'member' | 'payee'}) {
  const access = useAccess(), isCurrent = useCurrentAuthority();
  return <GroupSelectionPage key={`${access.authorityKey}:${action}`} {...access} action={action} isCurrent={isCurrent} />;
}

const PaymentsWorkArea = lazy(() => import('../../features/operations/PaymentsWorkArea').then(m => ({default: m.PaymentsWorkArea})));

function PaymentsRoute() {
  const access = useAccess();
  return <PaymentsWorkArea key={access.authorityKey} {...access} />;
}

function TransactionListRoute() {
  const params = new URLSearchParams(useLocation().search), session = useSession();
  if (usesPhoneCanonicalRecords(session)) {
    if (params.getAll('view').length === 1 && params.get('view') === 'momo' && !params.has('dataset')) {
      params.delete('view'); params.set('dataset', 'momo');
    }
    return <Navigate replace to={paymentsPath + (params.size ? '?' + params : '')} />;
  }
  const next = new URLSearchParams();
  if (params.get('view') === 'momo') next.set('dataset', 'momo');
  for (const key of ['search', 'status', 'sort', 'page']) {
    const values = params.getAll(key);
    if (values.length === 1) next.set(key, values[0]);
  }
  return <Navigate replace to={paymentsPath + (next.size ? '?' + next : '')} />;
}

interface RecordAction {
  element: ReactElement;
  access: WorkspaceAccess;
}

interface RecordRoutes {
  list?: ReactElement;
  create: RecordAction;
  edit: RecordAction;
}

const canManageUsers = requiresPermissions('users.manage');
const canManageReceivers = requiresPermissions('receivers.manage');
const canManagePayments = requiresPermissions('payments.manage');
const canManageLedgers = requiresPermissions('ledger.manage');
const canEditLegacyPayee = requiresAdminRole('receivers.manage', 'collections.read', 'overview.read');
const canCreateLegacyTransaction = requiresAdminRole('payments.manage', 'collections.read', 'receivers.read', 'overview.read');

const canReadCoreArea = (area: CoreArea) => requiresPermissions(CORE_PERMISSIONS[area]);
const canReadReceivingAccounts = canReadCoreArea('payees');

function GroupListRoute() {
  const {user} = useSession();
  return <>
    {user && canReadReceivingAccounts(user) && <nav className="group-workspace-links" aria-label="Group workspace">
      <Link to="/admin/payees" className="admin-btn admin-btn--secondary">Receiving accounts</Link>
    </nav>}
    <CoreListRoute area="groups" />
  </>;
}

const records: Record<CoreArea, RecordRoutes> = {
  groups: {
    list: <GroupListRoute />,
    create: {element: <GroupCreateRoute />, access: requiresPermissions('collections.create')},
    edit: {element: <GroupEditRoute />, access: requiresPermissions('collections.manage')},
  },
  users: {
    list: <PeopleListRoute />,
    create: {element: <UserCreateRoute />, access: canManageUsers},
    edit: {element: <UserEditRoute returnArea="users" />, access: canManageUsers},
  },
  members: {
    list: <MemberListRoute />,
    create: {element: <MemberCreateRoute />, access: user => user.financialModel === 'canonical_evidence_ledger' && user.authMethod === 'phone_passcode' ? canAddMember(user) : canManageUsers(user)},
    edit: {element: <UserEditRoute returnArea="members" />, access: canManageUsers},
  },
  payees: {
    create: {element: <GroupSelectionRoute action="payee" />, access: canManageReceivers},
    edit: {element: <PayeeEditRoute />, access: user =>
      user.financialModel === 'transaction_journals' ? canEditLegacyPayee(user) : canManageReceivers(user)},
  },
  transactions: {
    list: <TransactionListRoute />,
    create: {element: <TransactionEvidenceRoute />, access: user =>
      user.financialModel === 'transaction_journals' ? canCreateLegacyTransaction(user) : canManagePayments(user)},
    edit: {element: <UnavailablePage title="Edit transaction" />, access: canManagePayments},
  },
  ledgers: {
    create: {element: <LegacyJournalCreateRoute />, access: canManageLedgers},
    edit: {element: <LegacyJournalEditRoute />, access: canManageLedgers},
  },
};

export const recordRoutes = [
  workspaceRoute('payments', <PaymentsRoute />, user => paymentViews.some(({id}) => canOpenPaymentView(id, user))),
  ...(Object.keys(CORE_PERMISSIONS) as CoreArea[]).flatMap(area => {
    const {list, create, edit} = records[area];
    const canRead = area === 'payees' ? canReadReceivingAccounts : canReadCoreArea(area);
    return [
      workspaceRoute(area, list ?? <CoreListRoute area={area} />, canRead),
      workspaceRoute(area + '/new', create.element, user => canRead(user) && create.access(user)),
      workspaceRoute(area + '/:id/edit', edit.element, user => canRead(user) && edit.access(user)),
      workspaceRoute(area + '/:id', <CoreDetailRoute area={area} />, canRead),
    ];
  }),
];

const canManageMemberships = requiresPermissions('collections.read', 'users.manage');

export const groupRecordRoutes = [
  workspaceRoute('groups/:id/members/new', <MembershipCreateRoute />, canManageMemberships),
  workspaceRoute('groups/:groupId/members/:userId/edit', <MembershipEditRoute />, canManageMemberships),
  workspaceRoute('groups/:groupId/payees/new', <LegacyPayeeCreateRoute />, requiresPermissions('collections.read', 'receivers.manage')),
  workspaceRoute('groups/:groupId/ledger-accounts/new', <LegacyLedgerAccountCreateRoute />,
    requiresAdminRole('collections.read', 'ledger.read', 'ledger.manage', 'overview.read')),
];
