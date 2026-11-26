# BuriMunsi production performance audit

26 November 2026 · Africa/Kigali

On the current Admin panel, populated Home took a median 1.88 seconds for Staff and 1.89 seconds for Admin. A selected payment opened from Staff Home in 2.11 seconds. On the preceding web performance release `6ce90c5`, Admin reached populated Home in a median 1.86 seconds and Staff in 1.89 seconds. All twelve Home reloads used one request. Staff opened a payment from Home in a median 2.72 seconds across eight clicks. On the production Pixel, both installed apps displayed all three Home amounts in every e107 trial. The median was 2.75 seconds for Staff and 2.28 seconds for Admin Sync across six launches per role. The slowest Staff launch took 10.05 seconds.

## What changed

The audit inventoried 3,026 tracked files at `38af6b1` and followed the normal signed-in paths through the Staff and Admin Sync Android apps, Admin PWA, Cloudflare Worker, Supabase Edge Functions, PostgreSQL, Storage and background jobs. It covered runtime code, the shared wire contracts, receiver compatibility, tests and deployment tooling. The timed routes were Home, Payments, payment details, Members, member details, balances, statements, Admin SMS and Team.

- Android now requests session, Home and savings together. Home can draw as soon as the scoped records arrive. When the optional database read times out and the server omits savings, Android requests them once in the background. A present partial response retains its recorded values. A route change, expired grant, downgraded capability, account switch or collection switch cannot attach the old response to the new screen.
- Android publishes authorized records before writing the encrypted cache. Navigation can proceed during optional reads. Reopening the current tab avoids refreshing it unnecessarily. A Staff member row can open directly when the signed-in actor, collection, permission, record version and freshness still match. Admin edits and deep links retain an authoritative lookup. Foreground and explicit readback of the same member detail sheet now issue one member request.
- The PWA loads route code on demand and starts independent data reads together. Home gets its own recent rows. Opening a payment starts its detail lookup immediately. Member balance and the first statement page can travel alongside the scoped member profile. The Admin SMS inbox uses the collection verified by its signed-in phone session. Multi-collection sessions still discover their permitted collections.
- Supabase reads Home totals and recent activity in one statement, and joins member and financial projections inside the same scope-checked transaction. Existing clients can keep calling the original endpoints. The optional 450 ms database budget preserves Home access if calculating savings takes longer. The query on a real, warm production snapshot spent about 20 ms executing. Successful production savings queries also reached 1.68 seconds, so testing included the timeout path.
- The PWA deployment retains immutable assets from previous builds. Two sampled URLs from older open sessions initially returned 404. The final asset inventory and signed-in browser retest are recorded below.

## Measurement

The same physical Pixel 4a, authenticated roles, app installation identities and observation code were used before and after the update. Each role had three fresh Home trials, two warm returns, two Members list trials and two trials per detail screen. Staff used a cold process for fresh samples. The Admin Sync foreground service stayed available during its hot launches. A Home money result required all three individual amounts to appear. Browser figures use the production host with three runs per role on the core paths and two on the additional routes. These are elapsed user journeys on the observed network.

### Physical Pixel 4a, v65 baseline and v67 before the final server rollout

| Screen or action | Staff before (s) | Staff after (s) | Admin Sync before (s) | Admin Sync after (s) |
|---|---:|---:|---:|---:|
| First frame | 0.21 | 0.22 | 0.05 | 0.08 |
| Home records visible | 2.97 | 2.44 | 1.87 | 2.02 |
| Fresh Home data drawn | 2.97 | 2.46 | 1.86 | 2.11 |
| All three Home amounts visible | 4.75 | 2.44 | 3.46 | 2.02 |
| Return to the open app on Home | 2.58 | 2.58 | 4.16 | 2.29 |
| Payments tab acknowledgement | 0.12 | 0.23 | 0.10 | 0.18 |
| Payments records visible | 1.24 | 0.38 | 1.34 | 1.25 |
| First newly fetched Payments draw | 1.50 | 21.54 | 1.49 | 1.45 |
| Revisit Payments | 0.26 | 0.29 | 0.23 | 0.26 |
| Members list | 0.99 | 0.99 | 1.01 | 0.84 |
| Payment detail | 1.14 | 2.67 | 1.00 | 1.10 |
| Member detail | 1.79 | 0.15 | 0.81 | 0.70 |

### Physical Pixel 4a after reopening e107

Six launches rechecked the two installed Play-track builds against the final backend. Staff started a new process each time. Admin Sync kept its existing SMS foreground process. The values below are medians from three launches per role. All six received authorized Home and Payments data.

| Screen or action | Staff v65 (s) | Staff v67 on e107 (s) | Admin Sync v65 (s) | Admin Sync v67 on e107 (s) |
|---|---:|---:|---:|---:|
| Home records visible | 2.97 | 2.38 | 1.87 | 3.38 |
| All three Home amounts visible | 4.75 | 2.38 | 3.46 | 4.69 |
| Payments records visible | 1.24 | 1.40 | 1.34 | 1.87 |
| First newly fetched Payments draw | 1.50 | 2.34 | 1.49 | 1.92 |

One Staff trial displayed Home records in 3.70 seconds and all three amounts in 10.05 seconds. During that window, Supabase recorded three expirations of the optional 450 ms statement budget. One occurred while the savings function rechecked the bound session and two occurred while it read the financial projection. A successful fallback request spent 6.02 seconds in the Edge Function. Shared activity prevents attributing individual SQL statements to a specific device. In the two longest Payments refresh cases, Staff displayed rows in 0.34 seconds and Admin Sync in 0.25 seconds. The next new server draw arrived after 29.90 seconds and 25.84 seconds respectively. The corresponding Payments HTTP calls took 1.03 seconds and 0.91 seconds at Supabase. The time spent reusing the authorized 30-second snapshot accounts for most of the difference.

A second exclusive series on the same Pixel ran from 22:01:59 to 22:03:40 Kigali. Staff reached all three Home amounts in a median 3.09 seconds, with a 4.07-second maximum. Admin Sync reached them in 1.94 seconds, with a 2.63-second maximum. First Payments rows took 2.08 seconds for Staff and 1.30 seconds for Admin Sync. Medians for the next fresh draw were 3.57 and 1.49 seconds respectively. The longest waits were 20.00 and 28.90 seconds with existing rows already available. The gateway remained active through the tests and its two SMS permissions were reverified. All 22 relevant handset requests in the quiet run returned HTTP 200. Each launch obtained all three amounts on its first Home draw, and PostgreSQL recorded no cancellation of the optional savings query in that window.

Across both e107 runs, six trials per role, median time to all three amounts was **2.75 seconds for Staff** and **2.28 seconds for Admin Sync**. First visible Payments rows took 1.74 and 1.38 seconds respectively, compared with the v65 medians of 1.24 and 1.34. The next fresh Payments draw took 2.95 and 1.89 seconds respectively.

### Production Admin panel, baseline and the first e107 web build

| Screen or action | Admin before (s) | Admin after (s) | Staff before (s) | Staff after (s) |
|---|---:|---:|---:|---:|
| Reload to populated Home | 3.65 | 1.86 | 3.66 | 1.85 |
| Members list | 2.09 | 1.80 | 2.08 | 1.82 |
| Member balance | 4.84 | 2.30 | 4.83 | 2.31 |
| First statement page | 4.62 | 2.33 | 4.62 | 2.33 |
| Payments table and totals | 2.60 | 2.32 | 2.59 | 1.85 |
| Home to payment detail | 4.13 | 2.87 | 4.12 | 3.87 |
| SMS inbox | 3.63 | 3.09 | — | — |
| Team directory | 4.50 | 1.99 | — | — |

This table covers Worker source `7a2459e83b07`. Core routes had three trials per role. The additional routes had two. A repeated Staff sign-in for the last pair of payment-detail trials reached the normal 15-minute account budget and returned HTTP 429. A single retry in the next window completed both trials and signed out. The other three scheduled test groups finished on their first invocation. On the first Admin pass the member balance took 7.85 seconds and the statement took 6.35 seconds. The earlier intermediate release had a 5.75-second Admin Home median. The final build delivered 593,575 encoded Home JavaScript bytes, down from 678,258 at baseline.

The v67 measurements in the first Pixel table used an exclusive device series on e105. An earlier qualification series overlapped an untimed setup check. The Android first frame can show the app before its live records arrive. Both runs displayed all three Home amounts in every fresh trial. The UI reports missing reconciliation evidence independently of amounts that it can verify.

The Payments list can display an authorized snapshot less than 30 seconds old immediately. The second Staff trial on v67 fetched new data in 1.98 seconds. In the other two, the existing rows were visible in 0.38 and 0.34 seconds, and the next network-backed draw arrived at 21.54 and 29.09 seconds. Manual refresh uses the live read. These are separate user-visible and freshness timings. [Cache freshness](../../native/burimunsi/core/src/main/kotlin/rw/ikanisa/burimunsi/core/SnapshotFreshness.kt)

In the two matched Staff payment-detail trials, the live facts took 3.74 and 1.61 seconds. A separate test returned to the same payment six times per role. Its median was 0.16 seconds for both roles, with Staff reaching 1.71 seconds and Admin Sync 1.76 seconds. A remembered detail can render promptly. A first lookup or an expired view still waits for the current scoped payment, its allocation version and its detail-only reference.

The main browser comparison used signed-in Chrome at the same production origin. Home JavaScript fell from 678,258 to 589,377 encoded bytes on `2332b3b`. That release served 687 immutable assets and retained all 595 from its predecessor. A later loading-feedback release, `38af6b1`, served 779 immutable assets and retained the 687. Six more Home reloads per role on that release took a median of 3.17 seconds for Admin and 3.67 seconds for Staff. The slowest reloads took 3.64 and 6.25 seconds. All twelve traces showed session validation followed by the scoped financial read. Both sessions signed out normally. These additional reloads followed a different deployment and are reported separately.

## Browser Home startup

On the production loading-feedback release, the median time to first byte for session validation was 1.08 seconds for Admin and 1.06 seconds for Staff. The financial read began after that reply. Its median time to first byte was another 1.66 seconds for Admin and 2.21 seconds for Staff. A new optional session request returns both results from one authorized PostgreSQL snapshot. It runs on an initial phone-authenticated Home load. A reload on another route uses the ordinary session endpoint. [Session resolver](../../supabase/functions/_shared/domain/admin_browser_passcode.js) · [Scoped Home query](../../supabase/functions/_shared/domain/admin_burimunsi_payment_scope.js)

The client checks the actor, session, collection, permission, expiry and Home data shape before rendering the result. Sign-out, a scope change or leaving Home discards the result. An incomplete projection causes an ordinary scoped Home fetch. Zero and a recorded unknown wallet balance keep their distinct meanings. [Client session read](../../admin-web/src/session/sessionReadback.ts) · [Home screen](../../admin-web/src/features/overview/BuriMunsiHome.tsx)

Six more signed-in reloads per role on the new production release measured **3.17 → 1.86 seconds for Admin** and **3.67 → 1.85 seconds for Staff**, compared with the immediately preceding six-run series. Each of the twelve final traces contained one session request, zero separate Home requests, complete financial totals and a collection match. The slowest measured reload was 1.88 seconds. The Admin response passed the wallet-difference arithmetic against its incoming, outgoing and last recorded balance. Staff received its authorized totals. The regular Admin member enrollment screen returned six scoped payer suggestions and its search located the selected payer again. Neither test submitted an enrollment. Both browser sessions signed out. The native Staff session also passed ordinary, combined Home, savings and wallet reads, and signed out.

The PostgreSQL 17 fixture used 32 canonical payments and the deployed wallet-migration chain. The ordinary and combined responses agreed for each role. HTTP requests fell from two to one, reserved database connections from three to one and application SQL statements from fifteen to nine. Timeout, missing wallet permission, simultaneous grant revocation, scope change, logout and expiry at response handoff all suppressed the optional data. The compiled Chrome fixture with a controlled 180 ms delay per HTTP read measured 431 ms before and 247 ms after. These figures describe the qualification fixtures. [PostgreSQL test](../../supabase/tests/burimunsi/fresh-browser-home.mjs) · [Browser session tests](../../admin-web/tests/session/home-bootstrap.test.tsx)

## Staff payment detail on the web performance release

On the immediately preceding release, `a265c288093f`, four Staff clicks waited 1.80–2.70 seconds for the Payments list before requesting the selected record. The median time to usable detail was 3.86 seconds. Admin could already request both together because its authenticated profile carries a collection ID.

The final release, `6ce90c5015a4`, starts the two reads together for a signed-in phone-passcode Staff session. It keeps the detail hidden until the collection and payment version can be checked. A denied or malformed list discards the pending detail. A response older than the visible row needs one fresh lookup. The tests covered both arrival orders, other collections, old login sessions, canceled requests, masks on SMS evidence, off-page payments, and normal retry after an error. [Web Payments](../../admin-web/src/features/operations/BuriMunsiPayments.tsx) · [Payment workspace regression tests](../../admin-web/tests/app/payments-workspace.test.tsx)

All eight production Staff details passed the collection and version checks. The browser dispatched the two reads in the same millisecond on all four primary trials. Their median was 3.16 seconds, with a 5.83-second maximum. A second four-click series had a 2.43-second median. Together the eight trials took **2.72 seconds** at the median. Admin's four-trial median was 2.34 seconds, compared with 2.32 seconds immediately before. The two reads overlapped for both roles.

The Worker for this performance release was `e631dad2-fd35-4686-9c2c-0c4c914eb7b1` at 100% on Cloudflare, with asset digest `c98eea2fecb2b4bf91aeab97bc9f375102ccf6ac2c0befe0cccdb124c4b69806`. All 1,055 immutable assets and five public controls matched their exact bytes, including all 963 existing URLs. Seven bindings matched. This release did not require a Supabase pause.

Six fresh Home reloads per role on this Worker all used a single HTTP 200 session request. The final medians were **1.86 seconds for Admin** and **1.89 seconds for Staff**, compared with the original six-run medians of 3.17 and 3.67 seconds. Both roles opened an actual member's transaction history and closing balance in 1.86 and 1.96 seconds respectively. Admin read the first 25 SMS metadata items. Both signed out normally, as did Staff after the additional detail series.

An Admin sign-out in the earlier baseline run received HTTP 503 after 5.99 seconds and its disposable browser closed. The database still recognized that exact test session in the immediate readback. It expired at 22:41:01 Kigali. A production readback at 22:41:04 found the same session and confirmed that it could no longer authorize requests. The next baseline and both final roles completed sign-out successfully.

## Current Admin panel including wallet and statement changes

At 22:42 Kigali, Cloudflare verified the successor from `401dd9de8d0d` at 100% traffic. Its build digest is `87bb5eb3a0c94e9b69a721088ce2bd462a66735803e9adc9256dd83139fabf23`. All 1,147 immutable assets and five public controls passed readback, including the 1,055 URLs from the performance release. The seven bindings matched and Supabase remained open on e107.

A fresh production sign-in with each role exercised the successor. Each of twelve populated Home reloads made one request, with matching role, group and financial totals. All eight payment detail clicks started the collection and detail requests together and verified the data against the selected row. Both roles opened a member statement and signed out on their first attempt. Admin opened 25 SMS metadata entries.

| Journey | Staff | Admin |
|---|---:|---:|
| Sign-in through populated Home, one trial per role | 4.89 s | 4.92 s |
| Signed-in reload to populated Home, median of six | 1.88 s | 1.89 s |
| Home to selected payment, median of four | 2.11 s | 2.35 s |
| Slowest of the four payment detail clicks | 2.82 s | 4.40 s |
| Member statement from profile selection | 1.88 s | 1.90 s |

## Production database, Storage and messaging

The e105 deployment kept all 128 applied migrations and 37 canonical payments. All 75 private Storage objects were accounted for against the backup. Sixty-nine had passed restore verification and each of the six additions had a ciphertext readback. The original signed scheduler probe and two subsequent scheduled calls returned HTTP 200. One live Admin gateway was ready.

The warm production Home query took 0.47 ms for base records and 19.65 ms with savings. Successful savings queries had also reached 1.68 seconds. The server keeps the optional read bounded. The client recovers an omitted projection independently. The scoped payment detail SQL for a current production row took 0.13–0.17 ms across three owner read-only plans, with two index scans and zero physical reads. These executor times exclude application session checks and network transit. A production comparison of an alternative indexed wallet read showed 1.295 ms versus 1.268 ms. The existing indexes were retained. On e107 the full live savings projection took a median 26.06 ms including planning. Removing the reconciliation branch when the collection had no checkpoint took 22.34 ms, increased buffer hits and produced the same result. PostgreSQL had JIT disabled with no overrides. The evidence supported retaining the existing SQL and budget. The same provider window included a plain session request lasting 11.41 seconds. Its admission, connection and transport times could not be separated.

One previous dispatch had no conclusive result when the e105 release began. The release drained the executor, waited its safety interval, retained the original evidence and reopened the service. The first observed HTTP 503 was at 20:12:12 Kigali and the first verified HTTP 200 was at 20:27:04, an interruption of 14 minutes 52 seconds.

The original encrypted database backup was restored in isolation with 267 relations and 22 exact table-data checks. The isolated restore used a local PostgreSQL socket with archived functions and scheduled jobs disabled. The provider Auth signing identity has no verified restore.

The coordinated follow-up moved Supabase from e105 to e107 on source `242aa9daa698`, runtime digest `afb44f75c2f8b5e7b169a4adf7bbe8d325c0f0d26e9b92bbf5e16a9057c8ca62`. Before the change, the team refreshed the encrypted database and Storage delta, verified the four previous function archives, and observed zero active or unresolved admissions. All three changing functions were compiled and verified. The SMS gateway bundle retained its hash. The first HTTP 503 was at 21:51:17.559 Kigali and the first healthy e107 response was at 21:52:18.494, an observed interruption of 60.935 seconds.

The e107 scheduler's original signed probe and two consecutive scheduled jobs returned HTTP 200. The final checks found one ready gateway, zero queued native jobs, zero effective unresolved admissions and all 128 migrations unchanged. The independent canary matched all 37 scoped payment rows byte-for-byte and all 75 Storage object identities. It also verified the 67 active application ciphertext hash and size bindings. A subsequent offline restore check reopened both encrypted catalogues and all 75 object bodies, covering 65,400,138 bytes. All 69 original objects and all six additions passed authenticated decryption, byte-length and content-hash comparison. Their bucket, object, version and size inventory matched the production owner readback. Eight independent original S3 payload hashes and all 67 application ciphertext bindings matched. The restored bodies stayed in process memory. A further offline test opened the six recent objects using the application recovery keys and verified their plaintext hashes against the database reservations. Including the 56 original application records with known encryption context, all 62 current application records matched. Five historical preservation objects have verified stored bytes and still lack the original material needed to recover their plaintext. The other eight Storage objects have independent original payload hashes.

The first e107 web build `a59788a312a8`, commit `7a2459e83b07`, retained all 779 earlier immutable URLs and added 92. All 871 immutable assets, five controls and seven Worker bindings were verified at 100% traffic. Before the Supabase change, the new web build performed the ordinary Home fallback for both roles. One Staff sign-in returned HTTP 503 and succeeded on a single retry. The service reported zero unresolved dispatches at the change boundary.

In one recorded handset check, the active handset reported 31 historical SMS candidates, zero missing and 26 pending. Two were intentionally held and another 24 lacked per-message backend evidence. Four verified duplicate adoptions and one completed parse account for the five resolved candidates. The other handsets included expired or missing checks. All 51 observed-source journal entries had matching custody. Production showed zero runnable parser items and zero open parser jobs. The signed-in Admin inbox displayed 11 parsed, nine duplicate, two held and three non-payment entries among its first 25. No new eligible SMS arrived during the post-upgrade observation.

## Supabase-wide advisor findings

The production advisor returned zero health findings, 439 performance findings and 27 security findings across the shared project. Counts include legacy Collect, private operational tables and historical import schemas.

| Performance finding | Count | Scope observed |
|---|---:|---|
| Foreign keys without a leading index | 247 | Two in the canonical schema, on the raw SMS collection and the payment receiving account |
| Policies flagged for repeated authorization-setting evaluation | 117 | Five in the canonical payments and raw SMS schema |
| Tables without a primary key | 2 | Both in historical import schemas |
| Indexes with no observed use | 72 | All in shared application, private or SMS schemas |
| Fixed Auth connection-pool count | 1 | Project configuration |

The live payment policy for the runtime role compares each payment’s collection with the transaction’s collection setting. On the 37-row production collection, three read-only predicate comparisons took a median 0.179 ms with the current expression and 0.180 ms with the setting evaluated once. Both variants used zero disk reads. This isolated SQL comparison excludes login, network and the other policies. The measured wallet index experiment also showed less than 0.03 ms difference. The release preserved these policies and indexes. [Supabase policy performance guidance](https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan) · [Foreign key index guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys)

The security advisor identified 26 RLS-enabled tables without a policy in private and operations schemas, plus a project Auth MFA-options warning. These findings remain recorded for the shared platform owner. The production phone-passcode, role, same-collection and raw-SMS authorization tests passed. [RLS policy guidance](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) · [Supabase Auth MFA](https://supabase.com/docs/guides/auth/auth-mfa)

## Test coverage and distribution

- The e105 backend passed 3,994 Node tests and 127 Deno tests with 219 steps. The integrated main source passed 3,999 Node tests and the same Deno set on PostgreSQL 17. Both suites reported ten skipped Node tests and nine ignored Deno tests. Fifty operations checks and 34 owned PostgreSQL checks also passed.
- The integrated Admin application passed 1,268 React tests, 131 Worker tests and 43 compiled browser checks in each of two session modes. Live UAT used the production Staff and Admin sign-ins for Home, Members, Payments, balance and statement. Admin also opened the SMS inbox and Team. The optional financial projections matched the same signed-in member and collection.
- The final composition passed 1,298 React tests, 132 Worker tests, seven packaging checks and 45 compiled browser checks in each session mode. One existing SMS timer assertion failed during a concurrent test run. It passed in isolation and on the full rerun. The final Supabase `make test-backend` passed 3,999 Node tests and 127 Deno tests with 219 steps. A separately run PostgreSQL fixture exercised the expiry and revocation cases.
- Both Android variants passed offline compilation, lint, unit checks and the 161 API 36 instrumented tests. Cross-layer checks exercised session replacement, role or group changes, incomplete data, optional-query timeout, navigation during recovery and duplicate reads. The release bundles passed signature, manifest, executable-code and 16 KB page alignment checks.
- Both physically installed releases were upgraded in place and kept their data and permissions. Staff had no SMS grants. Admin Sync retained its SMS grants and foreground receiver. Google Play published version 67 (`0.23.0-collect.45`, source `7308390e2daa`) to both internal tracks. Google-generated v65 and v67 packages also passed an in-place update on Android 36. Each tester list had one approved address when checked. Play reported an optional native debug-symbol warning.
- The four hosted jobs in the Android release run could not start because of the GitHub billing restriction. The local suites above completed. The default history scan still flagged 650 matches across 12 commits dated 22–24 November. Private review classified 520 as translation identifiers, 74 as lines containing pinned digests, 40 as test fixtures or assertions, ten as SQL, four as generated test-key PEM markers and two as preference names. The five earlier performance commits and the three browser-bootstrap implementation and regression commits checked separately had zero matches. [GitHub Actions run](https://github.com/ikanisa/BuriMunsi/actions/runs/45878315426)

The Staff payment-detail integration at `6ce90c5015a4` passed 1,348 React tests, 132 Worker tests, seven packaging tests, 46 compiled browser checks per session mode and the source and design-authority checks. An inherited duplicate Members recovery read failed on the earlier source in isolation. The integrated Members changes passed that test and all 19 tests in its file. Strict scans of both new performance commits returned zero matches. GitHub recorded three unstarted jobs with billing annotations. [GitHub Actions run](https://github.com/ikanisa/BuriMunsi/actions/runs/45890170855)

The supported operations suite passed all 50 checks independently at the integrated release. Three older scheduler fixture programs selected by an incidental directory-wide test run require the archived source they attest. All 37 historical checks passed on their pinned commit, `db39009f`. The current event-driven fixture passed independently on PostgreSQL 17.

The wallet and statement changes that followed the performance release entered main at `773f474` and `c6f7826`. The first full run exposed a wallet accessibility test that still expected a link after the wallet control became a dialog button, and a test that checked for the allocation callback before React delivered it. The updated checks verify the dialog, its unavailable balance, and delivery of a single stale-allocation callback. Source `5abf874` passed 1,357 React tests and 132 Worker tests. The compiled browser ran all 46 checks in each session mode on the same runtime sources. The concurrent Android v68 source includes filter pickers. The v67 handset and Google Play measurements above refer to the released performance build.

## Open items at handoff

| Item | Evidence still needed |
|---|---|
| Long mobile and Edge responses | Per-request timings for admission, connection, session checks and financial SQL during a slow request. Staff first Payments rows took 1.74 seconds across the final six device trials, against 1.24 seconds at baseline. |
| Production SMS acceptance | The next genuine eligible M-Money SMS and its matching admitted source, parser decision and payment or duplicate readback. The historical handset report still has two held items and 24 without persisted per-item evidence. |
| Hosted CI | GitHub account billing must allow the workflow jobs to start. The local checks and direct production evidence are recorded above. |
| Historical recovery | Plaintext remains unresolved for five legacy preservation objects. A restore of the provider Auth signing identity remains unverified. |
| Shared database findings | The protected advisor inventory identifies each of the 439 performance and 27 security findings by rule, object and Supabase guidance. The release measured the settings and indexes used by the current payment paths. |
