# Recovering an Admin Sync handset with a v71 overflow marker

A v71 installation could fill its 512 local review slots before an unfamiliar approved-sender message was classified. It encrypted the existing 512 row IDs and receive times plus an uncertainty flag. The overflow write omitted the new row’s identity, receive time and body. A scan stopped before advancing past that row. Later cursor resets, inbox deletion, row-ID reuse and additional profile changes can leave the same protected data for different histories. The original-enrollment baseline also predates messages received after enrollment.

The receiver owner and an authorized group Admin can use the following procedure in the existing restricted case system.

1. Record the installed Admin Sync package and version, original device and installation alias, group membership, consent and time window, current hold and queue counts. Preserve the authorized originals and the phone’s app storage. An in-place same-signer upgrade preserves these records.
2. With the original installation signed in to the correct group, confirm consent, SMS permission, receiving SIM and the approved capture profile. Restore normal connectivity and run **Gateway → Sync**. Keep the original messages on the device throughout the check. Use an approved complete capture profile for previously unfamiliar legitimate formats.
3. Review each independently identified receipt through **SMS**, **Payments** and the scoped member statement. In the restricted case record, match the original to the source digest, payment, allocation and conditional payer outcome. Check the same identity again after a normal sync. An unfamiliar or mixed message remains private. A missing original or a recycled row number stays unresolved. Preserve evidence for any existing historical command separately.
4. Record the verified matches individually. Record any original whose identity cannot be reconstructed as unresolved historical coverage. Keep the aggregate historic hold open, even after all 512 named locators are resolved. A current phone scan, later provider balance, empty queue, renewed consent or another installation cannot reconstruct the discarded ID. A separately authorized immutable carrier or handset archive can substantiate individual originals in the case system. The current client has no independently authenticated complete v71 overflow register to import.
5. Preserve the account, installation and encrypted history for subsequent work on that case. Continue the ordinary exactly-once workflow for independently supported receipts. Retain any material unresolved historical coverage in the release or operational decision. General support records should contain case references and counts only.

The regression fixture uses the v71 checkpoint writer and reader. Two different overflow row/date pairs yield identical serialized state. Removing all 512 identified locators leaves the same three-byte uncertainty marker. The v72 app uses the same fail-closed reader for these records. New overflow records retain the additional exact locators on encrypted pages. [Regression fixture](../../test/native/LegacyOverflowEvidence.kt)

On a build that includes pending-census diagnostics, a restricted device
operator can inspect the existing receiver service dump after the app has
received acknowledgement of an incomplete census. The current cycle may show
count-only `audit_pending_*` fields: unfamiliar layout, unresolved intake
custody, server item conflict or unavailability, repeated source, or
nonfinal processing. Counts saturate at 10,000 per bucket and disappear
with a new cycle or process restart. They never contain raw text, digests,
IDs or transaction details and are not part of the server report. They are
not extra payments, missing payment counts or permission to reprocess.
A dump with no such fields does not establish that an inbox is complete.
