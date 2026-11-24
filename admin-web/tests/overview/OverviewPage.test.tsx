import {act, fireEvent, render, screen, within} from '@testing-library/react';
import {MemoryRouter} from 'react-router';
import {describe, expect, it, vi} from 'vitest';
import type {AdminRequest, JsonObject} from '../../src/api/client';
import {OverviewPage} from '../../src/features/overview/OverviewPage';
import {canonicalFixture} from './fixtures';

const wrapper = MemoryRouter;
const admin = ['overview.read', 'payments.read', 'reconciliations.read', 'users.read'];
const base = {financialModel: 'canonical_evidence_ledger', authorityKey: 'session-a'} as const;

describe('compact Admin home', () => {
  it('shows no more than three measured metrics, not the raw evidence, and formats Kigali rollover', async () => {
    const request = vi.fn(async () => canonicalFixture());
    render(<OverviewPage {...base} request={request} permissions={admin} />, {wrapper});

    expect(screen.getByRole('heading', {name: 'Home', level: 1})).toBeVisible();
    const summary = await screen.findByRole('region', {name: 'Workspace snapshot'});
    expect(within(summary).getAllByRole('term')).toHaveLength(3);
    expect(within(summary).getByText('Net recorded contributions')).toBeVisible();
    expect(within(summary).getByText('RWF 9,007,199,254,740,993')).toBeVisible();
    expect(within(summary).getByText('Cumulative records, not provider settlement.')).toBeVisible();
    expect(within(summary).getByText(/17 Nov 2026.*01:00 Kigali/)).toHaveAttribute('datetime', '2026-11-16T23:00:00.000Z');
    expect(within(summary).getByRole('link', {name:'Open reconciliation'})).toHaveAttribute('href', '/admin/payments?view=attention&status=all');
    expect(within(summary).getByRole('link', {name:'Open payments'})).toHaveAttribute('href', '/admin/payments');
    expect(within(summary).getByRole('link', {name:'Open members'})).toHaveAttribute('href', '/admin/members');
    expect(within(summary).queryByText('Retained payment evidence')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('updates Today across Kigali midnight without relabeling its cumulative snapshot as daily', async () => {
    vi.setSystemTime(new Date('2026-11-23T21:59:59.000Z'));
    try {
      const view = render(<OverviewPage {...base} request={vi.fn(async () => canonicalFixture())} permissions={admin} />, {wrapper});
      expect(screen.getByText('Today in Kigali · 23 November 2026')).toBeVisible();
      const summary = await screen.findByRole('region', {name:'Workspace snapshot'});
      vi.setSystemTime(new Date('2026-11-23T22:00:01.000Z'));
      fireEvent(window, new Event('pageshow'));
      expect(screen.getByText('Today in Kigali · 24 November 2026')).toBeVisible();
      expect(within(summary).getByText(/17 Nov 2026.*01:00 Kigali/)).toBeVisible();
      expect(within(summary).getByText('Cumulative records, not provider settlement.')).toBeVisible();
      view.unmount();
    } finally {vi.useRealTimers();}
  });

  it('keeps the zero unallocated value but does not show an exception CTA and hides unavailable links', async () => {
    const request = vi.fn(async () => canonicalFixture(0));
    const view = render(<OverviewPage {...base} request={request} permissions={admin} />, {wrapper});
    expect(await screen.findByText('Unallocated payments')).toBeVisible();
    expect(screen.queryByRole('link', {name:'Open reconciliation'})).not.toBeInTheDocument();

    view.rerender(<OverviewPage {...base} request={request} permissions={['overview.read']} />);
    expect(screen.queryByText(/RWF /)).not.toBeInTheDocument();
    expect(await screen.findByText('Active members')).toBeVisible();
    expect(screen.queryByText('Unallocated payments')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(request.mock.calls).toHaveLength(2);
  });

  it('discards an older session response, recovers from failed data and does not leak content after permission loss', async () => {
    let release: (value: JsonObject) => void = () => {};
    const old = vi.fn<AdminRequest>(() => new Promise<JsonObject>(resolve => {release = resolve;}));
    const request = vi.fn(async () => canonicalFixture(0));
    request.mockRejectedValueOnce(new Error('internal source text'));
    const view = render(<OverviewPage {...base} request={old} permissions={admin} />, {wrapper});
    view.rerender(<OverviewPage {...base} request={request} authorityKey="session-b" permissions={admin} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The workspace snapshot could not be verified.');
    expect(screen.queryByText('internal source text')).not.toBeInTheDocument();
    await act(async () => release(canonicalFixture(5)));
    expect(old.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(screen.queryByText('Unallocated payments')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name:'Try again'}));
    expect(await screen.findByText('Unallocated payments')).toBeVisible();
    expect(screen.queryByRole('link', {name:'Open reconciliation'})).not.toBeInTheDocument();
    view.rerender(<OverviewPage {...base} request={request} authorityKey="session-b" permissions={[]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Access unavailable');
    expect(screen.queryByRole('region', {name:'Workspace snapshot'})).not.toBeInTheDocument();
    expect(request.mock.calls).toHaveLength(2);
  });
});
