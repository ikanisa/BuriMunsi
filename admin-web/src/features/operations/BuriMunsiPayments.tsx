import {useCallback, useState} from 'react';
import {Link, useLocation, useNavigate, useSearchParams} from 'react-router';
import {AdminRequestError} from '../../api/client';
import {useSession} from '../../session/SessionProvider';
import {canDisplaySessionRecords, canReadSmsEvidence} from '../../session/sessionContext';
import {CompactText, Button, Card, ErrorState, LoadingState, PageHeader} from '../../ui';
import {Facts} from './OperationsRecords';
import {ReceiverSmsPanel} from './ReceiverSmsPanel';
import {CanonicalPaymentEvidence} from './CanonicalPaymentEvidence';
import {PaymentAllocationWizard} from './PaymentAllocationWizard';
import {FinancialAnalysisTable, type FinancialColumn} from './FinancialAnalysisTable';
import {PaymentTotalsSummary} from './PaymentFlowTotals';
import {AllocationStatus, PaymentDirection, buriMunsiPaymentsPath, buriMunsiSmsPath, paymentAmount, recordedText} from './BuriMunsiPaymentRows';
import {initialColumnFilters, type ColumnFilter, type FinancialSort} from './financialAnalysisModel';
import {type PaymentAnalysisQuery} from '../../../../supabase/functions/_shared/domain/burimunsi/payment-analysis-shared.mjs';
import {buriMunsiPayment, paymentAllocation, paymentCounterpartyEvidence, paymentDirection, paymentId, paymentInstant, paymentMemberName, paymentMemberNumber, paymentTime, readCanonicalPaymentAnalysis, type BuriMunsiPayment} from './canonicalPaymentAnalysis';
import {useOperationRead, type OperationReadState} from './useOperationRead';

const maxSearchLength = 80;
const amountFormat = new Intl.NumberFormat('en-RW');

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
    else { next.set('view', 'sms'); next.delete('payment'); next.delete('allocate'); }
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
  const {epoch, request, status, user} = useSession(), [params, setParams] = useSearchParams();
  const location = useLocation(), navigate = useNavigate();
  const [confirmation, setConfirmation] = useState(''), [detailRevision, setDetailRevision] = useState(0);
  const [allocationRevision, setAllocationRevision] = useState(0);
  const canReadSms = canReadSmsEvidence(user), group = user?.adminIdentity?.collectionId;
  const allocating = params.getAll('allocate').length === 1 ? paymentId.safeParse(params.get('allocate')).data : undefined;
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
  const {result, retry, refreshing} = useOperationRead(JSON.stringify([epoch, group, canReadSms, payload, allocationRevision]), true, load,
    {retainDuringRefresh:true, invalidResponse:'Matching payments and totals could not be confirmed. Please refresh.'});
  const data = result?.status === 'success' ? result.value : null;
  const rows = data?.items ?? [];
  const scopedGroup = group ?? rows[0]?.groupId;
  const prefetchStaff = !group && user?.role === 'staff' && user.authMethod === 'phone_passcode';
  const detailScopeConfirmed = !!group || result?.status === 'success' || !prefetchStaff && !!result;
  const detailRead = usePaymentDetail(selected, {
    requestGroup: prefetchStaff ? undefined : scopedGroup,
    expectedGroup: scopedGroup,
    start: detailScopeConfirmed || prefetchStaff && status === 'authenticated' && !result,
    publish: detailScopeConfirmed,
    seenVersion: rows.find(row => row.id === selected)?.version,
    listContext: JSON.stringify([payload, detailRevision, allocationRevision]),
  });
  const refresh = () => {
    retry();
    if (selected) setDetailRevision(value => value + 1);
  };
  function changeCriteria(nextFilters:ReadonlyMap<string,ColumnFilter>,nextSort:FinancialSort) {
    setFilters(nextFilters); setSort(nextSort);
    if (page > 1) {setResettingOffset(true); changePage(1);}
  }
  function closeAllocation() {
    if (location.state?.allocationReturn === allocating) navigate(-1);
    else {const next = new URLSearchParams(params); next.delete('allocate'); setParams(next, {replace:true, preventScrollReset:true});}
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
    return <button type="button" className="operations-link" aria-expanded={selected === row.id} onClick={() => show(row.id)}><CompactText cell>{name}</CompactText></button>;
  }
  const columns: FinancialColumn<BuriMunsiPayment>[] = [
    {key:'reference',label:'FT reference',kind:'text',value:r=>recordedText(r.ftId),render:r=>rowButton(r, recordedText(r.ftId) ?? 'View payment')},
    {key:'time',label:'Time',kind:'date',value:r=>paymentInstant(r.atRaw),render:r=>paymentTime(r.atRaw)},
    {key:'amount',label:'Amount',kind:'number',align:'end',value:r=>r.amountRwf,render:r=>r.amountRwf === null ? '—' :
      <span className="payment-flow-amount" data-payment-flow={r.direction}>{amountFormat.format(r.amountRwf)}</span>},
    {key:'direction',label:'IN/OUT',kind:'category',value:r=>r.direction,render:r=><PaymentDirection direction={r.direction} />,
      options:[{value:'incoming',label:'Incoming'},{value:'outgoing',label:'Outgoing'}]},
    {key:'allocation',label:'Allocation',kind:'category',value:r=>r.state,render:r=><AllocationStatus row={r} search={params} />,
      options:[{value:'allocated',label:'Allocated'},{value:'unallocated',label:'Unallocated'}]},
    {key:'memberName',label:'Member',kind:'text',value:paymentMemberName},
    {key:'memberNumber',label:'Member phone',kind:'text',value:paymentMemberNumber},
  ];
  if (canReadSms) columns.push({key:'sms',label:'SMS evidence',kind:'category',value:r=>r.sourceId ? 'linked' : 'none',
    options:[{value:'linked',label:'Linked'},{value:'none',label:'None linked'}],render:r=>r.sourceId ? rowButton(r,'Review linked SMS') : 'None linked'});
  const detail = selected && detailScopeConfirmed ? <PaymentDetail key={selected} group={scopedGroup} {...detailRead}
    search={params} onClose={() => show()} /> : null;
  const actions = <>{query && <Button onClick={() => {
    const next = new URLSearchParams(params);
    next.delete('q'); next.delete('offset');
    setParams(next);
  }}>Clear search “{query}”</Button>}
    <Button icon="refresh" onClick={refresh} loading={!result || refreshing}>Refresh</Button></>;
  return <Card className="operations-records">
    {confirmation && !allocating && <p className="operations-note" role="status">{confirmation}</p>}
    <FinancialAnalysisTable label="Payments" rows={rows} columns={columns} rowKey={r=>r.id}
      remote={{filters,sort,total:data?.totalCount ?? null,matching:data?.matchingCount ?? null,refreshing,onCriteria:changeCriteria,
        error:result?.status === 'error' ? <ErrorState message={result.message} onRetry={refresh} /> : undefined}}
      actions={actions} summary={data ? () => <><PaymentTotalsSummary {...data.directionTotalsRwf} missing={data.missing} />
        <p>Payment totals as of <time dateTime={data.asOf}>{paymentTime(data.asOf)} (Kigali)</time>.</p></> : undefined}
      pageSize={25} page={page} onPageChange={changePage} expanded={selected && detail ? {key:selected,content:detail} : null} />
    {selected && result && !rows.some(r=>r.id===selected) && detail}
    {allocating && <PaymentAllocationWizard key={JSON.stringify([epoch,scopedGroup,allocating])} id={allocating} group={scopedGroup}
      onClose={closeAllocation} onStale={() => setAllocationRevision(value => value + 1)} onAllocated={() => {
        setConfirmation('Payment allocated.'); closeAllocation(); setAllocationRevision(value => value + 1);
      }} />}
  </Card>;
}

function usePaymentDetail(paymentKey: string | undefined,
  {requestGroup, expectedGroup, start, publish, seenVersion, listContext}: {
    requestGroup?: string; expectedGroup?: string; start: boolean; publish: boolean; seenVersion?: number; listContext: string;
  }) {
  const {epoch, request} = useSession();
  const load = useCallback(async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const response = await request('burimunsi/payments/'+paymentKey, {signal});
    signal.throwIfAborted();
    const payment = buriMunsiPayment.parse(response);
    if (payment.id !== paymentKey || requestGroup && payment.groupId !== requestGroup) throw new Error('The payment changed.');
    return payment;
  }, [requestGroup, paymentKey, request]);
  // The server binds the GET to the current session. Staff wait for analysis
  // before publishing it, without restarting the GET when the list proves scope.
  const selection = JSON.stringify([epoch, requestGroup, paymentKey, listContext]);
  const [visit, setVisit] = useState({selection, index: 0});
  if (visit.selection !== selection) setVisit({selection, index: visit.index + 1});
  const scope = JSON.stringify([selection, visit.index]);
  const first = useOperationRead(scope, start && !!paymentKey, load);
  function qualified(result: OperationReadState<BuriMunsiPayment> | null): OperationReadState<BuriMunsiPayment> | null {
    if (!publish) return null;
    if (result?.status === 'success' && expectedGroup && result.value.groupId !== expectedGroup) {
      return {status:'error',key:scope,message:'The workspace response could not be verified.'};
    }
    return result;
  }
  const olderThanList = (result: OperationReadState<BuriMunsiPayment> | null) =>
    result?.status === 'success' && seenVersion !== undefined && result.value.version < seenVersion;
  // Only an older, verified-scope response needs a second GET against the current list version.
  const firstResult = qualified(first.result), outdated = olderThanList(firstResult);
  const newer = useOperationRead(JSON.stringify([scope, seenVersion]), outdated, load);
  const result = outdated ? qualified(newer.result) : firstResult;
  const retry = outdated ? newer.retry : first.retry;
  if (olderThanList(result)) {
    return {result:{status:'error' as const,key:scope,message:'The payment changed. Refresh to verify its details.'},retry};
  }
  return {result,retry};
}

function PaymentDetail({group, search, onClose, result, retry}: {group?: string; search: URLSearchParams; onClose: () => void;
  result: OperationReadState<BuriMunsiPayment> | null; retry: () => void}) {
  const {user} = useSession();
  const payment = result?.status === 'success' ? result.value : null;
  const evidenceGroup = payment?.groupId ?? group;
  const recordedParty = payment ? paymentCounterpartyEvidence(payment) : null;
  const member = payment && paymentMemberName(payment);
  const memberPhone = payment && paymentMemberNumber(payment);
  return <section className={'payment-detail' + (payment ? ' admin-content-enter' : '')} aria-label="Payment details">
    <header className="payment-detail-heading">
      <h2>{recordedText(payment?.ftId) ?? 'Payment details'}</h2>
      <div>{payment && <AllocationStatus row={payment} search={search} text />}<Button onClick={onClose}>Close</Button></div>
    </header>
    {!result ? <LoadingState label="Loading payment" layout="details" /> : result.status === 'error' ? <ErrorState message={result.message} onRetry={retry} /> :
      payment && <><Facts items={[['Amount', paymentAmount(payment.amountRwf)], ['IN/OUT', <PaymentDirection direction={payment.direction} />],
        ['Time', paymentTime(payment.atRaw)],
        ...(member ? [['Member', member] as [string,string]] : []),
        ...(memberPhone ? [['Member phone', memberPhone] as [string,string]] : [])]} />
        {(recordedParty?.name || recordedParty?.number) && <details className="payment-detail-disclosure">
          <summary>Recorded counterparty details</summary><Facts items={[
            ...(recordedParty.name ? [['Name', recordedParty.name] as [string,string]] : []),
            ...(recordedParty.number ? [['Number or code', recordedParty.number] as [string,string]] : []),
          ]} />
        </details>}
        {payment.sourceId && canReadSmsEvidence(user) && (evidenceGroup
          ? <CanonicalPaymentEvidence key={payment.sourceId} paymentId={payment.id} group={evidenceGroup} sourceId={payment.sourceId} />
          : <Link className="operations-link" to={buriMunsiSmsPath}>Open M-Money SMS</Link>)}
        {user && payment.groupId && payment.state === 'allocated' && payment.canAllocate === true && <Link className="operations-link"
          to={buriMunsiPaymentsPath + '?' + new URLSearchParams({...Object.fromEntries(search),allocate:payment.id})}
          state={{allocationReturn:payment.id}} preventScrollReset aria-haspopup="dialog">
          Review allocation request</Link>}
      </>}
  </section>;
}
