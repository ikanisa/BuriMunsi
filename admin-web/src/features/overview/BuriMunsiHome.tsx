import {useCallback} from 'react';
import {Link} from 'react-router';
import {z} from 'zod';
import {useSession} from '../../session/SessionProvider';
import {hasScopedAdminAuthority} from '../../session/ownerIdentity';
import {canDisplaySessionRecords, canReadSmsEvidence} from '../../session/sessionContext';
import {Button, Card, EmptyState, ErrorState, Icon, LoadingState, PageHeader} from '../../ui';
import {BuriMunsiPaymentRows, buriMunsiPaymentsPath, buriMunsiSmsPath} from '../operations/BuriMunsiPaymentRows';
import {buriMunsiPayment} from '../operations/canonicalPaymentAnalysis';
import {useOperationRead} from '../operations/useOperationRead';
import './overview.css';

const count = z.number().int().nonnegative();
const totalRwf = z.string().regex(/^(0|[1-9]\d{0,37})$/).transform(value => BigInt(value));
const snapshot = z.object({
  paymentCount: count, memberCount: count, unallocatedCount: count, recentPayments: z.array(buriMunsiPayment),
  paymentTotals: z.object({incomingRwf:totalRwf,outgoingRwf:totalRwf,latestSmsBalanceRwf:count.nullish()}).optional(),
  asOf: z.string().refine(value => Number.isFinite(Date.parse(value))),
}).refine(value => value.unallocatedCount <= value.paymentCount && value.recentPayments.length <= value.paymentCount &&
  new Set(value.recentPayments.map(row => row.id)).size === value.recentPayments.length);
const amountFormat = new Intl.NumberFormat('en-RW');

function Figure({label, icon, value, to, paymentMetric}:
  {label: string; icon: string; value: number | bigint | null; to?: string;
    paymentMetric?: 'incoming' | 'outgoing' | 'sms-balance'}) {
  const className = 'overview-metric overview-metric-card';
  const content = <dl><dt title={label}><Icon name={icon} /><span className="admin-sr-only">{label}</span></dt>
    <dd>{value === null ? 'Unavailable' : (paymentMetric ? 'RWF ' : '') + amountFormat.format(value)}</dd></dl>;
  return to ? <Link className={className + ' overview-metric-card--link'} data-payment-metric={paymentMetric} to={to}>{content}</Link> :
    <div className={className} data-payment-metric={paymentMetric}>{content}</div>;
}

export function BuriMunsiHome() {
  const session = useSession(), {request, epoch, user} = session;
  const visible = canDisplaySessionRecords(session) && !!user?.permissions.includes('overview.read');
  const payments = !!user?.permissions.includes('payments.read');
  const load = useCallback(async (signal: AbortSignal) => snapshot.parse(await request('burimunsi/home', {signal})), [request]);
  const sms = canReadSmsEvidence(user);
  const collection = visible && user && sms && hasScopedAdminAuthority(user) ? user.adminIdentity?.collectionId : undefined;
  const authority=JSON.stringify([epoch,user?.id,user?.sessionId,user?.role,collection,[...(user?.permissions ?? [])].sort()]);
  const {result, retry} = useOperationRead('burimunsi-home:' + authority, visible, load);
  const canOpenSms=!!collection && session.status==='authenticated';
  const totals = result?.status === 'success' ? result.value.paymentTotals : undefined;
  return <><PageHeader title="Home" actions={<Button icon="refresh" aria-label="Refresh Home" onClick={retry} />} />
    {!visible ? <ErrorState title="Access unavailable" message="Your account cannot view the group snapshot." /> : !result ? <LoadingState label="Loading Home" /> :
      result.status === 'error' ? <ErrorState message={result.message} onRetry={retry} /> : <>
        <section className="overview-summary" aria-label="Group snapshot">
          <div className="overview-metrics">
            {payments && <Figure label="Payments" icon="swap" value={result.value.paymentCount} to={buriMunsiPaymentsPath} />}
            <Figure label="Members" icon="users" value={result.value.memberCount} to={user?.permissions.includes('users.read') ? '/admin/members' : undefined} />
            {payments && <Figure label="Unallocated" icon="unlinked" value={result.value.unallocatedCount} to={buriMunsiPaymentsPath + '?status=unallocated'} />}
          </div>
          {payments && <div className="overview-metrics overview-payment-metrics">
            <Figure label="Cumulative incoming payments" icon="incoming" value={totals?.incomingRwf ?? null}
              to={buriMunsiPaymentsPath + '?direction=incoming'} paymentMetric="incoming" />
            <Figure label="Cumulative outgoing payments" icon="outgoing" value={totals?.outgoingRwf ?? null}
              to={buriMunsiPaymentsPath + '?direction=outgoing'} paymentMetric="outgoing" />
            {sms && <Figure label="Latest MoMo SMS balance" icon="message" value={totals?.latestSmsBalanceRwf ?? null}
              to={canOpenSms ? buriMunsiSmsPath : undefined} paymentMetric="sms-balance" />}
          </div>}
        </section>
        {payments && <Card className="operations-records"><div className="operations-toolbar"><h2>Recent payments</h2>
          <Link className="operations-link" to={buriMunsiPaymentsPath}>View all payments</Link></div>
          {result.value.recentPayments.length ? <BuriMunsiPaymentRows rows={result.value.recentPayments} /> :
            <EmptyState title="No payments yet" />}
        </Card>}
      </>}
  </>;
}
