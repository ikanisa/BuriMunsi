# Isolated BuriMunsi PostgreSQL checks

The shared Edge suite skips eight tests when no PostgreSQL fixture is present.
`qualify.mjs` runs them in five fresh PostgreSQL 17 clusters using synthetic
records. The test workers connect directly to the private Unix socket after
checking the cluster's data directory, socket, server version and listener
settings.
Every cluster is stopped and its stop is checked before its temporary directory
is removed. An unconfirmed stop preserves the directory for investigation.
TERM and INT cancel the owned test process group and trigger that cleanup;
`interrupt.test.mjs` verifies termination during the active history suite. Run it
directly with `node --test-reporter=tap interrupt.test.mjs`, with the same
environment, so that the process receiving TERM or INT forwards it to the
qualifier and waits for cleanup. A hard kill can still interrupt cleanup.
Startup and stop commands are synchronous with bounded timeouts, so their
signal handling can be delayed until the command returns. The declared CI step
allows a 120-second termination grace; an immediate SIGKILL or host failure can
still leave an owned temporary cluster requiring operator cleanup.

```sh
COLLECT_BURI_TEST_PG_QUALIFY=true \
COLLECT_BURI_TEST_PG_BIN_DIR=/absolute/physical/postgresql-17/bin \
COLLECT_BURI_TEST_TMP_ROOT=/physical/writable/temp/root \
node scripts/supabase/testing/buri-isolated-pg/qualify.mjs
```

The binary directory and temporary root must be physical paths; the temporary
root must be separate from the checkout. Run as a non-root OS user. This checks
the current source queries and migration snippets under a synthetic C-locale
database; it does not test real accounts, a managed Supabase project, provider
connections or the full migration chain. The isolated bootstrap superuser is
not evidence of privileges on the hosted `postgres` role.

### Read-only contention snapshot

The release owner's probe is `advisory-contention.sql`. Use an approved
diagnostic role on the intended database during natural recurrence. It does
not acquire the application advisory locks, inspect query text or read
application data. It has a two-second statement limit. Keep a bounded sample
private; report times, target labels and counts rather than process IDs.
A verified pair requires the blocker PID to also hold the exact target in the
same observation. Pairings can disappear during a snapshot; a null pair,
missing transaction metadata (role visibility), or a quiet result is not
evidence that no lock caused an earlier failure. Correlate with the exact
failed operation and timestamps before attributing any incident. The probe
does not cancel a process, take a lock or retry a request.
