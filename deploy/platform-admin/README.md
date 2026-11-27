# BuriMunsi Admin Worker

`wrangler.burimunsi.jsonc` binds `https://burimunsi-admin.ikanisa.com` to the
BuriMunsi React PWA in `build/admin-web` and to the approved managed Supabase
project. The Worker requires that origin and the exact
`burimunsi-admin-production` profile on every entry.

Browser API requests use the same origin. The Worker admits Admin APIs and
serves the public [privacy and data use notice](https://burimunsi-admin.ikanisa.com/privacy)
and [account-deletion guidance](https://burimunsi-admin.ikanisa.com/privacy/account-deletion).
The standalone `collect-api` Edge function serves the same documents. The deletion page directs
requests to [BuriMunsi support on WhatsApp at +250 788 767 816](https://wa.me/250788767816).
Admin sign-in uses the BuriMunsi
mobile number and passcode. The Worker bounds request and response bodies,
translates the host-only BuriMunsi session cookie for the Admin API, and
preserves request identifiers and outcome-unknown responses.
Collect mobile association and member routes are refused at the Worker.

Run `npm test` from this directory. The current integrated transport digest is
recorded in `supabase-transport.provenance.json`. Build and verify the PWA with the
[Admin package commands](../../admin-web/README.md) before preparing a hosting
candidate. Qualified static assets retain their exact bytes. The PWA service
worker caches credential-free static assets and verifies the versioned files.

If a dispatched request returns `proxy_outcome_unknown`, use its original
operation or idempotency reference to reconcile the outcome. The transport
dispatches each request once.
