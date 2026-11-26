import {useCallback, useMemo, useState} from 'react';
import {Link, useLocation, useNavigate, useSearchParams} from 'react-router';
import {useSession} from '../../session/SessionProvider';
import {canDisplaySessionRecords, canReadSmsEvidence} from '../../session/sessionContext';
import {Button, Card, EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge} from '../../ui';
import {MomoCell, MomoTable} from './MomoRecordViews';
import {Facts} from './OperationsRecords';
import {ReceiverSmsPanel} from './ReceiverSmsPanel';
import {CanonicalPaymentEvidence} from './CanonicalPaymentEvidence';
import {PaymentAllocationWizard} from './PaymentAllocationWizard';
import {FinancialAnalysisTable, type FinancialColumn} from './FinancialAnalysisTable';
import {PaymentFlowTotals} from './PaymentFlowTotals';
import {buriMunsiPayment, paymentAllocation, paymentDirection, paymentId, paymentInstant, paymentTime, paymentMemberName, paymentMemberNumber, paymentCounterpartyEvidence, readAllCanonicalPayments, type BuriMunsiPayment} from './canonicalPaymentAnalysis';
import {useOperationRead} from './useOperationRead';
import './operations.css';
import './paymentsWorkspace.css';

export {buriMunsiPayment};
export type {BuriMunsiPayment};
const maxSearchLength = 80;
const amountFormat = new Intl.NumberFormat('en-RW');
const amount = (value: number | null) => value === null ? '—' : 'RWF ' + amountFormat.format(value);
const allocationLabel = (state: BuriMunsiPayment['state']) => state === 'allocated' ? 'Allocated' : 'Unallocated';
const directionLabel = (value: BuriMunsiPayment['direction']) => value === 'incoming' ? 'Incoming' : 'Outgoing';
const recordedText = (value: string | null | undefined) => value?.trim() ? value : null;
export const buriMunsiPaymentsPath = '/admin/payments';
export const buriMunsiSmsPath = buriMunsiPaymentsPath + '?view=sms';
export const buriMunsiPaymentPath = (id: string) => buriMunsiPaymentsPath + '?' + new URLSearchParams({payment: id});

function AllocationStatus({row, search}: {row: BuriMunsiPayment; search?: URLSearchParams}) {
  const badge = <StatusBadge tone={row.state === 'allocated' ? 'success' : 'warning'}>{allocationLabel(row.state)}</StatusBadge>;
  if (row.state !== 'unallocated' || row.canAllocate !== true) return badge;
  const next = new URLSearchParams(search);
  next.set('allocate', row.id);
  next.delete('view');
  next.delete('source');
  return <Link className="payment-allocation-link" to={buriMunsiPaymentsPath + '?' + next}
    state={{allocationReturn: row.id}} preventScrollReset aria-haspopup="dialog"
    aria-label={'Unallocated – allocate payment ' + (recordedText(row.ftId) ?? row.id)}>{badge}</Link>;
}

export function BuriMunsiPaymentRows({rows, onSelect}: {rows: BuriMunsiPayment[]; onSelect?: (paymentId: string) => void}) {
  return <MomoTable name="Payments" headings={['Reference', 'Direction', 'Amount', 'Member', 'Status', 'Payment time']} compact>
    {rows.map(row => <tr key={row.id}><MomoCell label="Reference">{onSelect
      ? <button type="button" className="operations-link" onClick={() => onSelect(row.id)}>{row.ftId ?? 'View payment'}</button>
      : <Link className="operations-link" to={buriMunsiPaymentPath(row.id)}>{row.ftId ?? 'View payment'}</Link>}</MomoCell>
      <MomoCell label="Direction">{directionLabel(row.direction)}</MomoCell><MomoCell label="Amount">{amount(row.amountRwf)}</MomoCell>
      <MomoCell label="Member">{paymentMemberName(row) ?? '—'}</MomoCell><MomoCell label="Status"><AllocationStatus row={row} /></MomoCell>
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
  const location = useLocation(), navigate = useNavigate();
  const [confirmation, setConfirmation] = useState('');
  const canReadSms = canReadSmsEvidence(user), group = user?.adminIdentity?.collectionId;
  const allocating = params.getAll('allocate').length === 1 ? paymentId.safeParse(params.get('allocate')).data : undefined;
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
    {retainDuringRefresh: true, invalidResponse:'The complete payment list could not be confirmed. Please refresh.'});
  const rows = result?.status === 'success' ? result.value : undefined;
  const scopedGroup = group ?? rows?.[0]?.groupId;
  const instants = useMemo(() => new Map(rows?.map(row => [row.id, paymentInstant(row.atRaw)])), [rows]);
  function closeAllocation() {
    if (location.state?.allocationReturn === allocating) {
      navigate(-1);
    } else {
      const next = new URLSearchParams(params);
      next.delete('allocate');
      setParams(next, {replace: true, preventScrollReset: true});
    }
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
    {key:'time',label:'Time (Kigali)',kind:'date',value:r=>instants.get(r.id) ?? null,render:r=>paymentTime(r.atRaw)},
    {key:'amount',label:'Amount (RWF)',kind:'number',align:'end',value:r=>r.amountRwf,render:r=>r.amountRwf === null ? '—' : amountFormat.format(r.amountRwf)},
    {key:'direction',label:'Direction',kind:'category',value:r=>r.direction,render:r=>directionLabel(r.direction),
      options:[{value:'incoming',label:'Incoming'},{value:'outgoing',label:'Outgoing'}]},
    {key:'allocation',label:'Allocation',kind:'category',value:r=>r.state,render:r=><AllocationStatus row={r} search={params} />,
      options:[{value:'allocated',label:'Allocated'},{value:'unallocated',label:'Unallocated'}]},
    {key:'member',label:'Member',kind:'text',value:paymentMemberName},
    {key:'memberNumber',label:'Member number',kind:'text',value:paymentMemberNumber},
  ];
  if (canReadSms) columns.push({key:'sms',label:'SMS evidence',kind:'category',value:r=>r.sourceId ? 'linked' : 'none',
    options:[{value:'linked',label:'Linked'},{value:'none',label:'None linked'}],render:r=>r.sourceId ? rowButton(r,'Review linked SMS') : 'None linked'});
  const selectedVersion = selected ? rows?.find(row => row.id === selected)?.version : undefined;
  const detail = selected ? <PaymentDetail key={selected + '/' + selectedVersion} id={selected} group={scopedGroup}
    search={params} onClose={() => show()} /> : null;
  const actions = <>{query && <Button onClick={() => {
    const next = new URLSearchParams(params);
    next.delete('q'); next.delete('offset');
    setParams(next);
  }}>Clear search “{query}”</Button>}
    <Button icon="refresh" onClick={retry}>Refresh</Button></>;
  return <Card className="operations-records">
    {confirmation && !allocating && <p className="operations-note" role="status">{confirmation}</p>}
    {result && !rows?.length && <div className="operations-toolbar">{actions}</div>}
    {!result ? <LoadingState label="Loading payments" /> : result.status === 'error' ? <ErrorState message={result.message} onRetry={retry} /> :
      rows?.length ? <FinancialAnalysisTable key={JSON.stringify([group, query, allocation, direction])} label="Payments" rows={rows}
        columns={columns} rowKey={r=>r.id} initialSort={{key:'time',direction:'desc'}} initialFilters={initialFilters}
        actions={actions} summary={matching => <PaymentFlowTotals rows={matching} />} pageSize={25} page={page} onPageChange={changePage}
        expanded={selected && detail ? {key:selected,content:detail} : null} /> : <EmptyState title="No payments found" />}
    {selected && rows && !rows.some(r=>r.id===selected) && detail}
    {allocating && (group || rows) && <PaymentAllocationWizard key={JSON.stringify([epoch, scopedGroup, allocating])}
      id={allocating} group={scopedGroup} onClose={closeAllocation} onStale={retry}
      onAllocated={() => {setConfirmation('Payment allocated.'); closeAllocation(); retry();}} />}
  </Card>;
}

function PaymentDetail({id: paymentKey, group, search, onClose}: {id: string; group?: string; search: URLSearchParams; onClose: () => void}) {
  const {epoch, request, user} = useSession();
  const load = useCallback(async (signal: AbortSignal) => {
    const payment = buriMunsiPayment.parse(await request('burimunsi/payments/'+paymentKey, {signal}));
    if (payment.id !== paymentKey || group && payment.groupId !== group) throw new Error('The payment changed.');
    return payment;
  }, [group, paymentKey, request]);
  const {result, retry} = useOperationRead(JSON.stringify([epoch, group, paymentKey]), true, load);
  const payment = result?.status === 'success' ? result.value : null;
  const evidenceGroup = payment?.groupId ?? group;
  const counterparty = payment && paymentCounterpartyEvidence(payment);
  const recordedParty: [string, string][] = [];
  if (counterparty?.name) recordedParty.push(['Recorded counterparty', counterparty.name]);
  if (counterparty?.number) recordedParty.push(['Recorded number / code', counterparty.number]);
  return <section aria-label="Payment details"><div className="operations-toolbar"><h2>Payment details</h2><Button onClick={onClose}>Close</Button></div>
    {!result ? <LoadingState label="Loading payment" /> : result.status === 'error' ? <ErrorState message={result.message} onRetry={retry} /> :
      payment && <><Facts items={[[ 'FT reference', payment.ftId ], ['Direction', directionLabel(payment.direction)], ['Amount', amount(payment.amountRwf)],
        ['Time (Kigali)', paymentTime(payment.atRaw)], ['Member', paymentMemberName(payment)], ['Member number', paymentMemberNumber(payment)],
        ...recordedParty, ['Allocation', <AllocationStatus row={payment} search={search} />], ['Record ID', payment.id]]} />
        {payment.sourceId && canReadSmsEvidence(user) && (evidenceGroup
          ? <CanonicalPaymentEvidence key={payment.sourceId} group={evidenceGroup} sourceId={payment.sourceId} />
          : <Link className="operations-link" to={buriMunsiSmsPath}>Open M-Money SMS</Link>)}
      </>}
  </section>;
}
