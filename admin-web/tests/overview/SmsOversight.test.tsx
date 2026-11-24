import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {MemoryRouter} from 'react-router';
import type {ReactNode} from 'react';

function renderOversight(node: ReactNode) {
  return render(node, {wrapper: ({children}) => <MemoryRouter>{children}</MemoryRouter>});
}
async function openDiagnostics() {
  fireEvent.click(await screen.findByText('SMS diagnostics', {selector: 'summary'}));
}
import {AdminRequestError} from '../../src/api/client';
import {OperationsLiveContext} from '../../src/features/operations/operationsLiveContext';
import {SmsOversight} from '../../src/features/overview/SmsOversight';
import {parseSmsOversight} from '../../src/features/overview/smsOversightContract';

function sample(checkedAt = new Date().toISOString()) {
  return {contract_version: 1, scope: 'admin_operational_health', metrics_scope: 'all_retained_rows',
    worker_heartbeat: 'not_recorded', external_services_checked: false, checked_at: checkedAt,
    configuration: {momo_processing: 'paused', native_auto_processing: 'disabled', native_sms_ledger: 'disabled'},
    queues: {assisted_sms: {queued: 4, claimed: 1, send_started: 2, uncertain: 1, automatic_retry: false}}};
}
describe('SMS oversight', () => {
  it('keeps idle standalone health checks 30 seconds apart and immediately refreshes a receipt change', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => sample());
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
  it('shows only authorized fresh samples without claiming provider availability', async () => {
    const request = vi.fn(async () => sample());
    const {rerender} = renderOversight(<SmsOversight request={request} permissions={['system_health.read']} authorityKey="session-a" />);
    const hidden = await screen.findByText('Queued receipts');
    expect(hidden).not.toBeVisible();
    expect(screen.queryByRole('link', {name:'Open SMS evidence'})).not.toBeInTheDocument();
    await openDiagnostics();
    expect(hidden).toBeVisible();
    expect(screen.getByText(/worker activity and provider availability are not verified/i)).toBeInTheDocument();
    rerender(<SmsOversight request={request} permissions={[]} authorityKey="session-b" />);
    expect(screen.queryByText('Queued receipts')).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('reads the narrow SMS contract in one request when enabled', async () => {
    const request = vi.fn(async (_path: string) => ({...sample(), scope: 'admin_sms_health'}));
    renderOversight(<SmsOversight request={request} permissions={['system_health.read']} authorityKey="session-a" preferSmsHealth />);
    await openDiagnostics();
    expect(screen.getByText('Queued receipts')).toBeVisible();
    expect(request.mock.calls.map(([path]) => path)).toEqual(['oversight/sms-health']);
  });
  it('requests the versioned carrier and scheduler evidence once for an authorized SMS operator', async () => {
    const request = vi.fn(async (_path: string) => sample());
    renderOversight(<SmsOversight request={request} permissions={['system_health.read', 'sms.read']} authorityKey="operator" preferSmsHealth />);
    await openDiagnostics();
    expect(screen.getByText('Queued receipts')).toBeVisible();
    expect(request.mock.calls.map(([path]) => path)).toEqual(['oversight/health?evidenceVersion=2']);
  });
  it.each(['oversight_not_found', 'proxy_route_not_allowed'])('falls back once from an older route with %s', async code => {
    const request = vi.fn(async (path: string) => {
      if (path === 'oversight/sms-health') throw new AdminRequestError('Unavailable route.', {statusCode: 404, code});
      return sample();
    });
    const view = renderOversight(<SmsOversight request={request} permissions={['system_health.read']} authorityKey="session-a" preferSmsHealth />);
    await openDiagnostics();
    expect(screen.getByText('Queued receipts')).toBeVisible();
    view.rerender(<SmsOversight request={request} permissions={['system_health.read']} authorityKey="session-a" preferSmsHealth refreshGeneration={1} />);
    await waitFor(() => expect(request.mock.calls.map(([path]) => path)).toEqual(['oversight/sms-health', 'oversight/health', 'oversight/health']));
  });
  it('keeps a narrow response or permission failure closed', async () => {
    const request = vi.fn(async (_path: string) => sample());
    const {rerender} = renderOversight(<SmsOversight request={request} permissions={['system_health.read']} authorityKey="session-a" preferSmsHealth />);
    expect(await screen.findByText('SMS status could not be verified')).toBeVisible();
    request.mockRejectedValueOnce(new AdminRequestError('Denied.', {statusCode: 403, code: 'permission_required'}));
    rerender(<SmsOversight request={request} permissions={['system_health.read']} authorityKey="session-b" preferSmsHealth />);
    expect(await screen.findByText('SMS status could not be verified')).toBeVisible();
    expect(request.mock.calls.map(([path]) => path)).toEqual(['oversight/sms-health', 'oversight/sms-health']);
  });
  it('keeps scoped internal credits, gateway acceptance and reported delivery distinct', async () => {
    const value = sample();
    const payer = {pending: 0, gateway_accepted: 3, sent: 2, delivered: 1, failed: 0, unknown: 2, suppressed: 0};
    const payload = {...value, queues: {...value.queues,
      burimunsi_sms: {pending: 0, retrying: 0, blocked: 0, unmatched: 1, posted: 7, oldest_pending_seconds: 90},
      burimunsi_payer_sms: payer,
    }};
    renderOversight(<SmsOversight request={vi.fn(async () => payload)} permissions={['system_health.read', 'sms.read']} authorityKey="session-a" />);
    expect(await screen.findByRole('link', {name: 'Open SMS evidence'})).toHaveAttribute('href', '/admin/payments?view=sms');
    await openDiagnostics();
    expect(screen.getByRole('heading', {name: 'BuriMunsi payer receipts'})).toBeVisible();
    expect(screen.getByText('Internally credited')).toBeVisible();
    expect(screen.getByText(/the oldest pending, retrying or unmatched item was 1 min old/i)).toBeVisible();
    expect(screen.getByText('Gateway accepted')).toBeVisible();
    expect(screen.getByText('Reported delivered')).toBeVisible();
    expect(() => parseSmsOversight({...payload, queues: {...payload.queues, burimunsi_payer_sms: {...payer, delivered: -1}}})).toThrow();
  });
  it('shows the signed run, gateway heartbeat, expired commitments and suppression reasons', async () => {
    const body = sample(), digest = 'b'.repeat(64);
    const response = {...body,worker_heartbeat:'confirmed_dispatch',queues:{...body.queues,burimunsi_sms_operations:{
      payer:{pending:1,gateway_accepted:0,sent:0,delivered:2,failed:0,unknown:0,suppressed:1,expired:1},oldest_pending_seconds:95,
      reasons:{unverified_destination:1,gateway_expired:1},scheduler_enabled:true,cron_active:true,cron_interval_seconds:1,unresolved_dispatches:1,gateway_heartbeat:'recent',last_confirmed_at:body.checked_at,last_confirmed_sha256:digest,gateway_last_seen_at:body.checked_at}}};
    renderOversight(<SmsOversight request={vi.fn(async () => response)} permissions={['system_health.read','sms.read']} authorityKey="owner" />);
    await openDiagnostics();
    expect(screen.getByText('Last confirmed scheduled run')).toBeVisible(); expect(screen.getByText('1 s')).toBeVisible();
    expect(screen.getByText('Last receipt gateway heartbeat')).toBeVisible(); expect(screen.getByText('Expired')).toBeVisible();
    expect(screen.getByText('Payer number unverified')).toBeInTheDocument();
    expect(parseSmsOversight(response).operations?.lastConfirmedDigest).toBe(digest);
  });
  it('refetches current health immediately on an operations change and stops when permission is removed',async()=>{
    const request=vi.fn(async()=>sample());
    const view=renderOversight(<SmsOversight request={request} permissions={['system_health.read','sms.read']} authorityKey="owner" />);
    await screen.findByText('Queued receipts');
    await act(async()=>{window.dispatchEvent(new Event('burimunsi-operations-changed'));});
    await waitFor(()=>expect(request).toHaveBeenCalledTimes(2));
    view.rerender(<SmsOversight request={request} permissions={[]} authorityKey="signed-out" />);
    await act(async()=>{window.dispatchEvent(new Event('burimunsi-operations-changed'));});
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('reports an empty age when only blocked or posted SMS work remains', async () => {
    const value = sample();
    const payload = {...value, queues: {...value.queues,
      burimunsi_sms: {pending: 0, retrying: 0, blocked: 1, unmatched: 0, posted: 4, oldest_pending_seconds: null},
    }};
    renderOversight(<SmsOversight request={vi.fn(async () => payload)} permissions={['system_health.read', 'sms.read']} authorityKey="session-a" />);
    await openDiagnostics();
    expect(screen.getByText(/No age was recorded for pending, retrying or unmatched items/i)).toBeVisible();
  });
  it('does not show stale counts as current', async () => {
    const request = vi.fn(async () => sample(new Date(Date.now() - 65_000).toISOString()));
    renderOversight(<SmsOversight request={request} permissions={['system_health.read']} authorityKey="session-a" />);
    expect(await screen.findByText('Last SMS check is out of date')).toBeInTheDocument();
    expect(screen.queryByText('Queued receipts')).not.toBeInTheDocument();
  });

  it('separates the active native queue from paused managed processing and does not assert settlement', async () => {
    const body = sample();
    const request = vi.fn(async () => ({...body, configuration:{...body.configuration,native_auto_processing:'enabled'},
      queues:{...body.queues,burimunsi_sms:{pending:2,retrying:0,blocked:0,unmatched:0,posted:5,oldest_pending_seconds:47}}}));
    renderOversight(<SmsOversight request={request} permissions={['system_health.read', 'sms.read']} authorityKey="session-a" />);
    expect(await screen.findByText('SMS processing pending')).toBeVisible();
    expect(screen.queryByText('Native SMS processing disabled')).not.toBeInTheDocument();
    expect(screen.getByText('Internally credited')).not.toBeVisible();
    await openDiagnostics();
    expect(screen.getByText(/provider settlement is recorded separately/i)).toBeVisible();
  });
  it('expires an already displayed health result and removes the old diagnostic values without a network refresh', async () => {
    const deadline = Date.now() + 1_000;
    const request = vi.fn(async () => sample(new Date(deadline - 60_000).toISOString()));
    renderOversight(<SmsOversight request={request} permissions={['system_health.read', 'sms.read']} authorityKey="session-a" />);
    await openDiagnostics();
    expect(screen.getByText('Queued receipts')).toBeVisible();
    expect(await screen.findByText('Last SMS check is out of date', {}, {timeout: 3_000})).toBeVisible();
    expect(screen.queryByText('Queued receipts')).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
