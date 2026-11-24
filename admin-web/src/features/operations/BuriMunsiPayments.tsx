import {useCallback, useMemo, useRef, useState, type FormEvent} from 'react';
import {Link, useSearchParams} from 'react-router';
import {z} from 'zod';
import {AdminRequestError} from '../../api/client';
import {useSession} from '../../session/SessionProvider';
import {canDisplaySessionRecords, canReadSmsEvidence} from '../../session/sessionContext';
import {Button, Card, EmptyState, ErrorState, Field, LoadingState, PageHeader, StatusBadge} from '../../ui';
import {MomoCell, MomoTable} from './MomoRecordViews';
import {Facts} from './OperationsRecords';
import {ReceiverSmsPanel} from './ReceiverSmsPanel';
import {CanonicalPaymentEvidence} from './CanonicalPaymentEvidence';
import {FinancialAnalysisTable, type FinancialColumn} from './FinancialAnalysisTable';
import {PaymentFlowTotals} from './PaymentFlowTotals';
import {buriMunsiPayment, paymentAllocation, paymentDirection, paymentId, paymentInstant, paymentTime, readAllCanonicalPayments, type BuriMunsiPayment} from './canonicalPaymentAnalysis';
import {useOperationRead} from './useOperationRead';
import './operations.css';
import './paymentsWorkspace.css';

export {buriMunsiPayment};
export type {BuriMunsiPayment};
const membersPage = z.object({items: z.array(z.object({id: paymentId, name: z.string().min(1)})).max(25)});
const allocated = z.object({paymentId, memberId: paymentId, state: z.literal('allocated'), version: z.number().int().positive()});
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
  const {epoch, request, user} = useSession(), [params, setParams] = useSearchParams();
  const canReadSms = canReadSmsEvidence(user), group = user?.adminIdentity?.collectionId;
  const selected = params.get('view') === 'sms' ? undefined : paymentId.safeParse(params.get('payment')).data;
  const query = (params.get('q') ?? '').trim().slice(0, maxSearchLength);
  const allocation = paymentAllocation.safeParse(params.get('status')).data, direction = paymentDirection.safeParse(params.get('direction')).data;
  const offsetText = params.get('offset') ?? '0';
  const offset = /^\d{1,6}$/.test(offsetText) ? Number(offsetText) : 0;
  const page = offset <= 100_000 && offset % 25 === 0 ? offset / 25 + 1 : 1;
  const initialFilters: Record<string,string> = {};
  if (allocation) initialFilters.allocation = allocation;
  if (direction) initialFilters.direction = direction;
  const load = useCallback((signal: AbortSignal) => readAllCanonicalPayments(request, signal, query, group), [group, query, request]);
  const {result, retry} = useOperationRead(JSON.stringify([epoch, group, 'payments', query]), true, load,
    {invalidResponse:'The complete payment list could not be confirmed. Please refresh.'});
  const rows = result?.status === 'success' ? result.value : undefined;
  const instants = useMemo(() => new Map(rows?.map(row => [row.id, paymentInstant(row.atRaw)])), [rows]);
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
    {key:'time',label:'Time (Kigali)',kind:'date',value:r=>instants.get(r.id) ?? null,render:r=>paymentTime(r.atRaw)},
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
    {result && !rows?.length && <div className="operations-toolbar">{actions}</div>}
    {!result ? <LoadingState label="Loading payments" /> : result.status === 'error' ? <ErrorState message={result.message} onRetry={retry} /> :
      rows?.length ? <FinancialAnalysisTable key={JSON.stringify([group, query, allocation, direction])} label="Payments" rows={rows}
        columns={columns} rowKey={r=>r.id} initialSort={{key:'time',direction:'desc'}} initialFilters={initialFilters}
        actions={actions} summary={matching => <PaymentFlowTotals rows={matching} />} pageSize={25} page={page} onPageChange={changePage}
        expanded={selected && detail ? {key:selected,content:detail} : null} /> : <EmptyState title="No payments found" />}
    {selected && rows && !rows.some(r=>r.id===selected) && detail}
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
        {payment.state === 'unallocated' && payment.canAllocate === true &&
          <AllocatePayment key={payment.version} payment={payment} onUpdated={() => {retry(); onUpdated();}} />}
      </>}
  </section>;
}

function AllocatePayment({payment, onUpdated}: {payment: BuriMunsiPayment; onUpdated: () => void}) {
  const session = useSession(), {epoch, request, user} = session;
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(''), [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{memberId: string; key: string} | null>(null);
  const sending = useRef(false);
  const load = useCallback(async (signal: AbortSignal) => membersPage.parse(await request(
    `burimunsi/payments/members?${new URLSearchParams({q: query, limit: '25'})}`, {signal})), [query, request]);
  const {result, retry} = useOperationRead(`${epoch}:allocate-member:${query}`, true, load);
  async function allocate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || !user || !selected || !session.isCurrentAuthority(epoch, user.id, user.sessionId)) return;
    const saved = pending;
    if (saved && saved.memberId !== selected) return;
    const intent = saved ?? {memberId: selected, key: crypto.randomUUID()};
    setPending(intent);
    const current = () => session.isCurrentAuthority(epoch, user.id, user.sessionId);
    sending.current = true;
    setBusy(true);
    setMessage('');
    try {
      const receipt = allocated.parse(await request(`burimunsi/payments/${payment.id}/allocate`, {
        method: 'POST', body: {memberId: intent.memberId, expectedVersion: payment.version}, idempotencyKey: intent.key,
      }));
      if (receipt.paymentId !== payment.id || receipt.memberId !== intent.memberId || receipt.version !== payment.version + 1) {
        throw new Error('The allocation response changed.');
      }
      if (current()) onUpdated();
    } catch (error) {
      if (current()) {
        if (error instanceof AdminRequestError && !error.outcomeUnknown) {
          setPending(null);
          if (error.statusCode === 409) onUpdated();
          setMessage(error.message);
        } else setMessage('Allocation was not confirmed. Retry this allocation or reopen the payment to check its status.');
      }
    } finally {
      sending.current = false;
      if (current()) setBusy(false);
    }
  }
  const members = result?.status === 'success' ? result.value.items : [];
  return <section className="momo-assignment" aria-label="Allocate to member"><h3>Allocate to member</h3>
    <form className="operations-search" onSubmit={event => {
      event.preventDefault();
      const next = String(new FormData(event.currentTarget).get('member') ?? '').trim().slice(0, maxSearchLength);
      setSelected(''); setQuery(next);
    }}><Field label="Search group members" htmlFor="buri-allocation-search">
      <input id="buri-allocation-search" name="member" className="admin-input" maxLength={maxSearchLength} disabled={busy || pending !== null} />
    </Field><Button type="submit" disabled={busy || pending !== null}>Search</Button></form>
    {!result ? <LoadingState label="Loading group members" /> : result.status === 'error' ? <ErrorState message={result.message} onRetry={retry} /> :
      members.length ? <form className="operations-action-form" onSubmit={allocate}><Field label="Member" htmlFor="buri-allocation-member">
        <select id="buri-allocation-member" className="admin-input" value={selected} onChange={event => setSelected(event.target.value)}
          required disabled={busy || pending !== null}><option value="">Choose a member</option>
          {members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select></Field><Button type="submit" variant="primary" disabled={!selected || busy}>{pending ? 'Retry allocation' : 'Allocate'}</Button></form> :
        <EmptyState title="No group members found" />}
    {message && <p role="status">{message}</p>}
  </section>;
}
