import {BURIMUNSI_ADMIN_ORIGIN, standalonePrivacyRoute} from './burimunsi-standalone.js';
import {burimunsiSupport} from './burimunsi-support.js';
import {privacyPortalCss} from './domain/privacy_portal_style.js';

const pathRoot = '/privacy/account-deletion';
const stylesheet = `${pathRoot}/assets/style.css`;
const edgePrefix = '/functions/v1/collect-api';
const policy = "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

function supportDocument(stylesheetPath) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Account deletion · BuriMunsi</title><link rel="stylesheet" href="${stylesheetPath}"></head>
<body><div id="page"><header><a class="identity" href="${BURIMUNSI_ADMIN_ORIGIN}/">BuriMunsi</a></header>
<main><h1>Account deletion</h1><p>Contact BuriMunsi support to request an account deletion review without installing the app.</p>
<p><a href="${burimunsiSupport.url}" rel="noreferrer">Contact support on WhatsApp at ${burimunsiSupport.phone}</a></p>
<p class="notice">Submitting a request starts a review. Your account stays accessible while we review which data can be deleted and which financial records must be retained.</p>
<p class="muted">Keep your passcode and identity documents private. Support will explain how to verify your identity securely.</p></main></div></body></html>`;
}

export function standalonePrivacySupport(request, {directEdge = false, headers} = {}) {
  let path = new URL(request.url).pathname;
  if (!directEdge && path.startsWith(`${edgePrefix}${pathRoot}`)) path = path.slice(edgePrefix.length);
  if (!standalonePrivacyRoute(request.method, path)) return null;
  const isStylesheet = path === stylesheet;
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', isStylesheet ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
  responseHeaders.set('Content-Security-Policy', policy);
  responseHeaders.set('Cache-Control', 'private, no-store, no-transform');
  responseHeaders.set('X-Content-Type-Options', 'nosniff');
  responseHeaders.set('X-Frame-Options', 'DENY');
  responseHeaders.set('Referrer-Policy', 'no-referrer');
  responseHeaders.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (!isStylesheet) responseHeaders.set('X-Collect-Document', 'burimunsi.privacy.support.v1');
  const body = isStylesheet ? privacyPortalCss : supportDocument(directEdge ? edgePrefix + stylesheet : stylesheet);
  return new Response(request.method === 'HEAD' ? null : body, {headers: responseHeaders});
}
