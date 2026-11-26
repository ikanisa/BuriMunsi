# BuriMunsi

BuriMunsi records incoming and outgoing M-Money payments for its configured group. Staff and Admin work from the same Payments area. Admin Sync captures the group's eligible M-Money SMS, while Web Admin provides operator access, members, payments and authorized SMS evidence.

For BuriMunsi support or an account deletion request, [contact support on WhatsApp at +250 788 767 816](https://wa.me/250788767816).

## Source and runtime

| Surface | Maintained source |
| --- | --- |
| Android Staff and Admin Sync | `native/burimunsi/`, Kotlin/Compose with pinned receiver source in `vendor/receiver-compat/` |
| Web Admin | `admin-web/` and `deploy/platform-admin/wrangler.burimunsi.jsonc` |
| API, payments, SMS evidence and jobs | `supabase/functions/`, `supabase/migrations/`, `supabase/jobs/` and `deploy/collect-sms/` |
| Generated contracts | `contracts/` and the generators under `scripts/` |

The tracked source was extracted from `ikanisa/COOL` at `192c24f8574f42dc4be8736f787ab6e8d5cd97c5`. Builds use this checkout’s own source, including the verified receiver code under `vendor/receiver-compat/`. The BuriMunsi production target is the existing Supabase Cloud project `rrlduytparvsjfmegalh`. The web Admin target is `https://burimunsi-admin.ikanisa.com`. Each release has its own source and deployment identity.

## Build and verification

Use Node 24.19.0, Deno 2.9.6, Python 3, JDK 17 and the pinned Gradle and Android SDK described by `native/burimunsi/scripts/setup_native_toolchain.py`. Use a disposable PostgreSQL 17 cluster for managed-schema, SMS parsing and payment-allocation tests.

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

Admin Sync stores each eligible raw SMS in Supabase and preserves it separately
from the parsed payment. Each processing pass checks the eligible phone inbox
against retained sources and parser outcomes. A missing message is uploaded
under its original identity. For messages already on the phone at enrollment,
an exact match to an earlier payment reuses that payment. A newly verified
source goes to the regular parser. The check reports complete once every
eligible row is accounted for and the latest phone and parsed messages match.

The parser records supported incoming and outgoing
payments in `burimunsi.payments`. The Payments area shows both directions in
one list. Each payment starts **Unallocated** and becomes **Allocated** when
assigned to a member of the same group. Allocation uses the current payment
version and an idempotency key. A duplicate SMS or allocation retry preserves
the original payment. The first allocation of an incoming payment creates one
payer SMS request. The SMS goes to the full payer number evidenced by the
original receipt. A missing number or an opt-out is recorded in M-Money SMS.
The gateway reports delivery after the carrier acknowledges every message part.
Outgoing payments and earlier allocations produce no confirmation.

Release verification checks the profile-based SMS consent and access model,
raw SMS retention, parsing, the single Payments list and member allocation.
Historical receiver documents remain available as evidence.

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
