# Offline Storage object-inventory comparison

This verifier compares two **already approved or acquired manifests**, not object bodies. It opens local inputs only. It does not use the network, launch a capture, read Storage, access keys or credentials, decrypt archives, restore a database, or authorize a migration. The five-object predecessor and the separate v2 metadata reader remain unchanged.

## Trust and input contract

- Obtain the SHA-256 of the approved policy from the independent reviewer or trusted record, not by hashing an untrusted candidate policy immediately before running the verifier. The expected policy digest pins the limit and scope choices as well as the canonical baseline fingerprint. The verifier itself does not determine authorization.
- Encode each document as compact UTF-8 JSON using JSON.stringify, with optionally one final newline. Do not use a BOM, indentation, alternate numeric representations, or duplicate keys. All SHA-256 values are lowercase 64-character hexadecimal; sourceCommit is a lowercase 40-character commit hash.
- A policy has exactly: format = collect.storage.object-inventory-policy.v1, sourceCommit, scopeSha256, snapshotSha256, referenceSha256, maxObjects, maxObjectBytes, maxTotalBytes. The scope digest identifies the approved project and object scope without exposing names. The snapshot digest binds the independently approved inventory snapshot. referenceSha256 is the SHA-256 of the exact baseline manifest bytes, including any final newline.
- Each inventory has exactly: format = collect.storage.object-inventory.v1, sourceCommit, scopeSha256, snapshotSha256, objects. Each object entry has exactly identitySha256, versionSha256, sizeBytes and bodySha256. An approved producer must derive consistent opaque identity and version digests and independently attest any body digest. Never substitute an ETag, invent a missing version, copy a reference digest into the observed entry, or treat hashes of guessable labels as anonymization. Entries and manifests remain private. The ordering of observed entries is irrelevant; one identity may appear only once in each manifest, even at a different version.
- Approved bounds must be positive safe integers; each size is a non-negative safe integer. The verifier also caps policy/manifest byte size, entry count and claimed sizes. The CLI accepts only physical absolute paths to current-user-owned mode-0600 regular files with one link. The reference and observed inputs must have different paths and device/inode identities. Distinct file copies, even with matching bytes, do not demonstrate independent acquisition. Place them in separately protected owner-controlled custody, not the checkout. No data enters Git.

## Use

Run from this checkout with the pinned Node runtime after the four arguments are available:

    node scripts/supabase/storage-inventory-verify/verify.mjs <approved_policy_sha256> <policy_path> <reference_path> <observed_path>

The CLI emits one sanitized JSON result and returns nonzero on refusal. A match means only that the entries in the two input inventories correspond one-to-one and agree on declared size, version and body digest. It does not prove current provider identity, acquisition authenticity, actual bytes, contemporaneous Storage/database snapshots, backup retrieval, independent key custody, an operational restore, or migration readiness. Independently prove those conditions using the approved recovery protocol.

## Synthetic test

    node --test --test-reporter=tap scripts/supabase/storage-inventory-verify/verify.test.mjs

The fixtures use 61 invented opaque identities, no real record names, keys, provider responses or files. They cover order independence and equal-count/size replacement, rejected substitutions, pins, duplicates, byte limits, malformed input and private-file CLI behavior. The tests give no authority to run a real inventory or capture.
