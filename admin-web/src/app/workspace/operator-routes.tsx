import {lazy} from 'react';
import {Navigate, useLocation, useNavigate} from 'react-router';
import {canReadMemberReceipts, paymentViewLocation} from '../../features/operations/paymentLocations';
import {OverviewPage} from '../../features/overview/OverviewPage';
import {canReadRequestHistory} from '../../features/requests/permissions';
import {hasScopedAdminAuthority} from '../../session/ownerIdentity';
import {useSession} from '../../session/SessionProvider';
import {canReadSmsEvidence} from '../../session/sessionContext';
import {verificationPath} from '../../session/returnLocation';
import {useAccess, useSensitiveAccess} from './access';
import {requiresAdminRole, requiresPermissions, workspaceRoute} from './routePolicy';
import {canOpenOperatorProfile, canOpenTeam} from './team-access';

const RequestHistoryPage = lazy(() => import('../../features/requests/RequestHistoryPage').then(m => ({default: m.RequestHistoryPage})));
const SmsReceiptsPage = lazy(() => import('../../features/operations/SmsReceiptPages').then(m => ({default: m.SmsReceiptsPage})));
const SmsReceiptDetailPage = lazy(() => import('../../features/operations/SmsReceiptPages').then(m => ({default: m.SmsReceiptDetailPage})));
const GatewayDevicesPage = lazy(() => import('../../features/operations/GatewayDevicePages').then(m => ({default: m.GatewayDevicesPage})));
const GatewayEnrollmentPage = lazy(() => import('../../features/operations/GatewayEnrollmentPage').then(m => ({default: m.GatewayEnrollmentPage})));
const GatewayDeviceDetailPage = lazy(() => import('../../features/operations/GatewayDevicePages').then(m => ({default: m.GatewayDeviceDetailPage})));
const ReceiverGrantsPage = lazy(() => import('../../features/operations/ReceiverGrantPages').then(m => ({default: m.ReceiverGrantsPage})));
const ReceiverGrantDetailPage = lazy(() => import('../../features/operations/ReceiverGrantPages').then(m => ({default: m.ReceiverGrantDetailPage})));
const MemberReceiptsPage = lazy(() => import('../../features/operations/MemberReceiptPages').then(m => ({default: m.MemberReceiptsPage})));
const MemberReceiptDetailPage = lazy(() => import('../../features/operations/MemberReceiptPages').then(m => ({default: m.MemberReceiptDetailPage})));
const EmailEventsPage = lazy(() => import('../../features/operations/EmailEventsPage').then(m => ({default: m.EmailEventsPage})));
const AssistedSmsPage = lazy(() => import('../../features/assisted/AssistedSmsPage').then(m => ({default: m.AssistedSmsPage})));
const SmsControlsPage = lazy(() => import('../../features/assisted/SmsControlsPage').then(m => ({default: m.SmsControlsPage})));
const BuriMunsiPage = lazy(() => import('../../features/burimunsi').then(m => ({default: m.BuriMunsiPage})));

function LegacyMomoReceiptsRoute() {
  const {user} = useSession();
  return <Navigate replace to={canReadSmsEvidence(user) ? paymentViewLocation('sms') : paymentViewLocation('recorded', {momo: true})} />;
}

export function OverviewRoute() {
  const access = useAccess();
  const {verificationMode} = useSession();
  return <OverviewPage key={access.authorityKey} request={access.request} permissions={access.permissions} role={access.role}
    financialModel={access.financialModel} authorityKey={access.authorityKey} preferSmsHealth={verificationMode === 'passcode'} />;
}

function RequestHistoryRoute() {
  const access = useAccess(), sensitive = useSensitiveAccess(), location = useLocation();
  return <RequestHistoryPage key={`${access.authorityKey}:${location.search}`} {...access} {...sensitive}
    allowCancellation={false} locationSearch={location.search} />;
}

function AssistedSmsRoute() {
  const session = useSession(), go = useNavigate(), access = useAccess();
  return <AssistedSmsPage key={access.authorityKey} onVerify={() => go(verificationPath(session.verificationMode, '/admin/notification-operator'))} />;
}

function SmsControlsRoute() {
  const session = useSession(), go = useNavigate(), access = useAccess();
  return <SmsControlsPage key={access.authorityKey} onVerify={() => go(verificationPath(session.verificationMode, '/admin/notification-settings'))} />;
}

function BuriMunsiRoute() {
  const go = useNavigate(), session = useSession();
  return <BuriMunsiPage operatorApprovalEnabled nativeAdministrationEnabled
    onBack={session.user && canOpenTeam(session.user) ? () => go('/admin/admin-users') : undefined} onVerify={() => go(verificationPath(session.verificationMode, '/admin/burimunsi'))} />;
}

const canReadGateway = requiresAdminRole('gateway.read');
const canReadPayments = requiresPermissions('payments.read');

export const requestHistoryRoute = workspaceRoute('requests', <RequestHistoryRoute />,
  user => canReadRequestHistory(user.financialModel, user.permissions));

export const operatorRoutes = [
  workspaceRoute('sms-receipts', <SmsReceiptsPage />, canReadSmsEvidence),
  workspaceRoute('sms-receipts/:kind/:id', <SmsReceiptDetailPage />, canReadSmsEvidence),
  workspaceRoute('gateway', <GatewayDevicesPage />, canReadGateway),
  workspaceRoute('gateway/new', <GatewayEnrollmentPage />, requiresAdminRole('gateway.read', 'gateway.manage')),
  workspaceRoute('gateway/receiver-grants', <ReceiverGrantsPage />, canReadGateway),
  workspaceRoute('gateway/receiver-grants/:id', <ReceiverGrantDetailPage />, canReadGateway),
  workspaceRoute('gateway/:id', <GatewayDeviceDetailPage />, canReadGateway),
  workspaceRoute('member-receipts', <MemberReceiptsPage />, canReadMemberReceipts),
  workspaceRoute('member-receipts/:id', <MemberReceiptDetailPage />, canReadMemberReceipts),
  workspaceRoute('email', <EmailEventsPage />, requiresPermissions('email.read')),
  workspaceRoute('momo-receipts', <LegacyMomoReceiptsRoute />, user => canReadSmsEvidence(user) || canReadPayments(user)),
  workspaceRoute('notification-operator', <AssistedSmsRoute />, requiresAdminRole('assisted_sms.read')),
  workspaceRoute('notification-settings', <SmsControlsRoute />, user => (user.accountId ? hasScopedAdminAuthority(user) : user.role === 'owner') && user.permissions.includes('admin_users.manage')),
  workspaceRoute('burimunsi', <BuriMunsiRoute />, canOpenOperatorProfile),
];
