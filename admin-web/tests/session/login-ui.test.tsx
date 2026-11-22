import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {LoginPage} from '../../src/session/LoginPage';
import {AdminSessionController, SessionProvider} from '../../src/session/SessionProvider';

const publishableKey = 'sb_publishable_' + 'a'.repeat(32);
const csrf = 'c'.repeat(64);
const account = {id: 'operator-one', email: 'operator@example.test', role: 'admin', sessionId: 'session-one',
  permissions: ['overview.read'], principalId: 'principal-one', assuranceLevel: 1, mfaAt: null,
  authMethod: 'phone_passcode', phone: '+250780000001', financialModel: 'canonical_evidence_ledger'};
const reply = (body: unknown, status = 200) => Response.json(body, {status});
const anonymous = () => reply({user: null, expiresAt: null, csrfToken: null, ownerEmail: null});
const signedIn = (user = account) => reply({user: {...user, passcodeVerifiedAt: new Date(Date.now() - 1000).toISOString()},
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), csrfToken: csrf, ownerEmail: null});
const owner = {...account, role: 'owner'};
const ownerIdentity = {schemaVersion: 1, adminId: owner.id, principalId: owner.principalId, email: owner.email};
const confirmed = (passcodeVerifiedAt = new Date(Date.now() - 1000).toISOString()) => ({
  sessionContract: 2, user: {...owner, passcodeVerifiedAt}, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  csrfToken: csrf, ownerEmail: owner.email, ownerIdentity,
});

function openLogin(fetchImpl: typeof fetch, challenge = vi.fn()) {
  const onSignedIn = vi.fn();
  render(<SessionProvider config={{backend: 'supabase', phonePasscodeOnly: true, publishableKey,
    captchaEnabled: true, googleEnabled: true, acquireCaptcha: challenge, fetchImpl}}>
    <LoginPage onSignedIn={onSignedIn} />
  </SessionProvider>);
  return onSignedIn;
}

function submit() {
  fireEvent.change(screen.getByLabelText('Mobile number'), {target: {value: '0780 000 001'}});
  fireEvent.change(screen.getByLabelText('Four-digit passcode'), {target: {value: '0123'}});
  fireEvent.click(screen.getByRole('button', {name: 'Sign in'}));
}

describe('BuriMunsi phone and passcode sign-in', () => {
  it('requires session readback after an initial connection failure', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      if (++calls === 1) throw new TypeError('offline');
      return anonymous();
    });
    openLogin(fetchImpl);
    const check = await screen.findByRole('button', {name: 'Check session'});
    const help = screen.getByRole('link', {name: 'WhatsApp support · +250 788 767 816'});
    expect(help).toHaveAttribute('href', 'https://wa.me/250788767816');
    expect(help).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByLabelText('Mobile number')).toBeDisabled();
    expect(screen.getByText(/workspace could not be reached/i)).toBeInTheDocument();
    fireEvent.click(check);
    expect(await screen.findByRole('button', {name: 'Sign in'})).toBeInTheDocument();
    expect(screen.getByLabelText('Mobile number')).toBeEnabled();
    expect(calls).toBe(2);
  });

  it('sends only the normalized phone and passcode once, then confirms the exact cookie session', async () => {
    let authenticated = false;
    const challenge = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const identityVersion = new Headers(init?.headers).get('X-Collect-Owner-Identity-Version');
      if (path.endsWith('/auth/session')) {
        expect(identityVersion).toBe('1');
        return authenticated ? signedIn() : anonymous();
      }
      expect(path).toBe('/api/admin/auth/phone-passcode');
      expect(identityVersion).toBeNull();
      expect(JSON.parse(String(init?.body))).toEqual({phone: '+250780000001', pin: '0123'});
      expect(init?.credentials).toBe('same-origin');
      authenticated = true;
      return signedIn();
    });
    const onSignedIn = openLogin(fetchImpl, challenge);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Four-digit passcode')).toHaveAttribute('type', 'password');
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.queryByText(/google|reset your password|send.*code/i)).toBeNull();
    submit();
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      '/api/admin/auth/session', '/api/admin/auth/phone-passcode', '/api/admin/auth/session',
    ]);
    expect(challenge).not.toHaveBeenCalled();
  });

  it('never resubmits a lost sign-in request while the operator checks the session', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/auth/session')) return anonymous();
      throw new TypeError('connection lost');
    });
    openLogin(fetchImpl);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    submit();
    fireEvent.click(await screen.findByRole('button', {name: 'Check session'}));
    await screen.findByRole('button', {name: 'Sign in'});
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/auth/phone-passcode'))).toHaveLength(1);
    expect(screen.getByLabelText('Four-digit passcode')).toHaveValue('');
  });

  it.each([true, false])('checks a direct owner proof without a second session read (%s)', async matches => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      if (String(input).endsWith('/auth/session')) return anonymous();
      expect(new Headers(options?.headers).get('X-Collect-Owner-Identity-Version')).toBeNull();
      const proof = confirmed();
      return reply(matches ? proof : {...proof, ownerIdentity: {...ownerIdentity, principalId: 'another-person'}});
    });
    const onSignedIn = openLogin(fetchImpl);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    submit();
    if (matches) await waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    else {
      expect(await screen.findByRole('button', {name: 'Check session'})).toBeInTheDocument();
      expect(onSignedIn).not.toHaveBeenCalled();
    }
    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual(['/api/admin/auth/session', '/api/admin/auth/phone-passcode']);
  });

  it.each(['admin', 'staff'])('opens a managed %s session directly from its phone sign-in response', async role => {
    const accountId = '11111111-1111-4111-8111-111111111111';
    const user = {...account, email: null, accountId, role, passcodeVerifiedAt: new Date(Date.now() - 1000).toISOString()};
    const adminIdentity = {schemaVersion: 1, accountId, role, adminId: user.id, principalId: user.principalId, collectionId: 'group-one'};
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/auth/session') ? anonymous() :
      reply({sessionContract: 2, user, csrfToken: csrf, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ownerEmail: null, ...(role === 'admin' ? {adminIdentity} : {})}));
    const onSignedIn = openLogin(fetchImpl);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    submit();
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['/api/admin/auth/session', '/api/admin/auth/phone-passcode']);
  });

  it('rejects a different cookie session after a successful sign-in response', async () => {
    let attempted = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/auth/session')) return attempted ? signedIn({...account, sessionId: 'different-session'}) : anonymous();
      attempted = true;
      return signedIn();
    });
    const onSignedIn = openLogin(fetchImpl);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    submit();
    expect(await screen.findByRole('button', {name: 'Check session'})).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it.each([{...account, role: 'staff'}, {...account, authMethod: 'email_otp'}])('does not restore unsupported cookie authority', async user => {
    const fetchImpl = vi.fn(async () => signedIn(user));
    const onSignedIn = openLogin(fetchImpl);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', {name: 'Sign in'})).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});

describe('BuriMunsi passcode verification', () => {
  it('accepts the bound versioned proof on the same session without another GET', async () => {
    const verified = new Date().toISOString();
    const old = new Date(Date.now() - 310_000).toISOString();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      if (String(input).endsWith('/auth/session')) return reply(confirmed(old));
      expect(new Headers(options?.headers).get('X-Collect-Owner-Identity-Version')).toBeNull();
      return reply({contractVersion: 1, sessionId: owner.sessionId, passcodeVerifiedAt: verified, session: confirmed(verified)});
    });
    const controller = new AdminSessionController({backend: 'supabase', phonePasscodeOnly: true, publishableKey,
      captchaEnabled: false, googleEnabled: false, fetchImpl});
    try {
      await controller.refresh();
      await controller.verifySensitivePasscode('0123');
      expect(controller.getSnapshot().user?.passcodeVerifiedAt).toBe(verified);
      expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual(['/api/admin/auth/session', '/api/admin/auth/passcode/verify']);
    } finally {controller.stop();}
  });
  it.each([true, false])('requires independent readback of a new proof on the same session (%s)', async matches => {
    const original = new Date(Date.now() - 310_000).toISOString();
    const verified = new Date(Date.now() - 1000).toISOString();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const fetchPaths: string[] = [];
    let verifiedRequest = false;
    const controller = new AdminSessionController({backend: 'supabase', phonePasscodeOnly: true, publishableKey,
      captchaEnabled: true, googleEnabled: false, fetchImpl: async (input, init) => {
        const path = String(input);
        fetchPaths.push(path);
        const headers = new Headers(init?.headers);
        if (path.endsWith('/auth/session')) {
          expect(headers.get('X-Collect-Owner-Identity-Version')).toBe('1');
          return reply({
            user: {...account, passcodeVerifiedAt: verifiedRequest && matches ? verified : original},
            expiresAt, csrfToken: csrf, ownerEmail: null,
          });
        }
        expect(path).toBe('/api/admin/auth/passcode/verify');
        expect(headers.get('X-Collect-Owner-Identity-Version')).toBeNull();
        expect(headers.get('X-Collect-CSRF')).toBe(csrf);
        expect(JSON.parse(String(init?.body))).toEqual({pin: '0123'});
        verifiedRequest = true;
        return reply({contractVersion: 1, sessionId: account.sessionId, passcodeVerifiedAt: verified});
      }});
    try {
      await controller.refresh();
      const {epoch} = controller.getSnapshot();
      expect(controller.isRecentSensitiveVerification(epoch, account.id, account.sessionId)).toBe(false);
      if (matches) {
        await controller.verifySensitivePasscode('0123');
        expect(controller.isRecentSensitiveVerification(epoch, account.id, account.sessionId)).toBe(true);
      } else {
        await expect(controller.verifySensitivePasscode('0123')).rejects.toMatchObject({outcomeUnknown: true});
        expect(controller.isRecentSensitiveVerification(epoch, account.id, account.sessionId)).toBe(false);
      }
      expect(fetchPaths).toEqual(['/api/admin/auth/session', '/api/admin/auth/passcode/verify', '/api/admin/auth/session']);
    } finally {controller.stop();}
  });
});
