# Native observation contract

## Who can capture

BuriMunsi identifies a **human user**, not a handset or SIM. The designated Admin
signs in to Admin Sync with their registered mobile number and passcode, then
grants Android's SMS permissions on the supported phone they are using. Staff
cannot capture or view SMS. No operator approves, registers or pairs a phone
or SIM for inbound capture. The login number identifies the Admin profile; it
does not identify the SIM or receiving wallet.

The native API still uses the signed-in app installation and consent generation
to fence technical operations, retries and access. The installation context is
established by the app and server, not by a manual enrollment step. The server
derives account, collection, grant and installation from the current proof; a
request cannot choose a receiving wallet. This contract describes maintained
source. Held observation operations remain fail-closed unless the server
enables them against the qualified private schema.

OpenSMS is a separate **outbound delivery** service. Its managed sender setup
and carrier SIM are for sending notifications, not prerequisites to sign in
as Admin or read eligible incoming M-Money messages. See the
[OpenSMS operating guide](../../deploy/collect-sms/README.md).

`GET` and `POST /sms/observation-consent` return `{enabled,generation}`. The generation starts at zero when unset and increases on each permission change; an exact retry is idempotent. An older or conflicting value is rejected. `GET /sms/observation-profile` returns one current provider candidate-filter profile, valid for 24 hours. A separately operator-configured detection-only profile can be used while the receiving account itself remains unverified. Its collection/account scope prevents stale configuration from being reused after scope changes; it does not identify the wallet that received a message or approve the account for financial processing. If no separate profile is configured, the existing approved account profile can supply the filter. A disabled, stale, or invalid profile blocks capture.

`POST /sms/observations` accepts a stable request UUID and exact source text. The body is limited to 3,000 UTF-8 bytes. A live capture must have `complete: true`; catch-up must have `complete: false` and a non-null `inboxReceivedAt`. The service-centre timestamp and subscription ID may be null. Timestamps and subscription IDs are untrusted device metadata, not evidence of wallet ownership. The acknowledgement echoes the request UUID and SHA-256 of the exact UTF-8 raw body. `source_unresolved` and `financialEffects: 0` mean only encrypted private retention; they do not mean parsing, recipient identification, allocation or posting.

`GET /sms/observations` lists only the current authorized admin account's own consenting installation and grant. Its metadata-only `q` searches source IDs, not sender or message content. Its cursor is tied to the account, installation, filter and current snapshot. `POST /sms/observations/{id}/reveal` requires a review reason and records an audit event after checking the source, storage journal, current session, consent and separate read/reveal grants. The managed Admin adapter has its own opt-in `BURIMUNSI_ADMIN_SMS_OBSERVATIONS_ENABLED` flag, separate from native `BURIMUNSI_SMS_OBSERVATIONS_ENABLED`. Those server controls are not phone or SIM approvals. Retention admission, parsing, recording a payment and allocating it to a member are distinct outcomes.

## Optional provisional display hints

A client may opt in to version 1 on an authorized raw reveal. With the separate `BURIMUNSI_OBSERVATION_HINTS_ENABLED` server flag disabled (the default), or if the approved capture-time provider tuple no longer matches, the response is `displayHints: null`. A non-null hint contains only exact UTF-16 spans and quotations from an incomplete inbox message, bound to its body digest and the approved profile version and JSON digest. It is provisional display text: it does not establish a sender, a recipient, a receiving account, a transaction or a financial effect. Legacy reveal requests omit the field. Admin clients additionally require their own default-off `BURIMUNSI_ADMIN_OBSERVATION_HINTS_ENABLED` build option.

The detection-only filter can supply display quotations only when its exact capture-time version, contents, collection/account scope, evidence identity and revision still match at disclosure. Changing or disabling it returns no hints; the filter never changes the receiving account's approval status. The testing migration is registered in source; the runtime feature remains disabled pending coordinated activation.

## Admin evidence and recovery

The managed Admin MoMo source workflow provides a read-only view of observation admissions for the operator's authorized collection. A currently authorized collection Admin can see historical admissions from all contributors, including uploaders who were later revoked; revocation does not authorize the uploader to access them. It must show the source and request IDs, server admission time, and whether the retained source is confirmed or the storage/commit outcome is still unresolved. A missing journal row is not proof that no upload is in flight. The view must not expose PINs, bearer/device secrets or SMS text, and it must not imply that a receiver or payment has been identified.

The server must bind this view to the current managed Admin session, an active approval for each collection, and the independent `sms.read` grant and role ceiling. Original-text disclosure additionally requires the independent `sms.reveal` grant, the current canonical sensitive-operation assurance (including the current fresh-assurance checks for the active sign-in flow), a reason and an audit event, with session, authorization, source and storage rechecked after object retrieval. The existing canonical source list and its access checks remain intact.

A pending or uncertain admission must not be deleted, automatically replayed, or reported as a successful capture. If an exact retry verifies retained bytes while the original upload outcome remains unknown, the server returns `observation_upload_unresolved` with HTTP 503; the encrypted reservation and original admission remain pending for operator recovery. The same signed-in installation can retry the original request and fingerprint while authority and consent remain valid; the server reconciles that exact operation against the retained journal. Changing phones does not carry over that installation's encrypted queue or authority to replay it. The current-consent historical recovery operations below retain a new held observation when applicable; they do not settle an earlier uncertain dispatch. Admission counts and saturation require a scoped diagnostic view that does not expose another collection's records.

Source and synthetic tests do not prove that a hosted build, recovery scope or capacity is qualified. Verify cross-collection isolation, revoked permissions, applicable fresh-assurance expiry, audit failure, in-flight commits, unknown storage outcomes and saturated admission capacity before relying on the hosted workflow. This contract does not approve a retention or erasure disposition.

### Request-bound uncertain upload

A `POST /sms/observations` may return HTTP 503 with the existing error code
`observation_upload_unresolved`. When, and only when, the server has
revalidated the current authorized account and exact durable request plus its
matching encrypted reservation and monotonic unresolved-upload journal, that
response also contains these single-valued headers:

- `X-BuriMunsi-Observation-Unresolved: v1`
- `X-BuriMunsi-Observation-Request-Id: <original requestId>`
- `X-BuriMunsi-Correlation-Id: <X-BuriMunsi-Request>`

The values assert request identity over the existing authenticated TLS request;
they contain no SMS body or SMS-derived digest. They do not acknowledge an
observation, prove the provider's final outcome, or authorize a ledger effect.
The client validates all three headers against its in-flight request and retains
that exact encrypted queue entry. Missing, malformed or duplicate headers,
other 503 errors, authorization failures and capacity limits do not justify
continuing the queue under this special case. A later exact retry checks the
journal before any Storage call while the unknown flag remains set.

### Verifying the handset inbox

Admin Sync scans eligible provider messages available to the signed-in Admin on the current Android phone, in Android inbox row order. SIM/subscription fields describe the observed message; they do not grant access. Each run checks every row, including messages below its upload cursor. A service timestamp can tie across rows. The handset row order breaks ties in the newest-message comparison. Each page uses the original source key, exact body digest, sender, subscription and phone timestamps. A row already received through a legacy gateway supplies its original gateway envelope UUID for lineage checks. That compatibility path is not required for normal Admin Sync capture.

`POST /sms/observations/inbox-check` opens a run with the current consent generation and `state=checking`. Each `POST /sms/observations/reconcile-batch` with that `runId` records the returned source identities and any missing item. The device replays a missing ordinary observation with its original request, checks processing status, and reads `GET /sms/observations/reconcile-verified-status` for the collection revision. It finishes the same run with the candidate, missing and pending counts and the opaque latest handset and parsed keys. PostgreSQL independently checks the page evidence, processing outcome of every source, latest key, collection revision and current authority. A successful parse or canonical duplicate can close an item. Pending, conflicted, held, unverified historical and security-classified sources stay visible as unresolved when checking parser completeness. The scoped Admin response contains counts, a check time and the result of the head comparison. A newly admitted source, missing object or changed parse makes an earlier successful Admin check show incomplete until the phone reconciles again.

Set `includeProcessing` to `true` on a reconciliation page to receive `processingStatus` on each matched source. The final read checks the source identities, current consent and parser results in one database snapshot. Missing rows omit this field. Clients can also request the statuses separately through `POST /sms/observations/processing-status`.

`POST /sms/observations/recover-held` stores a current-consent historical review entry using the stable source key and `expectedConsentGeneration`. The durable held marker precedes the encrypted write and excludes the source from automatic financial processing. `POST /sms/observations/recover-held-ack` can acknowledge the exact original request after verifying consent, custody and retained bytes. An unconfirmed response keeps the original command on the device. An absent or changed authority, installation context, grant or consent must not silently discard unresolved evidence. A SIM change alone is not a registration or approval step.

A fresh authenticated handset page can reconcile that entry in standalone Payments. The server checks the source key, sender, body, service and receipt times, subscription, current consent, profile and encrypted object. If the complete identity matches a previous successful parse and one payment for the same wallet, the new source reports `duplicate` and refers to that payment. Otherwise, a verified source with no earlier processing enters the regular signed parser. A supported transfer starts unallocated. An uncertain request, conflicting earlier parse, protected import or change of authority keeps its review status. The retained marker and the evidence for the later decision remain available. [Database rules](../../supabase/migrations/20261124114504_burimunsi_verified_inbox_recovery.sql)

### Admin live updates

`POST /api/admin/sync/live` uses the current Admin cookie, CSRF token and `sms.read` permission. Send `{"collectionId":"…"}`, or `{}` when the session has one available collection. The response contains an opaque `topic` and an ISO UTC `expiresAt`. Its private Broadcast subscription expires within five minutes. A receipt, ledger, delivery or inbox-check transition sends `operations_changed` with `{"changed":true}`. Supabase may add its independently generated transport UUID in `id`. The browser refetches the current outcome through the authenticated Admin API. PostgreSQL rechecks the session, credential and collection permissions before publishing each change.

### From SMS evidence to Payments and payer notification

1. **Capture and processing are automatic when authorized.** Eligible SMS
   are retained privately before parsing. The backend validates supported,
   successful incoming or outgoing RWF payment facts against source evidence
   and the configured receiving-account scope. It records each distinct payment
   in `burimunsi.payments` without routine transaction approval. Exact retries
   or duplicates are linked to the original record instead of recording a
   second payment. Unparseable, conflicting, held or unsupported evidence is
   not promoted to a successful payment. See the [recording migration](../../supabase/migrations/20261124114501_burimunsi_record_payments.sql).
2. **Member allocation is separate from recording.** A newly recorded
   standalone payment starts **Unallocated**; migrated earlier payments can
   retain an existing assignment. The authorized allocation operation links a
   member of the same collection
   against the current payment version and uses the original request key for
   retry. This does not approve the transaction, confirm settlement or create
   a second payment. Both incoming and outgoing records appear in Payments.
3. **Only the first allocation of an incoming payment creates a payer
   notification obligation.** It is recorded in the same database transaction;
   it is not yet a send. There is no obligation for an unallocated payment,
   outgoing payment or an allocation made before the notification rule. The
   destination must be the full payer number evidenced in the original message,
   never the selected member's phone as a substitute. Missing or unverified
   destination, recorded opt-out or an applicable authorization or retention
   mismatch can suppress a send with a recorded reason. These checks do not
   treat a missing preference record as evidence of opt-in. See the [allocation receipt migration](../../supabase/migrations/20261124114502_burimunsi_allocation_receipts.sql).
4. **Delivery is an independent outcome.** Authorized SMS and Payments
   readers can see applicable `payerStatus` and `payerReason`; absent values
   do not imply success. Queued, gateway accepted, sent, reported delivered,
   suppressed, expired, failed, and unknown are not interchangeable. An uncertain
   dispatch is checked using its original gateway message, not resent with a
   new identity. Reported delivery requires carrier acknowledgements for all
   parts; it is not proof the payer read it or that the payment settled at the bank.
