import {lazy} from 'react';
import {useNavigate} from 'react-router';
import {AccountSecurityPage} from '../../session/AccountSecurityPage';
import {useSession, type AdminUser} from '../../session/SessionProvider';
import {verificationPath} from '../../session/returnLocation';
import {UnavailablePage} from '../UnavailablePage';
import {useAccess, useSensitiveAccess} from './access';
import {requiresPermissions, workspaceRoute} from './routePolicy';

const LicensesPage = lazy(() => import('../../features/licenses/LicensesPage').then(m => ({default: m.LicensesPage})));
const TeamPage = lazy(() => import('../../session/TeamPage').then(m => ({default: m.TeamPage})));
const PhoneTeamPage = lazy(() => import('../../session/PhoneTeamPage').then(m => ({default: m.PhoneTeamPage})));
const PrivacyPage = lazy(() => import('../../features/privacy/PrivacyPage').then(m => ({default: m.PrivacyPage})));

function canOpenOwnSecurity(actor: AdminUser) {
  return actor.permissions.includes('account.manage') || (actor.authMethod === 'phone_passcode' && !!actor.accountId);
}

function AccountSecurityRoute() {
  const session = useSession(), go = useNavigate();
  if (!session.user || !canOpenOwnSecurity(session.user)) return <UnavailablePage title="Account security" />;
  return <AccountSecurityPage onVerify={() => go(verificationPath(session.verificationMode, '/admin/security'))}
    onAuthenticator={() => go(verificationPath('authenticator', '/admin/security'))}
    onLicenses={() => go('/admin/licenses')} onPasswordRecovery={() => go('/admin/forgot-password')}
    onSignIn={() => go('/admin/login', {replace: true})} />;
}

function TeamRoute() {
  const session = useSession(), go = useNavigate();
  if (session.verificationMode === 'passcode' && session.user?.accountId) return <PhoneTeamPage />;
  return <TeamPage allowRecovery={session.verificationMode !== 'passcode'} showVerification={session.verificationMode !== 'passcode'}
    onVerify={() => go(verificationPath(session.verificationMode, '/admin/admin-users'))} />;
}

function PrivacyRoute() {
  const session = useSession(), sensitive = useSensitiveAccess(), go = useNavigate(), access = useAccess();
  return <PrivacyPage key={access.authorityKey} user={session.user!} epoch={session.epoch} verificationMode={session.verificationMode}
    request={session.request} verifyFresh={sensitive.verifyFresh} isCurrentAuthority={session.isCurrentAuthority}
    onVerify={() => go(verificationPath(session.verificationMode, '/admin/privacy-requests'))} />;
}

export const accountRoutes = [
  workspaceRoute('security', <AccountSecurityRoute />, canOpenOwnSecurity),
  workspaceRoute('licenses', <LicensesPage />, () => true),
  workspaceRoute('admin-users', <TeamRoute />, user => (!user.accountId || user.role === 'admin') && user.permissions.includes('admin_users.read')),
  workspaceRoute('privacy-requests', <PrivacyRoute />, requiresPermissions('privacy.review')),
];
