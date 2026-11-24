# Collect roster decoder

Historical standalone codec/workbook validation source for Collect roster
imports. This Python helper is not a Supabase Edge Function or the maintained
BuriMunsi decoder. See [maintained Edge paths and tests](#maintained-edge-paths-and-tests)
below.

## Decoder controls

The owner-selected roster policy accepts supported static images and rejects
animated or multi-frame images. Admission performs that refusal before source
retention; the signed bridge remains a second safeguard. The legacy helper's
frame-validation behavior below is retained as factual context and does not
authorize animation delivery.

The decoder performs Pillow PNG/JPEG/WebP decoding of every animation frame,
PDF object/stream inspection and PDFium rendering of every page, and bounded
ZIP/XML/openpyxl workbook-to-TSV derivation. It rejects active PDF content,
workbook formulas and external references, malformed source files and expansion
limits. Input and output bytes, image dimensions, frame/page counts and workbook
rows/columns are bounded in `decoder.py`.

On Linux, each job runs in a separate process with networking, socket, execution,
fork and tracing syscalls denied by seccomp. The child receives no provider,
database or signing credentials. `server.py` applies connection, replay, timeout
and resource limits. Run the container read-only, without Linux capabilities or
new privileges, with bounded memory, CPU, PIDs and temporary storage.

The HTTP supervisor accepts HMAC-authenticated requests with request, reservation,
nonce and policy identities. It stores nonce claims in SQLite and signs the exact
response payload, including source and build hashes. Provision a strong
`ROSTER_DECODER_SECRET` separately from source and persist the nonce state volume.

## Historical locked build inputs

The following documents the retained Linux image build, not a BuriMunsi release
or deployment step. It uses the pinned base image and the hash-locked Python
3.12/Linux ARM64 wheels in `requirements.lock`. A different architecture requires its own reviewed
wheel hashes and verification. The acquisition helper captures official package
metadata and exact lock-selected wheel bytes into a fresh directory:

```sh
python3 -B tools/roster-decoder/roster_wheelhouse.py --acquire \
  --lock-file tools/roster-decoder/requirements.lock \
  --lock-sha256 REVIEWED_WHOLE_LOCK_SHA256 \
  --destination /absolute/path/to/fresh/publisher-inputs
```

Use the helper's explicit wheel, receipt and metadata arguments with
`--decoder-directory tools/roster-decoder` and a fresh `--destination` to prepare
a private build context. Build that prepared directory with
`docker build --no-cache --network=none`. The source directory alone has no
wheelhouse and is not a complete image build context. Preserve the acquired
metadata, source hashes and publisher receipt outside this repository.

## Maintained Edge paths and tests

- [BuriMunsi Smart Onboarding](../../supabase/functions/_shared/domain/burimunsi/smart-onboarding-import.js)
  uses a [policy-gated native static JPEG preview](../../supabase/functions/_shared/domain/burimunsi/smart-onboarding-policy.js)
  through the [Edge adapter](../../supabase/functions/_shared/roster_native_jpeg_decoder.mjs).
  This source path requires explicit authorization, collection and build
  binding, and request consent. It does not establish hosted enablement,
  production OCR qualification, or native PDF/workbook support.
- The shared [Collect roster route](../../supabase/functions/_shared/domain/roster.js)
  and [signed decoder bridge](../../supabase/functions/_shared/roster_decoder_bridge.mjs)
  are compatibility source. Bridge tests use transport doubles; the Python
  supervisor's separate SQLite replay state is not part of the maintained
  BuriMunsi Edge run path.
- The [native probe](native-probe/README.md) preserves dependency experiments,
  not a qualified production decoder. Neither the probe nor the Python
  container is needed to run the following checks.

From the repository root, run the current checked-in synthetic tests with Node 24:

```sh
node --test \
  supabase/functions/_shared/tests/roster-image-policy.test.mjs \
  supabase/functions/_shared/tests/roster-static-admission.test.mjs \
  supabase/functions/_shared/tests/roster-native-jpeg-decoder.test.mjs \
  supabase/functions/_shared/tests/burimunsi/smart-onboarding-native-jpeg.test.mjs \
  supabase/functions/_shared/tests/burimunsi/smart-onboarding-policy.test.mjs \
  supabase/functions/_shared/tests/burimunsi/smart-onboarding-signed-bridge.test.mjs
```

These checks use synthetic fixtures. They do not need production credentials or
establish live processing, provider accuracy or release acceptance.

Primary references: [Pillow image safety](https://pillow.readthedocs.io/en/stable/reference/Image.html),
[PDFium wrapper](https://github.com/pypdfium2-team/pypdfium2),
[openpyxl security](https://openpyxl.readthedocs.io/en/stable/).
