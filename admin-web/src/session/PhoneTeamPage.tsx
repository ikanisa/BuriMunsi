import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';
import {AdminRequestError} from '../api/client';
import {useOperationRead} from '../features/operations/useOperationRead';
import {Button, Card, EmptyState, ErrorState, Field, LoadingState, PageHeader, StatusBadge} from '../ui';
import {hasScopedAdminAuthority} from './ownerIdentity';
import {confirmTeamReceipt, parsePhoneTeam, phoneTeamRoles, prepareTeamAccount,
  type PhoneTeam, type PhoneTeamMember, type PhoneTeamRole, type TeamChange} from './phoneTeam';
import {useSession} from './SessionProvider';

export function PhoneTeamPage() {
  const session = useSession(), actor = session.user;
  const accountId = actor?.accountId, phone = actor?.phone, role = actor?.role;
  const manageGrant = actor?.permissions.includes('admin_users.manage') === true;
  const canRead = !!accountId && actor?.authMethod === 'phone_passcode' && actor.role === 'admin' && actor.permissions.includes('admin_users.read');
  const {request, epoch} = session;
  const load = useCallback(async () => {
    if (!accountId || !role) throw new Error('The team account could not be verified.');
    return parsePhoneTeam(await request('team'), {accountId, phone, role, permissions: manageGrant ? ['admin_users.manage'] : []});
  }, [request, accountId, phone, role, manageGrant]);
  const {result, retry} = useOperationRead(JSON.stringify([epoch, accountId]), canRead, load);
  const team = result?.status === 'success' ? result.value : null;
  return <><PageHeader title="Team access" subtitle="Manage who can sign in to BuriMunsi." actions={<Button onClick={retry} icon="refresh">Refresh</Button>} />
    {!canRead ? <ErrorState title="Access unavailable" message="Your account cannot view team access." /> :
      !result ? <LoadingState label="Loading team access" /> :
      result.status === 'error' ? <ErrorState title="Team access unavailable" message={result.message} onRetry={retry} /> :
      team && actor && <PhoneTeamDirectory key={`${epoch}:${accountId}`} team={team} canManage={team.canManage && hasScopedAdminAuthority(actor)}
        reload={retry} />}
  </>;
}

function PhoneTeamDirectory({team, canManage, reload}: {team: PhoneTeam; canManage: boolean; reload: () => void}) {
  const session = useSession(), actor = session.user!;
  const [creating, setCreating] = useState(false), [editing, setEditing] = useState<PhoneTeamMember | null>(null);
  const [change, setChange] = useState<TeamChange | null>(null), [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false), [feedback, setFeedback] = useState('');
  const inFlight = useRef(false), mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const current = () => mounted.current && canManage && session.isCurrentAuthority(session.epoch, actor.id, actor.sessionId);
  function cancel() {setCreating(false); setEditing(null); setChange(null); setUncertain(false); setFeedback('');}
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current() || inFlight.current || change) return;
    const form = new FormData(event.currentTarget);
    if (editing && editing.role !== 'staff') return;
    try {
      if (editing) {
        const active = form.get('access') === 'active';
        if (editing.active === active) {setFeedback('Choose a different access status.'); return;}
        setChange({kind: 'access', requestId: crypto.randomUUID(), member: editing, role: editing.role, active});
      } else setChange(prepareTeamAccount(team, String(form.get('displayName') ?? ''), String(form.get('phone') ?? ''), 'staff'));
      setFeedback('');
    } catch (error) {setFeedback(error instanceof Error ? error.message : 'Check the account details.');}
  }
  async function apply() {
    if (!change || !current() || inFlight.current) return;
    const command = change;
    inFlight.current = true; setBusy(true); setFeedback('');
    try {
      const path = command.kind === 'create' ? 'team/accounts' : `team/accounts/${command.member.id}/access`;
      const body = command.kind === 'create'
        ? {requestId: command.requestId, displayName: command.displayName, phone: command.phone, role: command.role}
        : {requestId: command.requestId, expectedVersion: command.member.version, active: command.active, role: command.role};
      const response = await session.request(path, {body, idempotencyKey: command.requestId});
      if (!current()) return;
      confirmTeamReceipt(response, command);
      cancel(); reload();
    } catch (error) {
      if (!current()) return;
      setUncertain(error instanceof AdminRequestError && error.outcomeUnknown);
      setFeedback(error instanceof AdminRequestError && error.code === 'burimunsi_single_admin'
        ? 'BuriMunsi allows only one Admin. Refresh Team access before making another change.'
        : error instanceof Error ? error.message : 'The account change could not be confirmed.');
    } finally {inFlight.current = false; if (mounted.current) setBusy(false);}
  }
  return <>
    <Card className="admin-security-card"><h2>Team members</h2>
      {canManage && !creating && !editing && <Button onClick={() => {cancel(); setCreating(true);}}>Create account</Button>}
      {team.members.length === 0 ? <EmptyState title="No team members" /> : <div className="admin-table-wrap"><table className="admin-table">
        <thead><tr><th>Account</th><th>Mobile number</th><th>Role</th><th>Access</th>{canManage && <th>Actions</th>}</tr></thead>
        <tbody>{team.members.map(member => <tr key={member.id}><td>{member.displayName}</td><td>{member.phone}</td>
          <td>{phoneTeamRoles[member.role]}</td><td><StatusBadge tone={member.active ? 'success' : 'neutral'}>{member.active ? 'Active' : 'Disabled'}</StatusBadge></td>
          {canManage && <td>{member.role === 'staff' && member.id !== team.currentAccountId && <Button aria-label={`Manage ${member.displayName}`} disabled={creating || !!editing} onClick={() => {cancel(); setEditing(member);}}>Manage access</Button>}</td>}</tr>)}</tbody>
      </table></div>}
    </Card>
    {canManage && (creating || editing) && <Card className="admin-security-card"><h2>{editing ? 'Manage account access' : 'Create a Staff account'}</h2>
      {!change ? <form className="admin-auth-form" onSubmit={review}>
        {editing ? <p>{editing.displayName} · {editing.phone}</p> : <>
          <Field label="Name" htmlFor="team-name"><input className="admin-input" id="team-name" name="displayName" autoComplete="off" minLength={2} maxLength={100} required /></Field>
          <Field label="Mobile number" htmlFor="team-phone"><input className="admin-input" id="team-phone" name="phone" type="tel" autoComplete="off" maxLength={40} required /></Field>
          <p>The account starts with the configured four-digit passcode. The user can change it after signing in.</p>
        </>}
        <p>Role: Staff</p>
        {editing && <Field label="Access" htmlFor="team-access"><select className="admin-input" id="team-access" name="access" defaultValue={editing.active ? 'active' : 'disabled'}>
          <option value="active">Active</option><option value="disabled">Disabled</option></select></Field>}
        <Button type="submit" variant="primary">Review account</Button><Button onClick={cancel}>Cancel</Button>
      </form> : <><p>{change.kind === 'create' ? `${change.displayName} · ${change.phone}` : `${change.member.displayName} · ${change.member.phone}`}</p>
        <p>{phoneTeamRoles[change.role]} · {change.kind === 'create' || change.active ? 'Active' : 'Disabled'}</p>
        {uncertain && <p>Account change unconfirmed. Request <code>{change.requestId}</code>.</p>}
        <Button variant="primary" onClick={() => void apply()} loading={busy}>{uncertain ? 'Retry original request' : change.kind === 'create' ? 'Confirm account creation' : 'Confirm access change'}</Button>
        {!uncertain && <Button onClick={cancel} disabled={busy}>Cancel</Button>}
      </>}
      {feedback && <p role="status">{feedback}</p>}
    </Card>}
    <Card className="admin-security-card"><h2>Role permissions</h2>
      {(Object.keys(phoneTeamRoles) as PhoneTeamRole[]).map(role => <div key={role}><h3>{phoneTeamRoles[role]}</h3>
        <p>{team.permissionsByRole[role].length ? team.permissionsByRole[role].join(', ') : 'No permissions recorded'}</p></div>)}
    </Card>
  </>;
}
