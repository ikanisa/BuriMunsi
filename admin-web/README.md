# BuriMunsi Admin

This package owns the BuriMunsi browser Admin and installable PWA. The Supabase
Admin API owns session admission, permissions and writes. Android Staff and
Admin Sync ship from `native/burimunsi/`.

Payments shows the configured group's incoming and outgoing M-Money payments
together. The member assignment determines whether a payment is Allocated or
Unallocated. Operators with allocation access can select a member from the
same group. Authorized Admins can inspect the separate raw SMS evidence under
Payments.

## Local verification

From the repository root, with Node 24.19.0, npm and Python 3:

```sh
npm ci --prefix admin-web
make test-admin
make admin-fixture
node admin-web/tests/browser/smoke.mjs build/admin-web-fixture
```

Install the locked browser using
`admin-web/node_modules/.bin/playwright-core install --no-shell chromium`,
or set `ADMIN_PWA_CHROME` to the path of an installed Chrome binary.
The smoke test exercises the compiled package using loopback sessions and
verifies the installed worker's static cache.

## Production package

Run `make admin-web-build` with the approved `SUPABASE_PUBLISHABLE_KEY` and the
public CAPTCHA settings matching the backend. The command supplies the exact
`burimunsi-admin-production` deployment profile. Admin and Staff sign in with their
registered mobile number and four-digit passcode. A same-origin session cookie
authorizes the workspace routes covered by their grants. In Team access, an
authorized Admin creates Staff accounts with the configured starting passcode
and can enable or disable Staff access. Each user can change their own passcode
in Account security and sign in again. Admin sessions issued by the preceding
backend retain the read-only Team directory and passcode verification workflow.
The compiler accepts the validated public client values.

The site is `build/admin-web/`. The paired `build/admin-web.json` binds its bytes
to the source and public configuration. Set `ADMIN_PWA_BUILD_DIR` to a fresh
location under `build/` for a subsequent build. Run
`bash scripts/admin_pwa_hosting_gate.sh` to verify the hosting package before
using the [BuriMunsi Admin Worker](../deploy/platform-admin/README.md).

## Installed updates

A verified update activates after the last tab or installed window using the
previous build leaves Admin.

Finish or explicitly discard unsaved form edits in their current tabs. When a
new worker is waiting, enter `about:blank` in each open Admin tab. After the last
tab has left Admin, return online to Admin in those same tabs. Keep an installed
window open if it has pending work and offers no browser address bar. Use the
original request references to check uncertain outcomes before resubmitting.
