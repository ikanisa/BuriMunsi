import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';
import {Link} from 'react-router';
import {type AdminRequest} from '../../api/contracts';
import {useCurrentAuthority} from '../../app/workspace/access';
import {useSession, type AdminUser} from '../../session/SessionProvider';
import {Button, Card, ErrorState, LoadingState, PageHeader, StatusBadge} from '../../ui';
import {useOperationRead} from '../operations/useOperationRead';
import {canAddMember} from './addMemberAccess';
import {clearOriginalAttempt} from './canonicalMutation';
import {ENROLLMENT_FAMILY, ENROLLMENT_PATH, ENROLLMENT_PERMISSION, enrollmentIntent, readEnrollmentOutcome,
  readEnrollmentScope, rejectedEnrollment, validateMember, validEnrollmentAttempt,
  type EnrolledMember, type EnrollmentScope, type MemberDraft} from './memberEnrollment';
import {readPending, retainPending, type PendingAttempt, type PendingIdentity} from './pendingAttempt';
import {usePendingIdentity} from './usePendingIdentity';
import './memberEnrollment.css';

const attestations = [
  ['verifiedOwnership', 'I checked the full MoMo number and confirmed who owns it.'],
  ['acceptedTerms', 'The member accepted the savings terms.'],
  ['consentRecorded', 'I recorded the member’s consent to the privacy notice.'],
] as const;
const emptyConfirmations = {verifiedOwnership: false, acceptedTerms: false, consentRecorded: false};

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
    const attempt = scope.canEnroll ? await readPending(identity, ENROLLMENT_FAMILY, scope.collectionId) : null;
    if (attempt && !validEnrollmentAttempt(attempt, scope.collectionId)) throw new Error('Invalid original member request.');
    return {scope, attempt};
  }, [request, expectedGroup, identity]);
  const {result, retry} = useOperationRead(JSON.stringify([user.id, user.sessionId, expectedGroup, identity.permissions]),
    true, load, {invalidResponse: 'The group or the original member request could not be confirmed.'});
  if (!result) return <LoadingState label="Loading member form" />;
  if (result.status === 'error') return <ErrorState title="Member form unavailable" message={result.message} onRetry={retry} />;
  const {scope, attempt} = result.value;
  if (!scope.canEnroll) return <ErrorState title="Access unavailable" message="Your account cannot add members to this group." />;
  return <MemberForm key={scope.collectionId} {...{scope, identity, request, isCurrent}} original={attempt} />;
}

interface FormProps {
  scope: EnrollmentScope; identity: PendingIdentity; request: AdminRequest;
  isCurrent: () => boolean; original: PendingAttempt | null;
}
function MemberForm({scope, identity, request, isCurrent, original}: FormProps) {
  const [draft, setDraft] = useState<MemberDraft>({name: '', phone: ''});
  const [confirmed, setConfirmed] = useState(emptyConfirmations);
  const [errors, setErrors] = useState<{name?: string; phone?: string; consent?: string}>({});
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

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current || !current() || (pending && !canRetry)) return;
    const {name, phone, errors: fieldErrors} = validateMember(draft);
    const missing = attestations.find(([key]) => !confirmed[key]);
    setErrors({...fieldErrors, consent: missing ? 'Confirm each statement before saving the member.' : undefined});
    const first = fieldErrors.name ? 'name' : fieldErrors.phone ? 'phone' : missing?.[0];
    if (first) {event.currentTarget.querySelector<HTMLElement>(`[name="${first}"]`)?.focus(); return;}
    busy.current = true; setWorking('saving'); setMessage('');
    let original = pending;
    let submitted = false;
    try {
      const requestId = original?.request_key ?? crypto.randomUUID();
      const intent = await enrollmentIntent(requestId, {name, phone});
      if (!current()) return;
      if (original && (original.intent.memberHash !== intent.memberHash || original.intent.phoneHash !== intent.phoneHash)) {
        setMessage('Use the same registered name and MoMo number as the original request.'); return;
      }
      original = await retainPending(identity, ENROLLMENT_FAMILY, scope.collectionId, requestId, ENROLLMENT_PERMISSION, intent);
      if (!current()) return;
      setPending(original); setCanRetry(false); submitted = true;
      const response = await request(ENROLLMENT_PATH, {method: 'POST', idempotencyKey: requestId,
        body: {requestId, name, phone, ...confirmed}});
      const member = await readEnrollmentOutcome(response, original);
      if (member) await finish(original, member);
    } catch (error) {
      if (!current()) return;
      const rejection = submitted && original ? rejectedEnrollment(error) : null;
      if (rejection && original && !pending) {
        try {
          await clearOriginalAttempt(identity, original, current);
          if (current()) {setPending(null); setCanRetry(false); setMessage(rejection);}
        } catch {if (current()) setMessage('Check the original request before continuing.');}
      } else if (submitted) {
        setMessage('The save could not be confirmed. Check the original request before trying again.');
      } else {
        setMessage('The original request reference could not be saved. Return to Members and reopen the form.');
      }
    } finally {busy.current = false; if (current()) setWorking(null);}
  };
  const update = (field: keyof MemberDraft, value: string) => {
    setDraft(previous => ({...previous, [field]: value}));
    setConfirmed(emptyConfirmations); setErrors({}); setMessage('');
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
    {(!pending || canRetry) && <form className="admin-auth-form" aria-label="Member details" onSubmit={save} noValidate>
      <div className="admin-field"><label htmlFor="member-name">Registered MoMo name</label>
        <input className="admin-input" id="member-name" name="name" autoComplete="off" required minLength={2} maxLength={100}
          value={draft.name} onChange={event => update('name', event.target.value)} disabled={!!working}
          aria-invalid={!!errors.name} aria-describedby={errors.name ? 'member-name-error' : undefined} />
        {errors.name && <p className="admin-field-error" id="member-name-error">{errors.name}</p>}
      </div>
      <div className="admin-field"><label htmlFor="member-phone">MoMo phone number</label>
        <input className="admin-input" id="member-phone" name="phone" type="tel" autoComplete="off" required maxLength={40}
          value={draft.phone} onChange={event => update('phone', event.target.value)} disabled={!!working}
          aria-invalid={!!errors.phone} aria-describedby={errors.phone ? 'member-phone-error' : undefined} />
        {errors.phone && <p className="admin-field-error" id="member-phone-error">{errors.phone}</p>}
      </div>
      <fieldset className="members-enrollment-confirmations" disabled={!!working} aria-describedby={errors.consent ? 'member-consent-error' : undefined}>
        <legend>Member consent</legend>
        {attestations.map(([key, text]) => <label key={key}><input type="checkbox" name={key} required checked={confirmed[key]}
          onChange={event => {setConfirmed({...confirmed, [key]: event.target.checked}); setErrors({...errors, consent: undefined});}} /> {text}</label>)}
        {errors.consent && <p className="admin-field-error" id="member-consent-error">{errors.consent}</p>}
      </fieldset>
      <p className="core-note">New memberships start active. Eligible earlier MoMo payments may be matched and credited to this member.</p>
      <Button variant="primary" type="submit" disabled={!!working} loading={working === 'saving'}>{pending ? 'Retry original request' : 'Save member'}</Button>
    </form>}
    {working === 'saving' && <LoadingState label="Saving member" />}
  </Card>;
}
