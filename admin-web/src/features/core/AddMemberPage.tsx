import {useCallback, useEffect, useRef, useState} from 'react';
import {Link} from 'react-router';
import {type AdminRequest} from '../../api/contracts';
import {useCurrentAuthority} from '../../app/workspace/access';
import {useSession, type AdminUser} from '../../session/SessionProvider';
import {Button, Card, ErrorState, LoadingState, PageHeader, StatusBadge} from '../../ui';
import {useOperationRead} from '../operations/useOperationRead';
import {canAddMember} from './addMemberAccess';
import {EnrollmentReview} from './EnrollmentReview';
import {MemberRosterImport} from './MemberRosterImport';
import {EnrollmentMethods, type EnrollmentMode} from './RosterSources';
import {ROSTER_FAMILY, validImportAttempt, type ReviewedMember} from './memberRoster';
import {clearOriginalAttempt} from './canonicalMutation';
import {ENROLLMENT_FAMILY, ENROLLMENT_PATH, ENROLLMENT_PERMISSION, enrollmentIntent, readEnrollmentOutcome,
  readEnrollmentScope, rejectedEnrollment, validEnrollmentAttempt,
  type EnrolledMember, type EnrollmentScope, type MemberDraft} from './memberEnrollment';
import {readPending, retainPending, type PendingAttempt, type PendingIdentity} from './pendingAttempt';
import {usePendingIdentity} from './usePendingIdentity';
import './memberEnrollment.css';

export function AddMemberPage() {
  const {user, request, epoch} = useSession();
  return <><PageHeader title="Add member" actions={<Link className="admin-btn admin-btn--secondary" to="/admin/members">Back to Members</Link>} />
    {user && canAddMember(user) ? <MemberAccess key={`${epoch}:${user.sessionId}`} request={request} user={user} /> :
      <ErrorState title="Access unavailable" message="Your account cannot add members to this group." />}
  </>;
}

function MemberAccess({request, user}: {request: AdminRequest; user: AdminUser}) {
  const identity = usePendingIdentity(user);
  const isCurrent = useCurrentAuthority();
  const expectedGroup = user.adminIdentity?.collectionId;
  const load = useCallback(async (signal: AbortSignal) => {
    const scope = readEnrollmentScope(await request(ENROLLMENT_PATH, {signal}), expectedGroup);
    const [attempt, roster] = scope.canEnroll ? await Promise.all([
      readPending(identity, ENROLLMENT_FAMILY, scope.collectionId), readPending(identity, ROSTER_FAMILY, scope.collectionId),
    ]) : [null, null];
    if ((attempt && !validEnrollmentAttempt(attempt, scope.collectionId)) || (roster && !validImportAttempt(roster, scope.collectionId))) {
      throw new Error('Invalid original member request.');
    }
    return {scope, attempt, roster};
  }, [request, expectedGroup, identity]);
  const {result, retry} = useOperationRead(JSON.stringify([user.id, user.sessionId, expectedGroup, identity.permissions]),
    true, load, {invalidResponse: 'The group or the original member request could not be confirmed.'});
  if (!result) return <LoadingState label="Loading member form" layout="details" />;
  if (result.status === 'error') return <ErrorState title="Member form unavailable" message={result.message} onRetry={retry} />;
  const {scope, attempt, roster} = result.value;
  if (!scope.canEnroll) return <ErrorState title="Access unavailable" message="Your account cannot add members to this group." />;
  return <MemberJourneys key={scope.collectionId} {...{scope, identity, request, isCurrent, roster}} original={attempt} />;
}

interface FormProps {
  scope: EnrollmentScope; identity: PendingIdentity; request: AdminRequest;
  isCurrent: () => boolean; original: PendingAttempt | null;
}
function MemberJourneys({scope, identity, request, isCurrent, original, roster}: FormProps & {roster: PendingAttempt | null}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<EnrollmentMode | null>(original ? 'manual' : null);
  const [recoveringRoster, setRecoveringRoster] = useState(!!roster && !original);
  const back = () => {setMode(null); setRecoveringRoster(false);};
  if (mode === 'manual') return <MemberForm {...{scope,identity,request,isCurrent,original}} onBack={back} />;
  return <Card className="admin-security-card members-enrollment">
    {mode || recoveringRoster
      ? <MemberRosterImport initialMode={mode} fileInput={fileInput} group={scope.collectionId} {...{identity,request,isCurrent}} original={roster} onBack={back} />
      : <><h2>{scope.label}</h2><EnrollmentMethods choose={setMode} fileInput={fileInput} /></>}
  </Card>;
}

function MemberForm({scope, identity, request, isCurrent, original, onBack}: FormProps & {onBack: () => void}) {
  const [initial,setInitial] = useState<MemberDraft>({name:'', phone:''});
  const [revision,setRevision] = useState(0);
  const [pending, setPending] = useState(original), [canRetry, setCanRetry] = useState(false);
  const [member, setMember] = useState<EnrolledMember | null>(null), [message, setMessage] = useState('');
  const [working, setWorking] = useState<'saving' | 'checking' | null>(null);
  const busy = useRef(false), mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const current = () => mounted.current && isCurrent();

  const finish = async (original: PendingAttempt, member: EnrolledMember) => {
    if (!current()) return;
    await clearOriginalAttempt(identity, original, current);
    if (current()) {setMember(member); setPending(null); setMessage('');}
  };
  const check = async () => {
    if (!pending || busy.current || !current()) return;
    busy.current = true; setWorking('checking'); setMessage(''); setCanRetry(false);
    try {
      const response = await request(`${ENROLLMENT_PATH}/requests/${pending.request_key}`);
      const member = await readEnrollmentOutcome(response, pending, true);
      if (!current()) return;
      if (member) await finish(pending, member);
      else {
        setCanRetry(true);
        setMessage('No completed request was found. You can check again or retry with the same name and number.');
      }
    } catch {if (current()) setMessage('The original request could not be checked. Keep the reference and try again.');}
    finally {busy.current = false; if (current()) setWorking(null);}
  };

  const save = async (details: ReviewedMember) => {
    if (busy.current || !current() || (pending && !canRetry)) return;
    const {name, phone} = details;
    setInitial({name,phone});
    busy.current = true; setWorking('saving'); setMessage('');
    let original = pending;
    let submitted = false;
    try {
      const requestId = original?.request_key ?? crypto.randomUUID();
      const intent = await enrollmentIntent(requestId, {name, phone});
      if (!current()) return;
      if (original && (original.intent.memberHash !== intent.memberHash || original.intent.phoneHash !== intent.phoneHash)) {
        setMessage('Use the same registered name and mobile number as the original request.'); setRevision(value=>value+1); return;
      }
      original = await retainPending(identity, ENROLLMENT_FAMILY, scope.collectionId, requestId, ENROLLMENT_PERMISSION, intent, undefined, undefined, current);
      if (!current()) return;
      setPending(original); setCanRetry(false); submitted = true;
      const response = await request(ENROLLMENT_PATH, {method: 'POST', idempotencyKey: requestId,
        body: {requestId, ...details}});
      const member = await readEnrollmentOutcome(response, original);
      if (member) await finish(original, member);
    } catch (error) {
      if (!current()) return;
      const rejection = submitted && original ? rejectedEnrollment(error) : null;
      if (rejection && original && !pending) {
        try {
          await clearOriginalAttempt(identity, original, current);
          if (current()) {setPending(null); setCanRetry(false); setMessage(rejection); setRevision(value=>value+1);}
        } catch {if (current()) setMessage('Check the original request before continuing.');}
      } else if (submitted) {
        setMessage('The save could not be confirmed. Check the original request before trying again.');
      } else {
        setMessage('The original request reference could not be saved. Return to Members and reopen the form.');
      }
    } finally {busy.current = false; if (current()) setWorking(null);}
  };
  if (member) return <Card className="admin-security-card members-enrollment" role="status">
    <h2>Member confirmed</h2><p>{member.name} · {member.phone}</p>
    <p>{scope.label} · <StatusBadge tone={member.active ? 'success' : 'neutral'}>{member.active ? 'Active' : 'Inactive'}</StatusBadge></p>
  </Card>;
  return <Card className="admin-security-card members-enrollment">
    <h2>{pending ? 'Original member request' : scope.label}</h2>
    {pending && <div><p>Request <code>{pending.request_key}</code></p>
      <Button onClick={() => void check()} disabled={!!working} loading={working === 'checking'}>Check request</Button></div>}
    {message && <p role="alert">{message}</p>}
    {(!pending || canRetry) && <EnrollmentReview key={revision} initial={initial} busy={!!working}
      confirmLabel={pending ? 'Retry original request' : 'Confirm and save'} onConfirm={details=>void save(details)}
      onBack={pending ? ()=>{setCanRetry(false); setMessage('Check the original request before continuing.');} : onBack} />}
    {working === 'saving' && <LoadingState label="Saving member" />}
  </Card>;
}
