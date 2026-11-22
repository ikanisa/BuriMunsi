import {adminBrand} from '../branding';
import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Button, Card, EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge} from '../ui';
import {CloudflareTeamPanel} from './CloudflareTeamPanel';
import {InvitationRecoveryPanel, TeamManager} from './ManagedTeamPanel';
import type {TeamMutationContext} from './managedTeamMutations';
import {sensitiveVerificationDeadline, useSession, type AdminUser, type SessionContextValue} from './SessionProvider';
import {authorityKey} from './sessionAuthority';
import {verificationProofTime} from './sessionPolicy';
import {invitationStatus, parseTeam, teamDirectoryPath, type Team} from './teamDirectory';
import {isLegacyTeamOwner, isTeamManager} from './teamPolicy';
import './auth.css';

interface TeamPageProps {
  onVerify: () => void;
  allowMutations?: boolean;
  managedInvitationVersion?: 1 | 2;
  cloudflareRecoveryVersion?: 1;
  allowRecovery?: boolean;
  showVerification?: boolean;
}

function hasCurrentTeamVerification(session: SessionContextValue, actor: AdminUser): boolean {
  return session.isRecentSensitiveVerification(session.epoch, actor.id, actor.sessionId) &&
    (session.verificationMode !== 'email' || session.sensitiveEmailRecovery() === null);
}

export function TeamPage(props: TeamPageProps) {
  const session = useSession(), actor = session.user, mode = session.verificationMode;
  const [deadlineTick, setDeadlineTick] = useState(0);
  const expiry = actor ? Date.parse(actor.expiresAt) : null;
  const proofDeadline = actor ? sensitiveVerificationDeadline(actor, mode === 'authenticator' ? 'cloudflare' : 'supabase') : null;
  useEffect(() => {
    const now = Date.now();
    const future = [expiry, proofDeadline].filter((value): value is number => value !== null && value >= now);
    if (!future.length) return;
    const timer = window.setTimeout(() => setDeadlineTick(value => value + 1), Math.min(2_147_483_647, Math.min(...future) - now + 1));
    return () => window.clearTimeout(timer);
  }, [deadlineTick, expiry, proofDeadline]);
  if (!actor?.permissions.includes('admin_users.read') || !session.isCurrentAuthority(session.epoch, actor.id, actor.sessionId)) {
    return <ErrorState title="Access unavailable" message="Your account cannot view team access." />;
  }
  const fresh = hasCurrentTeamVerification(session, actor);
  const scope = JSON.stringify([session.epoch, authorityKey(actor), actor.expiresAt, verificationProofTime(actor), mode,
    fresh, props.managedInvitationVersion, props.allowMutations, props.allowRecovery, props.cloudflareRecoveryVersion]);
  return <TeamWorkspace key={scope} actor={actor} session={session} fresh={fresh} {...props} />;
}

const roleNames = {owner: 'Owner', admin: 'Admin', staff: 'Staff'} as const;
const accessStatus = {
  active: {label: 'Active', tone: 'success'},
  invited: {label: 'Invitation pending', tone: 'warning'},
  revoked: {label: 'Access removed', tone: 'neutral'},
} as const;

function TeamDirectoryCard({team, changesUnavailable, showInvitations}: {team: Team; changesUnavailable: boolean; showInvitations: boolean}) {
  return <Card className="admin-security-card">
    <h2>Team members</h2>
    {changesUnavailable && <p>Team access changes are currently unavailable.</p>}
    {team.members.length === 0 ? <EmptyState title="No team members" /> :
      <div className="admin-table-wrap"><table className="admin-table">
        <thead><tr><th scope="col">Account</th><th scope="col">Role</th><th scope="col">Status</th>{showInvitations && <th scope="col">Invitation</th>}</tr></thead>
        <tbody>{team.members.map(member => {
          const status = accessStatus[member.status];
          return <tr key={member.id}>
            <td><strong>{member.displayName || member.publicId || member.email}</strong><br /><span>{member.email}</span></td>
            <td>{roleNames[member.role]}</td>
            <td><StatusBadge tone={status.tone}>{status.label}</StatusBadge></td>
            {showInvitations && <td>{invitationStatus(member.emailStatus, member.invitationKind) ?? '—'}</td>}
          </tr>;
        })}</tbody>
      </table></div>}
  </Card>;
}

function TeamWorkspace({
  actor, session, fresh, onVerify, allowMutations = false, managedInvitationVersion = 2, cloudflareRecoveryVersion,
  allowRecovery = true, showVerification = true,
}: TeamPageProps & {actor: AdminUser; session: SessionContextValue; fresh: boolean}) {
  const {request, epoch, verificationMode} = session;
  const path = teamDirectoryPath(actor, verificationMode, managedInvitationVersion, fresh);
  const [read, setRead] = useState<{revision: number; team: Team; error?: never} | {revision: number; team?: never; error: string} | null>(null);
  const [revision, setRevision] = useState(0);
  const [actionMessage, setActionMessage] = useState('');
  const latest = useRef({actor, session});
  useLayoutEffect(() => {latest.current = {actor, session};}, [actor, session]);
  useEffect(() => {
    const {actor} = latest.current;
    const controller = new AbortController();
    const {signal} = controller;
    const isCurrent = () => {
      const current = latest.current;
      return !signal.aborted && current.session.isCurrentAuthority(epoch, actor.id, actor.sessionId) &&
        (path !== 'team/v2' || current.actor.emailVerifiedAt === actor.emailVerifiedAt &&
          hasCurrentTeamVerification(current.session, current.actor));
    };
    void request(path, {authenticated: true, signal}).then(body => {
      if (!isCurrent()) return;
      const team = parseTeam(body, actor, verificationMode, path === 'team/v2' ? 2 : 1);
      setRead({revision, team});
    }).catch((failure: unknown) => {
      if (isCurrent()) setRead({revision, error: failure instanceof Error && failure.message ? failure.message : 'Team access could not be loaded.'});
    });
    return () => controller.abort();
  }, [epoch, request, revision, verificationMode, path]);

  const displayed = read?.revision === revision ? read : null;
  const team = displayed?.team ?? null;
  const displayedTeam = useRef<Team | null>(null);
  useLayoutEffect(() => {
    displayedTeam.current = team;
    return () => {displayedTeam.current = null;};
  }, [team]);
  const isDirectoryCurrent = () => team !== null && team === displayedTeam.current &&
    session.isCurrentAuthority(epoch, actor.id, actor.sessionId);
  const refresh = () => {
    displayedTeam.current = null;
    setRevision(value => value + 1);
  };
  const resolved = (message: string) => {
    if (!isDirectoryCurrent()) return;
    setActionMessage(message);
    refresh();
  };
  const usesEmail = verificationMode === 'email';
  const isOwnerManager = isTeamManager(actor, verificationMode);
  const legacyRecovery = usesEmail && allowRecovery && !isOwnerManager && isLegacyTeamOwner(actor);
  const managedWrites = usesEmail && fresh && allowMutations && team?.canManage === true && team.contractVersion === managedInvitationVersion;
  const managedContext: TeamMutationContext = {
    allowMutations: managedWrites,
    invitationVersion: team?.contractVersion ?? managedInvitationVersion,
    identity: actor,
    request,
    verify: session.recheckSensitiveEmailVerification,
    current: () => isDirectoryCurrent() && hasCurrentTeamVerification(session, actor),
  };
  return <>
    <PageHeader title="Team access" subtitle={`Admins and staff who can use the ${adminBrand.product} workspace.`}
      actions={<Button icon="refresh" onClick={refresh} disabled={displayed === null}>Refresh</Button>} />
    {actionMessage && <p role="status">{actionMessage}</p>}
    {showVerification && (isOwnerManager || legacyRecovery) && <p><Button onClick={onVerify}>
      {legacyRecovery ? 'Verify email to review pending requests' : usesEmail ? 'Verify email to manage team access' : 'Verify authenticator to manage team access'}
    </Button></p>}
    {displayed === null && <LoadingState label="Loading team access" />}
    {displayed?.error && <ErrorState title="Team access unavailable" message={displayed.error} onRetry={refresh} />}
    {team && <>
      <TeamDirectoryCard team={team} showInvitations={verificationMode !== 'passcode'} changesUnavailable={team.canManage && (usesEmail ? !managedWrites :
        !allowMutations || cloudflareRecoveryVersion !== 1)} />
      {managedWrites && <TeamManager context={managedContext} team={team} onChanged={resolved} />}
      {allowRecovery && fresh && team.canRecoverInvitations && <InvitationRecoveryPanel context={managedContext} onResolved={resolved} />}
      {allowRecovery && isOwnerManager && !usesEmail && cloudflareRecoveryVersion === 1 &&
        <CloudflareTeamPanel actor={actor} epoch={epoch} team={team} allowMutations={allowMutations} isDirectoryCurrent={isDirectoryCurrent} onChanged={resolved} onVerify={onVerify} />}
      <Card className="admin-security-card"><h2>Role permissions</h2>
        {Object.entries(team.permissionsByRole).map(([role, permissions]) => <div key={role}>
          <h3>{role === 'owner' ? 'Owner' : role === 'admin' ? 'Admin' : 'Staff'}</h3>
          <p>{permissions.length ? permissions.join(', ') : 'No permissions recorded'}</p>
        </div>)}
      </Card>
    </>}
  </>;
}
