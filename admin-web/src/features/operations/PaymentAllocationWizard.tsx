import {useCallback, useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import {z} from 'zod';
import {AdminRequestError} from '../../api/client';
import {useSession, type AdminUser, type SessionContextValue} from '../../session/SessionProvider';
import {usesPhoneCanonicalRecords} from '../../session/sessionContext';
import {Button, Dialog, ErrorState, Field, LoadingState} from '../../ui';
import {clearOriginalAttempt} from '../core/canonicalMutation';
import {readPending, retainPending, sha256Text, type PendingAttempt} from '../core/pendingAttempt';
import {usePendingIdentity} from '../core/usePendingIdentity';
import {buriMunsiPayment, paymentId, paymentTime, type BuriMunsiPayment} from './canonicalPaymentAnalysis';
import {Facts} from './OperationsRecords';
import {useOperationRead} from './useOperationRead';

type WizardProps = {id: string; group?: string; onClose: () => void; onAllocated: () => void; onStale: () => void};
type Member = {id: string; name: string};
const family = 'burimunsi.payment-allocation', permission = 'payments.read';
const originalIntent = z.object({memberId:paymentId, expectedVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict();
const membersPage = z.object({items:z.array(z.object({id:paymentId,name:z.string().refine(value => !!value.trim())})).max(25)})
  .refine(page => new Set(page.items.map(member => member.id)).size === page.items.length);
const allocated = z.object({paymentId,memberId:paymentId,state:z.literal('allocated'),version:z.number().int().positive()});
const allocationReceipt = z.discriminatedUnion('state', [
  z.object({state:z.literal('committed'),requestId:z.uuid(),
    receipt:z.object({paymentId,memberId:paymentId,version:z.number().int().positive()}).strict()}).strict(),
  z.object({state:z.literal('unconfirmed'),requestId:z.uuid()}).strict(),
]);
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

function AllocationSession(props: WizardProps & {session:SessionContextValue; user:AdminUser}) {
  const {id,group,session,onClose} = props, {epoch,request} = session;
  const load = useCallback(async (signal: AbortSignal) => {
    const payment = buriMunsiPayment.parse(await request('burimunsi/payments/' + id,{signal}));
    if (payment.id !== id || !payment.groupId || group && payment.groupId !== group) throw Error('Payment scope changed.');
    return payment;
  }, [group,id,request]);
  const {result,retry} = useOperationRead(JSON.stringify([epoch,group,id]),true,load);
  if (result?.status === 'success') return <AllocationFlow {...props} payment={result.value} group={result.value.groupId!} />;
  return <Dialog open title="Allocate payment" onClose={onClose} footer={<Button onClick={onClose}>Cancel</Button>}>
    {!result ? <LoadingState label="Loading payment" /> : <ErrorState title="Payment unavailable" message={result.message} onRetry={retry} />}
  </Dialog>;
}

function AllocationFlow({id,group,payment,onClose,onAllocated,onStale,session,user}:
  WizardProps & {group:string; payment:BuriMunsiPayment; session:SessionContextValue; user:AdminUser}) {
  const identity = usePendingIdentity(user), {epoch,request,isCurrentAuthority} = session;
  const mounted = useRef(false), sending = useRef(false), notified = useRef(false), reviewHeading = useRef<HTMLHeadingElement>(null);
  const memberSearch = useRef<HTMLInputElement>(null), returning = useRef(false);
  useLayoutEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const current = useCallback(() => mounted.current && isCurrentAuthority(epoch,identity.id,identity.sessionId), [epoch,identity,isCurrentAuthority]);
  const loadOriginal = useCallback(async () => {
    const resource = await sha256Text(JSON.stringify([group,id]));
    const attempt = await readPending(identity,family,resource);
    if (attempt) {
      originalIntent.parse(attempt.intent);
      if (attempt.permission !== permission || !z.uuid().safeParse(attempt.request_key).success) throw Error('Invalid original request.');
    }
    return {resource,attempt};
  }, [group,id,identity]);
  const recovery = useOperationRead(JSON.stringify([epoch,group,id,identity]),true,loadOriginal,
    {invalidResponse:'The original allocation reference could not be checked. No allocation was sent.'});
  const [pending,setPending] = useState<PendingAttempt | null | undefined>(undefined);
  const original = pending === undefined && recovery.result?.status === 'success' ? recovery.result.value.attempt : pending;
  const [query,setQuery] = useState(''), [selected,setSelected] = useState(''), [review,setReview] = useState<Member | null>(null);
  const [busy,setBusy] = useState(false), [canRetry,setCanRetry] = useState(false), [done,setDone] = useState(false);
  const [message,setMessage] = useState(''), [terminal,setTerminal] = useState('');
  const stale = terminal || (recovery.result?.status === 'success' && original === null && !done
    ? payment.state === 'allocated' ? (payment.memberName ? 'This payment is already allocated to ' + payment.memberName + '.' : 'This payment is already allocated.')
      : payment.canAllocate !== true ? 'Allocation is unavailable for this payment.' : '' : '');
  const canChoose = recovery.result?.status === 'success' && original === null && !stale && !done;
  const membersQuery = useCallback(async (signal: AbortSignal) => membersPage.parse(await request(
    'burimunsi/payments/members?' + new URLSearchParams({q:query,limit:'25'}),{signal})).items,[query,request]);
  const members = useOperationRead(JSON.stringify([epoch,group,id,query]),canChoose && !review,membersQuery);
  const candidates = members.result?.status === 'success' ? members.result.value : [];
  const chosen = candidates.find(member => member.id === selected);
  const reviewedId = original ? String(original.intent.memberId) : review?.id;
  const inputId = useId();
  useEffect(() => {
    if (stale && !notified.current && current()) {notified.current = true; onStale();}
  }, [current,onStale,stale]);
  useEffect(() => {
    if (reviewedId) reviewHeading.current?.focus();
    else if (returning.current) {returning.current = false; memberSearch.current?.focus();}
  }, [reviewedId]);
  function close() {if (!sending.current) onClose();}

  async function checkRequest() {
    if (!original || sending.current || !current()) return;
    const intent = originalIntent.parse(original.intent);
    sending.current = true; setBusy(true); setCanRetry(false); setMessage('');
    try {
      const response = allocationReceipt.parse(await request('burimunsi/payments/' + id + '/allocation-receipt', {idempotencyKey:original.request_key}));
      if (!current()) return;
      if (response.requestId !== original.request_key) throw Error('Request reference changed.');
      if (response.state === 'committed') {
        if (response.receipt.paymentId !== id || response.receipt.memberId !== intent.memberId || response.receipt.version !== intent.expectedVersion + 1) {
          throw Error('Allocation receipt changed.');
        }
        await clearOriginalAttempt(identity,original,current);
        if (current()) {setPending(null); setDone(true); onAllocated();}
        return;
      }
      const latest = buriMunsiPayment.parse(await request('burimunsi/payments/' + id));
      if (!current()) return;
      if (latest.id !== id || latest.groupId !== group || latest.canAllocate !== true) throw Error('Payment scope changed.');
      if (latest.state === 'unallocated' && latest.version === intent.expectedVersion && payment.version === latest.version) {
        setCanRetry(true);
        setMessage('No completed request was found and the payment is still unallocated. You can retry the original request.');
      } else setMessage('The payment has changed. This does not confirm the original request. Keep its reference and do not submit another allocation.');
    } catch {
      if (current()) setMessage('The original request could not be checked. Keep its reference and check again.');
    } finally {sending.current = false; if (current()) setBusy(false);}
  }

  async function confirm() {
    if (sending.current || !current() || recovery.result?.status !== 'success' || (!original && !review) || (original && !canRetry) || stale || done) return;
    const intent = original ? originalIntent.parse(original.intent) : {memberId:review!.id,expectedVersion:payment.version};
    if (payment.state !== 'unallocated' || payment.version !== intent.expectedVersion || payment.canAllocate !== true) return;
    sending.current = true; setBusy(true); setCanRetry(false); setMessage('');
    let attempt = original, sent = false;
    try {
      attempt = await retainPending(identity,family,recovery.result.value.resource,original?.request_key ?? crypto.randomUUID(),permission,intent,undefined,undefined,current);
      if (!current()) return;
      setPending(attempt); sent = true;
      const receipt = allocated.parse(await request('burimunsi/payments/' + id + '/allocate',{
        method:'POST',body:intent,idempotencyKey:attempt.request_key,
      }));
      if (receipt.paymentId !== id || receipt.memberId !== intent.memberId || receipt.version !== intent.expectedVersion + 1) throw Error('The allocation response changed.');
      if (!current()) return;
      await clearOriginalAttempt(identity,attempt,current);
      if (current()) {setPending(null); setDone(true); onAllocated();}
    } catch (error) {
      if (!current()) return;
      const rejected = error instanceof AdminRequestError && !error.outcomeUnknown && error.statusCode === 409 &&
        (error.code === 'member_unavailable' || error.code === 'payment_changed');
      if (!original && attempt && sent && rejected) {
        try {
          await clearOriginalAttempt(identity,attempt,current);
          if (current()) {setPending(null); setTerminal('The payment, member or allocation access changed. Close and review the current records.');}
        } catch {if (current()) setMessage('The original reference remains. Check the payment before continuing.');}
      } else setMessage(sent ? 'Allocation was not confirmed. Check the original request before trying again.' :
        'The original request reference could not be saved. No allocation was sent.');
    } finally {sending.current = false; if (current()) setBusy(false);}
  }

  const finished = !!stale || done;
  return <Dialog open title="Allocate payment" onClose={close} footer={<>
    <Button onClick={close} disabled={busy}>{finished ? 'Close' : 'Cancel'}</Button>
    {!finished && review && !original && <Button onClick={() => {returning.current = true; setReview(null);setMessage('');}} disabled={busy}>Back</Button>}
    {canChoose && !review && <Button variant="primary" disabled={!chosen} onClick={() => {if (chosen && current()) setReview(chosen);}}>Review allocation</Button>}
    {!finished && review && !original && <Button variant="primary" loading={busy} onClick={() => void confirm()}>Confirm allocation</Button>}
    {original && !finished && <Button onClick={() => void checkRequest()} disabled={busy}>Check request</Button>}
    {original && canRetry && !finished && <Button variant="primary" loading={busy} onClick={() => void confirm()}>Retry allocation</Button>}
  </>}>
    {!recovery.result ? <LoadingState label="Checking allocation reference" /> : recovery.result.status === 'error' ?
      <ErrorState message={recovery.result.message} onRetry={recovery.retry} /> :
      finished ? <p role="status">{done ? 'Payment allocated.' : stale}</p> : <>
        {reviewedId ? <h3 tabIndex={-1} ref={reviewHeading}>{original ? 'Original allocation request' : 'Review allocation'}</h3> : <h3>Choose a member</h3>}
        <Facts items={[[payment.ftId ? 'FT reference' : 'Payment ID',payment.ftId || payment.id],
          ['Amount',payment.amountRwf === null ? 'Not recorded' : 'RWF ' + money.format(payment.amountRwf)],
          ['Direction',payment.direction === 'incoming' ? 'Incoming' : 'Outgoing'],['Time (Kigali)',paymentTime(payment.atRaw)]]} />
        {reviewedId ? <><Facts items={[...(!original && review ? [['Member',review.name] as [string,string]] : []),['Member ID',reviewedId]]} />
          {original && <p>Request <code>{original.request_key}</code></p>}</> : <>
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
