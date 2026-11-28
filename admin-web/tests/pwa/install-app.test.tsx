import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AdminAccountMenu} from '../../src/layout/AdminAccountMenu';
import {getAppInstallation, installInstructions} from '../../src/pwa-install';
import {LoginPage} from '../../src/session/LoginPage';
import {SessionProvider} from '../../src/session/SessionProvider';

// Each independent document owns its offered prompt and installed display mode.
const frames: HTMLIFrameElement[] = [];
afterEach(() => {frames.splice(0).forEach(frame => frame.remove());});
function browser(options: {installed?: boolean; iosStandalone?: boolean; install?: () => Promise<unknown>} = {}) {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  frames.push(frame);
  const target = frame.contentWindow!;
  const display = Object.assign(new EventTarget(), {matches: Boolean(options.installed)});
  const matchMedia = vi.fn(() => display);
  Object.defineProperty(target, 'matchMedia', {value: matchMedia});
  Object.defineProperties(target.navigator, {standalone: {value: options.iosStandalone}, install: {value: options.install}});
  return {target, display, matchMedia, controller: getAppInstallation(target)};
}
function offer(target: Window, prompt: () => Promise<unknown>, userChoice?: Promise<unknown>) {
  const event = Object.assign(new Event('beforeinstallprompt', {cancelable: true}), {prompt, userChoice});
  target.dispatchEvent(event);
  return event;
}

describe('desktop installation', () => {
  it('offers keyboard-accessible instructions on the signed-out form and leaves sign-in inputs alone', async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async () => Response.json({user: null, expiresAt: null, csrfToken: null, ownerEmail: null}));
    render(<SessionProvider config={{backend: 'supabase', phonePasscodeOnly: true, publishableKey: 'sb_publishable_' + 'a'.repeat(32),
      captchaEnabled: false, googleEnabled: false, fetchImpl}}>
      <LoginPage onSignedIn={vi.fn()} /></SessionProvider>);
    const phone = screen.getByLabelText('Mobile number');
    await user.type(phone, '000');
    const button = screen.getByRole('button', {name: 'How to install BuriMunsi Admin'});
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/bookmark this page/i)).toBeNull();
    button.focus();
    await user.keyboard('{Enter}');
    expect(button).toHaveFocus();
    expect(document.getElementById(button.getAttribute('aria-controls')!)).toHaveTextContent('bookmark this page');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard(' ');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(phone).toHaveValue('000');
    expect(fetchImpl.mock.calls).toHaveLength(1);
  });

  it('captures the offer before the account menu opens, waits for a click and consumes a dismissed prompt just once', async () => {
    const user = userEvent.setup();
    let dismiss!: (choice: {outcome: string}) => void;
    const choice = new Promise(resolve => {dismiss = resolve;});
    const prompt = vi.fn(async () => {});
    const event = offer(window, prompt, choice);
    expect(event.defaultPrevented).toBe(true);
    render(<AdminAccountMenu identity={{name: 'Test operator', role: 'Staff'}} />);
    expect(screen.queryByRole('button', {name: /install/i})).toBeNull();
    await user.click(screen.getByRole('button', {name: /Account:/}));
    const install = screen.getByRole('button', {name: 'Install BuriMunsi Admin'});
    expect(prompt).not.toHaveBeenCalled();
    install.focus();
    await user.keyboard('{Enter}');
    expect(install).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(install);
    expect(prompt).toHaveBeenCalledOnce();
    await act(async () => dismiss({outcome: 'dismissed'}));
    const help = screen.getByRole('button', {name: 'How to install BuriMunsi Admin'});
    expect(help).toHaveAttribute('aria-expanded', 'false');
    expect(help).toHaveFocus();
    await user.click(help);
    expect(prompt).toHaveBeenCalledOnce();
    expect(help).toHaveAttribute('aria-expanded', 'true');
    const nextOffer = vi.fn(async () => ({outcome: 'dismissed'}));
    act(() => {offer(window, nextOffer);});
    expect(help).toHaveAttribute('aria-expanded', 'true');
    expect(nextOffer).not.toHaveBeenCalled();
    await user.click(help);
    await user.click(screen.getByRole('button', {name: 'Install BuriMunsi Admin'}));
    expect(nextOffer).toHaveBeenCalledOnce();
  });

  it('uses a fresh offer after a dismissal and suppresses the entry after acceptance', async () => {
    const {target, controller} = browser();
    const dismissed = vi.fn(async () => ({outcome: 'dismissed'}));
    offer(target, dismissed);
    await controller.request();
    expect(controller.getSnapshot()).toBe('help');
    const accepted = vi.fn(async () => ({outcome: 'accepted'}));
    offer(target, accepted);
    await controller.request();
    expect(controller.getSnapshot()).toBe('installed');
    expect(offer(target, dismissed).defaultPrevented).toBe(false);
    await controller.request();
    expect(dismissed).toHaveBeenCalledOnce();
    expect(accepted).toHaveBeenCalledOnce();
  });

  it('uses a supported navigator installer on the user gesture, without opening two browser prompts', async () => {
    let complete!: () => void;
    const install = vi.fn(function(this: Navigator) {
      expect(this).toBe(target.navigator);
      return new Promise<void>(resolve => {complete = resolve;});
    });
    const {target, controller} = browser({install});
    const legacy = vi.fn(async () => ({outcome: 'accepted'}));
    offer(target, legacy);
    expect(controller.getSnapshot()).toBe('available');
    expect(install).not.toHaveBeenCalled();
    const pending = controller.request();
    expect(install).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toBe('prompting');
    await controller.request();
    complete();
    await pending;
    expect(controller.getSnapshot()).toBe('installed');
    expect(legacy).not.toHaveBeenCalled();
  });

  it('keeps browser cancellation quiet and falls back to help if the installer is unavailable', async () => {
    const cancelled = browser({install: vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError'))});
    expect(await cancelled.controller.request()).toBe('done');
    expect(cancelled.controller.getSnapshot()).toBe('help');
    const install = vi.fn().mockRejectedValue(new DOMException('unavailable', 'NotAllowedError'));
    const {controller} = browser({install});
    expect(await controller.request()).toBe('help');
    expect(controller.getSnapshot()).toBe('help');
    await controller.request();
    expect(install).toHaveBeenCalledOnce();
  });

  it('reconciles an external installation, a display-mode change and legacy standalone windows', async () => {
    const {target, controller, display, matchMedia} = browser({installed: true});
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    expect(matchMedia).toHaveBeenCalledWith(expect.stringContaining('(display-mode: standalone)'));
    expect(controller.getSnapshot()).toBe('installed');
    expect(browser({iosStandalone: true}).controller.getSnapshot()).toBe('installed');
    display.matches = false;
    display.dispatchEvent(new Event('change'));
    expect(listener).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toBe('help');
    const prompt = vi.fn();
    offer(target, prompt);
    expect(controller.getSnapshot()).toBe('available');
    target.dispatchEvent(new Event('appinstalled'));
    expect(controller.getSnapshot()).toBe('installed');
    await controller.request();
    expect(prompt).not.toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    display.dispatchEvent(new Event('change'));
    expect(listener).not.toHaveBeenCalled();
  });

  it('shows instructions when a deferred browser prompt fails', async () => {
    const prompt = vi.fn().mockRejectedValue(new Error('prompt unavailable'));
    offer(window, prompt);
    render(<AdminAccountMenu identity={{name: 'Test operator'}} />);
    await userEvent.click(screen.getByRole('button', {name: /Account:/}));
    fireEvent.click(screen.getByRole('button', {name: 'Install BuriMunsi Admin'}));
    await waitFor(() => expect(screen.getByRole('button', {name: 'How to install BuriMunsi Admin'})).toHaveAttribute('aria-expanded', 'true'));
    expect(screen.getByText(/bookmark this page/i)).toBeVisible();
  });

  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X) Version/27.0 Safari/605.1.15', 0, [], 'Add to Dock'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X) Version/27.0 Safari/605.1.15', 5, [], 'Add to Home Screen'],
    ['Mozilla/5.0 (iPhone) Version/18.0 Mobile Safari/605.1.15', 1, [], 'Add to Home Screen'],
    ['Mozilla/5.0 (Windows NT 10.0) Chrome/146.0 Safari/537.36 Edg/146.0', 0, [], 'More tools and Apps'],
    ['Mozilla/5.0 Chrome/146.0 Safari/537.36', 0, ['Chromium', 'Google Chrome'], 'Cast, save, and share'],
    ['Mozilla/5.0 (Linux; Android) Chrome/146.0 Mobile Safari/537.36', 1, ['Google Chrome'], 'Install and create shortcut'],
    ['Mozilla/5.0 (Macintosh) Chrome/146.0 Safari/537.36', 0, ['Other Chromium browser'], 'bookmark this page'],
  ] as const)('provides instructions appropriate to %s, touch %s and brands %s', (userAgent, maxTouchPoints, brands, expected) => {
    expect(installInstructions({userAgent, maxTouchPoints, userAgentData: {brands: brands.map(brand => ({brand}))}})).toContain(expected);
  });
});
