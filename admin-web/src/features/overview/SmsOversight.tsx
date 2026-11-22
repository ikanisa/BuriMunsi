import {useCallback, useContext, useEffect, useRef, useState} from 'react';
import {InteractionSuspendedContext} from '../../ui/useFocusScope';
import {useVisibleOperationsRefresh} from '../operations/useVisibleOperationsRefresh';
import type {AdminRequest} from '../../api/client';
import {Button, Card, ErrorState, LoadingState} from '../../ui';
import {assistedLabels, nativeLabels, parseSmsOversight, payerLabels, receiptLabels, reasonLabels, type Oversight} from './smsOversightContract';

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
export function SmsOversight({request, permissions, authorityKey}: {request: AdminRequest; permissions: readonly string[]; authorityKey: string}) {
  const allowed = permissions.includes('system_health.read'), suspended = useContext(InteractionSuspendedContext);
  const [revision, setRevision] = useState(0), [now, setNow] = useState(Date.now);
  const [state, setState] = useState<{scope: string; access: string; sample: Oversight | null; error: boolean} | null>(null);
  const inFlight = useRef<AbortController | null>(null), invalidated = useRef(false);
  const refresh = useCallback((changed: boolean) => {
    setNow(Date.now());
    if (inFlight.current) {if (changed) invalidated.current = true;}
    else setRevision(value => value + 1);
  }, []);
  useVisibleOperationsRefresh(allowed && !suspended, 5000, refresh);
  const access = JSON.stringify([authorityKey, permissions.includes('sms.read')]), scope = JSON.stringify([access, revision]);
  const current = state?.scope === scope || (state?.access === access && !state?.error) ? state : null;
  useEffect(() => {
    if (!allowed || suspended) return;
    const controller = new AbortController(); inFlight.current = controller;
    invalidated.current = false;
    void request('oversight/health?evidenceVersion=2', {authenticated: true, expectedStatus: 200, signal: controller.signal})
      .then(parseSmsOversight)
      .then(sample => {if (!controller.signal.aborted) setState({scope, access, sample, error: false});})
      .catch(() => {if (!controller.signal.aborted) setState({scope, access, sample: null, error: true});})
      .finally(() => {
        if (inFlight.current !== controller) return;
        inFlight.current = null;
        if (invalidated.current && document.visibilityState === 'visible' && navigator.onLine) setRevision(value => value + 1);
      });
    return () => {controller.abort(); if (inFlight.current === controller) inFlight.current = null;};
  }, [access, allowed, request, scope, suspended]);
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
          {(sample.operations || sample.payer) && <section aria-label="BuriMunsi payer receipts" className="overview-oversight-section">
            <h3>BuriMunsi payer receipts</h3>
            {sample.operations ? <>
              <QueueCounts labels={receiptLabels} counts={sample.operations.payer} />
              {sample.operations.oldest !== null && <p>Oldest pending payer receipt is {formatAge(sample.operations.oldest)} old.</p>}
              {Object.keys(sample.operations.reasons).length > 0 && <details><summary>Receipt reasons</summary><dl className="overview-oversight-counts">
                {Object.entries(sample.operations.reasons).map(([key, n]) => <div key={key}><dt>{reasonLabels[key as keyof typeof reasonLabels]}</dt><dd>{n}</dd></div>)}
              </dl></details>}
            </> : sample.payer && <QueueCounts labels={payerLabels} counts={sample.payer} />}
            <p>Reported delivery requires a delivery report for every SMS part from the gateway handset.</p>
          </section>}
          {sample.operations && <section className="overview-oversight-section" aria-label="Scheduled processing">
            <h3>Scheduled processing</h3><dl className="overview-oversight-counts">
              <div><dt>Scheduler</dt><dd>{sample.operations.schedulerEnabled ? 'Enabled' : 'Paused'}</dd></div>
              <div><dt>Cron job</dt><dd>{sample.operations.cronActive ? 'Active' : 'Inactive'}</dd></div>
              <div><dt>Scheduler interval</dt><dd>{sample.operations.cronIntervalSeconds === null ? 'Unverified' : formatAge(sample.operations.cronIntervalSeconds)}</dd></div>
              <div><dt>Unresolved dispatches</dt><dd>{sample.operations.unresolvedDispatches}</dd></div>
              <div><dt>Last confirmed scheduled run</dt><dd>{sample.operations.lastConfirmedAt ? checkedAtFormatter.format(new Date(sample.operations.lastConfirmedAt)) + ' Kigali' : 'None recorded'}</dd></div>
              <div><dt>Receipt gateway</dt><dd>{{not_recorded:'No heartbeat recorded',recent:'Recent heartbeat',stale:'Stale heartbeat'}[sample.operations.gatewayHeartbeat]}</dd></div>
              <div><dt>Last receipt gateway heartbeat</dt><dd>{sample.operations.gatewayLastSeenAt ? checkedAtFormatter.format(new Date(sample.operations.gatewayLastSeenAt)) + ' Kigali' : 'None recorded'}</dd></div>
            </dl>{sample.operations.lastConfirmedDigest && <details><summary>Confirmed response digest</summary><code>{sample.operations.lastConfirmedDigest}</code></details>}
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
        {!sample.operations && <p>Worker activity and provider availability are not verified.</p>}
      </>}
  </Card>;
}
