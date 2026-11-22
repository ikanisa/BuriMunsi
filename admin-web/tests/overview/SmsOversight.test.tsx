import {act, render, screen, waitFor} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {SmsOversight} from '../../src/features/overview/SmsOversight';
import {parseSmsOversight} from '../../src/features/overview/smsOversightContract';

function sample(checkedAt = new Date().toISOString()) {
  return {contract_version: 1, scope: 'admin_operational_health', metrics_scope: 'all_retained_rows',
    worker_heartbeat: 'not_recorded', external_services_checked: false, checked_at: checkedAt,
    configuration: {momo_processing: 'paused', native_auto_processing: 'disabled', native_sms_ledger: 'disabled'},
    queues: {assisted_sms: {queued: 4, claimed: 1, send_started: 2, uncertain: 1, automatic_retry: false}}};
}
describe('SMS oversight', () => {
  it('rejects changed meaning, invalid timestamps and unbounded counts', () => {
    expect(parseSmsOversight(sample()).counts.queued).toBe(4);
    expect(() => parseSmsOversight({...sample(), worker_heartbeat: 'healthy'})).toThrow();
    expect(() => parseSmsOversight({...sample(), checked_at: '2026-02-31T00:00:00.000Z'})).toThrow();
    const bad = sample(); bad.queues.assisted_sms.queued = -1;
    expect(() => parseSmsOversight(bad)).toThrow();
  });
  it('shows only authorized fresh samples without claiming provider availability', async () => {
    const request = vi.fn(async () => sample());
    const {rerender} = render(<SmsOversight request={request} permissions={['system_health.read']} authorityKey="session-a" />);
    expect(await screen.findByText('Queued receipts')).toBeInTheDocument();
    expect(screen.getByText(/worker activity and provider availability are not verified/i)).toBeInTheDocument();
    rerender(<SmsOversight request={request} permissions={[]} authorityKey="session-b" />);
    expect(screen.queryByText('Queued receipts')).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('keeps scoped internal credits, gateway acceptance and reported delivery distinct', async () => {
    const value = sample();
    const payer = {pending: 0, gateway_accepted: 3, sent: 2, delivered: 1, failed: 0, unknown: 2, suppressed: 0};
    const payload = {...value, queues: {...value.queues,
      burimunsi_sms: {pending: 2, retrying: 1, blocked: 0, unmatched: 1, posted: 7, oldest_pending_seconds: 90},
      burimunsi_payer_sms: payer,
    }};
    render(<SmsOversight request={vi.fn(async () => payload)} permissions={['system_health.read', 'sms.read']} authorityKey="session-a" />);
    expect(await screen.findByRole('heading', {name: 'BuriMunsi payer receipts'})).toBeVisible();
    expect(screen.getByText('Internally credited')).toBeVisible();
    expect(screen.getByText('Gateway accepted')).toBeVisible();
    expect(screen.getByText('Reported delivered')).toBeVisible();
    expect(() => parseSmsOversight({...payload, queues: {...payload.queues, burimunsi_payer_sms: {...payer, delivered: -1}}})).toThrow();
  });
  it('shows the signed run, gateway heartbeat, expired commitments and suppression reasons', async () => {
    const body = sample(), digest = 'b'.repeat(64);
    const response = {...body,worker_heartbeat:'confirmed_dispatch',queues:{...body.queues,burimunsi_sms_operations:{
      payer:{pending:1,gateway_accepted:0,sent:0,delivered:2,failed:0,unknown:0,suppressed:1,expired:1},oldest_pending_seconds:95,
      reasons:{unverified_destination:1,gateway_expired:1},scheduler_enabled:true,cron_active:true,cron_interval_seconds:1,unresolved_dispatches:1,gateway_heartbeat:'recent',last_confirmed_at:body.checked_at,last_confirmed_sha256:digest,gateway_last_seen_at:body.checked_at}}};
    render(<SmsOversight request={vi.fn(async () => response)} permissions={['system_health.read','sms.read']} authorityKey="owner" />);
    expect(await screen.findByText('Last confirmed scheduled run')).toBeVisible(); expect(screen.getByText('1 s')).toBeVisible();
    expect(screen.getByText('Last receipt gateway heartbeat')).toBeVisible(); expect(screen.getByText('Expired')).toBeVisible();
    expect(screen.getByText('Payer number unverified')).toBeInTheDocument();
    expect(parseSmsOversight(response).operations?.lastConfirmedDigest).toBe(digest);
  });
  it('refetches current health immediately on an operations change and stops when permission is removed',async()=>{
    const request=vi.fn(async()=>sample());
    const view=render(<SmsOversight request={request} permissions={['system_health.read','sms.read']} authorityKey="owner" />);
    await screen.findByText('Queued receipts');
    await act(async()=>{window.dispatchEvent(new Event('burimunsi-operations-changed'));});
    await waitFor(()=>expect(request).toHaveBeenCalledTimes(2));
    view.rerender(<SmsOversight request={request} permissions={[]} authorityKey="signed-out" />);
    await act(async()=>{window.dispatchEvent(new Event('burimunsi-operations-changed'));});
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('does not show stale counts as current', async () => {
    const request = vi.fn(async () => sample(new Date(Date.now() - 65_000).toISOString()));
    render(<SmsOversight request={request} permissions={['system_health.read']} authorityKey="session-a" />);
    expect(await screen.findByText('Sample expired. Refresh for current counts.')).toBeInTheDocument();
    expect(screen.queryByText('Queued receipts')).not.toBeInTheDocument();
  });
});
