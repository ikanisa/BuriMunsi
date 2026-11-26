import {useCallback} from 'react';
import {Link} from 'react-router';
import {z} from 'zod';
import {useSession} from '../../session/SessionProvider';
import {hasScopedAdminAuthority} from '../../session/ownerIdentity';
import {canDisplaySessionRecords, canReadSmsEvidence} from '../../session/sessionContext';
import {Button, Card, EmptyState, ErrorState, Icon, LoadingState, PageHeader, StatusBadge} from '../../ui';
import {BuriMunsiPaymentRows, buriMunsiPaymentsPath, buriMunsiSmsPath} from '../operations/BuriMunsiPaymentRows';
import {buriMunsiPayment} from '../operations/canonicalPaymentAnalysis';
import {useOperationRead} from '../operations/useOperationRead';
import './overview.css';

const count = z.number().int().nonnegative();
const totalRwf = z.string().regex(/^(0|[1-9]\d{0,37})$/).transform(value => BigInt(value));
const signedRwf = z.string().regex(/^(0|-?[1-9]\d{0,38})$/).transform(value => BigInt(value));
const snapshot = z.object({
  paymentCount: count, memberCount: count, unallocatedCount: count, recentPayments: z.array(buriMunsiPayment),
  paymentTotals: z.object({
    incomingRwf:totalRwf,outgoingRwf:totalRwf,latestSmsBalanceRwf:count.nullish(),walletGapRwf:signedRwf.nullish(),
  }).optional(),
  asOf: z.string().refine(value => Number.isFinite(Date.parse(value))),
}).refine(value => value.unallocatedCount <= value.paymentCount && value.recentPayments.length <= value.paymentCount &&
  new Set(value.recentPayments.map(row => row.id)).size === value.recentPayments.length);
const amountFormat = new Intl.NumberFormat('en-RW');

function Figure({label, icon, value, to, paymentMetric}:
  {label: string; icon: string; value: number | bigint | null; to?: string;
    paymentMetric?: 'incoming' | 'outgoing' | 'sms-balance'}) {
  const className = 'overview-metric overview-metric-card';
  const formatted = value === null ? 'Unavailable' : (paymentMetric ? 'RWF ' : '') + amountFormat.format(value);
  const content = <dl><dt title={label}><Icon name={icon} /><span className="admin-sr-only">{label}</span></dt>
    <dd data-long-amount={paymentMetric && formatted.length > 15 ? true : undefined}>{formatted}</dd></dl>;
  return to ? <Link className={className + ' overview-metric-card--link'} data-payment-metric={paymentMetric} to={to}>{content}</Link> :
    <div className={className} data-payment-metric={paymentMetric}>{content}</div>;
}

export function BuriMunsiHome() {
  const session = useSession(), {request, takeStartupHome, epoch, user} = session;
  const visible = canDisplaySessionRecords(session) && !!user?.permissions.includes('overview.read');
  const payments = !!user?.permissions.includes('payments.read');
  const sms = canReadSmsEvidence(user);
  const load = useCallback(async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const startup = takeStartupHome?.();
    if (startup) {
      const parsed = snapshot.safeParse(startup.home);
      const totals = parsed.success ? parsed.data.paymentTotals : undefined;
      if (parsed.success && totals && parsed.data.recentPayments.every(row => row.groupId === startup.collectionId && (sms || !row.sourceId)) &&
          (sms ? Object.hasOwn(totals,'latestSmsBalanceRwf') : totals.latestSmsBalanceRwf == null && totals.walletGapRwf == null)) return parsed.data;
    }
    return snapshot.parse(await request('burimunsi/home', {signal}));
  }, [request, takeStartupHome, sms]);
  const collection = visible && user && sms && hasScopedAdminAuthority(user) ? user.adminIdentity?.collectionId : undefined;
  const authority=JSON.stringify([epoch,user?.id,user?.sessionId,user?.role,user?.adminIdentity?.collectionId,[...(user?.permissions ?? [])].sort()]);
  const {result, retry, refreshing} = useOperationRead('burimunsi-home:' + authority, visible, load, {retainDuringRefresh: true});
  const canOpenSms=!!collection && session.status==='authenticated';
  const totals = result?.status === 'success' ? result.value.paymentTotals : undefined;
  const walletGap = sms && totals?.latestSmsBalanceRwf != null ? totals.walletGapRwf : null;
  return <><PageHeader title="Home" actions={<Button icon="refresh" aria-label="Refresh Home" onClick={retry}
    loading={visible && (!result || refreshing)} />} />
    {!visible ? <ErrorState title="Access unavailable" message="Your account cannot view the group snapshot." /> :
      !result ? <LoadingState label="Loading Home" layout="home" homeCards={payments ? [3, sms ? 3 : 2] : [1, 0]} /> :
      result.status === 'error' ? <ErrorState message={result.message} onRetry={retry} /> : <>
        <section className="overview-summary admin-content-enter" aria-label="Group snapshot" aria-busy={refreshing || undefined}>
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
          {payments && walletGap != null && walletGap !== 0n && <p className="overview-wallet-status" role="status">
            <StatusBadge tone="warning"><span>Wallet difference · RWF {amountFormat.format(walletGap)}</span></StatusBadge>
          </p>}
        </section>
        {payments && <Card className="operations-records admin-content-enter"><div className="operations-toolbar"><h2>Recent payments</h2>
          <Link className="operations-link" to={buriMunsiPaymentsPath}>View all payments</Link></div>
          {result.value.recentPayments.length ? <BuriMunsiPaymentRows rows={result.value.recentPayments} /> :
            <EmptyState title="No payments yet" />}
        </Card>}
      </>}
  </>;
}
