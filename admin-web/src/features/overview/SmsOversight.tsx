import {useEffect, useRef, useState} from 'react';
import {AdminRequestError, type AdminRequest} from '../../api/client';
import {Button, Card, ErrorState, LoadingState} from '../../ui';
import {assistedLabels, nativeLabels, parseSmsOversight, payerLabels, type Oversight} from './smsOversightContract';

const checkedAtFormatter = new Intl.DateTimeFormat('en-GB', {timeZone: 'Africa/Kigali', dateStyle: 'medium', timeStyle: 'short'});

function formatAge(seconds: number | null): string {
  if (seconds === null) return 'None recorded';
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  return `${Math.floor(seconds / 86400)} d ${Math.floor((seconds % 86400) / 3600)} h`;
}

function QueueCounts<Key extends string>({labels, counts}: {labels: Record<Key, string>; counts: Record<Key, number>}) {
  return <dl className="overview-oversight-counts">{(Object.keys(labels) as Key[]).map(key =>
    <div key={key}><dt>{labels[key]}</dt><dd>{counts[key].toLocaleString('en-US')}</dd></div>
  )}</dl>;
}

/** Metadata only: a stale sample never presents counts as current. */
export function SmsOversight({request, permissions, authorityKey, preferSmsHealth}: {request: AdminRequest; permissions: readonly string[]; authorityKey: string; preferSmsHealth?: boolean}) {
  const allowed = permissions.includes('system_health.read');
  const [revision, setRevision] = useState(0), [now, setNow] = useState(Date.now);
  const [state, setState] = useState<{scope: string; sample: Oversight | null; error: boolean} | null>(null);
  const legacyAuthority = useRef<string | null>(null);
  const scope = JSON.stringify([authorityKey, revision]); const current = state?.scope === scope ? state : null;
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    const options = {authenticated: true, expectedStatus: 200, signal: controller.signal};
    const read = async () => {
      if (preferSmsHealth && legacyAuthority.current !== authorityKey) {
        try {return parseSmsOversight(await request('oversight/sms-health', options), 'admin_sms_health');}
        catch (failure) {
          if (controller.signal.aborted || !(failure instanceof AdminRequestError) || failure.statusCode !== 404 ||
              !['oversight_not_found', 'proxy_route_not_allowed'].includes(failure.code ?? '')) throw failure;
          legacyAuthority.current = authorityKey;
        }
      }
      return parseSmsOversight(await request('oversight/health', options));
    };
    void read()
      .then(sample => {if (!controller.signal.aborted) setState({scope, sample, error: false});})
      .catch(() => {if (!controller.signal.aborted) setState({scope, sample: null, error: true});});
    return () => controller.abort();
  }, [allowed, authorityKey, preferSmsHealth, request, scope]);
  useEffect(() => {
    if (!allowed) return;
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, [allowed]);
  if (!allowed) return null;
  const sample = current?.sample;
  const checked = sample ? Date.parse(sample.checkedAt) : NaN;
  const fresh = Number.isFinite(checked) && now >= checked - 5000 && now < checked + 60000;
  return <Card className="overview-oversight"><div className="overview-oversight-heading"><h2>SMS oversight</h2>
    <Button icon="refresh" onClick={() => {setNow(Date.now()); setRevision(value => value + 1);}}>Refresh SMS oversight</Button></div>
    {!current ? <LoadingState label="Loading SMS oversight" /> : current.error ?
      <ErrorState message="SMS oversight could not be verified." onRetry={() => setRevision(value => value + 1)} /> : sample && <>
        <p className="overview-measured">Checked {checkedAtFormatter.format(new Date(sample.checkedAt))} Kigali</p>
        {!fresh ? <p role="status">Sample expired. Refresh for current counts.</p> : <>
          <section aria-label="BuriMunsi SMS processing" className="overview-oversight-section">
            <h3>BuriMunsi SMS processing</h3>
            {sample.native ? <>
              <QueueCounts labels={nativeLabels} counts={sample.native.counts} />
              <p>{sample.native.oldestPendingSeconds === null
                ? 'No age was recorded for pending, retrying or unmatched items at this check.'
                : `At this check, the oldest pending, retrying or unmatched item was ${formatAge(sample.native.oldestPendingSeconds)} old.`}
                {' '}Internal credits measure ledger postings. Provider settlement is recorded separately.</p>
            </> : <p role="status">BuriMunsi queue measurements are unavailable.</p>}
          </section>
          {sample.payer && <section aria-label="BuriMunsi payer receipts" className="overview-oversight-section">
            <h3>BuriMunsi payer receipts</h3>
            <QueueCounts labels={payerLabels} counts={sample.payer} />
            <p>Recorded gateway observations for approved collections.</p>
          </section>}
          <section aria-label="Assisted receipt delivery" className="overview-oversight-section">
            <h3>Assisted receipt delivery</h3>
            <QueueCounts labels={assistedLabels} counts={sample.counts} />
            {sample.oldestQueuedSeconds !== undefined && <p>Oldest queued at check: {formatAge(sample.oldestQueuedSeconds)}</p>}
            {sample.oldestUnobservedSendSeconds !== undefined && <p>Oldest unconfirmed send at check: {formatAge(sample.oldestUnobservedSendSeconds)}</p>}
            <p>Handset delivery is unverified.</p>
          </section>
          <p>Managed MoMo processing: {sample.managed} · Native SMS parsing: {sample.parsing} · Native SMS ledger: {sample.ledger}</p>
        </>}
        <p>Worker activity and provider availability are not verified.</p>
      </>}
  </Card>;
}
