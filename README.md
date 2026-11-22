# BuriMunsi

BuriMunsi runs group savings for its configured group. The Android Staff app handles member and payment workflows. The Android Admin Sync variant operates on the authorized receiving handset. The web Admin handles operator access, member and financial oversight, and reconciliation.

## Source and runtime

| Surface | Maintained source |
| --- | --- |
| Android Staff and Admin Sync | `native/burimunsi/`, Kotlin/Compose with pinned receiver source in `vendor/receiver-compat/` |
| Web Admin | `admin-web/` and `deploy/platform-admin/wrangler.burimunsi.jsonc` |
| API, ledger, evidence and jobs | `supabase/functions/`, `supabase/migrations/`, `supabase/jobs/` and `deploy/collect-sms/` |
| Generated contracts | `contracts/` and the generators under `scripts/` |

The tracked source was extracted from `ikanisa/COOL` at `192c24f8574f42dc4be8736f787ab6e8d5cd97c5`. Builds use this checkout’s own source, including the verified receiver code under `vendor/receiver-compat/`. The BuriMunsi production target is the existing Supabase Cloud project `rrlduytparvsjfmegalh`. The web Admin target is `https://burimunsi-admin.ikanisa.com`. This preserves the current financial ledger and receipt evidence while giving each release its own source and deployment identity.

## Build and verification

Use Node 24.19.0, Deno 2.9.6, Python 3, JDK 17 and the pinned Gradle and Android SDK described by `native/burimunsi/scripts/setup_native_toolchain.py`. Use a disposable PostgreSQL 17 cluster for managed-schema and ledger rehearsals.

```sh
npm ci --prefix admin-web --no-audit --no-fund
npm ci --prefix deploy/platform-admin --ignore-scripts --no-audit --no-fund
npm ci --prefix scripts/supabase --ignore-scripts --no-audit --no-fund
make check-source
make test-admin
make test-backend
make admin-fixture
node admin-web/tests/browser/smoke.mjs build/admin-web-fixture
```

`make admin-web-build` requires the approved Supabase publishable key and the public production CAPTCHA configuration. The build command supplies the exact dedicated profile. Keep provider secrets outside this checkout. `make native-build NATIVE_OUTPUT=/absolute/path/to/new-evidence` produces the isolated native test and qualification artifacts. Follow [testing-candidate compilation](native/burimunsi/configuration/testing-candidate.md) for a configured unsigned release build.

## Internal access and SMS receiving

People sign in to the Android app with a phone number and passcode managed by
BuriMunsi. The Admin adds Staff by phone number. Leaving the passcode field
blank at creation uses the configured `BURIMUNSI_DEFAULT_STAFF_PIN` secret.

The Admin account has M-Money SMS access. Staff SMS access is off. The receiving
app uses one active receiving SIM at a time on the current handset. The Admin
can use the existing receiver handoff when changing phones. App access comes
from the account on any supported handset.

The release record binds the Android artifacts, Admin build and live Edge
source. Record carrier receipt reconciliation when an authorized transaction
is completed through the active receiver. [Android authority transition](native/burimunsi/configuration/authority-transition.md) · [Scheduler operation](supabase/jobs/README.md)

The managed runtime revision requires the exact deployment source, the current
fence epoch and function inventory, and verified preimages for
`BURIMUNSI_PRODUCT_MODE=standalone` and the explicitly approved
`BURIMUNSI_COLLECTION_ID`. The collection identifier must match the only
configured Supabase collection. The initial revision can use the project
owner’s bound single-statement Management API transport in
`scripts/supabase/cloud-release/management-revision.mjs`. Managed release
receipts are written to the checkout’s private `build/managed-release/`
directory. Password-backed procedures use an operator-provided private
`BURIMUNSI_DB_PASSWORD_FILE`.

Frozen archive source manifests and recovery recipes preserve historical
evidence. Current builds, tests and commissioning use the BuriMunsi source,
current release records, and separately controlled provider credentials.
