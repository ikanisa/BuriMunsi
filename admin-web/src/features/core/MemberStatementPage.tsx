import {useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Link} from 'react-router';
import {CompactText, Button, Card, Dialog, EmptyState, ErrorState, LoadingState, PageHeader} from '../../ui';
import {InteractionSuspendedContext} from '../../ui/useFocusScope';
import {paymentEventInstant, paymentEventTime} from '../operations/canonicalPaymentAnalysis';
import {FinancialAnalysisTable, type FinancialColumn, type FinancialSort} from '../operations/FinancialAnalysisTable';
import type {ColumnFilters} from '../operations/financialAnalysisModel';
import {useOperationRead} from '../operations/useOperationRead';
import {canReadMemberStatement, memberStatementPageSize, memberStatementPath, parseStatementPage, readCompleteMemberStatement,
  readMemberStatement, readMemberStatementPage, statementAmount, statementGroupTitle, type CompleteMemberStatement, type MemberStatementPosition,
  type ProfileMembership, type StatementPage, type StatementPayment} from './memberStatement';
import {isId} from './contracts';
import {memberStatementCsv, statementFilename} from './memberStatementDownload';
import type {AdminRequest, FeatureAccess} from './types';
import './core.css';

export type StatementProfile = {data: Record<string, unknown>; membership: ProfileMembership | null; statementUnavailable: boolean};
type HistoryReader = () => Promise<CompleteMemberStatement>;

// The grid and download share one verified revision. Releasing the page or its
// authority clears both a pending request and a completed financial snapshot.
function useStatementHistory(page: (StatementPage & {membership: ProfileMembership}) | null, request: AdminRequest, suspended: boolean) {
  const cached = useRef<{controller: AbortController; history: Promise<CompleteMemberStatement>} | null>(null);
  useLayoutEffect(() => () => {
    cached.current?.controller.abort();
    cached.current = null;
  }, [page, request, suspended]);
  return useCallback<HistoryReader>(() => {
    if (!page || suspended) return Promise.reject(new Error('The statement is unavailable.'));
    if (!cached.current) {
      const controller = new AbortController();
      const history = readCompleteMemberStatement(page, page.membership, request, controller.signal).catch(error => {
        if (cached.current?.controller === controller) cached.current = null;
        throw error;
      });
      cached.current = {controller, history};
    }
    return cached.current.history;
  }, [page, request, suspended]);
}

export function MemberStatementPage({id, expectedGroup, returnTo, actorId, authorityKey, permissions, request, navigate, profile, onRetryProfile}:
  FeatureAccess & {id: string; expectedGroup?: string; returnTo?: string; profile?: StatementProfile; onRetryProfile?: () => void}) {
  const allowed = isId(id) && canReadMemberStatement(permissions);
  const suspended = useContext(InteractionSuspendedContext);
  const scope = JSON.stringify([authorityKey, actorId, id, expectedGroup, profile?.membership?.id]);
  const [selected, setSelected] = useState<(MemberStatementPosition & {scope: string; membership: ProfileMembership; name: string | null}) | null>(null);
  const position = selected?.scope === scope ? selected : null;
  const offset = position?.offset ?? 0;
  const load = useCallback(async (signal: AbortSignal) => {
    if (!position && profile) {
      const {data, membership, statementUnavailable} = profile;
      if (statementUnavailable || !membership?.id || !membership.groupId) throw new Error('Statement unavailable.');
      const statement = Object.hasOwn(data, 'member_statement') ? parseStatementPage(data.member_statement, id, membership, {offset: 0}) :
        await readMemberStatementPage(request, signal, id, membership);
      return {...statement, membership, name: null};
    }
    if (!position) return readMemberStatement(request, signal, id, actorId, expectedGroup, {offset: 0});
    const {membership, name} = position;
    const statement = await readMemberStatementPage(request, signal, id, membership, position);
    return {...statement, membership, name};
  }, [request, id, actorId, expectedGroup, position, profile]);
  const {result, retry} = useOperationRead(JSON.stringify([scope, offset, position?.revision]), allowed, load,
    {invalidResponse: profile ? 'The member’s transaction history could not be verified.' : 'The membership or its complete payment history could not be verified.'});
  const data = result?.status === 'success' ? result.value : null;
  const readHistory = useStatementHistory(data, request, suspended);
  const changePage = (next: number) => data && setSelected({scope, offset: (next - 1) * memberStatementPageSize,
    revision: data.revision, membership: data.membership, name: data.name});
  const restart = () => {
    if (profile && (!profile.membership?.id || !profile.membership.groupId)) {onRetryProfile?.(); return;}
    setSelected(profile?.membership ? {scope, offset: 0, membership: profile.membership, name: null} : null);
    retry();
  };
  const profileQuery = returnTo ? '?' + new URLSearchParams({returnTo}) : '';
  const content = <>
    {!allowed ? <ErrorState title="Access unavailable" message="This account cannot open this member statement." /> :
      !result ? <LoadingState label="Loading member statement" layout="table" /> :
      result.status === 'error' ? <ErrorState title="Member statement unavailable" message={result.message} onRetry={restart} /> : data && <Card className="admin-content-enter"><div className="core-detail">
        <div className="member-statement-heading"><h2>{profile ? 'Member statement' : data.membership.groupTitle ?? 'Membership'}</h2>
          {!suspended && (statementGroupTitle(data.groupId,data.membership.groupTitle) ? <StatementDownload key={JSON.stringify([scope,data.membership.id,data.membership.groupTitle,data.membership.recordNumber,data.membership.publicId,data.revision,offset])}
            readHistory={readHistory} refresh={restart} /> : <span>A verified group name is required to download this statement.</span>)}</div>
        <dl>{!profile && <div><dt>Record ID</dt><dd>{data.membership.recordNumber ?? 'Unavailable'}</dd></div>}
          <div><dt>Closing balance</dt><dd>{profile ? <Link className="operations-link" to={memberStatementPath(id) + (returnTo !== '/admin/members' ? profileQuery : '')}
            aria-label={'Open member statement, total balance ' + statementAmount(data.closingRwf, true)}>{statementAmount(data.closingRwf, true)}</Link> :
            statementAmount(data.closingRwf, true)}</dd></div></dl>
        {!profile && <p>Incoming payments allocated to this member in this group are credits. Outgoing payments are debits.</p>}
        {!data.items.length ? <EmptyState title="No member transactions" description="No payments have been allocated to this membership." /> :
          <StatementTransactions key={JSON.stringify([scope, data.membership.id, data.revision, offset])}
            page={data} showSourceTime={!profile} readHistory={readHistory} changePage={changePage} refresh={restart} />}
      </div></Card>}
  </>;
  return profile ? <section aria-label="Member statement">{content}</section> : <>
    <PageHeader title="Member statement" subtitle={data?.name ?? undefined}
      actions={<Button onClick={() => navigate(isId(id) ? '/admin/members/' + id + profileQuery : '/admin/members')}>Back to member</Button>} />
    {content}
  </>;
}

type StatementCriteria = {filters: ColumnFilters; sort: FinancialSort};
const postedOrder: StatementCriteria = {filters: new Map(), sort: {key: '', direction: 'asc'}};
const rowKey = (payment: StatementPayment) => payment.id;

function StatementTransactions({page, showSourceTime, readHistory, changePage, refresh}: {
  page: StatementPage; showSourceTime: boolean; readHistory: HistoryReader; changePage: (page: number) => void; refresh: () => void;
}) {
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [criteria, setCriteria] = useState<StatementCriteria | null>(null), [localPage, setLocalPage] = useState(1);
  const wholePage = page.totalCount === page.items.length;
  const {result} = useOperationRead(page.revision, !wholePage && criteria !== null, readHistory,
    {invalidResponse: 'The complete member statement could not be verified.'});
  const complete = wholePage ? page.items : result?.status === 'success' ? result.value.transactions : null;
  const sourcePage = page.offset / memberStatementPageSize + 1;
  const items = complete ?? (criteria ? [] : page.items);
  const selected = items.find(payment => payment.id === paymentId);
  const columns = useMemo<FinancialColumn<StatementPayment>[]>(() => [
    {key: 'date', label: 'Date (Kigali)', kind: 'date', value: payment => paymentEventInstant(payment),
      render: payment => {
        const formatted = paymentEventTime(payment);
        return <><span className="statement-local-time" title={formatted}>{formatted}</span>
          {showSourceTime && payment.occurredAt!==null && payment.atRaw.trim() && formatted !== payment.atRaw && <small className="statement-source-time">{payment.atRaw}</small>}</>;
      }},
    {key: 'reference', label: 'Reference', kind: 'text', value: payment => payment.ftId,
      render: payment => {
        const reference = payment.ftId?.trim();
        const label = reference ? 'View transaction ' + reference :
          ['View transaction', payment.direction === 'incoming' ? 'Credit' : 'Debit', statementAmount(payment.amountRwf, true), paymentEventTime(payment)].join(', ');
        return <button type="button" className="member-statement-reference" aria-label={label} aria-haspopup="dialog"
          onClick={() => setPaymentId(payment.id)}><CompactText cell>{reference || 'View transaction'}</CompactText></button>;
      }},
    {key: 'debit', label: 'Debit (RWF)', kind: 'number', exactInteger: true,
      value: payment => payment.direction === 'outgoing' ? String(payment.amountRwf) : null},
    {key: 'credit', label: 'Credit (RWF)', kind: 'number', exactInteger: true,
      value: payment => payment.direction === 'incoming' ? String(payment.amountRwf) : null},
    {key: 'balance', label: 'Balance (RWF)', kind: 'number', exactInteger: true, value: payment => String(payment.balanceRwf)},
  ], [showSourceTime]);
  const onCriteria = (filters: ColumnFilters, sort: FinancialSort) => {
    if (!criteria && !filters.size && !sort.key) return;
    setPaymentId(null); setLocalPage(1); setCriteria({filters, sort});
  };
  const view = {...(criteria ?? postedOrder), onCriteria};
  return <>
    <FinancialAnalysisTable rows={items} columns={columns} rowKey={rowKey} label="Member transactions"
      pageSize={memberStatementPageSize} page={complete || criteria ? localPage : sourcePage}
      onPageChange={complete ? setLocalPage : changePage} loadingLabel="Loading complete member statement"
      criteria={complete ? view : undefined}
      remote={complete ? undefined : {...view, total: page.totalCount, matching: criteria ? null : page.totalCount,
        error: result?.status === 'error' ? <ErrorState title="Member statement analysis unavailable" message={result.message} onRetry={refresh} /> : undefined}} />
    {selected && <Dialog open placement="picker" title="Transaction details" onClose={() => setPaymentId(null)}>
      <dl className="member-transaction-facts">
        <div className="member-transaction-amount"><dt>{selected.direction === 'incoming' ? 'Credit' : 'Debit'}</dt>
          <dd>{statementAmount(selected.amountRwf, true)}</dd></div>
        <div><dt>Reference</dt><dd>{selected.ftId?.trim() || 'Not recorded'}</dd></div>
        <div><dt>Date (Kigali)</dt><dd>{paymentEventTime(selected)}</dd></div>
        <div><dt>Running balance</dt><dd>{statementAmount(selected.balanceRwf, true)}</dd></div>
      </dl>
    </Dialog>}
  </>;
}

function StatementDownload({readHistory, refresh}: {readHistory: HistoryReader; refresh: () => void}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [file, setFile] = useState<{href:string; name:string}>();
  const flight = useRef<AbortController | null>(null), resource = useRef<string | undefined>(undefined);
  const link = useRef<HTMLAnchorElement>(null);
  useLayoutEffect(() => () => {
    flight.current?.abort();
    if (resource.current) URL.revokeObjectURL(resource.current);
  }, []);
  useEffect(() => {if (file) link.current?.click();}, [file]);

  async function prepare() {
    if (flight.current || resource.current) return;
    const controller = new AbortController();
    flight.current = controller;
    setBusy(true); setError(false);
    try {
      const history = await readHistory();
      controller.signal.throwIfAborted();
      const name=statementFilename(history);
      resource.current = URL.createObjectURL(new Blob([memberStatementCsv(history)], {type: 'text/csv;charset=utf-8'}));
      setFile({href:resource.current, name});
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      flight.current = null;
    }
  }
  return <div className="member-statement-download">
    {file ? <a className="admin-btn admin-btn--secondary" ref={link} href={file.href} download={file.name}>Download statement</a> :
      <Button loading={busy} onClick={() => void prepare()}>{busy ? 'Preparing CSV…' : 'Download statement'}</Button>}
    {error && <><span role="alert">Could not prepare the complete statement.</span><Button onClick={refresh}>Refresh statement</Button></>}
  </div>;
}
