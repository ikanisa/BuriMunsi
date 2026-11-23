# BuriMunsi

BuriMunsi runs group savings for its configured group. The Android Staff app handles member and payment workflows. Admin Sync captures eligible M-Money receipts for the signed-in Admin. The web Admin handles operator access, member and financial oversight, and reconciliation.

For BuriMunsi support or an account deletion request, [contact support on WhatsApp at +250 788 767 816](https://wa.me/250788767816).

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

`make admin-web-build` requires the approved Supabase publishable key. The build command supplies the exact dedicated profile. Keep provider secrets outside this checkout. `make native-build NATIVE_OUTPUT=/absolute/path/to/new-evidence` produces the isolated native test and qualification artifacts. Follow [testing-candidate compilation](native/burimunsi/configuration/testing-candidate.md) for a configured unsigned release build.

## Account roles, SMS access and payments

BuriMunsi has one designated human Admin and separate Staff accounts. Users sign
in with their registered mobile number and four-digit passcode. The signed-in
profile determines access: only the Admin can capture M-Money SMS; Staff never
have SMS access.

The Admin can sign in on any supported Android phone and use any SIM that
receives the relevant M-Money messages. SMS capture starts automatically after
Admin sign-in and once Android's SMS permissions are granted. No device or SIM
registration, manual pairing, or phone handoff is part of the product workflow.
The login number identifies the user, not the phone or SIM.

Payment processing is automatic. The system validates and deduplicates eligible
receipts and posts verified payments without manual transaction review or
approval. A receipt that cannot be validated must not post as a payment.

This is the product requirement, not a claim that an existing build or
deployment already meets it. Historical receiver documents remain release
evidence, not the current product workflow. Release verification must confirm
that the Android apps and backend follow the profile-based model.

The release record binds the Android artifacts, Admin build and live Edge
source. See [scheduler operation](supabase/jobs/README.md) for background
processing and operational evidence.

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
