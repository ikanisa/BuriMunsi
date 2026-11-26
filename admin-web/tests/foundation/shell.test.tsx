import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AdminShell } from '../../src/layout/AdminShell';
import { Button, Dialog } from '../../src/ui';

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

  it('puts permitted BuriMunsi workflows and receiver guidance in account Help', async () => {
    const user = userEvent.setup();
    render(<AdminShell navigation={navigation} currentPath="/admin"
      identity={{name:'Member reader', role:'Staff', androidHelpPaths:['/admin/members', '/admin/payments']}}>
      <p>Overview</p></AdminShell>);
    await user.click(screen.getByRole('button', {name:'Account: Member reader'}));
    await user.click(screen.getByText('Help', {selector:'summary'}));
    const help = within(screen.getByRole('group', {name:'BuriMunsi on web and Android'}));
    expect(help.getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(['#/admin/members', '#/admin/payments']);
    expect(help.getByText(/registered Android receiver/)).toBeVisible();
    expect(help.queryByRole('link', {name:'Add or import members'})).not.toBeInTheDocument();
    expect(help.queryByRole('link', {name:'Open the M-Money SMS inbox'})).not.toBeInTheDocument();
    expect(help.queryByRole('link', {name:'Manage staff access'})).not.toBeInTheDocument();
    await user.click(help.getByRole('link', {name:'Review payments'}));
    expect(screen.getByRole('button', {name:'Account: Member reader'})).toHaveAttribute('aria-expanded','false');
  });

});

function DialogExample() {
  const [open, setOpen] = useState(false);
  return <><Button onClick={() => setOpen(true)}>Review</Button><Dialog open={open} title="Review record" onClose={() => setOpen(false)}><label htmlFor="note">Note</label><input id="note" /><Button>Confirm</Button></Dialog></>;
}

describe('Shared controls', () => {
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
