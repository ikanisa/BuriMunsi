import {BURIMUNSI_ADMIN_ORIGIN, standalonePrivacyRoute} from './burimunsi-standalone.js';
import {burimunsiSupport} from './burimunsi-support.js';
import {privacyPortalCss} from './domain/privacy_portal_style.js';

const pathRoot = '/privacy/account-deletion';
const stylesheet = `${pathRoot}/assets/style.css`;
const edgePrefix = '/functions/v1/collect-api';
const policy = "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

function publicDocument(title, prefix, main) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${title} · BuriMunsi</title><link rel="stylesheet" href="${prefix}${stylesheet}"></head>
<body><div id="page"><header><a class="identity" href="${BURIMUNSI_ADMIN_ORIGIN}/">BuriMunsi</a></header>
<main><h1>${title}</h1>${main}</main></div></body></html>`;
}

function supportDocument(prefix) {
  return publicDocument('Account deletion', prefix, `<p>Contact BuriMunsi support to request an account deletion review without installing the app.</p>
<p><a href="${burimunsiSupport.url}" rel="noreferrer">Contact support on WhatsApp at ${burimunsiSupport.phone}</a></p>
<p class="notice">Send a message asking for account deletion to start the review. Your account stays accessible while support verifies your identity and determines which records can be deleted and which financial records must be retained.</p>
<p class="muted">Keep your passcode and identity documents private. Support will explain how to verify your identity securely.</p>
<p><a href="${prefix}/privacy">How BuriMunsi uses your data</a></p>`);
}

function privacyDocument(prefix) {
  return publicDocument('Privacy and data use', prefix, `<p>BuriMunsi Staff, Admin Sync and Web Admin help your group manage members and record M-Money payments.</p>
<h2>Members and payments</h2><p>BuriMunsi uses names and mobile numbers to identify operators and members. Authorized operators can see their group’s members and payments, including amounts, dates, payer details and member allocations.</p>
<h2>M-Money messages</h2><p>After the Admin grants Android SMS permission, Admin Sync sends eligible M-Money messages to Supabase to record payments. Original messages are stored separately from payment records. Only an authorized Admin can open an original. BuriMunsi records the reason for that access. Staff cannot read original messages.</p>
<p>When an incoming payment is allocated to a member, BuriMunsi can send a confirmation through its SMS provider to the payer number on the receipt. A recorded opt-out prevents that message.</p>
<h2>Photos of member lists</h2><p>When you use a photo of a member list, the app sends the image to OpenAI to extract names and mobile numbers. You can review the extracted members before saving them.</p>
<h2>Retention and account deletion</h2><p>You can <a href="${prefix}${pathRoot}">request account deletion</a>. Support reviews which information can be deleted and which financial records must be retained. For questions about your data, <a href="${burimunsiSupport.url}" rel="noreferrer">contact BuriMunsi support on WhatsApp</a>.</p>`);
}

export function standalonePrivacySupport(request, {directEdge = false, headers} = {}) {
  let path = new URL(request.url).pathname;
  if (!directEdge && path.startsWith(`${edgePrefix}/privacy`)) path = path.slice(edgePrefix.length);
  if (!standalonePrivacyRoute(request.method, path)) return null;
  const isStylesheet = path === stylesheet;
  const isPrivacy = path === '/privacy' || path === '/privacy/';
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', isStylesheet ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
  responseHeaders.set('Content-Security-Policy', policy);
  responseHeaders.set('Cache-Control', 'private, no-store, no-transform');
  responseHeaders.set('X-Content-Type-Options', 'nosniff');
  responseHeaders.set('X-Frame-Options', 'DENY');
  responseHeaders.set('Referrer-Policy', 'no-referrer');
  responseHeaders.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (!isStylesheet) responseHeaders.set('X-Collect-Document', isPrivacy ? 'burimunsi.privacy.notice.v1' : 'burimunsi.privacy.support.v1');
  const prefix = directEdge ? edgePrefix : '';
  const body = isStylesheet ? privacyPortalCss : isPrivacy ? privacyDocument(prefix) : supportDocument(prefix);
  return new Response(request.method === 'HEAD' ? null : body, {headers: responseHeaders});
}
