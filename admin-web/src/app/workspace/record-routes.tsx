import {lazy, type ReactElement} from 'react';
import {Link, Navigate, useLocation, useParams} from 'react-router';
import {canOpenPaymentView, paymentViews, paymentsPath} from '../../features/operations/paymentLocations';
import {isValidId} from '../../features/operations/contracts';
import {CORE_PERMISSIONS, type CoreArea} from '../../features/core/types';
import {canAddMember} from '../../features/core/addMemberAccess';
import {canReadMemberStatement} from '../../features/core/memberStatement';
import {listLocation, readFilters} from '../../features/core/coreListFilters';
import {MemberDirectoryActions} from '../../features/core/MemberDirectory';
import {useSession} from '../../session/SessionProvider';
import {usesPhoneCanonicalRecords} from '../../session/sessionContext';
import {UnavailablePage} from '../UnavailablePage';
import {useAccess, useCurrentAuthority, useSensitiveAccess} from './access';
import {LegacyJournalCreateRoute, LegacyJournalEditRoute, TransactionEvidenceRoute} from './financial-routes';
import {collectWorkspaceOnly, requiresAdminRole, requiresPermissions, workspaceRoute, type WorkspaceAccess} from './routePolicy';

const CoreListPage = lazy(() => import('../../features/core/CoreListPage').then(m => ({default: m.CoreListPage})));
const CoreRecordPage = lazy(() => import('../../features/core/CoreRecordPage').then(m => ({default: m.CoreRecordPage})));
const MemberStatementPage = lazy(() => import('../../features/core/MemberStatementPage').then(m => ({default: m.MemberStatementPage})));
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
  const access = useAccess(), location = useLocation(), {user} = useSession();
  return <CoreListPage key={`${access.authorityKey}:${area}`} {...access} area={area} locationSearch={location.search}
    simplePayments={user?.authMethod === 'phone_passcode'} />;
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
    simplePayments={session.user?.authMethod === 'phone_passcode'} scopedMember={scopedMember}
    memberActions={scopedMember && session.user && <MemberDirectoryActions user={session.user} identity={identity} />} />;
}

function MemberCreateRoute() {
  const session = useSession();
  return usesPhoneCanonicalRecords(session) ? <AddMemberPage /> : <GroupSelectionRoute action="member" />;
}

function CoreDetailRoute({area}: {area: CoreArea}) {
  const access = useAccess(), sensitive = useSensitiveAccess(), isCurrent = useCurrentAuthority(), {id = ''} = useParams(), location = useLocation(), session = useSession();
  const scopedMember = usesPhoneCanonicalRecords(session) && (area === 'members' || area === 'users');
  return <CoreRecordPage key={`${access.authorityKey}:${area}:${id}`} {...access} identity={sensitive.identity} area={area} id={id}
    scopedMember={scopedMember} expectedGroup={session.user?.adminIdentity?.collectionId} isCurrent={isCurrent} returnTo={new URLSearchParams(location.search).get('returnTo')}
    simplePayments={session.user?.authMethod === 'phone_passcode'} />;
}

function MemberStatementRoute() {
  const access = useAccess(), session = useSession(), {id = ''} = useParams(), {search} = useLocation();
  if (!usesPhoneCanonicalRecords(session)) return <UnavailablePage title="Member statement" />;
  const raw = new URLSearchParams(search).get('returnTo');
  const returnTo = raw?.startsWith('/admin/members?') ? listLocation('members',
    readFilters(raw.slice('/admin/members'.length), 'members', 'canonical_evidence_ledger', true)) : undefined;
  return <MemberStatementPage key={JSON.stringify([access.authorityKey, id])} {...access} id={id}
    returnTo={returnTo} expectedGroup={session.user?.adminIdentity?.collectionId} />;
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
const BuriMunsiPayments = lazy(() => import('../../features/operations/BuriMunsiPayments').then(m => ({default: m.BuriMunsiPayments})));

function PaymentsRoute() {
  const access = useAccess(), {user} = useSession();
  return user?.authMethod === 'phone_passcode' ? <BuriMunsiPayments key={access.authorityKey} /> :
    <PaymentsWorkArea key={access.authorityKey} {...access} />;
}

function TransactionListRoute() {
  const {user} = useSession(), params = new URLSearchParams(useLocation().search), next = new URLSearchParams();
  if (user?.authMethod === 'phone_passcode') {
    const query = params.get('q') ?? params.get('search');
    const status = params.get('status');
    if (query) next.set('q', query);
    if (status === 'allocated' || status === 'unallocated') next.set('status', status);
    return <Navigate replace to={paymentsPath + (next.size ? '?' + next : '')} />;
  }
  if (params.get('view') === 'momo') next.set('dataset', 'momo');
  for (const key of ['search', 'status', 'sort', 'page']) {
    const values = params.getAll(key);
    if (values.length === 1) next.set(key, values[0]);
  }
  return <Navigate replace to={paymentsPath + (next.size ? '?' + next : '')} />;
}

function TransactionDetailRoute() {
  const {user} = useSession(), {id} = useParams();
  if (user?.authMethod === 'phone_passcode') return <Navigate replace
    to={isValidId(id) ? paymentsPath + '?' + new URLSearchParams({payment: id}) : paymentsPath} />;
  return <CoreDetailRoute area="transactions" />;
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
const canReadReceivingAccounts = collectWorkspaceOnly(canReadCoreArea('payees'));

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
  workspaceRoute('members/:id/statement', <MemberStatementRoute />, user =>
    user.financialModel === 'canonical_evidence_ledger' && canReadMemberStatement(user.permissions)),
  ...(Object.keys(CORE_PERMISSIONS) as CoreArea[]).flatMap(area => {
    const {list, create, edit} = records[area];
    const canRead = area === 'payees' ? canReadReceivingAccounts :
      area === 'ledgers' ? collectWorkspaceOnly(canReadCoreArea(area)) : canReadCoreArea(area);
    const canModify = area === 'transactions' ? collectWorkspaceOnly(canRead) : canRead;
    return [
      workspaceRoute(area, list ?? <CoreListRoute area={area} />, canRead),
      workspaceRoute(area + '/new', create.element, user => canModify(user) && create.access(user)),
      workspaceRoute(area + '/:id/edit', edit.element, user => canModify(user) && edit.access(user)),
      workspaceRoute(area + '/:id', area === 'transactions' ? <TransactionDetailRoute /> : <CoreDetailRoute area={area} />, canRead),
    ];
  }),
];

const canManageMemberships = requiresPermissions('collections.read', 'users.manage');

export const groupRecordRoutes = [
  workspaceRoute('groups/:id/members/new', <MembershipCreateRoute />, canManageMemberships),
  workspaceRoute('groups/:groupId/members/:userId/edit', <MembershipEditRoute />, canManageMemberships),
  workspaceRoute('groups/:groupId/payees/new', <LegacyPayeeCreateRoute />, collectWorkspaceOnly(requiresPermissions('collections.read', 'receivers.manage'))),
  workspaceRoute('groups/:groupId/ledger-accounts/new', <LegacyLedgerAccountCreateRoute />,
    collectWorkspaceOnly(requiresAdminRole('collections.read', 'ledger.read', 'ledger.manage', 'overview.read'))),
];
