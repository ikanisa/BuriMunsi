import {useCallback, useContext, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Link} from 'react-router';
import {CompactText, Button, Card, Dialog, EmptyState, ErrorState, LoadingState, PageHeader} from '../../ui';
import {InteractionSuspendedContext} from '../../ui/useFocusScope';
import {paymentTime} from '../operations/canonicalPaymentAnalysis';
import {useOperationRead} from '../operations/useOperationRead';
import {canReadMemberStatement, memberStatementPageSize, memberStatementPath, parseStatementPage, readMemberStatement, readMemberStatementPage,
  statementAmount, type MemberStatementPosition, type ProfileMembership} from './memberStatement';
import {isId} from './contracts';
import {memberStatementCsv, type StatementPage} from './memberStatementDownload';
import type {AdminRequest, FeatureAccess} from './types';
import './core.css';

export type StatementProfile = {data: Record<string, unknown>; membership: ProfileMembership | null; statementUnavailable: boolean};

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
  const pages = Math.max(1, Math.ceil((data?.totalCount ?? 0) / memberStatementPageSize));
  const current = offset / memberStatementPageSize + 1;
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
          {!suspended && <StatementDownload key={JSON.stringify([scope, data.membership.id, data.revision, offset])}
            page={data} membership={data.membership} request={request} refresh={restart} />}</div>
        <dl>{!profile && <div><dt>Record ID</dt><dd>{data.membership.recordNumber ?? 'Unavailable'}</dd></div>}
          <div><dt>Closing balance</dt><dd>{profile ? <Link className="operations-link" to={memberStatementPath(id) + (returnTo !== '/admin/members' ? profileQuery : '')}
            aria-label={'Open member statement, total balance ' + statementAmount(data.closingRwf, true)}>{statementAmount(data.closingRwf, true)}</Link> :
            statementAmount(data.closingRwf, true)}</dd></div></dl>
        {!profile && <p>Incoming payments allocated to this member in this group are credits. Outgoing payments are debits.</p>}
        {!data.items.length ? <EmptyState title="No member transactions" description="No payments have been allocated to this membership." /> : <>
          <StatementTransactions key={JSON.stringify([scope, data.membership.id, data.revision, offset])}
            items={data.items} showSourceTime={!profile} />
          {pages > 1 && <nav className="core-pager" aria-label="Member statement pages">
            <span>Page {current} of {pages}</span><div>
              <Button disabled={current === 1} onClick={() => changePage(current - 1)}>Previous</Button>
              <Button disabled={current === pages} onClick={() => changePage(current + 1)}>Next</Button>
            </div></nav>}
        </>}
      </div></Card>}
  </>;
  return profile ? <section aria-label="Member statement">{content}</section> : <>
    <PageHeader title="Member statement" subtitle={data?.name ?? undefined}
      actions={<Button onClick={() => navigate(isId(id) ? '/admin/members/' + id + profileQuery : '/admin/members')}>Back to member</Button>} />
    {content}
  </>;
}

function StatementTransactions({items, showSourceTime}: {items: StatementPage['items']; showSourceTime: boolean}) {
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const selected = items.find(payment => payment.id === paymentId);
  return <>
    <div className="admin-table-wrap" role="region" aria-label="Member transactions" tabIndex={0}>
      <table className="admin-table member-statement-table" aria-label="Member transactions"><thead><tr>
        {['Date (Kigali)', 'Reference', 'Debit (RWF)', 'Credit (RWF)', 'Balance (RWF)'].map(heading =>
          <th scope="col" key={heading}>{heading}</th>)}
      </tr></thead><tbody>{items.map(payment => {
        const formatted = paymentTime(payment.atRaw);
        const reference = payment.ftId?.trim();
        const incoming = payment.direction === 'incoming';
        const label = reference ? 'View transaction ' + reference :
          ['View transaction', incoming ? 'Credit' : 'Debit', statementAmount(payment.amountRwf, true), formatted].join(', ');
        return <tr key={payment.id}><td>{formatted}
          {showSourceTime && payment.atRaw.trim() && formatted !== payment.atRaw && <small className="statement-source-time">{payment.atRaw}</small>}</td>
          <td><button type="button" className="member-statement-reference" aria-label={label} aria-haspopup="dialog"
            onClick={() => setPaymentId(payment.id)}><CompactText cell>{reference || 'View transaction'}</CompactText></button></td>
          <td>{!incoming ? statementAmount(payment.amountRwf) : '—'}</td>
          <td>{incoming ? statementAmount(payment.amountRwf) : '—'}</td>
          <td>{statementAmount(payment.balanceRwf)}</td></tr>;
      })}</tbody></table>
    </div>
    {selected && <Dialog open placement="picker" title="Transaction details" onClose={() => setPaymentId(null)}>
      <dl className="member-transaction-facts">
        <div className="member-transaction-amount"><dt>{selected.direction === 'incoming' ? 'Credit' : 'Debit'}</dt>
          <dd>{statementAmount(selected.amountRwf, true)}</dd></div>
        <div><dt>Reference</dt><dd>{selected.ftId?.trim() || 'Not recorded'}</dd></div>
        <div><dt>Date (Kigali)</dt><dd>{paymentTime(selected.atRaw)}</dd></div>
        <div><dt>Running balance</dt><dd>{statementAmount(selected.balanceRwf, true)}</dd></div>
      </dl>
    </Dialog>}
  </>;
}

function StatementDownload({page, membership, request, refresh}: {
  page: StatementPage; membership: ProfileMembership; request: AdminRequest; refresh: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [href, setHref] = useState<string>();
  const flight = useRef<AbortController | null>(null), resource = useRef<string | undefined>(undefined);
  const link = useRef<HTMLAnchorElement>(null);
  useLayoutEffect(() => () => {
    flight.current?.abort();
    if (resource.current) URL.revokeObjectURL(resource.current);
  }, []);
  useEffect(() => {if (href) link.current?.click();}, [href]);

  async function prepare() {
    if (flight.current || resource.current) return;
    const controller = new AbortController();
    flight.current = controller;
    setBusy(true); setError(false);
    try {
      const csv = await memberStatementCsv(page, membership, request, controller.signal);
      controller.signal.throwIfAborted();
      resource.current = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}));
      setHref(resource.current);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      flight.current = null;
    }
  }
  return <div className="member-statement-download">
    {href ? <a className="admin-btn admin-btn--secondary" ref={link} href={href} download="burimunsi-member-statement.csv">Download statement</a> :
      <Button loading={busy} onClick={() => void prepare()}>{busy ? 'Preparing CSV…' : 'Download statement'}</Button>}
    {error && <><span role="alert">Could not prepare the complete statement.</span><Button onClick={refresh}>Refresh statement</Button></>}
  </div>;
}
