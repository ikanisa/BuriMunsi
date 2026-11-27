import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AdminShell } from '../../src/layout/AdminShell';
import { Button, Dialog, LoadingState, type LoadingLayout } from '../../src/ui';

const navigation = [
  {label: 'Home', path: '/admin', icon: 'home'},
  {label: 'Members', path: '/admin/members', icon: 'users', relatedPaths: ['/admin/users']},
  {label: 'Payments', path: '/admin/payments', relatedPaths: ['/admin/transactions', '/admin/sms-receipts']},
];

describe('Admin shell', () => {
  it('only shows daily destinations and marks legacy locations without changing their targets', () => {
    render(<AdminShell navigation={navigation} currentPath="/admin/users/record?returnTo=members"
      identity={{name: 'Operator', role: 'Staff'}}><h1>Member detail</h1></AdminShell>);
    const nav = within(screen.getByRole('navigation', {name: 'Admin sections'}));
    expect(nav.getAllByRole('link').map(link => link.textContent)).toEqual(['Home', 'Members', 'Payments']);
    expect(nav.getByRole('link', {name: 'Members'})).toHaveAttribute('aria-current', 'location');
    expect(nav.getByRole('link', {name: 'Members'})).toHaveAttribute('href', '#/admin/members');
    expect(screen.getByRole('heading', {name: 'Member detail'})).toBeVisible();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it.each(['/admin/transactions/123', '/admin/sms-receipts/capture/456'])('marks Payments active on %s', path => {
    render(<AdminShell navigation={navigation} currentPath={path}><p>Records</p></AdminShell>);
    expect(screen.getByRole('link', {name: 'Payments'})).toHaveAttribute('aria-current', 'location');
  });

  it('does not treat alias lookalikes as primary sections', () => {
    render(<AdminShell navigation={navigation} currentPath="/admin/transactions-archive"><p>Records</p></AdminShell>);
    expect(screen.getByRole('link', {name: 'Payments'})).not.toHaveAttribute('aria-current');
  });

  it('exposes mobile navigation state and closes it with Escape', async () => {
    const user = userEvent.setup();
    render(<AdminShell navigation={navigation} currentPath="/admin"><p>Overview</p></AdminShell>);
    const menu = screen.getByRole('button', { name: 'Open navigation' });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    await user.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(menu).toHaveFocus();
  });

  it('gates account link presentation and restores keyboard focus on Escape', async () => {
    const user = userEvent.setup(), signOut = vi.fn();
    render(<AdminShell navigation={navigation} currentPath="/admin" identity={{name: 'Operator'}}
      accountNavigation={[{label: 'Workspace', path: '/admin/groups'}, {label: 'SMS controls', path: '/admin/notification-settings', group: 'advanced'}]}
      onSignOut={signOut}><p>Overview</p></AdminShell>);
    const trigger = screen.getByRole('button', {name: 'Account: Operator'});
    await user.click(trigger);
    await user.tab();
    expect(screen.getByRole('link', {name: 'Workspace'})).toHaveFocus();
    expect(screen.getByRole('link', {name: 'SMS controls'})).not.toBeVisible();
    expect(screen.queryByRole('link', {name: 'Privacy requests'})).not.toBeInTheDocument();
    await user.click(screen.getByText('Help', {selector: 'summary'}));
    const help = screen.getByRole('link', {name: 'WhatsApp support · +250 788 767 816'});
    expect(screen.queryByRole('group', {name: 'BuriMunsi on web and Android'})).not.toBeInTheDocument();
    expect(help).toHaveAttribute('href', 'https://wa.me/250788767816');
    expect(help).toHaveAttribute('rel', 'noopener noreferrer');
    await user.click(screen.getByText('Advanced', {selector: 'summary'}));
    expect(screen.getByRole('link', {name: 'SMS controls'})).toHaveAttribute('href', '#/admin/notification-settings');
    screen.getByRole('link', {name: 'SMS controls'}).focus();
    await user.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('omits the entire Help flyout for the BuriMunsi workspace and keeps the account controls', async () => {
    const user = userEvent.setup();
    render(<AdminShell navigation={navigation} currentPath="/admin" showAccountHelp={false} onSignOut={() => {}}
      accountNavigation={[{label:'Account security',path:'/admin/security'},{label:'Open-source notices',path:'/admin/licenses',group:'help'}]}
      identity={{name:'Member reader', role:'Staff'}}>
      <p>Overview</p></AdminShell>);
    const account = screen.getByRole('button', {name:'Account: Staff, Member reader'});
    expect(account).toHaveTextContent(/^Staff$/);
    await user.click(account);
    expect(screen.queryByText('Help', {selector:'summary'})).not.toBeInTheDocument();
    const privacy = screen.getByRole('link', {name: 'Privacy and data use (opens in a new tab)'});
    expect(privacy).toHaveAttribute('href', '/privacy');
    expect(privacy).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByText(/registered Android receiver/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', {name:/WhatsApp support|Open-source notices|Review payments/})).not.toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Sign out'})).toBeVisible();
    await user.click(screen.getByRole('link', {name:'Account security'}));
    expect(screen.getByRole('button', {name:'Account: Staff, Member reader'})).toHaveAttribute('aria-expanded','false');
  });

});

function DialogExample() {
  const [open, setOpen] = useState(false);
  return <><Button onClick={() => setOpen(true)}>Review</Button><Dialog open={open} title="Review record" onClose={() => setOpen(false)}><label htmlFor="note">Note</label><input id="note" /><Button>Confirm</Button></Dialog></>;
}

describe('Shared controls', () => {
  it.each<LoadingLayout>(['inline', 'workspace', 'home', 'table', 'details'])('announces one status for the %s loading layout', layout => {
    render(<LoadingState label="Retrieving records" layout={layout} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/^Retrieving records$/);
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    expect(within(status).queryByRole('button')).not.toBeInTheDocument();
    expect(within(status).queryByRole('row')).not.toBeInTheDocument();
  });

  it('reserves only the Home cards and table available to the current account', () => {
    const {rerender} = render(<LoadingState layout="home" homeCards={[1, 0]} />);
    const status = screen.getByRole('status');
    expect(status.querySelectorAll('.admin-loading-metric')).toHaveLength(1);
    expect(status.querySelector('.admin-loading-table')).not.toBeInTheDocument();
    rerender(<LoadingState layout="home" homeCards={[3, 2]} />);
    expect(status.querySelectorAll('.admin-loading-metric')).toHaveLength(5);
    expect(status.querySelector('.admin-loading-table')).toBeInTheDocument();
  });

  it('traps dialog keyboard focus and restores the trigger on Escape', async () => {
    const user = userEvent.setup();
    render(<DialogExample />);
    const trigger = screen.getByRole('button', { name: 'Review' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Review record' });
    expect(within(dialog).getByRole('button', { name: 'Close dialog' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(dialog).getByRole('button', { name: 'Confirm' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('disables a loading action and exposes its busy state', () => {
    render(<Button loading>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-busy', 'true');
  });
});
