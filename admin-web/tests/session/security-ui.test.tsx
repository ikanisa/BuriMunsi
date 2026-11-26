import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';
import type {ReactNode} from 'react';
import {AccountSecurityPage} from '../../src/session/AccountSecurityPage';
import {SensitiveEmailVerificationPage} from '../../src/session/SensitiveEmailVerificationPage';
import {SessionProvider, useSession} from '../../src/session/SessionProvider';

const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
const user = {id: 'operator-one', email: 'a@example.com', role: 'staff', sessionId: 'session-one', permissions: ['account.manage'], assuranceLevel: 1, mfaAt: null, financialModel: 'transaction_journals'};
const reply = (body: unknown) => new Response(JSON.stringify(body), {status: 200, headers: {'Content-Type': 'application/json'}});
function Protected({children}: {children: ReactNode}) {return useSession().status === 'authenticated' ? children : null;}

function submitNewPassword() {
  fireEvent.change(screen.getByLabelText('Current password'), {target: {value: 'old-password'}});
  fireEvent.change(screen.getByLabelText('New password'), {target: {value: 'different-new-password'}});
  fireEvent.change(screen.getByLabelText('Confirm new password'), {target: {value: 'different-new-password'}});
  fireEvent.click(screen.getByRole('button', {name: 'Change password'}));
}

describe('account security', () => {
  it('keeps phone Account security focused on one four-digit change and preserves leading zeros in the request', async () => {
    const actor = {
      id: '10000000-0000-4000-8000-000000000001', accountId: '40000000-0000-4000-8000-000000000002',
      principalId: '20000000-0000-4000-8000-000000000001', sessionId: '30000000-0000-4000-8000-000000000001',
      role: 'staff', phone: '+250780000002', displayName: 'Test Staff', permissions: ['overview.read'],
      authMethod: 'phone_passcode', passcodeVerifiedAt: null, financialModel: 'canonical_evidence_ledger',
    };
    const writes: unknown[] = [];
    let authenticated = true, finishChange!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => {finishChange = resolve;});
    const fetchImpl = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).endsWith('/auth/session')) return reply(authenticated
        ? {user: actor, csrfToken: 'c'.repeat(64), expiresAt, ownerEmail: null}
        : {user: null, csrfToken: null, expiresAt: null, ownerEmail: null});
      if (String(url).endsWith('/auth/passcode/change')) {
        writes.push(JSON.parse(String(options?.body)));
        return pending;
      }
      throw new Error('Unexpected account request');
    });
    const onSignIn = vi.fn(), user = userEvent.setup();
    render(<SessionProvider config={{backend: 'supabase', phonePasscodeOnly: true, publishableKey: 'sb_publishable_' + 'a'.repeat(32),
      captchaEnabled: false, googleEnabled: false, fetchImpl}}><Protected><AccountSecurityPage
      onVerify={() => undefined} onLicenses={() => undefined} onPasswordRecovery={() => undefined} onSignIn={onSignIn} /></Protected></SessionProvider>);
    await screen.findByRole('heading', {name: 'Change passcode'});
    expect(screen.queryByRole('button', {name: 'Open-source licenses'})).toBeNull();
    expect(screen.queryByText('Manage your BuriMunsi sign-in.')).toBeNull();
    const current = screen.getByLabelText('Current passcode'), next = screen.getByLabelText('New passcode');
    const confirm = screen.getByLabelText('Confirm new passcode'), change = screen.getByRole('button', {name: 'Change passcode'});
    const form = current.closest('form')!;
    for (const input of [current, next, confirm]) {
      expect(input).toHaveAttribute('type', 'password');
      expect(input).toHaveAttribute('inputmode', 'numeric');
      expect(input).toHaveAttribute('pattern', '[0-9]{4}');
      expect(input).toHaveAttribute('minlength', '4');
      expect(input).toHaveAttribute('maxlength', '4');
      await user.click(input);
      for (const invalid of ['00420', '00a2', '１２３４', '٠١٢٣', '01 2']) {
        await user.paste(invalid);
        expect(input).toHaveValue('');
      }
      fireEvent.change(input, {target: {value: '1x'}});
      expect(input).toHaveValue('');
    }
    await user.click(current); await user.paste('0007');
    await user.click(next); await user.paste('0007');
    await user.click(confirm); await user.paste('0007');
    expect(next).toHaveAttribute('aria-invalid', 'true');
    expect(change).toBeDisabled();
    fireEvent.submit(form);
    await user.clear(next); await user.type(next, '004');
    expect(change).toBeDisabled();
    fireEvent.submit(form);
    await user.type(next, '2');
    expect(confirm).toHaveAccessibleDescription('The new passcodes do not match.');
    expect(change).toBeDisabled();
    fireEvent.submit(form);
    expect(writes).toEqual([]);
    await user.clear(confirm); await user.paste('0042');
    expect(change).toBeEnabled();
    await user.click(change);
    await waitFor(() => expect(writes).toEqual([{current: '0007', newPin: '0042', confirm: '0042'}]));
    for (const input of [current, next, confirm]) expect(input).toHaveValue('');
    fireEvent.submit(form);
    expect(writes).toHaveLength(1);
    authenticated = false;
    finishChange(reply({ok: true}));
    await waitFor(() => expect(onSignIn).toHaveBeenCalledOnce());
  });

  it.each([true, false])('shows managed authenticator access only when the server advertises it: %s', async (mfaAvailable) => {
    const publishableKey = 'sb_publishable_' + 'a'.repeat(32), csrf = 'c'.repeat(64), onAuthenticator = vi.fn();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith('/auth/session')
      ? reply({user: {...user, mfaAvailable, financialModel: 'canonical_evidence_ledger'}, expiresAt, csrfToken: csrf})
      : reply({contractVersion: 1, sessionId: 'session-one', emailVerifiedAt: null}));
    render(<SessionProvider config={{backend: 'supabase', publishableKey, captchaEnabled: false, googleEnabled: false, fetchImpl}}><Protected><AccountSecurityPage onVerify={() => undefined} onAuthenticator={onAuthenticator} onLicenses={() => undefined} onPasswordRecovery={() => undefined} onSignIn={() => undefined} /></Protected></SessionProvider>);
    await screen.findByRole('button', {name: 'Verify email'});
    expect(screen.getByRole('button', {name: 'Open-source licenses'})).toBeVisible();
    const button = screen.queryByRole('button', {name: 'Authenticator'});
    if (mfaAvailable) {expect(button).toBeInTheDocument(); fireEvent.click(button!); expect(onAuthenticator).toHaveBeenCalledOnce();}
    else expect(button).not.toBeInTheDocument();
  });

  it('keeps the existing Cloudflare authenticator verification link', async () => {
    const onVerify = vi.fn(), fetchImpl = vi.fn(async () => reply({user, expiresAt}));
    render(<SessionProvider config={{backend: 'cloudflare', captchaEnabled: false, googleEnabled: false, fetchImpl}}><Protected><AccountSecurityPage onVerify={onVerify} onAuthenticator={() => undefined} onLicenses={() => undefined} onPasswordRecovery={() => undefined} onSignIn={() => undefined} /></Protected></SessionProvider>);
    fireEvent.click(await screen.findByRole('button', {name: 'Authenticator'})); expect(onVerify).toHaveBeenCalledOnce();
  });

  it('acknowledges a managed password change on the current screen and clears the fields', async () => {
    const publishableKey = 'sb_publishable_' + 'a'.repeat(32), csrf = 'c'.repeat(64), onSignIn = vi.fn();
    const proof = new Date(Date.now() - 5_000).toISOString();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path.endsWith('/auth/session')) return reply({user: {...user, financialModel: 'canonical_evidence_ledger'}, expiresAt, csrfToken: csrf});
      if (path.endsWith('/auth/email-verification')) return reply({contractVersion: 1, sessionId: user.sessionId, emailVerifiedAt: proof});
      return reply({ok: true});
    });
    render(<SessionProvider config={{backend: 'supabase', publishableKey, captchaEnabled: false, googleEnabled: false, fetchImpl}}><Protected><AccountSecurityPage onVerify={() => undefined} onLicenses={() => undefined} onPasswordRecovery={() => undefined} onSignIn={onSignIn} /></Protected></SessionProvider>);
    await screen.findByLabelText('Current password');
    submitNewPassword();
    expect(await screen.findByRole('status')).toHaveTextContent('Password changed.');
    expect(screen.getByLabelText('Current password')).toHaveValue('');
    expect(screen.getByLabelText('New password')).toHaveValue('');
    expect(screen.getByLabelText('Confirm new password')).toHaveValue('');
    expect(onSignIn).not.toHaveBeenCalled();
  });

  it('returns a predecessor password change to sign-in', async () => {
    const onSignIn = vi.fn();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith('/auth/session')
      ? reply({user, expiresAt})
      : reply({ok: true}));
    render(<SessionProvider config={{backend: 'cloudflare', captchaEnabled: false, googleEnabled: false, fetchImpl}}><Protected><AccountSecurityPage onVerify={() => undefined} onLicenses={() => undefined} onPasswordRecovery={() => undefined} onSignIn={onSignIn} /></Protected></SessionProvider>);
    await screen.findByLabelText('Current password');
    submitNewPassword();
    await waitFor(() => expect(onSignIn).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
  });

  it('clears credential fields and blocks repeated password changes after a lost response', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/auth/session')) return reply({user, expiresAt});
      throw new TypeError('connection lost');
    });
    render(<SessionProvider config={{backend: 'cloudflare', captchaEnabled: false, googleEnabled: false, fetchImpl}}><Protected><AccountSecurityPage onVerify={() => undefined} onLicenses={() => undefined} onPasswordRecovery={() => undefined} onSignIn={() => undefined} /></Protected></SessionProvider>);
    await screen.findByLabelText('Current password');
    submitNewPassword();
    expect(await screen.findByRole('button', {name: 'Back to sign in'})).toBeInTheDocument();
    expect(screen.getByLabelText('Current password')).toHaveValue('');
    expect(screen.getByLabelText('New password')).toHaveValue('');
    expect(screen.getByRole('button', {name: 'Change password'})).toBeDisabled();
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/auth/change-password'))).toHaveLength(1);
  });

  it('shows an expired sensitive code and honors the server resend interval', async () => {
    const publishableKey = 'sb_publishable_' + 'a'.repeat(32), csrf = 'c'.repeat(64);
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path.endsWith('/auth/session')) return reply({user: {...user, financialModel: 'canonical_evidence_ledger'}, expiresAt, csrfToken: csrf});
      if (path.endsWith('/auth/email-verification')) return reply({contractVersion: 1, sessionId: 'session-one', emailVerifiedAt: null});
      if (path.endsWith('/auth/email/request')) return new Response(JSON.stringify({challenge_id: '0f689afa-5a45-4fb5-a147-9aff36f137dd', retry_after: 60, expires_in: 0, delivery_status: 'accepted'}), {status: 202, headers: {'Content-Type': 'application/json'}});
      return reply({error: {code: 'not_found'}});
    });
    render(<SessionProvider config={{backend: 'supabase', publishableKey, captchaEnabled: false, googleEnabled: false, fetchImpl}}><Protected><SensitiveEmailVerificationPage onDone={() => undefined} /></Protected></SessionProvider>);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole('button', {name: 'Send email code'}));
    expect(await screen.findByText('This code has expired. Request a new code.')).toBeInTheDocument();
    expect(screen.getByRole('button', {name: /Request again in/})).toBeDisabled();
    expect(screen.queryByRole('button', {name: 'Verify email'})).not.toBeInTheDocument();
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/auth/email/request'))).toHaveLength(1);
  });

  it('reports a confirmed email step separately from going back', async () => {
    const publishableKey = 'sb_publishable_' + 'a'.repeat(32), csrf = 'c'.repeat(64), onDone = vi.fn();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith('/auth/session')
      ? reply({user: {...user, financialModel: 'canonical_evidence_ledger'}, expiresAt, csrfToken: csrf})
      : reply({contractVersion: 1, sessionId: 'session-one', emailVerifiedAt: new Date().toISOString()}));
    render(<SessionProvider config={{backend: 'supabase', publishableKey, captchaEnabled: false, googleEnabled: false, fetchImpl}}><Protected><SensitiveEmailVerificationPage onDone={onDone} /></Protected></SessionProvider>);
    fireEvent.click(await screen.findByRole('button', {name: 'Check verification'}));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(true));
    fireEvent.click(screen.getByRole('button', {name: 'Back'}));
    expect(onDone).toHaveBeenLastCalledWith(false);
  });
});
