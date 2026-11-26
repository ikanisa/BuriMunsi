# BuriMunsi engineering handover

**25 November 2026 · Africa/Kigali · Development source handover, not production acceptance.**

## Resume from the verified baseline

- Repository: [ikanisa/BuriMunsi](https://github.com/ikanisa/BuriMunsi), normal integration to `main`. Canonical checkout: `/Volumes/PRO-G40/BuriMunsi`. Prior verified Git baseline and current hosted qualification comparison: `971d3443e2caccb67b61f17ee7e57a84836082e7`. Read the actual main tip, dirty state, worktrees, and current deployed versions before work. [PR #1](https://github.com/ikanisa/BuriMunsi/pull/1) is merged.
- Source: Android Staff/Admin Sync `native/burimunsi/` and `vendor/receiver-compat/`; Admin/PWA `admin-web/` with Worker `deploy/platform-admin/`; Edge and jobs `supabase/functions/`, `supabase/jobs/`; schema `supabase/migrations/`; shared contracts `contracts/`. Product/UI authority is the repo-designated Revolut Design workflow, not a replacement mockup.
- Hosted target is the existing Supabase BuriMunsi project, Admin at [burimunsi-admin.ikanisa.com](https://burimunsi-admin.ikanisa.com). Exact active versions and release controls are independent from this branch. Do not use names, an active status, a public landing page, or a successful build as proof that authenticated workflows are deployed.
- Product invariant: one human Admin profile, phone number + passcode; Android SMS access is role/profile-based and requires ordinary OS permission on supported devices. No SIM or handset allowlist as an account condition. Staff has no SMS access. Payment processing is automatic; member allocation is not financial approval. Preserve unresolved predecessor custody across replacement, not as a hidden approval gate.

## What exists and what it proves

| Area | Verified evidence | Does not prove |
|---|---|---|
| Source | Exact release checkout previously clean and matched remote main; same-revision source, backend and web tests preserved. This handover changes no running code by itself. | GitHub-hosted checks or provider rollout. |
| Hosted request integrity | One bounded sample had 21/259 reconciliation HTTP 503s; six of seven late failures closely followed advisory-lock timeouts. Newer quiet sample had no representative reconciliation/Admin traffic. | Historical blocker/root cause, original outcomes or recovery. Do not add overlapping counts. |
| Supabase schema and API | 122 migration records through `20261124114504` at last check. Payments paired migrations present. Additive lookup `20261124151857` absent with its routine; 11 local PostgreSQL and 15 Edge/Worker checks were retained. | Compatibility of actual deployed App/Edge/Worker versions; no migration was applied. |
| Android | v64 candidate carried 11 privacy patches plus version increment. Exact preflight 9/9 and API 36 offline 70 Staff + 91 Admin Sync; two configured unsigned APKs. Pixel Staff v63 only at readback; Admin Sync not installed. | Trusted v64 signing, supported min-OS/16 KiB runtime, physical or authenticated qualification. |
| Privacy | Candidate prefilters known credential and nonfinancial input, with a bounded path for unclassified receipts and nonmutating held-file inventory. 162 observation-adapter, 115 gateway and 133 Edge/parser fixture checks, plus Android Keystore storage proof. | Full signed Android→API sink test, real carrier-format coverage, safe hosted receipt admission. Do not enable Admin Sync against the real inbox yet. |
| Admin/PWA | Free local baseline: 1,222 Admin, 128 Worker, and 41 browser assertions per session mode. Public Admin manifest is older/different from the candidate. | Authenticated routes, rollout/rollback with open tabs, or actual billing/ledger totals. |
| Recovery | 12/12 synthetic rehearsal; no restorable hosted snapshot, same-cutoff Storage bytes or identity/key/config recovery packet verified. | Hosted recovery or restoration authorization. Do not clone a project with active jobs to test. |
| Security & QA | Strict positive-controlled scan of 42 changed source paths and both configured unsigned APKs passed. Exact-main free gateway/jobs 50 and owned PostgreSQL 28 checks retained. | Whole history disposition, exact final signed release, full CI parity or a clean Admin bundle. Existing Actions startup/billing failure was before tests, and does not authorize spending. |

## Remaining gates and accountable next actions

| IDs | Action and acceptance |
|---|---|
| **H01–H02** | Backend owner: identify blocking transaction on natural recurrence with redacted same-lock evidence; join exact original run/page/request IDs to authoritative results and preserve unresolved cases. Do not retry with a new ID. Use existing support case only when independently authorized. |
| **H03–H05** | Backend/operations: test actual authenticated App, Admin, SMS and Jobs on a scoped fixture; verify admission, processing, parser availability, scheduled dispatch, bounded retries and recovery. Observe traffic, failure rates and queue age over a meaningful window. Never send a historical outbound backlog. |
| **A01–A02** | Android + Edge: integrate/deduplicate the candidate, validate supported and mixed formats, and use the signed offline-development test path to prove excluded text is absent from durable journal/queue, upload, backend custody, AI inputs and logs. Preserve older held data and source IDs without replay/deletion. |
| **A03–A04** | Android release custodian: rebuild both configured variants from the integrated exact source; verify release hashes and original signing certificate continuity; no substitute key. Verify static 16 KiB alignment and runtime where channel requires it. v64 remains unsigned until the protected signer is available. |
| **A05–A07** | Device/QA: upgrade the approved Pixel in place only after privacy and signing gates. Exercise Staff and Admin roles, consent and permission changes. Assess event-driven arrival, offline/reboot/force-stop/first catch-up and repeated receipts. Fence any predecessor and preserve its queued/in-flight items; no blind import. |
| **A08** | QA: minimum and current API, 16 KiB runtime where applicable, accessible large text and launch languages, startup, memory and battery evidence. A signed-out 4 KiB test or offscreen field view is not a complete pass. |
| **R01–R02** | Recovery custodian: request completed backup timestamp and PITR range, exact compatible Storage bytes and separately held identity/key/config protection; agree RPO/RTO. Rehearse an owned restore with deny-egress, no live bindings, exact money/ID/checksum reconciliation and no external contact. |
| **R03** | Security reviewer: privately disposition exact scan findings by provenance, not by path alone. Scope any public client value attestation to its exact origin, artifact and digest. Rescan final source/Worker/Android; rotate only confirmed real exposure through its custodian. |
| **R04** | Release owner: after recovery and scoped release approval, verify current catalog/history, apply only the exact additive lookup migration once, then exact Edge and Admin/Worker in that order. Stop on mismatch. If needed roll back compatible HTTP first; leave additive SQL for forward repair under the controlled procedure. |
| **R05–R06** | QA/release: produce one exact source record for all required checks, with GitHub-run status separate. Bind Admin assets/Worker ID and roll-back version/traffic, Edge versions, schema history and both signed APKs. Check hosted DNS/TLS and authenticated PWA upgrade, old-tab assets, cache/session isolation and same-ID outcome after interrupted writes in both directions. |
| **W01–W03** | QA/backend: original-ID allocation recovery after a lost acknowledgement, independent totals and limits under concurrent activity, and scoped payment-to-SMS evidence with allowed reveal and revoked/Staff denial. |
| **W04–W06** | Admin/QA: stale response isolation across logout, tabs and user roles; one five-minute proof window; automated posting and notification opt-out/idempotency tested separately, with inquiry rather than blind resend. |
| **W07–W09** | QA/release: actual authorised Admin routes on multiple layouts, role/API enforcement, and one integrated signed Android→hosted reconciliation→Admin journey. Simulated UI/HTTP/DB checks do not waive live development qualification. |
| **L01–L03** | Product/operator: document actual bank/custody terms and included features; designated operator UAT with independently expected ledger/bank extracts; approve separate Staff and Admin distribution routes without assuming public Play SMS approval. |
| **L04–L05** | Operations/release: accountable owner and backup, protected alert recipient/acknowledgement, support and recovery runbooks, stable observation period, exact tag and artifact/distribution links verified at go-live. Not ready while critical privacy, integrity or release gates remain. |

## Work custody and integration order

1. Keep customer records, private diagnostic details, signing files, OTPs, protected backup links and generated APKs out of public Git. Detailed evidence and unapplied patch stacks are in the canonical checkout's Git-ignored `local/audits/2026-11-24-revised-open-tasks/` and `local/releases/android/v64/qualification/`.
2. Android sequence: the numbered order in the local A01 receipts, from complete/incomplete PDU through inbox/census/held/legacy/queue preview to held read-only inventory; then version bump. Edge admission then acknowledgement is a related but separate pair. Do not layer the overlapping F00 engine patch blindly on either. W09 aggregates the smaller W fixtures: choose one source, resolve shared test-file changes deliberately, and retain the currently blocked full PostgreSQL run as a failure to execute, not a pass.
3. The two repository-managed GitHub workflows qualify source and native builds. Their contents do not deploy. At inspection no applicable branch protection, GitHub deployments or repo webhooks were found; outside-provider automatic linkage is not certified. Keep runtime changes and rollouts separate until the exact provider link, paired deployment plan, and critical release test results are known. Never force-push or write production as a smoke test.
4. Resume with **A02/A04 and H01/H02 in parallel**, plus protected recovery evidence. Then exact signed physical/hosted development tests R04/R06 and W01–W09; lastly actual UAT, operator readiness and distribution. Reuse recorded passed work; rerun the checks affected by the final diff only. Record PASS, FAIL, BLOCKED and NOT RUN separately.

## 25 November continuation: source fixes and verified gates

**Status: local development qualification advanced. Not deployed, signed, commissioned or released.** The latest revisions below supersede the initial snapshot in this file where the evidence changed.

| Work | Result |
|---|---|
| A01–A02 / SMS privacy | Android excludes recognizable credentials before local custody; unfamiliar inbox rows keep encrypted locator metadata, not raw bodies. Edge admission rejects credentials and texts without positive receipt evidence before new custody. Local PostgreSQL regression caught and corrected existing currency-first debit/reversal and amount-first completed debit formats. Exact cross-language corpus: 24 cases, 8 admitted and 16 withheld. The isolated API test checked generic errors and no new observation, raw SMS, Storage, or parser job records for excluded texts. Signed handset and real carrier qualification remain open; precedence and reference layout of transfer/cash-in variants must be checked against approved carrier examples. Unfamiliar formats stay unconfirmed rather than discarded or sent to the parser. |
| Android candidate | Both v64 package identities remain unchanged. Staff has no SMS permissions; Admin Sync keeps the scoped receive/read permissions. The independently reviewed correction was rebuilt at `2e9b9fa`: 8 artifact inspections and 161 offline API 36 tests (70 Staff, 91 Admin Sync) passed. Both configured unsigned APKs passed static 16 KiB alignment and the pinned scan. Exact current inputs were verified in protected SSD custody for the trusted signer. The physical Pixel is accessible again; the installed Staff v63 certificate matches the pinned v64 lineage, and Admin Sync is not installed. This is not permission to install, sign with an alternative key or release. Do not install an older or unsigned pair or clear predecessor data. |
| Admin | Verified stale read and second-tab isolation at session/role changes, six tablet routes, two session modes, and worker cache integrity. The cache regression now runs in the standard Admin test target. These are local fixtures, not proof of an authenticated hosted upgrade. |
| H01–H05 | Hosted sample 25 November 10:00–15:30 Kigali: 1,521 HTTP responses, no 503, no representative App reconciliation/Admin traffic. Both original inbox runs have durable page rows, but neither has verified recovery or a terminal state. No exact transport-request-to-outcome correlation or replay was established. The target lock had no holder or waiter in one snapshot. 59 distinct scheduler acknowledgements in the last sampled hour prove transport, not new business processing. |
| R01–R04 | Signed-in Supabase showed seven physical database recovery points; latest listed **25 November 00:40:23 Kigali** (24 November 22:40:23 UTC). No PITR. The visible Storage object metadata had 69 rows and no creation/update after that cutoff; that is not proof of actual object bytes, deletions, configuration/key recovery or a restorable matched set. The pending evidence lookup passed isolated atomicity/compatibility tests but is not in hosted migration history. |
| R05–R06 | Local source and frozen Edge gates passed. The completed lanes include 50 gateway/jobs, 29 owned PostgreSQL, 6 PostgreSQL-backed Edge suites (48 substeps), 1,224 Admin tests, 128 Worker tests, and 42 browser checks per session mode. On `2e9b9fa`, 3,985 Edge Node tests passed (8 skipped) and frozen typechecking passed. [Android Actions](https://github.com/ikanisa/BuriMunsi/actions/runs/45633761915) and [source/Admin/Edge Actions](https://github.com/ikanisa/BuriMunsi/actions/runs/45633761907) had zero executed steps with billing/startup annotations, not a test failure or pass. Git history scan still requires private disposition; local review verified the UI catalog and runtime-generated test-key classes without changing scanner rules. Do not approve artifacts based on scope-limited source or unsigned APK scans. Read-only Cloudflare status showed Worker 94fca136 at 100% traffic (24 November 12:53:45 Kigali). A preceding version is visible; its compatibility and rollback have not been qualified. A local exact-source Admin package and hosting gate passed, using a client publishable key independently matched to the active Supabase key (86 files). Its only scanner finding was attributed to that exact client key in a disposable differential copy. The unchanged strict release scan still flags it; the attestation is not an allowlist or hosted qualification. Old-version rollback and already-open authenticated-tab qualification remain open. |
| Branch custody | Remote has eight historical non-main refs. Five are ancestors of main. The other known runtime or migration changes for open Admin tabs, receipt storage and hosted reconciliation are already represented in main; the applied migration was not edited or reapplied. Preserve history and reconcile only useful differences, not blanket merges or deletions. |

**Hosted release boundary:** Supabase still reported 122 recorded migrations through `20261124114504`, with `20261124151857` absent. Active App / Admin / Jobs / SMS versions were **169 / 170 / 167 / 67**. The public [Admin URL](https://burimunsi-admin.ikanisa.com) is not proof of candidate availability. Only the default Supabase branch was listed. Do not assume another hosted test target or use customer records to qualify it. [PR #1](https://github.com/ikanisa/BuriMunsi/pull/1) was previously merged; subsequent verified changes landed normally on main.

### Remaining release blockers, in order

1. **Android signing and representative device** (release-key custodian / QA): sign the newest qualified artifacts through the legacy certificate lineage without distributing keys; provide the connected Pixel with authorized synthetic Admin and Staff identities; prove privacy sinks, SMS capture/catch-up, consent and queue-preserving upgrade on the actual candidate. Qualify minimum Android and actual 16 KiB runtime where required by delivery.
2. **Recovery custody and historical scan review** (Supabase / security owners): supply checksum-verifiable matching Storage, database restoration access, identities/configuration protection and an independently attested public-key provenance record where needed. Agree acceptable loss/recovery time. Rehearse with no live egress, jobs, keys or notice delivery. Privately disposition the existing findings; do not rotate merely suspected credentials.
3. **Hosted compatibility and request integrity** (backend / hosting owners): obtain scoped development actors and a synthetic collection, confirm original uncertain outcomes or retain them as pending, verify exact release controls and known-good rollback, then follow database → compatible Edge → Admin/Worker. Test all four authenticated routes with real policies but synthetic inputs. Measure recovery and inspect open-tab transition, same-ID receipts and queue age; never blindly replay.
4. **Launch acceptance** (operator, distribution and operations owners): establish approved remaining bank/product scope, exercise the existing operator UAT pack through accounting and bank reconciliation, approve separate Staff and Admin delivery routes and qualify installation. No operator acceptance, production tag, public distribution or live pager was recorded here.

### Operator runbook: halt, recover, observe

- **Halt the affected lane** for a confirmed duplicate posting, unexplained balance difference or privacy incident. Preserve original IDs, timestamps, deployed version, access records and opaque request evidence. For an uncertain result, read back with the original ID; do not retry under a new one or erase a queue. Pause distribution rather than uninstalling or wiping an Android receiver.
- **Handoff and access loss:** preserve predecessor custody/in-flight IDs, stop the old receiver before enabling its replacement, preserve normal Admin profile access and Android consent, and verify checkpoint continuity before resuming. On loss, revoke the affected session/grant through the approved control; leave unrelated identities and retained evidence intact.
- **Alert proposal, not live:** five reconciliation HTTP 503s in five minutes, or at least 10% across ten or more responses **from that same reconciliation route**; three missing scheduler acknowledgements; 15 minutes oldest eligible queue age; a missing verified receipt past the approved cutoff; and any monitoring blind spot. Deduplicate and send count/age/category only. Primary/backup ownership, supported private destination and acknowledgement have not been exercised.
- **Restore** only in isolation with matching encrypted bytes, identity/key/config protection and provider egress disabled. Verify totals, original receipt and allocation identities, unresolved items and zero dispatch. Hosted repair uses exact compatible builds and approved controls; never treat a database restore as a routine app rollback.
- **Observe** at least one full 24-hour operating cycle after deploying the matched release, with representative queue, scheduler, privacy, Android crash/ANR and operator reconciliation evidence. Reset after a material release or halt incident. The hourly implementation and reporting follow-up is active; it is not production incident paging.

The proposed alert thresholds and duplicate-alert suppression can be exercised offline with `python3 -m unittest discover -s scripts/qa -p test_l04_alert_rules.py`. This pure helper has no live telemetry, delivery, authorization or financial side effects.

## Same-day follow-up: offline Android, database permissions and lock evidence

- **A08:** Both exact v64 optimized offline qualification variants passed eight signed-out checks at 200% text across English and Kinyarwanda and verified portrait/landscape rotation. Phone and passcode fields and the submit control were reachable by scrolling. Empty submit stayed disabled in all eight. On the network-disabled Android 16 emulator (4 KiB), 24 cold-start samples ranged 118–316 ms (median 160 ms); observed process PSS was 27,131–31,198 KiB. These are emulator measurements only. No authenticated workflow, TalkBack, minimum OS, physical performance, battery load, or 16 KiB execution claim.
- **W08:** 8 RLS permission checks (including the parent test) and 7 application PostgreSQL fixture checks passed on owned PostgreSQL 17.11, with no failures or skips. The permission change preserves the existing trigger and its RLS action while removing ordinary client execution; the native suites cover payment disclosure and SMS scope. Authenticated hosted qualification still needs approved test accounts and a synthetic group on an exact compatible deployment.
- **R03:** Independently recomputed 12 more historical findings as SHA-256 pins of exact versioned file bytes. Historical disposition now covers 536 of 647 distinct findings; 111 remain unresolved and are not confirmed exposures. No scanner policy or credential changed. The strict release scan is not waived.
- **H01:** Added a bounded [read-only advisory lock snapshot](../../scripts/supabase/testing/buri-isolated-pg/advisory-contention.sql) and a real PostgreSQL regression. It correlates a current waiter with a granted holder of the exact lock and excludes unrelated locks and raw SQL. All eight isolated native PostgreSQL tests passed including this case. There was no new hosted probe or incident reproduction. The historical holder still requires evidence on natural recurrence; a quiet snapshot cannot diagnose it.

- **L04:** The offline alert helper now expects counts for the protected reconciliation route only. It keeps an open incident through missing telemetry or too little reconciliation traffic to verify recovery, so the same incident does not page twice. Separately observed privacy or ledger incidents can still trigger a halt during a telemetry gap. All 14 offline cases passed. Before activation, verify actual route filtering and complete window inputs, retain episode state between checks, name the primary and backup owners, and test a private destination and acknowledgement. No live alert was connected or sent.

### L04: Offline incident checkpoint and pending notifications

The operations helper now retains completed five-minute UTC sample windows, open episodes and pending count-only notifications in a private local SQLite checkpoint. An identical repeat of the latest window is idempotent; stale, conflicting or skipped windows are rejected. Represent an actually missing window as telemetry unavailable rather than manufacturing healthy counts. A restart preserves pending events and their IDs. A full pending queue refuses the next event-producing sample without advancing its checkpoint; preserve that sample and resolve the backlog before retrying it.

Keep the checkpoint under a dedicated owner-only directory, outside Git. Initialise it once with `python3 scripts/qa/l04_alert_checkpoint.py /absolute/private/alerts.db init`. Use `status` after a restart, `ingest WINDOW_END_UTC_EPOCH` with one aggregate JSON object on stdin, and `pending` to inspect stable IDs. A later authorised delivery adapter must use the event ID for destination deduplication and call `ack EVENT_ID` only after verified handoff. This acknowledgement does not close the underlying incident and is not a substitute for operator acknowledgement. After restart or handoff, use `incidents` for a single consistent read of the last window, open incident severities and undelivered counts by category. An empty delivery backlog does not mean recovery, and a recovered incident can still have undelivered notifications. The view does not include event IDs or raw telemetry. Do not drop or replace a checkpoint, or clear a backlog on a timeout. Restore its protected state or audit and refurnish missing windows under operator control. The helper stores no SMS body, account or receipt ID, raw SQL, token or telemetry records.

Run `python3 -m unittest discover -s scripts/qa -p 'test_l04_alert_*.py'`. This checks atomic recording, duplicate/concurrent samples, explicit telemetry gaps, restarts, pending acknowledgements, limits and privacy. There is no live telemetry adapter, pager, outbound message or production activation in this change. Qualification still needs an agreed operator and reserve owner, real route evidence, a private delivery destination, and tested recipient acknowledgement.

### L04: Closed-window aggregate intake

`python3 scripts/qa/l04_alert_adapter.py /absolute/private/alerts.db` ingests a
version 1 aggregate envelope from standard input into the same checkpoint, not
raw logs. Give it integer UTC epoch `window_start` and `window_end` exactly five
minutes apart on UTC five-minute boundaries and already closed. Include
`incidents` with `duplicate_postings` (count), `unexplained_difference` (boolean)
and `privacy_event` (boolean). Supply `telemetry: null` when coverage cannot be
proven; separately verified incident signals still apply. Otherwise `telemetry`
contains `missed_jobs`, `queue_oldest_seconds`, `overdue_receipt_checks` and an
`operations` map with an explicit `observationReconcileBatch` bucket carrying
`responses` and `http_503`, even for zero traffic. The protected bucket represents
only POST /v1/burimunsi/sms/observations/reconcile-batch. Other operations do not
affect its alert denominator or failure count.

No exporter or destination is configured. Before activation, compare exact
operation classification, 503 counts and window completeness against a bounded
hosted sample; establish trusted independent incident inputs, reporter and backup
owners, and a private delivery and acknowledgement procedure. Never emit an
apparently complete empty window when collection was incomplete.

### L04: Verify monitoring coverage before clearing an incident

The offline coverage gate (`scripts/qa/l04_alert_coverage.py`) does not treat
successful reads of function invocation logs as proof that client-facing API
responses were counted. It builds the aggregate input only when separately
attested client-facing ingress and invocation aggregates for the exact route
and same closed five-minute window are complete, their counts agree, no malformed
rows were counted, and the independent jobs/queue/receipt counters are available.
Otherwise it emits telemetry unavailable, preserving independent integrity and
privacy signals. A source attestation workflow and a real private delivery
destination are still required; the helper neither connects nor sends anything.

In the bounded hosted comparison on 25 November 2026 at 21:45–22:00 Kigali,
the selected stream returned 54 function rows with no protected-route suffix
matches. This establishes neither zero client traffic nor coverage of gateway
failures and is not evidence of recovery.

### R05: Reproducible local source receipt

On a clean exact-commit checkout, create a fresh owner-only evidence directory
outside Git and run `python3 scripts/qa/r05_local_source_receipt.py
/absolute/private/source-receipt.json`. This runs only the frozen source,
design-authority and offline alert checks. It writes the exact commit and each
actual outcome; it refuses a changed or dirty checkout and never overwrites a
prior receipt. Output includes no test log or credentials. Hosted CI, Edge,
gateway, jobs, PostgreSQL, Admin and Android are marked NOT RUN, even if the
source receipt passes. Record real evidence for those lanes separately.
