import {useCallback, useState} from 'react';
import {Button, Card, EmptyState, ErrorState, LoadingState, PageHeader} from '../../ui';
import {paymentTime} from '../operations/canonicalPaymentAnalysis';
import {useOperationRead} from '../operations/useOperationRead';
import {canReadMemberStatement, memberStatementPageSize, readMemberStatement, statementAmount, type MemberStatementPosition} from './memberStatement';
import {isId} from './contracts';
import type {FeatureAccess} from './types';
import './core.css';

export function MemberStatementPage({id, expectedGroup, returnTo, actorId, authorityKey, permissions, request, navigate}:
  FeatureAccess & {id: string; expectedGroup?: string; returnTo?: string}) {
  const allowed = isId(id) && canReadMemberStatement(permissions);
  const scope = JSON.stringify([authorityKey, id, expectedGroup]);
  const [selected, setSelected] = useState<(MemberStatementPosition & {scope: string}) | null>(null);
  const offset = selected?.scope === scope ? selected.offset : 0;
  const revision = selected?.scope === scope ? selected.revision : undefined;
  const load = useCallback((signal: AbortSignal) => readMemberStatement(request, signal, id, actorId, expectedGroup, {offset, revision}),
    [request, id, actorId, expectedGroup, offset, revision]);
  const {result, retry} = useOperationRead(JSON.stringify([scope, offset, revision]), allowed, load,
    {invalidResponse: 'The membership or its complete payment history could not be verified.'});
  const data = result?.status === 'success' ? result.value : null;
  const pages = Math.max(1, Math.ceil((data?.totalCount ?? 0) / memberStatementPageSize));
  const current = offset / memberStatementPageSize + 1;
  const changePage = (next: number) => data && setSelected({scope, offset: (next - 1) * memberStatementPageSize, revision: data.revision});
  const restart = () => {
    setSelected(null);
    retry();
  };
  const profileQuery = returnTo ? '?' + new URLSearchParams({returnTo}) : '';
  return <>
    <PageHeader title="Member statement" subtitle={data?.name ?? undefined}
      actions={<Button onClick={() => navigate(isId(id) ? '/admin/members/' + id + profileQuery : '/admin/members')}>Back to member</Button>} />
    {!allowed ? <ErrorState title="Access unavailable" message="This account cannot open this member statement." /> :
      !result ? <LoadingState label="Loading member statement" /> :
      result.status === 'error' ? <ErrorState message={result.message} onRetry={restart} /> : data && <Card><div className="core-detail">
        <h2>{data.membership.groupTitle ?? 'Membership'}</h2>
        <dl><div><dt>Record ID</dt><dd>{data.membership.recordNumber ?? 'Unavailable'}</dd></div>
          <div><dt>Closing balance</dt><dd>{statementAmount(data.closingRwf, true)}</dd></div></dl>
        <p>Incoming payments allocated to this member in this group are credits. Outgoing payments are debits.</p>
        {!data.items.length ? <EmptyState title="No member transactions" description="No payments have been allocated to this membership." /> : <>
          <div className="admin-table-wrap" role="region" aria-label="Member transactions" tabIndex={0}>
            <table className="admin-table member-statement-table" aria-label="Member transactions"><thead><tr>
              {['Date (Kigali)', 'Reference', 'Debit (RWF)', 'Credit (RWF)', 'Balance (RWF)'].map(heading =>
                <th scope="col" key={heading}>{heading}</th>)}
            </tr></thead><tbody>{data.items.map(payment => {
              const formatted = paymentTime(payment.atRaw);
              return <tr key={payment.id}><td>{formatted}
                {payment.atRaw?.trim() && formatted !== payment.atRaw && <small className="statement-source-time">{payment.atRaw}</small>}</td>
                <td>{payment.ftId?.trim() ? payment.ftId : 'Not recorded'}</td>
                <td>{payment.direction === 'outgoing' ? statementAmount(payment.amountRwf) : '—'}</td>
                <td>{payment.direction === 'incoming' ? statementAmount(payment.amountRwf) : '—'}</td>
                <td>{statementAmount(payment.balanceRwf)}</td></tr>;
            })}</tbody></table>
          </div>
          {pages > 1 && <nav className="core-pager" aria-label="Member statement pages">
            <span>Page {current} of {pages}</span><div>
              <Button disabled={current === 1} onClick={() => changePage(current - 1)}>Previous</Button>
              <Button disabled={current === pages} onClick={() => changePage(current + 1)}>Next</Button>
            </div></nav>}
        </>}
      </div></Card>}
  </>;
}
