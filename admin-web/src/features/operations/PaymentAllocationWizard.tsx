import {useCallback, useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import {z} from 'zod';
import {AdminRequestError} from '../../api/client';
import {useSession, type AdminUser, type SessionContextValue} from '../../session/SessionProvider';
import {usesPhoneCanonicalRecords} from '../../session/sessionContext';
import {Button, CompactText, Dialog, ErrorState, Field, Icon, LoadingState} from '../../ui';
import {clearOriginalAttempt} from '../core/canonicalMutation';
import {readPending, retainPending, sha256Text, type PendingAttempt} from '../core/pendingAttempt';
import {usePendingIdentity} from '../core/usePendingIdentity';
import {buriMunsiPayment, paymentId, paymentEventTime, type BuriMunsiPayment} from './canonicalPaymentAnalysis';
import {Facts} from './OperationsRecords';
import {useOperationRead} from './useOperationRead';

type WizardProps = {id: string; group?: string; onClose: () => void; onAllocated: () => void; onStale: () => void};
type Member = {id:string; name:string; publicId?:string | null; memberNumber?:string | null};
const family = 'burimunsi.payment-allocation', permission = 'payments.read';
const originalIntent = z.object({memberId:paymentId, expectedVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict();
const membersPage = z.object({items:z.array(z.object({id:paymentId,name:z.string().refine(value => !!value.trim()),
  publicId:z.string().regex(/^\d{6}$/).nullish(), memberNumber:z.string().regex(/^\d{12}$/).nullish()})).max(25),
  nextCursor:paymentId.nullable().optional()}).refine(page => !page.nextCursor || page.nextCursor === page.items.at(-1)?.id)
  .refine(page => new Set(page.items.map(member => member.id)).size === page.items.length);
const allocated = z.object({paymentId,memberId:paymentId,state:z.literal('allocated'),version:z.number().int().positive()});
const allocationReceipt = z.discriminatedUnion('state', [
  z.object({state:z.literal('committed'),requestId:z.uuid(),
    receipt:z.object({paymentId,memberId:paymentId,version:z.number().int().positive()}).strict()}).strict(),
  z.object({state:z.literal('unconfirmed'),requestId:z.uuid()}).strict(),
]);
const money = new Intl.NumberFormat('en-RW');

function smsPhoneEnding(identifier: string | null | undefined) {
  const raw = identifier?.trim();
  if (!raw || raw.length > 40 || !/^[+0-9*xX•#() .-]+$/.test(raw)) return null;
  const number = raw.replace(/[ ().-]/g,'');
  const mobile = /^(?:0|\+?250|00250)7[2389]\d{7}$/;
  const masked = /^(?:(?:0|\+?250|00250)7(?:[2389]\d{0,3})?)?[*xX•#]{2,12}\d{3,4}$/;
  return mobile.test(number) || masked.test(number) ? number.slice(-3) : null;
}

function nameKey(name: string) {
  return name.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('en');
}

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
  const memberSearch = useRef<HTMLInputElement>(null), memberButton = useRef<HTMLButtonElement>(null), returning = useRef(false);
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
  const [query,setQuery] = useState(''), [chosen,setChosen] = useState<Member | null>(null), [review,setReview] = useState<Member | null>(null);
  const [picking,setPicking] = useState(false), [cursors,setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const [busy,setBusy] = useState(false), [canRetry,setCanRetry] = useState(false), [done,setDone] = useState(false);
  const [message,setMessage] = useState(''), [terminal,setTerminal] = useState('');
  const stale = terminal || (recovery.result?.status === 'success' && original === null && !done
    ? payment.state === 'allocated' ? (payment.memberName ? 'This payment is already allocated to ' + payment.memberName + '.' : 'This payment is already allocated.')
      : payment.canAllocate !== true ? 'Allocation is unavailable for this payment.' : '' : '');
  const canChoose = recovery.result?.status === 'success' && original === null && !stale && !done;
  const membersQuery = useCallback(async (signal: AbortSignal) => {
    const params = new URLSearchParams({q:query,limit:'25'});
    if (cursor) params.set('after',cursor);
    return membersPage.parse(await request('burimunsi/payments/members?' + params,{signal}));
  },[query,cursor,request]);
  const members = useOperationRead(JSON.stringify([epoch,group,id,query,cursor]),canChoose && !review,membersQuery);
  const memberPage = members.result?.status === 'success' ? members.result.value : null;
  const candidates = memberPage?.items ?? [];
  const nextCursor = memberPage?.nextCursor;
  const party = payment.direction === 'incoming' ? 'Payer' : 'Recipient';
  const rawName = payment.payerNameRaw?.trim();
  const smsName = rawName && !smsPhoneEnding(rawName) ? rawName : null;
  const smsKey = nameKey(smsName ?? '');
  // The scoped directory searches a literal substring. One full word admits
  // different spacing; the complete normalized names must still match below.
  const nameQuery = (smsKey.match(/[\p{L}\p{M}]+/gu) ?? []).reduce((longest,word) =>
    word.length > longest.length ? word : longest,'').slice(0,80);
  const targeted = !!nameQuery && !cursor && query === '' && (memberPage?.nextCursor != null || candidates.length === 25);
  const loadMatches = useCallback(async (signal: AbortSignal) => membersPage.parse(await request(
    'burimunsi/payments/members?' + new URLSearchParams({q:nameQuery,limit:'25'}),{signal})).items,[nameQuery,request]);
  const matchesRead = useOperationRead(JSON.stringify([epoch,group,id,'name-match',nameQuery]),canChoose && !review && targeted,loadMatches);
  const namePage = matchesRead.result?.status === 'success' ? matchesRead.result.value : null;
  const matches = new Map<string,Member>();
  if (query === '' && !cursor && nameQuery) {
    for (const member of [...candidates,...(namePage ?? [])]) {
      if (nameKey(member.name) === smsKey) matches.set(member.id,member);
    }
  }
  const suggestion = matches.size === 1 && (!targeted || namePage && namePage.length < 25)
    ? matches.values().next().value : undefined;
  const choices = [...new Map([...candidates,...matches.values()].map(member => [member.id,member])).values()];
  const memberLabel = (member:Member) => member.memberNumber ? member.name + ' · ' + member.memberNumber :
    member.publicId ? member.name + ' · ' + member.publicId :
    choices.some(other => other.id !== member.id && nameKey(other.name) === nameKey(member.name)) ? member.name + ' · ' + member.id : member.name;
  const reviewedId = original ? String(original.intent.memberId) : review?.id;
  const inputId = useId();
  useEffect(() => {
    if (stale && !notified.current && current()) {notified.current = true; onStale();}
  }, [current,onStale,stale]);
  useEffect(() => {
    if (picking) memberSearch.current?.focus();
    else if (reviewedId) reviewHeading.current?.focus();
    else if (returning.current) {returning.current = false; memberButton.current?.focus();}
  }, [reviewedId,picking]);
  function close() {if (!sending.current) onClose();}
  function closePicker(member?:Member) {
    if (!current()) return;
    if (member) setChosen(member);
    returning.current = true;
    setPicking(false);
    setQuery(''); setCursors([]);
  }

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
  if (picking && canChoose && !review) return <Dialog open placement="picker" title="Select member"
    onClose={() => closePicker()} footer={<Button onClick={() => closePicker()}>Cancel</Button>}>
    <form className="payment-member-search" onSubmit={event => {
      event.preventDefault();
      setCursors([]);
      setQuery(String(new FormData(event.currentTarget).get('member') ?? '').trim().slice(0,80));
    }}><Field htmlFor={inputId+'-search'} label="Search group members"><input ref={memberSearch} id={inputId+'-search'}
      name="member" type="search" autoComplete="off" className="admin-input" placeholder="Name, member number or Collect ID" maxLength={80} defaultValue={query} /></Field>
      <Button type="submit">Search</Button></form>
    {!members.result ? <LoadingState label="Loading group members" /> : members.result.status === 'error' ?
      <ErrorState title="Members unavailable" message={members.result.message} onRetry={members.retry} /> : choices.length ?
      <ul className="payment-member-choices" aria-label="Group members">{choices.map(member =>
        <li key={member.id}><button type="button" className="payment-member-choice" aria-pressed={member.id === chosen?.id}
          onClick={() => closePicker(member)}><CompactText>{memberLabel(member)}</CompactText>
          {member.id === chosen?.id && <Icon name="check" />}</button></li>)}</ul> : <p>No group members found.</p>}
    {memberPage && (cursor || memberPage.nextCursor) && <nav className="operations-search" aria-label="Member search pages">
      {cursor && <Button onClick={() => setCursors(history => history.slice(0,-1))}>Previous members</Button>}
      {nextCursor && <Button onClick={() => setCursors(history => [...history,nextCursor])}>Next members</Button>}
    </nav>}
    {memberPage?.nextCursor === undefined && candidates.length === 25 && <p>More members may match. Refine the search by name.</p>}
  </Dialog>;
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
          ['Time',paymentEventTime(payment)],[party + ' name',smsName],
          [party + ' MoMo ending',smsPhoneEnding(payment.payerPhoneRaw)]]} />
        {reviewedId ? <><Facts items={[...(!original && review ? [['Member',memberLabel(review)] as [string,string]] : []),['Member ID',reviewedId]]} />
          {original && <p>Request <code>{original.request_key}</code></p>}</> : <>
          {suggestion && <div className="operations-search"><span>{party} name match</span>
            <Button variant="soft" aria-label={'Select suggested member ' + suggestion.name}
              onClick={() => {if (current()) setChosen(suggestion);}}>{suggestion.name}</Button></div>}
          {matches.size > 1 && <p>Several group members match the SMS name. Choose the intended member.</p>}
          <button ref={memberButton} type="button" className="payment-member-choice payment-member-trigger" aria-label="Choose member"
            aria-haspopup="dialog" aria-describedby={chosen ? inputId+'-chosen' : undefined} onClick={() => {if (current()) setPicking(true);}}>
            <span id={inputId+'-chosen'}><CompactText>{chosen ? memberLabel(chosen) : 'Choose member'}</CompactText></span><Icon name="chevron" />
          </button>
        </>}
      </>}
    {message && !finished && <p role="status">{message}</p>}
  </Dialog>;
}
