import type {ReactNode} from 'react';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {MemoryRouter, Route, Routes} from 'react-router';
import {describe, expect, it, vi} from 'vitest';
import {AdminRequestError} from '../../src/api/client';
import {OperationsLiveContext} from '../../src/features/operations/operationsLiveContext';
import {SmsOversight} from '../../src/features/overview/SmsOversight';
import {parseSmsOversight} from '../../src/features/overview/smsOversightContract';

function renderOversight(node: ReactNode) {
  return render(node, {wrapper: ({children}) => <MemoryRouter>{children}</MemoryRouter>});
}

function sample(checkedAt = new Date().toISOString()) {
  return {contract_version: 1, scope: 'admin_operational_health', metrics_scope: 'all_retained_rows',
    worker_heartbeat: 'not_recorded', external_services_checked: false, checked_at: checkedAt,
    configuration: {momo_processing: 'paused', native_auto_processing: 'disabled', native_sms_ledger: 'disabled'},
    queues: {assisted_sms: {queued: 4, claimed: 1, send_started: 2, uncertain: 1, automatic_retry: false}}};
}

const health = ['system_health.read'];
const healthAndSms = ['system_health.read', 'sms.read'];
const nativeQueue = {pending: 0, retrying: 0, blocked: 0, unmatched: 0, posted: 7, oldest_pending_seconds: null};

describe('SMS oversight', () => {
  it('keeps idle standalone health checks 30 seconds apart and immediately refreshes a receipt change', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({...sample(), scope: 'admin_sms_health'}));
    const disconnected = {connected: () => false, subscribe: () => () => {}};
    const view = renderOversight(<OperationsLiveContext.Provider value={disconnected}>
      <SmsOversight request={request} permissions={['system_health.read','sms.read']} authorityKey="operator" preferSmsHealth />
    </OperationsLiveContext.Provider>);
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(request).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
      expect(request).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(request).toHaveBeenCalledTimes(2);
      await act(async () => { window.dispatchEvent(new Event('burimunsi-operations-changed')); });
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
  it('rejects changed meaning, invalid timestamps and unbounded counts', () => {
    expect(parseSmsOversight(sample()).counts.queued).toBe(4);
    expect(() => parseSmsOversight({...sample(), worker_heartbeat: 'healthy'})).toThrow();
    expect(() => parseSmsOversight({...sample(), checked_at: '2026-02-31T00:00:00.000Z'})).toThrow();
    const bad = sample(); bad.queues.assisted_sms.queued = -1;
    expect(() => parseSmsOversight(bad)).toThrow();
  });

  it('shows the time and status without an evidence link to health-only viewers, and hides them when access is lost', async () => {
    const body = sample(), request = vi.fn(async () => body);
    const {rerender} = renderOversight(<SmsOversight request={request} permissions={health} authorityKey="session-a" />);
    const region = screen.getByRole('region', {name: 'SMS processing status'});
    expect(within(region).getByRole('status')).toHaveTextContent('Checking SMS…');
    expect(await within(region).findByText('Native SMS processing disabled')).toBeVisible();
    expect(within(region).getByText(/Kigali/)).toHaveAttribute('datetime', body.checked_at);
    expect(within(region).queryByRole('link')).not.toBeInTheDocument();
    rerender(<SmsOversight request={request} permissions={[]} authorityKey="session-b" />);
    expect(screen.queryByRole('region', {name: 'SMS processing status'})).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reads the narrow SMS contract in one request when enabled', async () => {
    const request = vi.fn(async (_path: string) => ({...sample(), scope: 'admin_sms_health'}));
    renderOversight(<SmsOversight request={request} permissions={health} authorityKey="session-a" preferSmsHealth />);
    expect(await screen.findByText('Native SMS processing disabled')).toBeVisible();
    expect(request.mock.calls.map(([path]) => path)).toEqual(['oversight/sms-health']);
  });

  it('opens existing SMS evidence from anywhere on the single status link', async () => {
    const body = {...sample(), scope: 'admin_sms_health'}, request = vi.fn(async (_path: string) => body);
    renderOversight(<Routes>
      <Route path="/" element={<SmsOversight request={request} permissions={healthAndSms} authorityKey="operator" preferSmsHealth />} />
      <Route path="/admin/payments" element={<p>Payments evidence</p>} />
    </Routes>);
    const link = screen.getByRole('link', {name: 'Open SMS evidence'});
    const status = await within(link).findByText('Native SMS processing disabled');
    expect(link).toHaveAttribute('href', '/admin/payments?view=sms');
    expect(link).toHaveAccessibleDescription(/Native SMS processing disabled.*Checked.*Kigali/);
    expect(within(link).getByText(/Kigali/)).toHaveAttribute('datetime', body.checked_at);
    expect(link.querySelector('a, button, summary, [tabindex]')).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(request.mock.calls.map(([path]) => path)).toEqual(['oversight/sms-health']);
    fireEvent.click(status);
    expect(await screen.findByText('Payments evidence')).toBeVisible();
  });

  it.each(['oversight_not_found', 'proxy_route_not_allowed'])('falls back once from an older route with %s', async code => {
    const request = vi.fn(async (path: string) => {
      if (path === 'oversight/sms-health') throw new AdminRequestError('Unavailable route.', {statusCode: 404, code});
      return sample();
    });
    const view = renderOversight(<SmsOversight request={request} permissions={health} authorityKey="session-a" preferSmsHealth />);
    expect(await screen.findByText('Native SMS processing disabled')).toBeVisible();
    view.rerender(<SmsOversight request={request} permissions={health} authorityKey="session-a" preferSmsHealth refreshGeneration={1} />);
    await waitFor(() => expect(request.mock.calls.map(([path]) => path)).toEqual(['oversight/sms-health', 'oversight/health', 'oversight/health']));
  });

  it('uses the authorized evidence response when an older server lacks the status route', async () => {
    const request = vi.fn(async (path: string) => {
      if (path === 'oversight/sms-health') throw new AdminRequestError('Unavailable route.', {statusCode: 404, code: 'oversight_not_found'});
      return sample();
    });
    renderOversight(<SmsOversight request={request} permissions={healthAndSms} authorityKey="operator" preferSmsHealth />);
    expect(await screen.findByText('Native SMS processing disabled')).toBeVisible();
    expect(request.mock.calls.map(([path]) => path)).toEqual(['oversight/sms-health', 'oversight/health?evidenceVersion=2']);
  });

  it('keeps a narrow response or permission failure closed', async () => {
    const request = vi.fn(async (_path: string) => sample());
    const {rerender} = renderOversight(<SmsOversight request={request} permissions={health} authorityKey="session-a" preferSmsHealth />);
    expect(await screen.findByText('SMS status could not be verified')).toBeVisible();
    request.mockRejectedValueOnce(new AdminRequestError('Denied.', {statusCode: 403, code: 'permission_required'}));
    rerender(<SmsOversight request={request} permissions={health} authorityKey="session-b" preferSmsHealth />);
    expect(await screen.findByText('SMS status could not be verified')).toBeVisible();
    expect(screen.queryByText(/Kigali/)).not.toBeInTheDocument();
    expect(request.mock.calls.map(([path]) => path)).toEqual(['oversight/sms-health', 'oversight/sms-health']);
  });

  it.each([
    {label: 'SMS processing not verified', queue: undefined},
    {label: 'Some SMS need attention', queue: {...nativeQueue, blocked: 1}},
    {label: 'Some SMS need attention', queue: {...nativeQueue, unmatched: 1, pending: 1, oldest_pending_seconds: 90}},
    {label: 'SMS processing pending', queue: {...nativeQueue, pending: 2, oldest_pending_seconds: 47}},
    {label: 'SMS processing pending', queue: {...nativeQueue, retrying: 1, oldest_pending_seconds: 60}},
    {label: 'No pending or unresolved SMS at last check', queue: nativeQueue},
  ])('summarizes an enabled native queue as "$label"', async ({label, queue}) => {
    const body = sample();
    const request = vi.fn(async () => ({...body, configuration: {...body.configuration, native_auto_processing: 'enabled'},
      queues: {...body.queues, burimunsi_sms: queue}}));
    renderOversight(<SmsOversight request={request} permissions={healthAndSms} authorityKey="operator" />);
    expect(await screen.findByText(label)).toBeVisible();
  });

  it('keeps the full evidence contract while showing only the checked summary on Home', async () => {
    const body = sample(), digest = 'b'.repeat(64);
    const payer = {pending: 1, gateway_accepted: 3, sent: 2, delivered: 1, failed: 0, unknown: 2, suppressed: 1};
    const response = {...body, worker_heartbeat: 'confirmed_dispatch', queues: {...body.queues,
      burimunsi_sms: nativeQueue, burimunsi_payer_sms: payer, burimunsi_sms_operations: {
        payer: {...payer, expired: 1}, oldest_pending_seconds: 95, reasons: {unverified_destination: 1, gateway_expired: 1},
        scheduler_enabled: true, cron_active: true, cron_interval_seconds: 1, unresolved_dispatches: 1,
        gateway_heartbeat: 'recent', last_confirmed_at: body.checked_at, last_confirmed_sha256: digest, gateway_last_seen_at: body.checked_at,
      }}};
    const parsed = parseSmsOversight(response);
    expect(parsed.native?.counts.posted).toBe(7);
    expect(parsed.payer).toEqual(payer);
    expect(parsed.operations?.lastConfirmedDigest).toBe(digest);
    expect(() => parseSmsOversight({...response, queues: {...response.queues, burimunsi_payer_sms: {...payer, delivered: -1}}})).toThrow();
    renderOversight(<SmsOversight request={vi.fn(async () => response)} permissions={healthAndSms} authorityKey="operator" />);
    expect(await screen.findByText('Native SMS processing disabled')).toBeVisible();
    const region = screen.getByRole('region', {name: 'SMS processing status'});
    expect(region.querySelector('details, dl')).toBeNull();
    expect(region).not.toHaveTextContent(/SMS diagnostics|Receipt reasons|Scheduled processing|Confirmed response digest|Assisted receipt delivery|Managed MoMo processing/i);
    expect(region).not.toHaveTextContent(digest);
  });

  it('refreshes on an operations change and stops when permission is removed', async () => {
    const body = sample();
    const request = vi.fn(async () => body);
    const view = renderOversight(<SmsOversight request={request} permissions={healthAndSms} authorityKey="operator" />);
    await screen.findByText('Native SMS processing disabled');
    request.mockResolvedValueOnce({...body, configuration: {...body.configuration, native_auto_processing: 'enabled'}});
    await act(async () => {window.dispatchEvent(new Event('burimunsi-operations-changed'));});
    expect(await screen.findByText('SMS processing not verified')).toBeVisible();
    view.rerender(<SmsOversight request={request} permissions={[]} authorityKey="signed-out" />);
    await act(async () => {window.dispatchEvent(new Event('burimunsi-operations-changed'));});
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps the original checked time on stale samples', async () => {
    const body = sample(new Date(Date.now() - 65_000).toISOString());
    renderOversight(<SmsOversight request={vi.fn(async () => body)} permissions={health} authorityKey="session-a" />);
    expect(await screen.findByText('Last SMS check is out of date')).toBeVisible();
    expect(screen.getByText(/Kigali/)).toHaveAttribute('datetime', body.checked_at);
    expect(screen.queryByText('Native SMS processing disabled')).not.toBeInTheDocument();
  });

  it('expires an already displayed status without a network refresh', async () => {
    const body = sample(new Date(Date.now() - 59_000).toISOString());
    const request = vi.fn(async () => body);
    renderOversight(<SmsOversight request={request} permissions={healthAndSms} authorityKey="session-a" />);
    await screen.findByText('Native SMS processing disabled');
    expect(await screen.findByText('Last SMS check is out of date', {}, {timeout: 3_000})).toBeVisible();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
