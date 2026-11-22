# Managed migration source history

`source-migrations.lock.json` is a byte-for-byte preservation of the source
migration lock used to qualify the managed Supabase Cloud transition. Its
historical format identifier is retained as provenance; it does not authorize
or configure a local production deployment. The migration SQL, the recorded
Cloud migration history, and the separate managed convergence candidates must
still be compared by the release tooling.

Historical PostgreSQL fixtures read this retained lock directly. Each fixture
checks the file names and body digests for its selected prefix and leaves later
Cloud migrations outside the rehearsal.

The retained lock, original lifecycle migration and its deployed managed
variant are exact qualification inputs. Both lifecycle bodies live under
`retained/`. The managed variant binds the fence and catalog observed when
the release ran.

The [20 November managed history at epoch 44](cloud-history-20261120-epoch44.json)
records all 89 migration bodies through `20261120104500`. A separate database
connection verified the seven new migrations, their catalog and grant checks,
and the payment and ledger totals recorded before the release. The receipt
includes the observed scheduler and Edge deployment identities.

The [earlier 82-migration readback](cloud-history-20261120.json) ends at
`20261118090305`. Run
`node --test scripts/supabase/cloud-release/recorded-history.test.mjs` to
compare both readbacks with their SQL sources and check that the first 82
entries are identical.

The forward release uses that 89-migration baseline to verify the four
writer-journal changes, the SMS helper search paths and the redundant index
cleanup. The complete cohort ends at `20261122045039` with 95 recorded
migrations. Run `make supabase-forward-release-postgres-test` to rehearse the
release and recovery on disposable PostgreSQL. To inspect the hosted ledger,
catalog and write fence using the
existing Supabase CLI authentication, run
`node scripts/supabase/cloud-release/apply.mjs --managed-forward inspect`.

In a drained, fenced maintenance window, use the observed `next` version and
`capture_sha256` with the `apply` action and a private evidence directory.
The transaction locks the ledger and fence, runs the exact migration, and
stores its original SQL in the ledger. Each commit is followed by two fresh
catalog readbacks. If the outcome is uncertain, use `reconcile` with the same
version, digest and directory. `retry` submits the SQL only after the original
predecessor has been verified under the transaction locks.

`fixtures/` contains only the schema and provider migration-history shapes
used by the synthetic chain test. Release tooling checks the retained lock,
individual migration bytes and fixture hashes before use.

The nonsecret managed lifecycle candidate generator is in
`scripts/supabase/cloud-release/managed-lifecycle-candidate.mjs`; its input
and generated SQL remain subject to the original preimage checks. These files
are migration evidence and test inputs, not a production service launcher.
