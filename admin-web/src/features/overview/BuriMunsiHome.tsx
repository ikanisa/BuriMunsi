import {useCallback, useState} from 'react';
import {Link} from 'react-router';
import {z} from 'zod';
import {useSession} from '../../session/SessionProvider';
import {hasScopedAdminAuthority} from '../../session/ownerIdentity';
import {canDisplaySessionRecords, canReadSmsEvidence} from '../../session/sessionContext';
import {Button, Card, Dialog, EmptyState, ErrorState, Icon, LoadingState, PageHeader, StatusBadge} from '../../ui';
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
type WalletTotals = z.output<typeof snapshot>['paymentTotals'];

function amountRwf(value: number | bigint | null | undefined) {
  return value == null ? 'Unavailable' : 'RWF ' + amountFormat.format(value);
}

function Figure({label, icon, value, to, onOpen, paymentMetric}:
  {label: string; icon: string; value: number | bigint | null; to?: string;
    onOpen?: () => void; paymentMetric?: 'incoming' | 'outgoing' | 'sms-balance'}) {
  const className = 'overview-metric overview-metric-card';
  const formatted = paymentMetric ? amountRwf(value) : value === null ? 'Unavailable' : amountFormat.format(value);
  const longAmount = paymentMetric && formatted.length > 15 ? true : undefined;
  const iconLabel = <><Icon name={icon} /><span className="overview-metric-label">{label}</span></>;
  if (onOpen) return <button type="button" className={className + ' overview-metric-opener'} data-payment-metric={paymentMetric}
    title={label} aria-label={label + ' · ' + formatted} aria-haspopup="dialog" onClick={onOpen}>
    <span className="overview-metric-icon">{iconLabel}</span>
    <span className="overview-metric-value" data-long-amount={longAmount}>{formatted}</span>
  </button>;
  const content = <dl><dt title={label}>{iconLabel}</dt><dd data-long-amount={longAmount}>{formatted}</dd></dl>;
  return to ? <Link className={className + ' overview-metric-card--link'} data-payment-metric={paymentMetric} to={to}>{content}</Link> :
    <div className={className} data-payment-metric={paymentMetric}>{content}</div>;
}

function WalletOverview({totals, sms, interactive, canOpenSms}:
  {totals: WalletTotals; sms: boolean; interactive: boolean; canOpenSms: boolean}) {
  const [open, setOpen] = useState(false);
  const balance = totals?.latestSmsBalanceRwf;
  const gap = sms && balance != null ? totals?.walletGapRwf : null;
  const discrepancy = gap != null && gap !== 0n;
  const openDetails = interactive && sms ? () => setOpen(true) : undefined;
  const difference = <StatusBadge tone="warning"><span>Wallet difference · {amountRwf(gap)}</span></StatusBadge>;
  return <>
    <div className="overview-metrics overview-payment-metrics">
      <Figure label="Cumulative incoming payments" icon="incoming" value={totals?.incomingRwf ?? null}
        to={buriMunsiPaymentsPath + '?direction=incoming'} paymentMetric="incoming" />
      <Figure label="Cumulative outgoing payments" icon="outgoing" value={totals?.outgoingRwf ?? null}
        to={buriMunsiPaymentsPath + '?direction=outgoing'} paymentMetric="outgoing" />
      {sms && <Figure label="Latest MoMo SMS balance" icon="message" value={balance ?? null}
        onOpen={openDetails} paymentMetric="sms-balance" />}
    </div>
    {discrepancy && <p className="overview-wallet-status" role="status">
      {openDetails ? <button className="overview-wallet-trigger" type="button" aria-haspopup="dialog"
        onClick={openDetails}>{difference}</button> : difference}
    </p>}
    {sms && interactive && <Dialog open={open} placement="picker" title="Wallet details" onClose={() => setOpen(false)}
      footer={canOpenSms && <Link className="admin-btn admin-btn--primary overview-wallet-action" to={buriMunsiSmsPath}>
        <Icon name="message" />Open SMS inbox</Link>}>
      <dl className="overview-wallet-details">
        <div className="overview-wallet-balance"><dt>Latest verified SMS balance</dt><dd>{amountRwf(balance)}</dd></div>
        <div><dt>Cumulative incoming payments</dt><dd>{amountRwf(totals?.incomingRwf)}</dd></div>
        <div><dt>Cumulative outgoing payments</dt><dd>{amountRwf(totals?.outgoingRwf)}</dd></div>
        <div className="overview-wallet-difference" data-discrepancy={discrepancy || undefined}>
          <dt>Wallet difference</dt><dd>{amountRwf(gap)}</dd>
        </div>
      </dl>
      <p className="overview-wallet-basis">The difference is incoming payments minus outgoing payments minus the latest verified SMS balance.</p>
    </Dialog>}
  </>;
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
          {payments && <WalletOverview key={authority} totals={totals} sms={sms}
            interactive={session.status === 'authenticated'} canOpenSms={canOpenSms} />}
        </section>
        {payments && <Card className="operations-records admin-content-enter"><div className="operations-toolbar"><h2>Recent payments</h2>
          <Link className="operations-link" to={buriMunsiPaymentsPath}>View all payments</Link></div>
          {result.value.recentPayments.length ? <BuriMunsiPaymentRows rows={result.value.recentPayments} /> :
            <EmptyState title="No payments yet" />}
        </Card>}
      </>}
  </>;
}
