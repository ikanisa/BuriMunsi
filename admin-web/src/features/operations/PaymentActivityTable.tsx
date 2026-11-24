import {Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent} from 'react';
import {Link, useSearchParams} from 'react-router';
import type {AdminRequest} from '../../api/client';
import {useSession} from '../../session/SessionProvider';
import type {AdminUser} from '../../session/sessionResponses';
import {canDisplaySessionRecords, canReadSmsEvidence} from '../../session/sessionContext';
import {Button, Card, EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge} from '../../ui';
import {receiptLabels, reasonLabels} from '../overview/smsOversightContract';
import {MomoPaymentDetail} from './MomoPaymentReview';
import {MomoCell, MomoTable, formatMomoAmount} from './MomoRecordViews';
import {MomoSourceRevealPanel} from './MomoSourceRevealPanel';
import {PaymentActivityFacts} from './PaymentActivityFacts';
import {formatStatus, formatTime, statusTone} from './OperationsRecords';
import {ACTIVITY_LIMIT, activityKey, activityQuery, parsePaymentActivity, type ActivityReceipt, type PaymentActivity} from './paymentActivity';
import {paymentsPath} from './paymentLocations';
import {processingLabels} from './receiverSmsContract';
import {useOperationRead} from './useOperationRead';

const kinds = {payment: 'Payment record', momo: 'MoMo transaction', receiver_sms: 'Receiver SMS', capture: 'App receipt'};
const scopes = {all: 'All payments', payments: 'Payment records', momo: 'MoMo transactions', sms: 'SMS and receipts',
  android: 'Receiver SMS', captures: 'App receipts', attention: 'Needs attention'};
const knownLabel = (map: Readonly<Record<string, string>>, value: string) => Object.hasOwn(map, value) ? map[value] : formatStatus(value);
const stateLabel = (row: Pick<PaymentActivity, 'kind' | 'status'>) => row.kind === 'receiver_sms'
  ? knownLabel(processingLabels, row.status) : formatStatus(row.status);
function useActivityPage(request: AdminRequest, access: Pick<AdminUser,'role'|'authMethod'|'permissions'> | null,
  path: string, offset: number, key: string) {
  const load = useCallback(async (signal: AbortSignal) => {
    if (!access || !path) throw new Error('Payments unavailable.');
    return parsePaymentActivity(await request(path, {signal}), offset, access);
  }, [access, request, path, offset]);
  return useOperationRead(key, !!access && !!path, load, {live: true, pollMs: 30_000, invalidResponse: 'The payment records could not be verified.'});
}
export function PaymentActivityTable() {
  const session = useSession(), [params, setParams] = useSearchParams();
  const {user, request} = session, allowed = !!user && canDisplaySessionRecords(session);
  const role = user?.role, authMethod = user?.authMethod, permissionKey = JSON.stringify(user?.permissions ?? []);
  const access = useMemo(() => role ? {role, authMethod, permissions: JSON.parse(permissionKey) as string[]} : null, [role, authMethod, permissionKey]);
  const query = allowed && access ? activityQuery(params, access) : null;
  const path = query?.path ?? '', offset = query?.offset ?? 0;
  const {result, retry} = useActivityPage(request, access, path, offset, JSON.stringify([session.epoch, user?.id, role, permissionKey, path]));
  const {scope = 'all', search = '', selected = ''} = query ?? {};
  const edit = (change: (next: URLSearchParams) => void, replace = false) => {
    const next = new URLSearchParams(params); change(next); setParams(next, {replace});
  };
  const page = (value: number) => edit(next => {
    next.delete('page'); next.delete('payment');
    if (value) next.set('offset', String(value)); else next.delete('offset');
  });
  const select = (id: string | null) => edit(next => {if (id) next.set('payment', id); else next.delete('payment');}, !id);
  const runSearch = (value: string) => edit(next => {
    next.delete('offset'); next.delete('page'); next.delete('payment');
    if (value) next.set('search', value); else next.delete('search');
  });
  const returnPath = paymentReturnPath(path, scope, offset);
  return <section className="payments-workspace payments-activity"><PageHeader title="Payments" />
    {!query || !user ? <><ErrorState title="This filter isn’t available" message="Your account cannot open the records requested by this link." />
      {allowed && user && activityQuery(new URLSearchParams(), user) && <Link className="operations-link" to={paymentsPath}>Show all payments</Link>}</> :
      <Card className="operations-records"><div className="operations-toolbar">
        <ActivitySearch key={search} current={search} apply={runSearch} />
        <Button icon="refresh" onClick={retry}>Refresh</Button>
        {scope !== 'all' || query.status || params.has('account') || params.has('group') || params.has('from') || params.has('to') ?
          <p className="payments-active-filter">{scope !== 'all' && scopes[scope]}{query.status && ` · ${formatStatus(query.status)}`} <Link to={paymentsPath}>Clear filters</Link></p> : null}
      </div>
        {!result ? <LoadingState label="Loading payments" /> : result.status === 'error' ?
          <ErrorState title="Payments unavailable" message={result.message} onRetry={retry} /> :
          <>{result.value.items.length ? <ActivityRows key={path} rows={result.value.items} returnPath={returnPath} selectMomo={select} /> :
            <EmptyState title="No payments found" description="No records match this page." />}
            {(result.value.total > ACTIVITY_LIMIT || offset > 0) && <div className="operations-pagination">
              <span>{result.value.items.length ? `${offset + 1}–${offset + result.value.items.length} of ${result.value.total}` : `0 of ${result.value.total}`}</span>
              <div><Button disabled={offset === 0} onClick={() => page(Math.max(0, offset - ACTIVITY_LIMIT))}>Previous</Button>
                <Button disabled={offset + ACTIVITY_LIMIT >= result.value.total} onClick={() => page(offset + ACTIVITY_LIMIT)}>Next</Button></div>
            </div>}</>}
      </Card>}
    {allowed && query && selected && user?.permissions.includes('payments.read') &&
      <MomoPaymentDetail id={selected} allowActions={false} allowRecovery onClose={() => select(null)} />}
  </section>;
}

function paymentReturnPath(path: string, scope: string, offset: number) {
  const params = new URLSearchParams(path.split('?')[1]);
  params.delete('limit'); if (!offset) params.delete('offset'); params.set('scope', scope);
  return paymentsPath + '?' + params;
}

function ActivitySearch({current, apply}: {current: string; apply: (search: string) => void}) {
  const [draft, setDraft] = useState(current);
  const submit = (event: FormEvent) => {event.preventDefault(); apply(draft.trim());};
  return <form className="operations-search" onSubmit={submit} role="search">
    <label htmlFor="payments-activity-search" className="admin-sr-only">Search payments</label>
    <input id="payments-activity-search" className="admin-input" autoComplete="off" value={draft} maxLength={200}
      placeholder="Search name or reference" onChange={event => setDraft(event.target.value)} />
    <Button type="submit">Search</Button>
  </form>;
}

function ActivityRows({rows, returnPath, selectMomo}: {rows: PaymentActivity[]; returnPath: string; selectMomo: (id: string) => void}) {
  const {user} = useSession(), showSms = canReadSmsEvidence(user);
  const [expanded, setExpanded] = useState<{key: string; panel: 'record' | 'sms'} | null>(null);
  const headings = ['Record', 'Date · Kigali', 'Payer', 'Amount', 'Status', ...(showSms ? ['SMS / receipts'] : [])];
  function toggle(key: string, panel: 'record' | 'sms') {
    setExpanded(current => current?.key === key && current.panel === panel ? null : {key,panel});
  }
  return <MomoTable name="Payment activity" headings={headings} compact>
    {rows.map(row => {
      const key = activityKey(row), open = expanded?.key === key, title = row.reference ?? kinds[row.kind];
      const evidence = row.receipts.length, label = evidence === 1 ? '1 receipt' : `${evidence} receipts`;
      return <Fragment key={key}><tr role="row">
        <MomoCell label="Record"><button type="button" className="operations-link" aria-expanded={open && expanded.panel === 'record'}
          aria-controls={open ? 'payment-activity-details' : undefined} onClick={() => toggle(key,'record')}>{title}</button>
          {row.reference && <small>{kinds[row.kind]}</small>}</MomoCell>
        <MomoCell label="Date · Kigali">{formatTime(row.occurredAt)}</MomoCell><MomoCell label="Payer">{row.payer ?? '—'}</MomoCell>
        <MomoCell label="Amount">{row.amountRwf === null ? '—' : formatMomoAmount(row.amountRwf)}</MomoCell>
        <MomoCell label="Status"><StatusBadge tone={statusTone(row.status)}>{stateLabel(row)}</StatusBadge>
          {row.attention && row.status !== 'needs_attention' && <small>Needs attention</small>}</MomoCell>
        {showSms && <MomoCell label="SMS / receipts">{evidence ? <><button type="button" className="operations-link"
          aria-label={`Open ${label} for ${title}`} aria-expanded={open && expanded.panel === 'sms'}
          aria-controls={open ? 'payment-activity-details' : undefined} onClick={() => toggle(key,'sms')}>{label}</button>
          <small>{[...new Set(row.receipts.map(stateLabel))].join(' · ')}</small></> : '—'}</MomoCell>}
      </tr>{open && <tr className="payments-expanded-row"><td colSpan={headings.length}><div id="payment-activity-details">
        <ActivityDetail key={key + expanded.panel} row={row} panel={expanded.panel} returnPath={returnPath} selectMomo={selectMomo} />
      </div></td></tr>}</Fragment>;
    })}
  </MomoTable>;
}

function ActivityDetail({row, panel, returnPath, selectMomo}: {row: PaymentActivity; panel: 'record' | 'sms'; returnPath: string; selectMomo: (id: string) => void}) {
  const {user} = useSession(), permissions = user?.permissions ?? [];
  const [reviewSource, setReviewSource] = useState<string | null>(null);
  const focus = useRef<HTMLElement>(null);
  useEffect(() => {if (panel === 'sms') focus.current?.focus();}, [panel]);
  const suffix = '?' + new URLSearchParams({returnTo: returnPath});
  const receipts = canReadSmsEvidence(user) ? row.receipts : [];
  const financial = permissions.includes('payments.read');
  const showingReceipts = panel === 'sms' || row.kind === 'capture' || row.kind === 'receiver_sms';
  return <section className="payments-activity-detail" tabIndex={-1} ref={focus} aria-label={panel === 'sms' ? 'SMS and receipt details' : 'Record details'}>
    {!showingReceipts && <><h2>{kinds[row.kind]}</h2>
      {financial && row.paymentId && <PaymentActivityFacts kind="payment" id={row.paymentId} />}
      {!financial && row.reconciliationId && <PaymentActivityFacts kind="reconciliation" id={row.reconciliationId} />}
      {financial && row.kind === 'momo' && !row.paymentId && <PaymentActivityFacts kind="momo" id={row.id} />}
      {permissions.includes('reconciliations.read') && permissions.includes('users.read') && row.reconciliationId &&
        <Link className="operations-link" to={`/admin/reconciliations/${row.reconciliationId}${suffix}`}>Open reconciliation</Link>}
      {financial && (row.kind === 'payment' || canReadSmsEvidence(user)) && row.momoIds.map((id, i) => <button key={id} type="button" className="operations-link"
        onClick={() => selectMomo(id)}>Open MoMo transaction{row.momoIds.length > 1 ? ' ' + (i + 1) : ''}</button>)}
    </>}
    {showingReceipts && receipts.map(source => <ReceiptDetails key={activityKey(source)} source={source}
      showFinancial={financial} canReveal={permissions.includes('sms.reveal')}
      autoDetails={receipts.length === 1 || reviewSource === source.id}
      review={reviewSource === source.id} toggle={() => setReviewSource(reviewSource === source.id ? null : source.id)} />)}
  </section>;
}
function ReceiptDetails({source, showFinancial, canReveal, autoDetails, review, toggle}: {
  source: ActivityReceipt; showFinancial: boolean; canReveal: boolean; autoDetails: boolean; review: boolean; toggle: () => void;
}) {
  return <section className="payments-receipt-detail" aria-label={kinds[source.kind] + ' details'}>
    <h3>{kinds[source.kind]}</h3>
    <dl className="operations-facts"><div><dt>Source ID</dt><dd><code>{source.id}</code></dd></div>
      <div><dt>Processing</dt><dd>{stateLabel(source)}</dd></div>
      {showFinancial && source.paymentReference && <div><dt>Payment reference</dt><dd><Link to={paymentsPath + '?' + new URLSearchParams({search: source.paymentReference})}
        aria-label={'Search for payment reference ' + source.paymentReference}>{source.paymentReference}</Link></dd></div>}
      {showFinancial && source.payerStatus && <div><dt>Payer SMS</dt><dd>{knownLabel(receiptLabels, source.payerStatus)}</dd></div>}
      {showFinancial && source.payerReason && <div><dt>Receipt reason</dt><dd>{knownLabel(reasonLabels, source.payerReason)}</dd></div>}
    </dl>
    {source.kind === 'capture' && (autoDetails ? <PaymentActivityFacts kind="capture" id={source.id} /> :
      <Button onClick={toggle}>Show captured receipt</Button>)}
    {source.kind === 'receiver_sms' && source.collectionId && canReveal && source.bodySha256 && <><Button onClick={toggle} aria-expanded={review}>
      {review ? 'Close original SMS review' : 'Review original SMS'}</Button>
      {review && <MomoSourceRevealPanel enabled observationGroup={source.collectionId} source={{raw_sms_id: source.id, body_sha256: source.bodySha256}} />}</>}
  </section>;
}
