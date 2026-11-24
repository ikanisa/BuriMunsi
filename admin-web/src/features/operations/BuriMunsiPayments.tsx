import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';
import {Link, useSearchParams} from 'react-router';
import {z} from 'zod';
import {AdminRequestError} from '../../api/client';
import {useSession, type AdminUser} from '../../session/SessionProvider';
import {clearOriginalAttempt} from '../core/canonicalMutation';
import {readPending, retainPending, sha256Text, type PendingAttempt} from '../core/pendingAttempt';
import {usePendingIdentity} from '../core/usePendingIdentity';
import {canDisplaySessionRecords, canReadSmsEvidence} from '../../session/sessionContext';
import {Button, Card, EmptyState, ErrorState, Field, LoadingState, PageHeader, StatusBadge} from '../../ui';
import {MomoCell, MomoTable} from './MomoRecordViews';
import {Facts} from './OperationsRecords';
import {ReceiverSmsPanel} from './ReceiverSmsPanel';
import {CanonicalPaymentEvidence} from './CanonicalPaymentEvidence';
import {FinancialAnalysisTable, type FinancialColumn} from './FinancialAnalysisTable';
import {PaymentTotalsSummary} from './PaymentFlowTotals';
import {initialColumnFilters, type ColumnFilter, type FinancialSort} from './financialAnalysisModel';
import {type PaymentAnalysisQuery} from '../../../../supabase/functions/_shared/domain/burimunsi/payment-analysis-shared.mjs';
import {buriMunsiPayment, paymentAllocation, paymentDirection, paymentId, paymentInstant, paymentTime, readCanonicalPaymentAnalysis, type BuriMunsiPayment} from './canonicalPaymentAnalysis';
import {useOperationRead} from './useOperationRead';
import './operations.css';
import './paymentsWorkspace.css';

export {buriMunsiPayment};
export type {BuriMunsiPayment};
const membersPage = z.object({items: z.array(z.object({id: paymentId, name: z.string().min(1)})).max(25)});
const allocated = z.object({paymentId, memberId: paymentId, state: z.literal('allocated'), version: z.number().int().positive()});
const allocationReceipt = z.discriminatedUnion('state', [
  z.object({state: z.literal('committed'), requestId: z.uuid(),
    receipt: z.object({paymentId, memberId: paymentId, version: z.number().int().positive()}).strict()}).strict(),
  z.object({state: z.literal('unconfirmed'), requestId: z.uuid()}).strict(),
]);
const allocationFamily = 'burimunsi.payment-allocation';
const allocationPermission = 'payments.read';
const retainedAllocation = z.object({memberId: paymentId, expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict();
const maxSearchLength = 80;
const amountFormat = new Intl.NumberFormat('en-RW');
const amount = (value: number | null) => value === null ? '—' : 'RWF ' + amountFormat.format(value);
const allocationLabel = (state: BuriMunsiPayment['state']) => state === 'allocated' ? 'Allocated' : 'Unallocated';
const directionLabel = (value: BuriMunsiPayment['direction']) => value === 'incoming' ? 'Incoming' : 'Outgoing';
const recordedText = (value: string | null | undefined) => value?.trim() ? value : null;
export const buriMunsiPaymentsPath = '/admin/payments';
export const buriMunsiSmsPath = buriMunsiPaymentsPath + '?view=sms';
export const buriMunsiPaymentPath = (id: string) => buriMunsiPaymentsPath + '?' + new URLSearchParams({payment: id});

export function BuriMunsiPaymentRows({rows, onSelect}: {rows: BuriMunsiPayment[]; onSelect?: (paymentId: string) => void}) {
  return <MomoTable name="Payments" headings={['Reference', 'Direction', 'Amount', 'Member', 'Status', 'Payment time']} compact>
    {rows.map(row => <tr key={row.id}><MomoCell label="Reference">{onSelect
      ? <button type="button" className="operations-link" onClick={() => onSelect(row.id)}>{row.ftId ?? 'View payment'}</button>
      : <Link className="operations-link" to={buriMunsiPaymentPath(row.id)}>{row.ftId ?? 'View payment'}</Link>}</MomoCell>
      <MomoCell label="Direction">{directionLabel(row.direction)}</MomoCell><MomoCell label="Amount">{amount(row.amountRwf)}</MomoCell>
      <MomoCell label="Member">{row.memberName ?? '—'}</MomoCell><MomoCell label="Status"><StatusBadge>{allocationLabel(row.state)}</StatusBadge></MomoCell>
      <MomoCell label="Payment time">{paymentTime(row.atRaw)}</MomoCell></tr>)}
  </MomoTable>;
}

export function BuriMunsiPayments() {
  const session = useSession(), [params, setParams] = useSearchParams();
  const permitted = canDisplaySessionRecords(session) && !!session.user?.permissions.includes('payments.read');
  const canReadSms = canDisplaySessionRecords(session) && canReadSmsEvidence(session.user);
  const view = params.get('view'), legacySource = params.getAll('source');
  const invalidView = params.getAll('view').length > 1 || (view !== null && view !== 'sms') ||
    legacySource.length > 0 && (view !== 'sms' || legacySource.length !== 1 || legacySource[0] !== 'android') ||
    params.has('account') || params.has('group');
  const smsOpen = view === 'sms' || !permitted;
  function toggleInbox() {
    const next = new URLSearchParams(params);
    if (smsOpen) { next.delete('view'); next.delete('source'); }
    else { next.set('view', 'sms'); next.delete('payment'); }
    setParams(next);
  }
  return <section className="payments-workspace"><PageHeader title="Payments" />
    {invalidView ? <ErrorState title="Payment view unavailable" message="Open Payments to view your collection." /> :
      (!permitted && !canReadSms || view === 'sms' && !canReadSms) ? <ErrorState title="Access unavailable" message="Your account cannot open this payment view." /> :
        <>{permitted && <PaymentRecords />}
          {canReadSms && <section aria-label="M-Money SMS inbox">
            {permitted && <Button aria-expanded={smsOpen} onClick={toggleInbox}>M-Money SMS</Button>}
            {smsOpen && <ReceiverSmsPanel simplePayments />}
          </section>}
        </>}
  </section>;
}

function PaymentRecords() {
  const {epoch, user} = useSession(), [params] = useSearchParams();
  return <ScopedPaymentRecords key={JSON.stringify([epoch,user?.id,user?.sessionId,user?.role,user?.adminIdentity?.collectionId,
    canReadSmsEvidence(user),params.get('q'),params.get('status'),params.get('direction')])} />;
}

const defaultSort: FinancialSort={key:'time',direction:'desc'};
const categoryBookmarks = [{key:'allocation',kind:'category'},{key:'direction',kind:'category'}] as const;

function ScopedPaymentRecords() {
  const {epoch, request, user} = useSession(), [params, setParams] = useSearchParams();
  const canReadSms = canReadSmsEvidence(user), group = user?.adminIdentity?.collectionId;
  const selected = params.get('view') === 'sms' ? undefined : paymentId.safeParse(params.get('payment')).data;
  const query = (params.get('q') ?? '').trim().slice(0, maxSearchLength);
  const allocation = paymentAllocation.safeParse(params.get('status')).data, direction = paymentDirection.safeParse(params.get('direction')).data;
  const offsetText = params.get('offset') ?? '0';
  const offset = /^\d{1,6}$/.test(offsetText) ? Number(offsetText) : 0;
  const [resettingOffset,setResettingOffset] = useState(false);
  const page = !resettingOffset && offset <= 100_000 && offset % 25 === 0 ? offset / 25 + 1 : 1;
  if (offset===0 && resettingOffset) setResettingOffset(false);
  const [filters,setFilters] = useState(() => initialColumnFilters(categoryBookmarks.map(column=>({...column,label:column.key,value:()=>null})),
    {...(allocation && {allocation}), ...(direction && {direction})}));
  const [sort,setSort] = useState(defaultSort);
  const payload = JSON.stringify({q:query,offset:(page-1)*25,limit:25,filters:[...filters].map(([key,value])=>({key,...value})),sort});
  const load = useCallback(async (signal: AbortSignal) => {
    try {return await readCanonicalPaymentAnalysis(request, signal, JSON.parse(payload) as PaymentAnalysisQuery, group, canReadSms);}
    catch (error) {
      if (error instanceof AdminRequestError && error.code === 'payment_analysis_scope_too_large') {
        throw new AdminRequestError('The collection is too large for this payment view. No partial totals are displayed.');
      }
      throw error;
    }
  }, [group, canReadSms, payload, request]);
  const {result, retry} = useOperationRead(JSON.stringify([epoch, group, canReadSms, payload]), true, load,
    {invalidResponse:'Matching payments and totals could not be confirmed. Please refresh.'});
  const data = result?.status === 'success' ? result.value : null;
  const rows = data?.items ?? [];
  function changeCriteria(nextFilters:ReadonlyMap<string,ColumnFilter>,nextSort:FinancialSort) {
    setFilters(nextFilters); setSort(nextSort);
    if (page > 1) {setResettingOffset(true); changePage(1);}
  }
  function changePage(nextPage: number) {
    const next = new URLSearchParams(params);
    if (nextPage > 1) next.set('offset',String((nextPage - 1) * 25)); else next.delete('offset');
    setParams(next, {replace:true});
  }
  function show(id?: string) {
    const next = new URLSearchParams(params);
    if (id && id !== selected) {
      next.set('payment',id); next.delete('view'); next.delete('source');
    } else next.delete('payment');
    setParams(next);
  }
  function rowButton(row: BuriMunsiPayment, name: string) {
    return <button type="button" className="operations-link" aria-expanded={selected === row.id} onClick={() => show(row.id)}>{name}</button>;
  }
  const columns: FinancialColumn<BuriMunsiPayment>[] = [
    {key:'reference',label:'FT reference',kind:'text',value:r=>recordedText(r.ftId),render:r=>rowButton(r, recordedText(r.ftId) ?? 'View payment')},
    {key:'time',label:'Time (Kigali)',kind:'date',value:r=>paymentInstant(r.atRaw),render:r=>paymentTime(r.atRaw)},
    {key:'amount',label:'Amount (RWF)',kind:'number',align:'end',value:r=>r.amountRwf,render:r=>r.amountRwf === null ? '—' : amountFormat.format(r.amountRwf)},
    {key:'direction',label:'Direction',kind:'category',value:r=>r.direction,render:r=>directionLabel(r.direction),
      options:[{value:'incoming',label:'Incoming'},{value:'outgoing',label:'Outgoing'}]},
    {key:'allocation',label:'Allocation',kind:'category',value:r=>r.state,render:r=><StatusBadge>{allocationLabel(r.state)}</StatusBadge>,
      options:[{value:'allocated',label:'Allocated'},{value:'unallocated',label:'Unallocated'}]},
    {key:'counterparty',label:'Counterparty',kind:'text',value:r=>recordedText(r.payerNameRaw)},
    {key:'member',label:'Member',kind:'text',value:r=>recordedText(r.memberName)},
    {key:'counterpartyId',label:'Counterparty number / code',kind:'text',value:r=>recordedText(r.payerPhoneRaw)},
    {key:'memberPhone',label:'Member phone',kind:'text',value:r=>recordedText(r.memberPhone)},
  ];
  if (canReadSms) columns.push({key:'sms',label:'SMS evidence',kind:'category',value:r=>r.sourceId ? 'linked' : 'none',
    options:[{value:'linked',label:'Linked'},{value:'none',label:'None linked'}],render:r=>r.sourceId ? rowButton(r,'Review linked SMS') : 'None linked'});
  const detail = selected ? <PaymentDetail key={selected} id={selected} group={group ?? rows?.[0]?.groupId} onClose={() => show()} onUpdated={retry} /> : null;
  const actions = <>{query && <Button onClick={() => {
    const next = new URLSearchParams(params);
    next.delete('q'); next.delete('offset');
    setParams(next);
  }}>Clear search “{query}”</Button>}
    <Button icon="refresh" onClick={retry}>Refresh</Button></>;
  return <Card className="operations-records">
    {result?.status === 'error' && <ErrorState message={result.message} onRetry={retry} />}
    <FinancialAnalysisTable label="Payments" rows={rows} columns={columns} rowKey={r=>r.id}
      remote={{filters,sort,total:data?.totalCount ?? 0,matching:data?.matchingCount ?? 0,busy:!result || result.status==='error',onCriteria:changeCriteria}}
      actions={actions} summary={data ? () => <><PaymentTotalsSummary {...data.directionTotalsRwf} missing={data.missing} />
        <p>Payment totals as of <time dateTime={data.asOf}>{paymentTime(data.asOf)} (Kigali)</time>.</p></> : undefined}
      pageSize={25} page={page} onPageChange={changePage} expanded={selected && detail ? {key:selected,content:detail} : null} />
    {selected && result && !rows.some(r=>r.id===selected) && detail}
  </Card>;
}

function PaymentDetail({id: paymentKey, group, onClose, onUpdated}: {id: string; group?: string; onClose: () => void; onUpdated: () => void}) {
  const {epoch, request, user} = useSession();
  const load = useCallback(async (signal: AbortSignal) => {
    const payment = buriMunsiPayment.parse(await request('burimunsi/payments/'+paymentKey, {signal}));
    if (payment.id !== paymentKey || group && payment.groupId !== group) throw new Error('The payment changed.');
    return payment;
  }, [group, paymentKey, request]);
  const {result, retry} = useOperationRead(JSON.stringify([epoch, group, paymentKey]), true, load);
  const payment = result?.status === 'success' ? result.value : null;
  const evidenceGroup = payment?.groupId ?? group;
  return <section aria-label="Payment details"><div className="operations-toolbar"><h2>Payment details</h2><Button onClick={onClose}>Close</Button></div>
    {!result ? <LoadingState label="Loading payment" /> : result.status === 'error' ? <ErrorState message={result.message} onRetry={retry} /> :
      payment && <><Facts items={[[ 'FT reference', payment.ftId ], ['Direction', directionLabel(payment.direction)], ['Amount', amount(payment.amountRwf)],
        ['Time (Kigali)', paymentTime(payment.atRaw)], ['Counterparty', recordedText(payment.payerNameRaw)], ['Counterparty number / code', recordedText(payment.payerPhoneRaw)],
        ['Member', payment.memberName], ['Member phone', recordedText(payment.memberPhone)], ['Allocation', allocationLabel(payment.state)], ['Record ID', payment.id]]} />
        {payment.sourceId && canReadSmsEvidence(user) && (evidenceGroup
          ? <CanonicalPaymentEvidence key={payment.sourceId} group={evidenceGroup} sourceId={payment.sourceId} />
          : <Link className="operations-link" to={buriMunsiSmsPath}>Open M-Money SMS</Link>)}
        {user && payment.groupId && payment.canAllocate === true &&
          <AllocatePayment key={JSON.stringify([epoch, user.id, user.sessionId, user.role, [...user.permissions].sort(), payment.groupId, payment.id, payment.version])}
            user={user} group={payment.groupId} payment={payment} onUpdated={() => {retry(); onUpdated();}} />}
      </>}
  </section>;
}

function AllocatePayment({payment, group, user, onUpdated}: {payment: BuriMunsiPayment; group: string; user: AdminUser; onUpdated: () => void}) {
  const session = useSession(), {epoch, request} = session;
  const identity = usePendingIdentity(user);
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(''), [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false), [canRetry, setCanRetry] = useState(false);
  const [pending, setPending] = useState<PendingAttempt | null | undefined>(undefined);
  const sending = useRef(false), mounted = useRef(false);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const current = () => mounted.current && session.isCurrentAuthority(epoch, user.id, user.sessionId);
  const loadOriginal = useCallback(async () => {
    const resource = await sha256Text(JSON.stringify([group, payment.id]));
    const attempt = await readPending(identity, allocationFamily, resource);
    if (attempt) {
      retainedAllocation.parse(attempt.intent);
      if (attempt.permission !== allocationPermission || !z.uuid().safeParse(attempt.request_key).success) throw new Error('Invalid original request.');
    }
    return {resource, attempt};
  }, [group, identity, payment.id]);
  const recovery = useOperationRead(JSON.stringify([epoch, group, payment.id, identity]), true, loadOriginal,
    {invalidResponse:'The original allocation reference could not be checked. No allocation was sent.'});
  const original = pending === undefined && recovery.result?.status === 'success' ? recovery.result.value.attempt : pending;
  const canChoose = recovery.result?.status === 'success' && original === null && payment.state === 'unallocated';
  const load = useCallback(async (signal: AbortSignal) => membersPage.parse(await request(
    `burimunsi/payments/members?${new URLSearchParams({q: query, limit: '25'})}`, {signal})), [query, request]);
  const {result, retry} = useOperationRead(JSON.stringify([epoch, group, query]), canChoose, load);

  async function checkRequest() {
    if (!original || sending.current || !current()) return;
    const intent = retainedAllocation.parse(original.intent);
    sending.current = true; setBusy(true); setCanRetry(false); setMessage('');
    try {
      const response = allocationReceipt.parse(await request(`burimunsi/payments/${payment.id}/allocation-receipt`, {idempotencyKey:original.request_key}));
      if (!current()) return;
      if (response.requestId !== original.request_key) throw new Error('Request reference changed.');
      if (response.state === 'committed') {
        const receipt = response.receipt;
        if (receipt.paymentId !== payment.id || receipt.memberId !== intent.memberId || receipt.version !== intent.expectedVersion + 1) {
          throw new Error('Allocation receipt changed.');
        }
        await clearOriginalAttempt(identity, original, current);
        if (current()) {setPending(null); onUpdated();}
        return;
      }
      const latest = buriMunsiPayment.parse(await request(`burimunsi/payments/${payment.id}`));
      if (!current()) return;
      if (latest.id !== payment.id || latest.groupId !== group || latest.canAllocate !== true) throw new Error('Payment scope changed.');
      if (latest.state === 'unallocated' && latest.version === intent.expectedVersion && payment.version === latest.version) {
        setCanRetry(true);
        setMessage('No completed request was found and the payment is still unallocated. You can retry the original request.');
      } else {
        setMessage('The payment has changed. This does not confirm the original request. Keep its reference and do not submit another allocation.');
      }
    } catch {
      if (current()) setMessage('The original request could not be checked. Keep its reference and check again.');
    } finally {sending.current = false; if (current()) setBusy(false);}
  }

  async function allocate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || !current() || recovery.result?.status !== 'success' || (!original && !selected) || (original && !canRetry)) return;
    const intent = original ? retainedAllocation.parse(original.intent) : {memberId:selected, expectedVersion:payment.version};
    if (payment.state !== 'unallocated' || payment.version !== intent.expectedVersion) return;
    sending.current = true; setBusy(true); setCanRetry(false); setMessage('');
    let attempt = original, sent = false;
    try {
      attempt = await retainPending(identity, allocationFamily, recovery.result.value.resource, original?.request_key ?? crypto.randomUUID(), allocationPermission, intent, undefined, undefined, current);
      if (!current()) return;
      setPending(attempt); sent = true;
      const receipt = allocated.parse(await request(`burimunsi/payments/${payment.id}/allocate`, {
        method: 'POST', body: intent, idempotencyKey: attempt.request_key,
      }));
      if (receipt.paymentId !== payment.id || receipt.memberId !== intent.memberId || receipt.version !== intent.expectedVersion + 1) {
        throw new Error('The allocation response changed.');
      }
      if (!current()) return;
      await clearOriginalAttempt(identity, attempt, current);
      if (current()) {setPending(null); onUpdated();}
    } catch (error) {
      if (current()) {
        const rejected = error instanceof AdminRequestError && !error.outcomeUnknown && error.statusCode === 409 &&
          (error.code === 'member_unavailable' || error.code === 'payment_changed');
        if (!original && attempt && sent && rejected) {
          try {
            await clearOriginalAttempt(identity, attempt, current);
            if (current()) {
              setPending(null); if (error.code === 'payment_changed') onUpdated();
              setMessage(error instanceof Error ? error.message : 'Allocation was rejected.');
            }
          } catch {if (current()) setMessage('The original reference remains. Check the payment before continuing.');}
        } else if (sent) setMessage('Allocation was not confirmed. Check the original request before trying again.');
        else setMessage('The original request reference could not be saved. No allocation was sent.');
      }
    } finally {sending.current = false; if (current()) setBusy(false);}
  }
  if (!recovery.result) return <LoadingState label="Checking allocation reference" />;
  if (recovery.result.status === 'error') return <ErrorState message={recovery.result.message} onRetry={recovery.retry} />;
  if (original) return <section className="momo-assignment" aria-label="Original allocation request">
    <h3>Original allocation request</h3><p>Request <code>{original.request_key}</code></p>
    <Button onClick={() => void checkRequest()} disabled={busy}>Check request</Button>
    {canRetry && <form onSubmit={allocate}><Button type="submit" variant="primary" disabled={busy}>Retry allocation</Button></form>}
    {message && <p role="status">{message}</p>}
  </section>;
  if (!canChoose) return null;
  const members = result?.status === 'success' ? result.value.items : [];
  return <section className="momo-assignment" aria-label="Allocate to member"><h3>Allocate to member</h3>
    <form className="operations-search" onSubmit={event => {
      event.preventDefault();
      const next = String(new FormData(event.currentTarget).get('member') ?? '').trim().slice(0, maxSearchLength);
      setSelected(''); setQuery(next);
    }}><Field label="Search group members" htmlFor="buri-allocation-search">
      <input id="buri-allocation-search" name="member" className="admin-input" maxLength={maxSearchLength} disabled={busy} />
    </Field><Button type="submit" disabled={busy}>Search</Button></form>
    {!result ? <LoadingState label="Loading group members" /> : result.status === 'error' ? <ErrorState message={result.message} onRetry={retry} /> :
      members.length ? <form className="operations-action-form" onSubmit={allocate}><Field label="Member" htmlFor="buri-allocation-member">
        <select id="buri-allocation-member" className="admin-input" value={selected} onChange={event => setSelected(event.target.value)}
          required disabled={busy}><option value="">Choose a member</option>
          {members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select></Field><Button type="submit" variant="primary" disabled={!selected || busy}>Allocate</Button></form> :
        <EmptyState title="No group members found" />}
    {message && <p role="status">{message}</p>}
  </section>;
}
