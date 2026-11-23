export const hostingHeaders = `/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self)
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' wss://rrlduytparvsjfmegalh.supabase.co/realtime/v1/websocket; frame-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests
  X-Robots-Tag: noindex, nofollow

/
  Cache-Control: no-store, no-transform

/index.html
  Cache-Control: no-store, no-transform

/admin
  Cache-Control: no-store, no-transform

/admin/*
  Cache-Control: no-store, no-transform

/custom-sw.js
  Cache-Control: no-cache

/manifest.json
  Cache-Control: no-cache

/version.json
  Cache-Control: no-cache

/_build/*
  Cache-Control: public, max-age=31536000, immutable
`;

export const robotsRules = 'User-agent: *\nDisallow: /\n';

export function faviconRedirect(icon) {
  return `/favicon.ico /${icon} 302\n`;
}
