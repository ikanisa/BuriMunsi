import {AdminRequestError, type AdminApiClient, type AdminRequest} from '../api/client';
import type {PasswordChangeOutcome} from './sessionContext';

interface PasswordConfirmation {
  current: () => boolean;
  confirmAnonymous: () => Promise<boolean>;
}

type AccountPasswordPort = {request: AdminRequest; current: () => boolean} & (
  | {backend: 'supabase'; verifyEmail: () => Promise<boolean>}
  | {backend: 'cloudflare'; confirmAnonymous: () => Promise<boolean>}
);

export async function completePasswordSetup(
  {token, password, invite}: {token: string; password: string; invite: boolean},
  {request, current, confirmAnonymous}: PasswordConfirmation & {request: AdminApiClient['request']},
): Promise<void> {
  if (!/^\S{32,512}$/.test(token) || password.length < 12 || password.length > 128) throw new Error('Check the password and link.');
  const result = await request('auth/complete-password', {body: {token, password, invite}, authenticated: false}, {isCurrent: current});
  if (result.ok !== true || !current() || !(await confirmAnonymous())) {
    throw new AdminRequestError('The password result is not confirmed. Sign in using your email code or request a new reset link.', {outcomeUnknown: true});
  }
}

export async function changeAccountPassword(
  {currentPassword, newPassword}: {currentPassword: string; newPassword: string},
  port: AccountPasswordPort,
): Promise<PasswordChangeOutcome> {
  const {request, current} = port;
  if (!currentPassword || currentPassword.length > 512 || newPassword.length < 12 || newPassword.length > 128 || currentPassword === newPassword) {
    throw new Error('Enter your current password and a different new password of 12 to 128 characters.');
  }
  if (port.backend === 'supabase' && !(await port.verifyEmail())) {
    throw new AdminRequestError('Verify your email before making this change.', {code: 'recent_email_sign_in_required'});
  }
  if (!current()) throw new AdminRequestError('Your sign-in changed. Reopen account security.');
  const result = await request('auth/change-password', {body: {currentPassword, newPassword}, authenticated: true, expectedStatus: 200});
  if (result.ok !== true || !current() || (port.backend === 'cloudflare' && !(await port.confirmAnonymous()))) {
    throw new AdminRequestError('The password result is not confirmed. Sign in using your email code or request a reset.', {outcomeUnknown: true});
  }
  return port.backend === 'supabase' ? 'session-retained' : 'signed-out';
}
