/* eslint-disable no-control-regex -- Reject control characters in operator search input. */
import {useCallback, useLayoutEffect, useRef, useState, type FormEvent} from 'react';
import {Link, useSearchParams} from 'react-router';
import {useSession} from '../../session/SessionProvider';
import {canDisplaySessionRecords, canReadSmsEvidence} from '../../session/sessionContext';
import {AdminRequestError} from '../../api/client';
import {Button, Card, EmptyState, ErrorState, StatusBadge} from '../../ui';
import {isValidId} from './contracts';
import {momoStatuses, parseMomoPage, type MomoFilters, type MomoPage, type MomoStatus} from './momoContracts';
import {MomoMemberChecks, MomoPaymentDetail} from './MomoPaymentReview';
import {MomoSourceReview} from './MomoSourceReview';
import {formatStatus, formatTime} from './OperationsRecords';
import {formatMomoAmount, MomoCell, MomoPager, MomoResult, MomoTable, momoReadOptions} from './MomoRecordViews';
import {useOperationRead} from './useOperationRead';
import {paymentViewLocation} from './paymentLocations';

function kigaliDate(value: string, end: boolean): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return new Date(date.getTime() - 7200000 + (end ? 86399999 : 0)).toISOString();
}
type Draft = { search: string; status: MomoStatus; account: string; group: string; from: string; to: string };
type WorkspaceNavigation = {
  draft: Draft; filters: MomoFilters; offset: number; selected: string | null;
  apply: (draft: Draft, offset: number) => void; select: (id: string | null) => void;
};

/** URL re-entry restores the operator's search, filters, page and open detail. */
export function WorkspaceMomoTransactionList({allowActions = false, allowRecovery = true}: {allowActions?: boolean; allowRecovery?: boolean} = {}) {
  const session = useSession(), [params, setParams] = useSearchParams();
  const value = (key: string) => params.getAll(key).length === 1 ? params.get(key) ?? '' : '';
  const permissions = session.user?.permissions ?? [];
  const search = value('search'), status = value('status'), account = value('account'), group = value('group');
  const from = value('from'), to = value('to'), offset = Number(value('offset'));
  const start = kigaliDate(from, false), end = kigaliDate(to, true), ordered = !start || !end || start <= end;
  const draft: Draft = {
    search: search.length <= 200 && !/[\x00-\x1f\x7f]/.test(search) ? search : '',
    status: momoStatuses.find(candidate => candidate === status) ?? '',
    account: permissions.includes('receivers.read') && isValidId(account) ? account : '',
    group: permissions.includes('collections.read') && isValidId(group) ? group : '',
    from: ordered && start ? from : '', to: ordered && end ? to : '',
  };
  const applied = {draft, filters:{...draft, from: ordered ? start ?? '' : '', to: ordered ? end ?? '' : ''},
    offset: Number.isSafeInteger(offset) && offset >= 0 && offset <= 2147483647 && offset % 25 === 0 ? offset : 0,
    selected: isValidId(value('payment')) ? value('payment') : null};
  function listQuery(candidate: Draft, pageOffset: number) {
    const next = new URLSearchParams({dataset:'momo'});
    for (const [key, value] of Object.entries(candidate)) if (value) next.set(key,value);
    if (pageOffset) next.set('offset',String(pageOffset));
    return next;
  }
  const workspace: WorkspaceNavigation = {...applied,
    apply: (draft, offset) => setParams(listQuery(draft,offset)),
    select: id => {
      const next = listQuery(draft,applied.offset);
      if (id) next.set('payment',id);
      setParams(next,{replace: !id});
    },
  };
  const unavailableScope = (['account','group'] as const).some(key => {
    const requested = params.getAll(key);
    return requested.some(Boolean) && (requested.length !== 1 || !isValidId(requested[0]) ||
      !permissions.includes(key === 'account' ? 'receivers.read' : 'collections.read'));
  });
  if (!permissions.includes('payments.read')) return <ErrorState title="Access unavailable" message="Your current account cannot open these records." />;
  if (unavailableScope) return <>
    <ErrorState title="This filter isn’t available" message="Your current account cannot open these transactions with the scope in this link." />
    <p className="operations-note"><Link to={paymentViewLocation('recorded',{momo:true})}>Open MoMo transactions without the restricted filter</Link></p>
  </>;
  return <MomoTransactionList key={JSON.stringify([session.epoch,draft])} allowActions={allowActions} allowRecovery={allowRecovery} workspace={workspace} />;
}

function MomoTransactionList({allowActions, allowRecovery, workspace}: {allowActions: boolean; allowRecovery: boolean; workspace: WorkspaceNavigation}) {
  const session = useSession(), request = session.request, permissions = session.user?.permissions ?? [];
  const [search, setSearch] = useState(workspace.draft.search), [status, setStatus] = useState<MomoStatus>(workspace.draft.status),
    [account, setAccount] = useState(workspace.draft.account), [group, setGroup] = useState(workspace.draft.group),
    [from, setFrom] = useState(workspace.draft.from), [to, setTo] = useState(workspace.draft.to);
  const [filterError, setFilterError] = useState('');
  const {search: appliedSearch,status: appliedStatus,account: appliedAccount,group: appliedGroup,from: appliedFrom,to: appliedTo} = workspace.filters;
  const {offset, selected: selectedId} = workspace;
  const [checking, setChecking] = useState(false);
  const canCheck = ['payments.read', 'users.read', 'collections.read'].every((permission) => permissions.includes(permission));
  const {epoch, isCurrentAuthority} = session, actorId = session.user?.id, sessionId = session.user?.sessionId;
  const retryOwner = useRef<((signal: AbortSignal) => Promise<MomoPage>) | null>(null);
  const latestRequest = useRef(0);
  const load = useCallback(async function readTransactions(signal: AbortSignal): Promise<MomoPage> {
    const requestNumber = ++latestRequest.current;
    const query = new URLSearchParams({limit: '25', offset: String(offset), search: appliedSearch, status: appliedStatus});
    if (appliedAccount) query.set('receiving_account_id', appliedAccount); if (appliedGroup) query.set('group_id', appliedGroup);
    if (appliedFrom) query.set('from', appliedFrom); if (appliedTo) query.set('to', appliedTo);
    const path = `momo/transactions?${query}`;
    let body;
    try {body = await request(path, {signal});}
    catch (error) {
      if (!(error instanceof AdminRequestError) || error.statusCode !== 503 || error.code !== 'service_unavailable' || error.outcomeUnknown ||
          signal.aborted || retryOwner.current !== readTransactions || requestNumber !== latestRequest.current ||
          !actorId || !sessionId || !isCurrentAuthority(epoch, actorId, sessionId)) throw error;
      body = await request(path, {signal});
    }
    return parseMomoPage(body, offset, {search:appliedSearch,status:appliedStatus,account:appliedAccount,group:appliedGroup,from:appliedFrom,to:appliedTo});
  }, [appliedSearch, appliedStatus, appliedAccount, appliedGroup, appliedFrom, appliedTo, offset, request, epoch, actorId, sessionId, isCurrentAuthority]);
  useLayoutEffect(() => {
    retryOwner.current = load;
    return () => {retryOwner.current = null;};
  }, [load]);
  const {result, retry} = useOperationRead(`${session.epoch}:transactions:${JSON.stringify([appliedSearch,appliedStatus,appliedAccount,appliedGroup,appliedFrom,appliedTo])}:${offset}`, canDisplaySessionRecords(session) && permissions.includes('payments.read'), load, momoReadOptions);
  const apply = (event: FormEvent) => {
    event.preventDefault();
    const start = from ? kigaliDate(from, false) : '', end = to ? kigaliDate(to, true) : '';
    if (search.length > 200 || /[\x00-\x1f\x7f]/.test(search) || account && !isValidId(account) || group && !isValidId(group) || start === null || end === null || start && end && start > end) {setFilterError('Check the search, account, group and date values.'); return;}
    const next = {search: search.trim(),status,account: permissions.includes('receivers.read') ? account : '',
      group: permissions.includes('collections.read') ? group : '',from,to};
    setFilterError('');
    workspace.apply(next, 0);
  };
  return <><Card className="operations-records"><form className="operations-toolbar" onSubmit={apply}><h2>Transactions</h2>
    <label className="operations-filter">Search MoMo TX ID or counterparty<input className="admin-input" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={200} /></label>
    <label className="operations-filter">Payment status<select className="admin-input" value={status} onChange={(event) => setStatus(event.target.value as MomoStatus)}><option value="">All statuses</option>{momoStatuses.map((value) => <option key={value} value={value}>{formatStatus(value)}</option>)}</select></label>
    {permissions.includes('receivers.read') && <label className="operations-filter">Receiving account ID<input className="admin-input" value={account} onChange={(event) => setAccount(event.target.value)} /></label>}
    {permissions.includes('collections.read') && <label className="operations-filter">Group ID<input className="admin-input" value={group} onChange={(event) => setGroup(event.target.value)} /></label>}
    <label className="operations-filter">From · Kigali<input type="date" className="admin-input" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label className="operations-filter">To · Kigali<input type="date" className="admin-input" value={to} onChange={(event) => setTo(event.target.value)} /></label>
    <Button type="submit">Apply filters</Button><Button onClick={retry}>Refresh</Button>{canCheck && <Button onClick={() => setChecking(true)}>Member checks</Button>}</form>{filterError && <p role="alert" className="operations-note">{filterError}</p>}
    <MomoResult result={result} retry={retry} empty={() => false}>{(page: MomoPage) => <><p className="operations-note">Received {formatMomoAmount(page.totals.received_minor)} · Credited {formatMomoAmount(page.totals.credited_minor)} · Unallocated {formatMomoAmount(page.totals.unallocated_minor)}<br />Provider transaction date · As of {formatTime(page.asOf)} Kigali. Provider confirmation and settlement are not asserted.</p>
      {page.rows.length === 0 ? <EmptyState title="No matching transactions" /> : <MomoTable name="MoMo transactions" headings={['MoMo TX ID', 'Amount', 'Status', 'Time · Kigali']} compact>
        {page.rows.map(row => <tr key={row.id} role="row">
          <MomoCell label="MoMo TX ID"><button type="button" className="operations-link" onClick={() => workspace.select(row.id)}
            aria-label={row.provider_transaction_id ?? `View transaction ${row.id}`}>{row.provider_transaction_id ?? 'View details'}</button></MomoCell>
          <MomoCell label="Amount">{formatMomoAmount(row.amount_minor,row.currency)}</MomoCell>
          <MomoCell label="Status"><StatusBadge>{formatStatus(row.status)}</StatusBadge>{row.has_conflict ? <div>Evidence conflict</div> : null}</MomoCell>
          <MomoCell label="Time · Kigali">{row.transaction_at ? formatTime(row.transaction_at) : `Received ${formatTime(row.created_at)}`}</MomoCell>
        </tr>)}
      </MomoTable>}<MomoPager page={page} change={value => workspace.apply(workspace.draft, value)} /></>}</MomoResult>
  </Card>{appliedStatus === 'needs_attention' && canReadSmsEvidence(session.user) && <MomoSourceReview allowActions={allowActions} allowRecovery={allowRecovery} />}
  {selectedId && canDisplaySessionRecords(session) && permissions.includes('payments.read') && <MomoPaymentDetail id={selectedId} allowActions={allowActions} allowRecovery={allowRecovery} onClose={() => workspace.select(null)} />}
  {checking && canCheck && <MomoMemberChecks onClose={() => setChecking(false)} onSearch={(value) => {
    setChecking(false);
    workspace.apply({...workspace.draft, search: value, status: ''}, 0);
  }} />}</>;
}
