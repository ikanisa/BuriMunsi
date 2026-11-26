import {useCallback, useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import {z} from 'zod';
import {AdminRequestError} from '../../api/client';
import {useSession, type AdminUser, type SessionContextValue} from '../../session/SessionProvider';
import {usesPhoneCanonicalRecords} from '../../session/sessionContext';
import {Button, Dialog, ErrorState, Field, LoadingState} from '../../ui';
import {clearOriginalAttempt} from '../core/canonicalMutation';
import {readPending, retainPending, type PendingAttempt} from '../core/pendingAttempt';
import {usePendingIdentity} from '../core/usePendingIdentity';
import {buriMunsiPayment, paymentId, paymentTime} from './canonicalPaymentAnalysis';
import {Facts} from './OperationsRecords';
import {useOperationRead} from './useOperationRead';

type WizardProps = {id: string; group?: string; onClose: () => void; onAllocated: () => void; onStale: () => void};
type Member = {id: string; name: string};
const family = 'burimunsi.allocate', permission = 'payments.read';
const originalIntent = z.object({groupId:paymentId, memberId:paymentId, expectedVersion:z.number().int().positive()}).strict();
const membersPage = z.object({items:z.array(z.object({id:paymentId,name:z.string().refine(value => !!value.trim())})).max(25)})
  .refine(page => new Set(page.items.map(member => member.id)).size === page.items.length);
const allocated = z.object({paymentId,memberId:paymentId,state:z.literal('allocated'),version:z.number().int().positive()});
const money = new Intl.NumberFormat('en-RW');

export function PaymentAllocationWizard(props: WizardProps) {
  const session = useSession(), user = session.user;
  const boundGroup = user?.adminIdentity?.collectionId;
  if (!user || session.status !== 'authenticated' || !usesPhoneCanonicalRecords(session) || !user.permissions.includes(permission) ||
      !paymentId.safeParse(props.id).success || (boundGroup && props.group && boundGroup !== props.group) ||
      !session.isCurrentAuthority(session.epoch,user.id,user.sessionId)) {
    return <Dialog open title="Allocate payment" onClose={props.onClose} footer={<Button onClick={props.onClose}>Close</Button>}>
      <p role="status">Allocation is unavailable for this account or payment.</p></Dialog>;
  }
  const group = boundGroup ?? props.group;
  const scope = JSON.stringify([session.epoch,user.id,user.sessionId,user.principalId,user.role,[...user.permissions].sort(),props.id,group]);
  return <AllocationSession key={scope} {...props} group={group} session={session} user={user} />;
}

function AllocationSession({id,group,onClose,onAllocated,onStale,session,user}: WizardProps & {session:SessionContextValue; user:AdminUser}) {
  const identity = usePendingIdentity(user), {epoch,request,isCurrentAuthority} = session;
  const mounted = useRef(false), sending = useRef(false), notified = useRef(false), reviewHeading = useRef<HTMLHeadingElement>(null);
  const memberSearch = useRef<HTMLInputElement>(null), returning = useRef(false);
  useLayoutEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const current = useCallback(() => mounted.current && isCurrentAuthority(epoch,identity.id,identity.sessionId), [epoch,identity,isCurrentAuthority]);
  const loadPayment = useCallback(async (signal: AbortSignal) => {
    const payment = buriMunsiPayment.parse(await request('burimunsi/payments/' + id,{signal}));
    if (payment.id !== id || !payment.groupId || (group && payment.groupId !== group)) throw Error('Payment scope changed.');
    signal.throwIfAborted();
    const saved = await readPending(identity,family,id);
    const previous = saved && originalIntent.parse(saved.intent);
    if (saved && (!z.uuid().safeParse(saved.request_key).success || saved.permission !== permission || previous?.groupId !== payment.groupId)) {
      throw Error('The original allocation could not be verified.');
    }
    const changed = !!previous && payment.version !== previous.expectedVersion;
    if (saved && (changed || payment.state === 'allocated')) {
      await clearOriginalAttempt(identity,saved,() => current() && !signal.aborted);
    }
    return {payment,saved:changed || payment.state === 'allocated' ? null : saved,changed};
  }, [current,group,id,identity,request]);
  const read = useOperationRead(JSON.stringify([epoch,group,id]),true,loadPayment);
  const snapshot = read.result?.status === 'success' ? read.result.value : null, payment = snapshot?.payment;
  const [localAttempt,setAttempt] = useState<PendingAttempt | null | undefined>(undefined);
  const [query,setQuery] = useState(''), [selected,setSelected] = useState(''), [review,setReview] = useState<Member | null>(null);
  const [busy,setBusy] = useState(false), [message,setMessage] = useState(''), [terminal,setTerminal] = useState(''), [done,setDone] = useState(false);
  const attempt = localAttempt === undefined ? snapshot?.saved : localAttempt;
  const reviewedId = review?.id ?? (attempt ? String(attempt.intent.memberId) : undefined);
  const stale = terminal || (snapshot?.changed && payment?.state === 'unallocated' ? 'The payment changed. Reopen it to review its current allocation.' :
    payment?.state === 'allocated' ? (payment.memberName ? 'This payment is already allocated to ' + payment.memberName + '.' : 'This payment is already allocated.') :
    payment && payment.canAllocate !== true ? 'Allocation is unavailable for this payment.' : '');
  const canSelect = !!payment && !stale && !reviewedId && !done;
  const membersQuery = useCallback(async (signal: AbortSignal) => membersPage.parse(await request(
    'burimunsi/payments/members?' + new URLSearchParams({q:query,limit:'25'}),{signal})).items,[query,request]);
  const members = useOperationRead(JSON.stringify([epoch,group,id,query]),canSelect,membersQuery);
  const candidates = members.result?.status === 'success' ? members.result.value : [];
  const chosen = candidates.find(member => member.id === selected);
  const inputId = useId();
  useEffect(() => {
    if (stale && !notified.current && current()) {notified.current = true; onStale();}
  }, [current,onStale,stale]);
  useEffect(() => {
    if (reviewedId) reviewHeading.current?.focus();
    else if (returning.current) {returning.current = false; memberSearch.current?.focus();}
  }, [reviewedId]);
  function close() {if (!sending.current) onClose();}
  async function confirm() {
    if (!current() || sending.current || !payment?.groupId || !reviewedId || stale || done) return;
    sending.current = true; setBusy(true); setMessage('');
    let original = attempt;
    let submitted = false;
    try {
      if (!original) original = await retainPending(identity,family,id,crypto.randomUUID(),permission,
        {groupId:payment.groupId,memberId:reviewedId,expectedVersion:payment.version});
      if (!current()) return;
      setAttempt(original);
      submitted = true;
      const receipt = allocated.parse(await request('burimunsi/payments/' + id + '/allocate',{method:'POST',
        body:{memberId:reviewedId,expectedVersion:payment.version},idempotencyKey:original.request_key}));
      if (receipt.paymentId !== id || receipt.memberId !== reviewedId || receipt.version !== payment.version + 1) throw Error('Allocation receipt changed.');
      if (!current()) return;
      // The receipt confirms the allocation even if the tab cannot clear its pending copy.
      try {await clearOriginalAttempt(identity,original,current);} catch { /* A fresh read reconciles the recorded allocation. */ }
      if (current()) {setAttempt(null); setDone(true); onAllocated();}
    } catch (error) {
      if (!current()) return;
      if (submitted && original && error instanceof AdminRequestError && !error.outcomeUnknown) {
        try {await clearOriginalAttempt(identity,original,current);} catch {if (current()) setMessage('Reopen this payment to check its allocation.'); return;}
        if (!current()) return;
        setAttempt(null);
        if (error.statusCode === 403 || error.statusCode === 404 || error.statusCode === 409) {
          setTerminal('The payment, member or allocation access changed. Close and review the current records.');
        } else setMessage(error.message);
      } else setMessage(submitted ? 'Allocation was not confirmed. Retry the original allocation or close and check the payment.' :
        'The original allocation request could not be prepared. Reopen the payment to try again.');
    } finally {
      sending.current = false;
      if (current()) setBusy(false);
    }
  }

  const finished = !!stale || done;
  return <Dialog open title="Allocate payment" onClose={close} footer={<>
    <Button onClick={close} disabled={busy}>{finished ? 'Close' : 'Cancel'}</Button>
    {!finished && reviewedId && !attempt && <Button onClick={() => {returning.current = true; setReview(null);setMessage('');}} disabled={busy}>Back</Button>}
    {canSelect && <Button variant="primary" disabled={!chosen} onClick={() => {if (chosen && current()) setReview(chosen);}}>Review allocation</Button>}
    {!finished && reviewedId && <Button variant="primary" loading={busy} onClick={() => void confirm()}>{attempt ? 'Retry allocation' : 'Confirm allocation'}</Button>}
  </>}>
    {!read.result ? <LoadingState label="Loading payment" /> : read.result.status === 'error' ?
      <ErrorState title="Payment unavailable" message={read.result.message} onRetry={read.retry} /> :
      finished ? <p role="status">{done ? 'Payment allocated.' : stale}</p> : payment && <>
        {reviewedId ? <h3 tabIndex={-1} ref={reviewHeading}>Review allocation</h3> : <h3>Choose a member</h3>}
        <Facts items={[[payment.ftId ? 'FT reference' : 'Payment ID',payment.ftId || payment.id],
          ['Amount',payment.amountRwf === null ? 'Not recorded' : 'RWF ' + money.format(payment.amountRwf)],
          ['Direction',payment.direction === 'incoming' ? 'Incoming' : 'Outgoing'],['Time (Kigali)',paymentTime(payment.atRaw)]]} />
        {reviewedId ? <><Facts items={[...(review ? [['Member',review.name] as [string,string]] : []),['Member ID',reviewedId]]} />
          {attempt && !busy && !message && <p role="status">The previous allocation is unconfirmed. Retry the original request to check its outcome.</p>}</> : <>
          <form className="operations-search" onSubmit={event => {
            event.preventDefault(); setSelected(''); setQuery(String(new FormData(event.currentTarget).get('member') ?? '').trim().slice(0,80));
          }}><Field htmlFor={inputId+'-search'} label="Search group members"><input ref={memberSearch} id={inputId+'-search'} name="member" className="admin-input" maxLength={80} /></Field>
            <Button type="submit">Search</Button></form>
          {!members.result ? <LoadingState label="Loading group members" /> : members.result.status === 'error' ?
            <ErrorState title="Members unavailable" message={members.result.message} onRetry={members.retry} /> : candidates.length ?
            <Field htmlFor={inputId+'-member'} label="Member"><select id={inputId+'-member'} className="admin-input" value={selected} onChange={event => setSelected(event.target.value)}>
              <option value="">Choose a member</option>
              {candidates.map(member => <option key={member.id} value={member.id}>
                {candidates.some(other => other.id !== member.id && other.name === member.name) ? member.name + ' · ' + member.id : member.name}
              </option>)}
            </select></Field> : <p>No group members found.</p>}
        </>}
      </>}
    {message && !finished && <p role="status">{message}</p>}
  </Dialog>;
}
