#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { configuration, SafeError, saveCredential } from './config.mjs';
import { parseSession, readAdminSessionResponse, requestJson, sameAdminSession } from './api.mjs';
import { loginCookie, verifyAndSaveLogin } from './login_session.mjs';
import { runTerminalCommand, secretPrompt } from './operator_terminal.mjs';
import { captchaFields } from './login_otp.mjs';
import { normalizePhone, requirePin } from '../../../supabase/functions/_shared/domain/burimunsi/values.js';

/** Separate human-only setup; never registered as an MCP tool. */
export async function loginWithCredentials(config, email, password, options = {}) {
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof password !== 'string' || password.length < 1 || password.length > 512) {
    throw new SafeError('invalid_login', 'Enter the existing Admin account email and password.');
  }
  const captcha = captchaFields(options);
  // A login is a single attempt. An uncertain response is never retried.
  const reply = await requestJson(config, '/api/admin/auth/login', { method: 'POST', body: { email, password, ...captcha } });
  return verifyAndSaveLogin(config, reply, email, 'The Admin session could not be verified. No local credential was saved.');
}
export { secretPrompt } from './operator_terminal.mjs';

export async function loginWithPhonePasscode(config, input, pin) {
  let phone;
  try { phone = normalizePhone(input); requirePin(pin); }
  catch { throw new SafeError('invalid_login', 'Enter a Rwanda mobile number and a four-digit passcode.'); }
  const reply = await requestJson(config, '/api/admin/auth/phone-passcode', { method: 'POST', body: { phone, pin } }).catch(error => {
    if (error.code === 'session_unavailable') throw new SafeError('invalid_login', 'Check your mobile number and four-digit passcode.');
    throw error;
  });
  const cookie = loginCookie(reply.headers, config.origin);
  const issued = parseSession(reply.value);
  if (issued.authMethod !== 'phone_passcode' || issued.phone !== phone) {
    throw new SafeError('session_changed', 'The sign-in response did not match the requested phone account.');
  }
  const { user, csrfToken } = await readAdminSessionResponse(config, cookie);
  if (!sameAdminSession(issued, user) || csrfToken !== reply.value.csrfToken) {
    throw new SafeError('session_changed', 'The phone account or session changed during sign-in.');
  }
  await saveCredential(config, { version: 2, origin: config.origin, cookie, accountId: user.id,
    principalId: user.principalId, sessionId: user.sessionId, expiresAt: user.expiresAt,
    phoneAccountId: user.phoneAccountId, collectionId: user.collectionId });
  return { role: user.role, expiresAt: user.expiresAt };
}

async function main() {
  if (!process.stdin.isTTY || !process.stderr.isTTY || process.argv.length !== 2) {
    throw new SafeError('interactive_login_required', 'Run the login command directly in a terminal and enter your mobile number and passcode at the prompts.');
  }
  const config = configuration();
  process.stderr.write(`Sign in to ${config.origin} with your BuriMunsi Admin or Staff account.\n`);
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  let phone;
  try { phone = await prompt.question('Mobile number: '); }
  finally { prompt.close(); }
  const pin = await secretPrompt('Four-digit passcode (hidden): ');
  const result = await loginWithPhonePasscode(config, phone, pin);
  process.stderr.write(`Local ${result.role} access saved until ${result.expiresAt}.\n`);
}
runTerminalCommand(import.meta.url, main, 'Local sign-in failed. No credentials were printed.');
