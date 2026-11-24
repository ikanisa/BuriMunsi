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

## Synthetic byte-readback witness

The separate readback command does not obtain, extract or decrypt an archive. It reads only already-furnished synthetic files under a reviewed, explicit private ordinal map. Never give it a real archive, object or credentials. The synthetic map marker is an input contract, not independent proof that supplied contents are synthetic or acquired independently.

The independently approved map digest pins compact UTF-8 JSON with exactly these fields:

- format: collect.storage.synthetic-byte-readback-map.v1
- syntheticOnly: true
- policySha256 and referenceSha256: exact previously approved hashes
- sourceCommit, scopeSha256, snapshotSha256: must match the approved policy
- files: exactly one entry per reference identity, in dense ordinal order starting at 1. Each entry has ordinal, identitySha256, versionSha256 and sizeBytes, with no path, name or body digest. A file’s allowed name is derived only from the ordinal (for example, 000001.opaque).

Run the command only against distinct, existing, private mode-0700 physical directories outside the checkout. The restore root must contain exactly the mapped files, owned by the current user and mode 0600 with one link each. The output directory must be empty. Keep the three separately supplied mode-0600 input JSON files outside both directories.

    node scripts/supabase/storage-inventory-verify/readback.mjs <reviewed_policy_sha256> <policy_file> <reference_file> <reviewed_map_sha256> <map_file> <furnished_synthetic_root> <empty_private_output_directory>

The witness checks exact length and SHA-256 of actual bounded file reads, including empty files, and rechecks file identities after the full sweep. It refuses missing or extra entries, private-permission violations, hash/length mismatch, traversal and relevant inode/path drift. Its further limits are 256 files, 64 MiB per file and 128 MiB total; wider scope needs a new review. A successful match publishes one mode-0600 observed-manifest.json in the empty output directory without overwriting; failure never publishes a matching manifest. The stdout receipt contains only scalar counts/status, not file paths, object IDs or hashes. The private output manifest contains opaque digest identifiers and is compatible with verify.mjs.

This is single-host, bounded readback of controlled files, not an atomic source snapshot, custody proof, decryption, database/Storage restore, or production release/migration authorization. Keep the furnished and output directories under exclusive operator control throughout the check. Real archive support would require a different review of provenance, independent custody, permissions, acquisition and inert restoration.

    node --test --test-reporter=tap scripts/supabase/storage-inventory-verify/readback.test.mjs
