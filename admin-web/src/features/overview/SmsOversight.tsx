import {useCallback, useContext, useEffect, useId, useRef, useState} from 'react';
import {InteractionSuspendedContext} from '../../ui/useFocusScope';
import {useVisibleOperationsRefresh} from '../operations/useVisibleOperationsRefresh';
import {AdminRequestError, type AdminRequest} from '../../api/client';
import {Link} from 'react-router';
import {Icon} from '../../ui';
import {kigaliTime} from './kigaliTime';
import {parseSmsOversight, type Oversight} from './smsOversightContract';

const SAMPLE_MAX_AGE_MS = 60_000;

export function SmsOversight({request, permissions, authorityKey, preferSmsHealth, refreshGeneration = 0}: {request: AdminRequest; permissions: readonly string[]; authorityKey: string; preferSmsHealth?: boolean; refreshGeneration?: number}) {
  const allowed = permissions.includes('system_health.read'), suspended = useContext(InteractionSuspendedContext);
  const descriptionId = useId();
  const [revision, setRevision] = useState(0), [now, setNow] = useState(Date.now);
  const [state, setState] = useState<{scope: string; access: string; sample: Oversight | null; error: boolean} | null>(null);
  const legacyAuthority = useRef<string | null>(null);
  const inFlight = useRef<AbortController | null>(null), invalidated = useRef(false);
  const refresh = useCallback((changed: boolean) => {
    setNow(Date.now());
    if (inFlight.current) {if (changed) invalidated.current = true;}
    else setRevision(value => value + 1);
  }, []);
  useVisibleOperationsRefresh(allowed && !suspended, preferSmsHealth ? 30_000 : 5000, refresh);
  const hasSmsRead = permissions.includes('sms.read');
  const access = JSON.stringify([authorityKey, hasSmsRead]), scope = JSON.stringify([access, revision, refreshGeneration]);
  const current = state?.scope === scope || (state?.access === access && !state?.error) ? state : null;
  useEffect(() => {
    if (!allowed || suspended) return;
    const controller = new AbortController(); inFlight.current = controller;
    invalidated.current = false;
    const options = {authenticated: true, expectedStatus: 200, signal: controller.signal};
    const read = async () => {
      if (hasSmsRead) return parseSmsOversight(await request('oversight/health?evidenceVersion=2', options));
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
      .then(sample => {if (!controller.signal.aborted) {setNow(Date.now()); setState({scope, access, sample, error: false});}})
      .catch(() => {if (!controller.signal.aborted) setState({scope, access, sample: null, error: true});})
      .finally(() => {
        if (inFlight.current !== controller) return;
        inFlight.current = null;
        if (invalidated.current && document.visibilityState === 'visible' && navigator.onLine) setRevision(value => value + 1);
      });
    return () => {controller.abort(); if (inFlight.current === controller) inFlight.current = null;};
  }, [access, allowed, authorityKey, hasSmsRead, preferSmsHealth, request, scope, suspended]);
  const sample = current?.sample;
  const checked = sample ? Date.parse(sample.checkedAt) : NaN;
  const fresh = Number.isFinite(checked) && now >= checked - 5000 && now < checked + SAMPLE_MAX_AGE_MS;
  useEffect(() => {
    if (!allowed || !Number.isFinite(checked)) return;
    const update = () => setNow(Date.now());
    const left = checked + SAMPLE_MAX_AGE_MS - Date.now();
    // Expire a report even when offline polling has stopped.
    const timer = left > 0 && left <= SAMPLE_MAX_AGE_MS + 5000 ? window.setTimeout(update, left) : undefined;
    window.addEventListener('pageshow', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('pageshow', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [allowed, checked]);

  if (!allowed) return null;
  let status = 'Checking SMS…';
  if (current?.error) status = 'SMS status could not be verified';
  else if (sample && !fresh) status = 'Last SMS check is out of date';
  else if (sample) {
    const native = sample.native?.counts;
    if (sample.parsing === 'disabled') status = 'Native SMS processing disabled';
    else if (sample.parsing === 'unknown' || !native) status = 'SMS processing not verified';
    else if (native.blocked || native.unmatched) status = 'Some SMS need attention';
    else if (native.pending || native.retrying) status = 'SMS processing pending';
    else status = 'No pending or unresolved SMS at last check';
  }
  const summary = <>
    <Icon name="message" />
    <p id={descriptionId}>
      <strong>SMS</strong> <span role="status">{status}</span>
      {sample && <small>Checked <time dateTime={sample.checkedAt}>{kigaliTime.format(new Date(sample.checkedAt))} Kigali</time></small>}
    </p>
  </>;
  const rowClass = 'overview-sms-row overview-evidence-card';
  return <section className="overview-sms" aria-label="SMS processing status">
    {hasSmsRead ? <Link className={rowClass} to="/admin/payments?view=sms" aria-label="Open SMS evidence" aria-describedby={descriptionId}>
      {summary}
      <span className="overview-card-action" aria-hidden="true"><Icon name="chevron" /></span>
    </Link> : <div className={rowClass}>{summary}</div>}
  </section>;
}
