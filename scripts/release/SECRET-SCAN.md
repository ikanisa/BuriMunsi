# BuriMunsi release secret scan

Use a clean full clone. This gate fails if the scanner or its positive control
cannot run, if a finding needs private review, or if a requested artifact cannot
be covered. There is no regex-only fallback.

```sh
bash scripts/release_secret_scan.sh --history
bash scripts/release_secret_scan.sh --artifacts /absolute/path/to/final.apk /absolute/path/to/admin-output
```

The first command scans commits reachable from Git HEAD and all local Git refs
using Gitleaks. CI uses full checkout history. This is not a scan of unfetched
refs, deleted unreachable history, uncommitted files or external evidence; the
command refuses a dirty, shallow or incomplete checkout. Git patch scanning
does not attest to opaque files or archived contents in commits; scan intended
release deliverables explicitly instead.

The November 27 private review classified 650 historical detections as
noncredentials. `reviewed-history.json` records the reviewed source commit,
tree, detector policy, digest of the private review and a digest of the distinct
findings per immutable commit. Each finding includes the file, rule, line
range and fingerprints of both the capture and full match. The gate rescans
every acquired ref, requires every reviewed group that is reachable to match,
and blocks a detection introduced in a new commit. A second private review of
the exact observations is required to update this record. Keep the original
classification evidence in private custody. The artifact command still flags
every detection in its independently supplied inputs.
The second command explicitly scans only the named regular files/trees and the
supported ZIP-family package members (including APK/AAB, single archive level).
It scans plain data and printable byte runs in binaries, not executable behavior
or every encryption/encoding scheme. Unreadable, oversized, nested, unsupported
or encrypted archives are refused, not assumed clean. A pass does not attest to
files not supplied, embedded data formats the rules cannot recognize, or whether
a suspected credential is valid.

Each invocation fetches the open-source pinned Gitleaks release for the host from
GitHub. It verifies the independently checked-in SHA-256 of the official archive
before extraction and compares the executable version. It runs built-in detection
rules with neither repository-wide path allowlists nor inline suppressions and
requires an intentionally synthetic positive control to be caught. The scanner
does not send artifact text to a provider. The wrapper reads the history report
through a private process pipe and writes no raw findings to a log or file. Temporary inputs are private
and removed on normal completion. Do not upload suspected artifacts while
investigating a finding; use an approved private review path and rotate/revoke
actual exposures rather than rewriting shared history as a reflex.
