# BuriMunsi production launch register

This is the public-safe checklist for the first BuriMunsi release. It records
requirements, dependencies and acceptance, not live deployment or completed
sign-off. The release operator keeps environment-specific receipts, provider
correspondence, test identity and backup evidence in protected custody.

**Priorities:** P0 must close for the applicable launch scope; P1 supports
qualification, rollout and operations; P2 is optional or scope dependent.
**Status snapshot:** Ready means the next scoped task can start, not that it
passed. Provider/access blocked, owner decision, pending and after prerequisite
are not complete. Do not enable, publish, spend or mutate data merely because
a checklist row describes a future step. Keep permission and receipt states,
release evidence and actual operator acceptance distinct.

## Public source references

- [Repository overview](../../README.md)
- [Source, Admin and Edge CI](../../.github/workflows/ci.yml)
- [Android build and instrumentation CI](../../.github/workflows/burimunsi-native.yml)
- [Android source](../../native/burimunsi)
- [BuriMunsi Admin package and PWA](../../admin-web/README.md)
- [Admin Worker, bindings and recovery](../../deploy/platform-admin/README.md)
- [Supabase job qualification](../../supabase/jobs/README.md)
- [Managed migration operator guidance](../../scripts/supabase/managed-cloud-migrations/README.md)
- [Single-Admin preflight fixture](../../scripts/supabase/single-admin-preflight/README.md)
- [Independent Storage inventory verification](../../scripts/supabase/storage-inventory-verify/README.md)

## Release scope

| ID | Priority | Status | Remaining task | Next responsible role | Depends on | Acceptance / done when |
| --- | --- | --- | --- | --- | --- | --- |
| G01 | P0 | Ready | Freeze the first-release feature list and map each feature to a test. Keep one human Admin, Staff without SMS access, profile-based login and automatic posting. | Release engineer + product owner | — | Sign-off lists in-scope features and names what is excluded; no device or SIM approval and no routine manual transaction approval. |
| G02 | P0 | Owner decision | Confirm the production environment and exact collection, bank/custody counterparts, roles, rollout audience and whether one or both Android variants are distributed to whom. | product owner + bank/operator | Draft launch scope | Written authority identifies hostnames, project, rollout audience and responsible operators; don't assume a second collection or public launch. |
| G03 | P0 | Owner decision | Confirm launch terms and operator/privacy commitments for savings and contributions; separate any loans, pledges, interest, payouts or exit terms from core if not approved. | product owner + bank/operator/legal | G01 | Current approved terms match UI and financial calculation tests; clear exclusions with no silent expansion. |
| G04 | P1 | Ready | Reconcile remaining engineering work in progress, preserved local changes and historical evidence with current main. Classify held variants rather than resetting or blindly merging. | Release engineer | G01 | Every unique open item is adopted, parked with rationale, or verified equivalent; no canonical checkout work or private artifacts lost. |
| G05 | P1 | Ready | Record release ownership, sign-off gates and go/no-go meeting; keep a single checklist and pinned release record. | Release engineer + product owner | G01/G02 | Named owners and dates; no blank responsibility at launch or post-launch support. |
| G06 | P1 | Ready | Verify privacy and operational disclosures against actual workflows and confirm the support/contact path. | Release engineer + privacy owner | G01/G02 | Only eligible MoMo messages are captured; data access, retention, deletion and escalation accurately reflect the chosen audience and law. |

## GitHub & CI

| ID | Priority | Status | Remaining task | Next responsible role | Depends on | Acceptance / done when |
| --- | --- | --- | --- | --- | --- | --- |
| C01 | P0 | Provider blocked | Resolve the existing GitHub Actions billing lock without starting a paid plan or bypassing required checks. | GitHub account owner | Existing account lock | Latest jobs actually start and run; if a policy-approved free alternative is accepted, document what it covers and what remains. |
| C02 | P0 | After prerequisite | Run required source, Edge, Admin and Android checks against the final integrated main commit. Keep verified local checks distinct from hosted CI. | Release engineer | C01, final candidate | Successful exact-commit checks and retained logs; all failed, ignored or blocked release-critical cases dispositioned. |
| C03 | P1 | Ready | Verify repository and external deployment triggers; keep sole maintained main and confirm final exact push/remote identity. | Release engineer | Owner metadata where required | No unintentional provider rollout, force push or history rewrite; final commit verified on remote. |
| C04 | P1 | After prerequisite | Create approved release record/tag and tie Admin assets, Android checksums, backend images/versions and migration receipts to final commit. | Release engineer | C02 and signed artifacts | One reproducible release manifest with public-safe evidence and protected private receipts. |
| C05 | P1 | Ready | Keep clean release checkouts; preserve canonical local snapshots, never commit APKs, credentials, personal records or raw test evidence to the public repository. | Release engineer | G04 | Verify required source is on main, replayable release build, private separately held artifacts and evidence. |

## Supabase recovery

| ID | Priority | Status | Remaining task | Next responsible role | Depends on | Acceptance / done when |
| --- | --- | --- | --- | --- | --- | --- |
| D01 | P0 | Ready | Record latest provider database recovery point and verify exact project, retention and recovery exposure before change. | Release engineer | Existing authenticated backup read | Latest completed physical backup verified, PITR setting and intended RPO/RTO recorded; no claims about Storage contents. |
| D02 | P0 | Access blocked | Obtain or verify a separate protected current Storage backup covering in-scope object bytes; map ownership and permissions. | Authorized backup custodian + Release engineer | D01, approved object scope | Independent readback covers the same source scope and every in-scope identity/version/length/hash; counts alone never pass. |
| D03 | P0 | Access blocked | Produce two independent, approved source and backup inventories. Qualify any new producer safely before actual capture; keep historical five-file reader unchanged. | Release engineer + approved reader/custodian | D02 | Stable opaque IDs and byte digests source-bound separately without exposing bodies, paths or credentials. |
| D04 | P0 | Access blocked | Verify current Auth/custom identities, grants, credentials custody, configs, secrets rotation/restore, integrations and Storage permissions recovery. | Release engineer + authorized admin | D02 | Protected inventory and independent recovery ownership for each component; read-only proof where supported, no keys in logs/Git. |
| D05 | P0 | After prerequisite | Rehearse isolated restoration of a current eligible real recovery set with egress/effects disabled; no actual hosted restore or billable clone by default. | Release engineer + custodian | D02–D04 | Database and dependent components recover in isolation with invariant checks, observed RPO/RTO and stop/rollback decision. Synthetic test results qualify only the tooling. |

## Supabase migration

| ID | Priority | Status | Remaining task | Next responsible role | Depends on | Acceptance / done when |
| --- | --- | --- | --- | --- | --- | --- |
| D06 | P0 | Ready | Qualify the supported exact 110→111 operator path; preserve managed history and atomic schema/history record, no generic database push. | Release engineer + release reviewer | D01, fixed migration plan | Exact SQL, before/after digests and closed matching release preimage; atomic execution/error behavior evidenced in an approved test environment. |
| D07 | P0 | After prerequisite | Collect fresh release preimages: fence epoch/mode, admissions drained, no unknown writer, exact deployed code/managed history/catalogue and zero conflicting active Admins. | Release engineer + Supabase release operator | D05/D06 | Bounded authorized checks pass together before any write. Open fence or any mismatch stops. Do not automatically disable an account. |
| D08 | P0 | After prerequisite | Apply only the reviewed single-Admin migration in the gated release window. Read back index, trigger, function ownership/permissions and exact 111-entry journal. | Release engineer + Supabase release operator | D05–D07 | All expected objects and original SQL verified; partial/unknown result triggers diagnosis, not automatic retry. Preserve old identities and history. |
| D09 | P0 | After prerequisite | Verify compatible runtime rollout and generic role behavior around the single-Admin constraint, old client reads, and controlled reopen. | Release engineer + release reviewer | D08, E03 | Concurrent or duplicate Admin attempts safely denied; Staff stays usable; no lockout, data loss or rollout drift. |
| D10 | P0 | After prerequisite | Rehearse lock/application compatibility and safe failed-release path: abort without partial apply; check ACK using exact history and catalogue; qualify forward correction if needed. | Release engineer + release reviewer | D06/D07 | Proven exact DDL+journal boundary, no blind rollback/history repair or unsafe automatic reopen. |

## Backend & Edge

| ID | Priority | Status | Remaining task | Next responsible role | Depends on | Acceptance / done when |
| --- | --- | --- | --- | --- | --- | --- |
| E01 | P0 | Provider pending | Finish diagnosis of the earlier 503s; distinguish endpoint recovery from authenticated App, Admin and jobs. Track the existing provider support case through the authorized channel. | Release engineer + Supabase | Egress/authorized tests and support | Bounded positive and negative authenticated requests across affected paths pass; recurrent problems have diagnosed cause or reviewed mitigation. No duplicate support email. |
| E02 | P0 | Ready | Compare deployed collect-api, admin-api, collect-sms and collect-jobs with maintained source and project/function settings. | Release engineer | Access to supported source/version readback | Exact current function/version/config digest and intended custom auth/app/HMAC boundary verified; no blanket JWT flip. |
| E03 | P0 | After prerequisite | Qualify and deploy required Edge functions in reviewed compatible order; verify source and runtime profile after deploy and preserve rollback. | Release engineer + authorized release operator | E01/E02/D05, migration sequencing | Target version IDs and approved config read back, correct scope, correct hosted APIs and no unauthorized mutations. |
| E04 | P0 | Ready | Verify least privilege for app and Admin routes plus database grants/RLS and function access, including wrong role/group, stale/revoked sessions, exports and raw SMS reveal. | Release engineer | Exact source and hosted test identities for final acceptance | Positive and denied cases pass for Staff/Admin/anonymous; secret scans, credential boundaries and access audit intact. |
| E05 | P0 | Ready | Qualify phone+passcode safety: throttling, hashing, enrollment, recovery, passcode change, disabling, session expiry and loss of role/access. | Release engineer | E04, approved test profiles | Actual authorized/denied flows pass at correct app roles; no default/shared secrets, no data shown after revocation. |
| E06 | P1 | Ready | Close backend evidence gaps for skipped release-critical tests: auth/storage, job and accounting cases; record nonapplicable optional lanes explicitly. | Release engineer | G01 | Test map covers applicable checks with reproducible fixture/host evidence and no misleading all-green claim. |
| E07 | P0 | Ready | Validate financial/API request recovery and secrets boundaries for hostile or stale inputs (CSRF, cache, original IDs, backed authorized reads). | Release engineer | E02/E04 | No publishable app package contains server secrets, no authority bypass; interrupted writes remain uncertain until resolved without duplicate action. |
| E08 | P1 | After prerequisite | Check configured dependencies and quotas for Storage, Realtime, provider extraction, deployed schedules and operational endpoint health. | Release engineer + service owner | E02/S01 | Exact binding, current owner, safe limits/fallback and measured health for each dependency in scope. |

## SMS & jobs

| ID | Priority | Status | Remaining task | Next responsible role | Depends on | Acceptance / done when |
| --- | --- | --- | --- | --- | --- | --- |
| S01 | P0 | Ready | Verify current scheduler configuration, reviewed model/secret bindings, capacity/cost and authenticated gated job admission before enabling any receipt processing. | Release engineer + provider/config owner | E02/D05 | Current readback closes known disabled OpenAI scheduler and cron states; correct reviewed source/scope, quotas and approved budget, no enablement yet. |
| S02 | P0 | After prerequisite | Qualify isolated signed dispatch with controlled synthetic receipt, correct model behavior, language/format validation and deterministic original-text/rule checks. | Release engineer | S01, authorized test lane | Exactly expected parse and proof, security/OTP filtered, ambiguous or incomplete no financial effect, no claim current model exercised without actual authorized test. |
| S03 | P0 | After prerequisite | Prove recovery and admission for pending/unmatched/replayed events, failure/outage, worker lease/ACK/idempotency and backlog cutoff before activation. | Release engineer | S02, authorized queue scope | Reconciled bounded backlog, no historical burst, approved test enqueue and retry/dead-letter handling, no untracked replays. |
| S04 | P0 | After prerequisite | Enable only qualified receipt processing and required schedules; confirm actual scheduled run, application acknowledgement and alert health. | Release engineer + authorized release operator | S01–S03/E03 | Real provider job executes intended workload only; dispatch, parse and ledger evidence separately verified. Can pause safely. |
| S05 | P1 | Scope dependent | Qualify contribution messages/push/email only if launch scope requires them; otherwise keep unavailable lanes off and report limitations. | Release engineer + release owner | G01, S03 | Scoped opt-in recipients, safe delay/retry and actual delivery verified or disabled; no historical/unsolicited sends. |
| S06 | P0 | After prerequisite | Certify capture completeness and gaps independently of server success status, comparing known test inbox IDs with retained canonical observations. | Release engineer + Admin test operator | A03/A05 | Readback tests interrupted/empty ingress and late older messages; UI changes stale proofs to unknown without asserting phone offline or settlement. |

## Android apps

| ID | Priority | Status | Remaining task | Next responsible role | Depends on | Acceptance / done when |
| --- | --- | --- | --- | --- | --- | --- |
| A01 | P0 | Access blocked | Qualify both signed release-candidate apps on the representative physical test device using authorized nonfinancial Staff/Admin profiles. Start with sign-in, Home and Payments read-only. | Release engineer + designated test-account owner | Approved profiles/session; E01 | Real signed package and hosted target match; correct role, scoped data and safe errors; never disclose passcodes. |
| A02 | P0 | After prerequisite | Test Admin's normal OS SMS-consent flow, denial, revocation and regrant on authorized clean test inbox; verify Staff cannot access SMS. | Release engineer + device/inbox custodian | A01, clean consented test inbox | No manual handset/SIM approval, collection tied to signed-in Admin profile, no unrelated messages imported. Actual test results not inferred from installed APK. |
| A03 | P0 | After prerequisite | Test a controlled eligible carrier SMS while app open, background, network offline, screen locked, and phone powered off then restarted/unlocked. | Release engineer + authorized test sender | A02, controlled carrier message, S02 | Sample exact identities visible in inbox → queue → API → parsing; distinguish carrier never delivered from app missed; catch-up not just timestamp. |
| A04 | P0 | After prerequisite | Test force-stop/relaunch, reboot, app update/reinstall, permission loss, switch handset/SIM and expired auth without confusing device with user. | Release engineer | A01–A03 | Recovery and capture/upload states accurate, no leaked or duplicated events; no guarantee of listening while force-stopped. |
| A05 | P0 | After prerequisite | Verify duplicate delivery, lost server acknowledgement, interrupted scan, equal-value separate events, multipart/timestamp/provider formats and queue reconnection. | Release engineer | A03/S03 | Exactly-once eligible effects and no loss; two genuine same-value events retained separately; uncertainty appropriately held. |
| A06 | P1 | Ready | Recheck startup, Home/Payments latency, SMS battery/background behavior and accessibility on representative supported Android devices; investigate historical slow requests. | Release engineer | A01 for hosted portion | Measured against named build, realistic network, minimum/current supported Android and practical hardware; acceptable cold start and no critical ANR/battery issues. |
| A07 | P0 | After prerequisite | Confirm intended package IDs, signature lineage and version progression; rebind release APK/AAB checksums/config to final commit when affected. | Release engineer + signing custodian | G02/C04/A01 | Both actual final artifacts signed and verified; older signed candidate proof used only for unchanged native source. |
| A08 | P0 | Owner decision | Confirm and qualify distribution separately for Staff and Admin Sync (e.g. approved private bank install vs applicable Play channel). | product owner + distribution owner | G02/A07 | Intended users can install/update. If Play: current requirements, Data safety, privacy, account deletion and SMS restricted-permission eligibility/review. USB install does not prove store eligibility. |
| A09 | P1 | After prerequisite | Create operator cutover procedure that preserves prior pending events and states; no presumption of old handset or SIM. | Release engineer + bank/operator | A02–A05 | Record cutover/reconciliation scope and handle old obligations if they exist, without blindly rescanning or clearing history. |
| A10 | P1 | After prerequisite | Test permission eligibility and normal app updates on the final installer; if the channel requires it, validate actual 16 KB runtime and delivered split artifacts. | Release engineer + distribution owner | A07/A08 | Local signed candidate APK ZIP/native library alignment verified; final installer/AAB/splits and intended-device behavior verified separately. |

## Web Admin & hosting

| ID | Priority | Status | Remaining task | Next responsible role | Depends on | Acceptance / done when |
| --- | --- | --- | --- | --- | --- | --- |
| W01 | P0 | Access blocked | Verify Cloudflare Worker deployment ID, active version/traffic, bound target/config, and exact known-good rollback. | Release engineer + Cloudflare account owner | Authorized dashboard/metadata session | Readback matches public live manifest; protect rollback and know what it restores and does not restore. |
| W02 | P0 | After prerequisite | Deploy qualified compact Admin to the intended pre-launch/prod host after backend compatibility; verify live manifest and routing. | Release engineer + Cloudflare release operator | W01/E03, approved release gates | Live package/source/Worker linked to release; asset/TLS/DNS and rollback evidence. A dry run or local package is not deployment. |
| W03 | P0 | After prerequisite | Run signed-in hosted Admin acceptance: sign-in / passcode recovery, Team, Members, Payments, SMS receipt trace, reconciliation, activity, security and direct permissions. | Release engineer + authorized test Admin | W02/E04/A01 | Actual hosted test results for authorized and denied actions, with synthetic records and no duplicate effects. |
| W04 | P1 | After prerequisite | Test installed PWA rollout/refresh/cache and pending edits on actual host; mobile, tablet, desktop and accessibility smoke. | Release engineer | W02/W03 | No authenticated cache leakage, duplicate write, content overflow or loss of operation on update, offline return, keyboard, zoom and stale sessions. |
| W05 | P1 | Ready | Confirm export/report scope; qualify any agreed report/export from scoped data without disclosing source or audit secrets. | Release engineer + product/operator | G01/E04 | Correct role, group, totals, reversals, Kigali dates and file output; no extra Reports surface unless needed. |
| W06 | P2 | Optional | Review whether legacy pages or compatibility URLs can be retired after validated migration, audit history and permission parity. | Release engineer | Stable launched UI and documented usage | Keep deep links unless necessary; no data deletion, policy weakening or untested redirection. |
| W07 | P1 | After prerequisite | Verify final compact routes with permission-limited hosted accounts, including mobile shortcuts, filters and Back state; review signed-in evidence on real host. | Release engineer | W02/W03 | Home/Member/Payment journeys and old bookmarks work where permitted; unauthorized scopes not inferred, reason/receipt links and request recovery retained. |

## Financial integrity

| ID | Priority | Status | Remaining task | Next responsible role | Depends on | Acceptance / done when |
| --- | --- | --- | --- | --- | --- | --- |
| F01 | P0 | Ready | Verify RWF fixed-precision arithmetic, references, member attribution, flags and ledger/audit constraints on canonical test cases. | Release engineer | E04/S02 | Known expected totals match, published numbers trace to records, explicit states for captured/parsed/posted/settled. |
| F02 | P0 | After prerequisite | Prove automatic correct posting and no extra debit/credit under duplicates, lost acknowledgements, delayed/out-of-order and concurrent processing. | Release engineer | S03/S04/A05 | One eligible receipt creates one correct amount for expected member. Ambiguous, unknown, unrelated or malformed events produce no unwarranted effect. |
| F03 | P0 | After prerequisite | Verify handling for fees, reversals, wrong/unmatched payer, two equal genuine contributions and safe corrections with audit trail. | Release engineer | F01/F02 | Do not edit posted history or treat an exception as routine approval; linked reversal/adjustment and exact retry identity verified. |
| F04 | P0 | Owner decision | Agree bank/provider reconciliation source, role, cadence, opening balance, permitted evidence and treatment of mismatches. | product owner + designated bank operator | G02/G03 | Named source custody and test procedure. SMS, parser and provider ACK alone do not establish bank settlement. |
| F05 | P0 | After prerequisite | Complete MoMo → bank → BuriMunsi test reconciliation with the authorized bank/operator evidence. | Release engineer + bank/operator | F02/F04 | End-to-end agreement of references, amounts, fees/reversals and independent bank settlement; unresolved differences isolated. |
| F06 | P2 | Scope dependent | Decide whether held Staff Savings expansion and any optional loan, pledge, exit or repayment flows are in release; qualify only approved work. | product owner + bank/product | G01/G03 | Any in-scope feature has approved terms, code/migration, exact balances, role tests and separate rollout evidence; do not replay held backfill. |
| F07 | P0 | After prerequisite | Prove that ambiguous receipts stay visible as exceptions without posting and operator actions preserve independent bank settlement status and audit trace. | Release engineer + operator | F02/F05 | No amounts infer from SMS alone, clearly labeled states, corrections isolated, operator can investigate without routine approval. |

## Operations & launch

| ID | Priority | Status | Remaining task | Next responsible role | Depends on | Acceptance / done when |
| --- | --- | --- | --- | --- | --- | --- |
| O01 | P0 | Ready | Finalize recovery and incident runbook for backup/restore, uncertain transactions, rollback/forward repair, access revocation, receiver changes and queue backlog. | Release engineer + on-call owner | D01/D05 and release design | Named people, tested steps and limits; prefer scoped mitigation, never replay uncertain transactions automatically. |
| O02 | P0 | After prerequisite | Configure and verify authorized monitoring for 503s, performance, scheduler/queue, missing/duplicate receipts and reconciliation differences. | Release engineer + on-call owner | E03/S04/F02 | Alert destinations and thresholds tested without exposing sensitive details; observable exact live versions and defined response. |
| O03 | P0 | Owner decision | Book and complete real UAT with designated bank/operator representatives, separately from agent QA. | product owner + bank/operator | A01–A05, W03, F05 | Actual tester/date/build/results and accepted limits documented. No invented sign-off, real-money test only if explicitly authorized. |
| O04 | P0 | After prerequisite | Conduct final deployment/cutover review with version evidence and safe go/no-go, then release through approved channels. | Release engineer + release owner | C04/D05/D08/E03/S04/A07/A08/W02/O03 | No unresolved high-severity money/security/privacy/recovery/receipt defects; authorized release target, artifact and rollback verified. |
| O05 | P0 | After prerequisite | Run post-launch end-to-end smoke with authorized synthetic/nonfinancial identities and confirm intended-user install/availability. | Release engineer + operator | O04 | Actual hosted Admin, signed Android, collection and functions align. No compliance filing or public distribution inferred from successful build. |
| O06 | P0 | After prerequisite | Observe receiver, schedules and reconciliation after rollout; report failures, halt/rollback thresholds and support ownership. | Release engineer + on-call owner | O05 | Agreed observation period actually elapsed, timed evidence captured, incidents handled and operating ownership handed over. |
| O07 | P1 | After prerequisite | Coordinate operator onboarding, test-day roster and support handoff; train on scope, phone/passcode, privacy, SMS drift and escalation. | Release engineer + bank/operator | G02/O03 | Named champion and recovery/remediation owner; controlled pilot checklist handed over and acknowledged. |
