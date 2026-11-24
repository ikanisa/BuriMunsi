import {useCallback} from 'react';
import {Link} from 'react-router';
import {z} from 'zod';
import {useSession} from '../../session/SessionProvider';
import {hasScopedAdminAuthority} from '../../session/ownerIdentity';
import {canDisplaySessionRecords, canReadSmsEvidence} from '../../session/sessionContext';
import {Button, Card, EmptyState, ErrorState, LoadingState, PageHeader} from '../../ui';
import {BuriMunsiPaymentRows, buriMunsiPayment, buriMunsiPaymentsPath, buriMunsiSmsPath} from '../operations/BuriMunsiPayments';
import {receiverPage} from '../operations/receiverSmsContract';
import {useOperationRead} from '../operations/useOperationRead';
import './overview.css';

const count = z.number().int().nonnegative();
const snapshot = z.object({
  paymentCount: count, memberCount: count, unallocatedCount: count, recentPayments: z.array(buriMunsiPayment),
  asOf: z.string().refine(value => Number.isFinite(Date.parse(value))),
}).refine(value => value.unallocatedCount <= value.paymentCount && value.recentPayments.length <= value.paymentCount &&
  new Set(value.recentPayments.map(row => row.id)).size === value.recentPayments.length);
const smsHealthLabels = {
  unknown: 'Inbox status unknown', checking: 'Checking Admin inbox',
  incomplete: 'Sync pending', verified: 'Last inbox check matched',
} as const;

function Figure({label, value, to}: {label: string; value: number; to?: string}) {
  const content = <dl><dt>{label}</dt><dd>{value.toLocaleString('en-RW')}</dd></dl>;
  return to ? <Link className="overview-metric overview-metric-card overview-metric-card--link" to={to}>{content}</Link> :
    <div className="overview-metric overview-metric-card">{content}</div>;
}

export function BuriMunsiHome() {
  const session = useSession(), {request, epoch, user} = session;
  const visible = canDisplaySessionRecords(session) && !!user?.permissions.includes('overview.read');
  const payments = !!user?.permissions.includes('payments.read');
  const load = useCallback(async (signal: AbortSignal) => snapshot.parse(await request('burimunsi/home', {signal})), [request]);
  const {result, retry} = useOperationRead(`${epoch}:burimunsi-home`, visible, load);
  const collection = visible && user && canReadSmsEvidence(user) && hasScopedAdminAuthority(user) ? user.adminIdentity?.collectionId : undefined;
  const loadSmsHealth = useCallback(async (signal: AbortSignal) => {
    if (!collection) throw new Error('SMS scope is unavailable.');
    const query = new URLSearchParams({collectionId: collection, limit: '1', includeProcessing: '1'});
    return receiverPage(await request(`momo/observations?${query}`, {signal}), collection).inboxCheck;
  }, [collection, request]);
  const {result: health, retry: retryHealth} = useOperationRead(`${epoch}:burimunsi-sms-health:${collection}`, !!collection, loadSmsHealth);
  const smsHealth = health?.status === 'success' ? smsHealthLabels[health.value.state] :
    health?.status === 'error' ? 'Status unavailable' : 'Checking sync';
  return <><PageHeader title="Home" actions={<Button icon="refresh" aria-label="Refresh Home" onClick={() => {retry(); if (collection) retryHealth();}} />} />
    {collection && <p className="operations-note"><Link className="operations-link" to={buriMunsiSmsPath}>M-Money SMS</Link>
      {' · '}<span role="status">{smsHealth}</span></p>}
    {!visible ? <ErrorState title="Access unavailable" message="Your account cannot view the group snapshot." /> : !result ? <LoadingState label="Loading Home" /> :
      result.status === 'error' ? <ErrorState message={result.message} onRetry={retry} /> : <>
        <section className="overview-summary" aria-label="Group snapshot">
          <div className="overview-metrics">
            {payments && <Figure label="Payments" value={result.value.paymentCount} to={buriMunsiPaymentsPath} />}
            <Figure label="Members" value={result.value.memberCount} to={user?.permissions.includes('users.read') ? '/admin/members' : undefined} />
            {payments && <Figure label="Unallocated" value={result.value.unallocatedCount} to={buriMunsiPaymentsPath + '?status=unallocated'} />}
          </div>
        </section>
        {payments && <Card className="operations-records"><div className="operations-toolbar"><h2>Recent payments</h2>
          <Link className="operations-link" to={buriMunsiPaymentsPath}>View all payments</Link></div>
          {result.value.recentPayments.length ? <BuriMunsiPaymentRows rows={result.value.recentPayments} /> :
            <EmptyState title="No payments yet" />}
        </Card>}
      </>}
  </>;
}
