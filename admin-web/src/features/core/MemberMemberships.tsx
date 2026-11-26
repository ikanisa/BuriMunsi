import {useCallback} from 'react';
import {Link} from 'react-router';
import {CompactText, Button, Card} from '../../ui';
import {useOperationRead} from '../operations/useOperationRead';
import {label} from './contracts';
import {canReadMemberStatement, memberStatementPath, profileMembership, readMemberBalanceProjection, readMemberStatementPage,
  statementAmount, type ProfileMembership} from './memberStatement';
import type {FeatureAccess} from './types';

type MembershipProps = Pick<FeatureAccess, 'request' | 'permissions' | 'authorityKey'> & {
  detail: Record<string, unknown>; memberId: string; expectedGroup?: string; returnTo: string; onRetryBalance?: () => void;
};

function BalanceLink({memberId, returnTo, value, onRetry}:
  Pick<MembershipProps, 'memberId' | 'returnTo'> & {value: bigint | null; onRetry?: () => void}) {
  const amount = statementAmount(value, true);
  const query = returnTo === '/admin/members' ? '' : '?' + new URLSearchParams({returnTo});
  return <><Link className="operations-link" to={memberStatementPath(memberId) + query}
    aria-label={'Open member statement, total balance ' + amount}>{amount}</Link>
    {onRetry && <Button onClick={onRetry}>Retry balance</Button>}</>;
}

function SeparateMembershipBalance({membership, memberId, request, authorityKey, returnTo}:
  Pick<MembershipProps, 'memberId' | 'request' | 'authorityKey' | 'returnTo'> & {membership: ProfileMembership}) {
  const {groupId, id} = membership;
  const load = useCallback(async (signal: AbortSignal) => {
    return (await readMemberStatementPage(request, signal, memberId, {id, groupId})).closingRwf;
  }, [request, memberId, groupId, id]);
  const {result, retry} = useOperationRead(JSON.stringify([authorityKey, groupId, memberId, id]), !!groupId && !!id, load);
  if (!groupId || !id) return <>Unavailable</>;
  if (!result) return <span role="status">Loading balance</span>;
  return <BalanceLink memberId={memberId} returnTo={returnTo} value={result.status === 'success' ? result.value : null}
    onRetry={result.status === 'error' ? retry : undefined} />;
}

function MembershipBalance(props: MembershipProps & {membership: ProfileMembership}) {
  if (!props.membership.groupId || !props.membership.id) return <>Unavailable</>;
  if (!Object.hasOwn(props.detail, 'member_balance')) return <SeparateMembershipBalance {...props} />;
  let amount: bigint | null = null;
  try {amount = readMemberBalanceProjection(props.detail.member_balance, props.memberId, props.membership);}
  catch { /* A mismatched current projection cannot establish a balance. */ }
  return <BalanceLink memberId={props.memberId} returnTo={props.returnTo} value={amount}
    onRetry={amount === null ? props.onRetryBalance : undefined} />;
}

export function MemberMemberships(props: MembershipProps) {
  let membership: ProfileMembership | null;
  try { membership = profileMembership(props.detail, props.memberId, props.expectedGroup); }
  catch { return <Card><div className="core-detail"><h2>Memberships</h2><p role="alert">This membership could not be verified.</p></div></Card>; }
  const financial = canReadMemberStatement(props.permissions);
  return <Card><div className="core-detail"><h2>Memberships</h2>
    {!membership ? <p>No memberships found.</p> : <div className="admin-table-wrap" role="region" aria-label="Memberships records" tabIndex={0}>
      <table className="admin-table"><thead><tr><th scope="col">Record ID</th>{membership.collectId && <th scope="col">Collect ID</th>}
        <th scope="col">Group</th>{membership.memberName && <th scope="col">Name on MoMo</th>}
        <th scope="col">Role</th><th scope="col">Status</th>{financial && <th scope="col">Total balance</th>}</tr></thead>
        <tbody><tr><td>{membership.recordNumber ?? 'Unavailable'}</td>{membership.collectId && <td>{membership.collectId}</td>}
          <td><CompactText cell>{membership.groupTitle ?? 'Not recorded'}</CompactText></td>{membership.memberName && <td><CompactText cell>{membership.memberName}</CompactText></td>}
          <td>{membership.role ? label(membership.role) : 'Not recorded'}</td><td>{membership.status ? label(membership.status) : 'Not recorded'}</td>
          {financial && <td><MembershipBalance {...props} membership={membership} /></td>}</tr></tbody>
      </table></div>}
  </div></Card>;
}
