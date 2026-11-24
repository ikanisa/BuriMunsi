import {useEffect, useId, useState, useSyncExternalStore} from 'react';
import {Link} from 'react-router';
import type {AdminRequest} from '../../api/client';
import {Button, ErrorState, Icon, LoadingState, PageHeader} from '../../ui';
import {canReadSmsEvidence} from '../../session/sessionContext';
import type {FeatureAccess, FinancialModel} from '../core/types';
import {formatOverviewValue, parseOverview, type OverviewData, type OverviewMetric} from './overview';
import {SmsOversight} from './SmsOversight';
import {kigaliDate, kigaliTime} from './kigaliTime';
import './overview.css';

function subscribeKigaliDate(update: () => void) {
  const timer = window.setInterval(update, 60_000);
  document.addEventListener('visibilitychange', update);
  window.addEventListener('pageshow', update);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', update);
    window.removeEventListener('pageshow', update);
  };
}
const currentKigaliDate = () => kigaliDate.format(new Date());

function SummaryMetric({metric, label, large, link}: {metric: OverviewMetric; label: string; large?: boolean; link?: {to: string; label: string}}) {
  const metricId = useId();
  const cardClass = `overview-metric overview-metric-card${large ? ' overview-metric--primary' : ''}`;
  const figure = <dl id={metricId}><dt>{label}</dt><dd>{formatOverviewValue(metric)}</dd></dl>;
  if (!link) return <div className={cardClass}>{figure}</div>;
  return <Link className={`${cardClass} overview-metric-card--link`} to={link.to}
    aria-label={link.label} aria-describedby={metricId}>
    {figure}
    <span className="overview-card-action">{link.label}<Icon name="chevron" /></span>
  </Link>;
}

export function OverviewPage({request, permissions, role, financialModel, authorityKey, preferSmsHealth}: {
  request: AdminRequest; permissions: readonly string[]; role: FeatureAccess['role']; financialModel: FinancialModel; authorityKey: string; preferSmsHealth?: boolean;
}) {
  const [result, setResult] = useState<{scope: string; data: OverviewData | null; error: string} | null>(null);
  const [generation, setGeneration] = useState(0);
  const measuredAtId = useId();
  const today = useSyncExternalStore(subscribeKigaliDate, currentKigaliDate);
  const allowed = permissions.includes('overview.read');
  const canReadPayments = permissions.includes('payments.read');
  const canReadReconciliation = permissions.includes('reconciliations.read');
  const canReadPeople = permissions.includes('users.read');
  const canReadSms = canReadSmsEvidence({role, permissions});
  const hasHealth = role !== 'staff' && permissions.includes('system_health.read');
  const scope = JSON.stringify([authorityKey, financialModel, generation, canReadPayments, canReadReconciliation, canReadPeople, canReadSms, allowed]);
  const current = result?.scope === scope ? result : null;
  const loading = allowed && current === null;
  const refresh = () => setGeneration(value => value + 1);

  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void request('core/overview', {authenticated: true, signal: controller.signal})
      .then((value) => {if (!controller.signal.aborted) setResult({scope, data: parseOverview(value, financialModel), error: ''});})
      .catch(() => {if (!controller.signal.aborted) setResult({scope, data: null, error: 'The workspace snapshot could not be verified.'});});
    return () => controller.abort();
  }, [allowed, financialModel, request, scope]);

  if (!allowed) return <><PageHeader title="Home" /><ErrorState title="Access unavailable" message="Your account cannot view workspace totals." /></>;
  const data = current?.data;
  const find = (name: string) => data?.metrics.find(metric => metric.key === name);
  const canonical = financialModel === 'canonical_evidence_ledger';
  const contributions = canReadPayments ? find(canonical ? 'total_net_contributions_rwf' : 'total_posted_contributions_rwf') : undefined;
  const activeMembers = find('active_members');
  const attention = canonical
    ? (canReadReconciliation ? find('unallocated_transactions') : undefined)
    : (canReadSms ? find('receipts_needing_review') : undefined);
  const attentionLink = attention && attention.value !== '0'
    ? {to: canonical ? '/admin/payments?view=attention&status=all' : '/admin/payments?view=sms', label: canonical ? 'Open reconciliation' : 'Review SMS receipts'}
    : undefined;
  return <>
    <PageHeader title="Home" subtitle={`Today in Kigali · ${today}`}
      actions={current?.error && !hasHealth ? undefined
        : <Button className="overview-refresh" icon="refresh" disabled={loading} aria-label="Refresh Home" onClick={refresh} />} />
    {loading ? <LoadingState label="Loading workspace snapshot" /> : current?.error ?
      <ErrorState message={current.error} onRetry={hasHealth ? undefined : refresh} /> : data && <section className="overview-summary" aria-label="Workspace snapshot" aria-describedby={measuredAtId}>
        <time hidden id={measuredAtId} dateTime={data.measuredAt}>Measured {kigaliTime.format(new Date(data.measuredAt))} Kigali</time>
        <div className="overview-metrics">
          {contributions && <SummaryMetric metric={contributions} label={contributions.label} large link={{to: '/admin/payments', label: 'Open payments'}} />}
          {activeMembers && <SummaryMetric metric={activeMembers} label="Active members" link={canReadPeople ? {to: '/admin/members', label: 'Open members'} : undefined} />}
          {attention && <SummaryMetric metric={attention} label={canonical ? 'Unallocated payments' : attention.label} link={attentionLink} />}
        </div>
      </section>}
    {hasHealth && <SmsOversight request={request} permissions={permissions} authorityKey={authorityKey} preferSmsHealth={preferSmsHealth} refreshGeneration={generation} />}
  </>;
}
