# Check role linkage in an inert recovery

Run the reader inside the isolated restore environment after mounting the encrypted PostgreSQL COPY archive read-only. Pass the inventory SHA-256 from the source capture receipt. The reader authenticates the inventory and the relation bytes it consumes. It prints aggregate relationships only and makes no network requests.

```sh
python3.11 -B scripts/supabase/current-pg-transfer/recovery-rehearsal/verify_role_dump.py \
  "$recovery_mount" --inventory-sha256 "$source_inventory_sha256"
python3.11 -B -m unittest discover -s scripts/supabase/current-pg-transfer/recovery-rehearsal
```

The result covers the native account and collection, group-bound device links, Web operator, Auth identity and BFF session relationships. It reports the receiving gateway’s enablement separately from the operator’s principal and collection. Native Staff and shared approvals have different identity rules. Counts describe the restored stored relationships. A successful sign-in, enforced RLS policies and a provider signing-key restore each require their own evidence.

An exit code of 0 means the checked relationships have no broken references, 1 identifies a broken reference and 2 indicates unreadable or inconsistent source evidence. A zero count can describe an empty recovery set. Check expected account and role counts against the independent acquisition record.

## Complete a typed service rehearsal

For a service restore from COPY, initialize the same major PostgreSQL version and the matching Auth schema on an isolated, encrypted recovery host. Bind the services to loopback or a private socket and block external network access, schedulers, webhooks, email and SMS delivery. Set the rehearsal PostgreSQL cluster name to `burimunsi_isolated_recovery`. Import the verified source data into its typed tables and restore reviewed schema, ownership, RLS and grants for every service path being tested.

Before allowing Auth or Payments traffic, run the following against the isolated PostgreSQL 17 database using its local connection settings.

```sh
psql --no-psqlrc --no-password --set=ON_ERROR_STOP=1 \
  --file=scripts/supabase/current-pg-transfer/recovery-rehearsal/prepare-service-data.sql
```

The COPY inventory omits generated columns. The script restores the canonical generated allocation state from the retained member ID and verifies the expression when the column already exists. It checks the sequence owned by `auth.refresh_tokens.id` against the restored IDs. A higher existing sequence value stays intact. The operation runs transactionally and can be repeated. A different generated expression, a plain allocation field, an exhausted sequence or an incompatible sequence stops the rehearsal for inspection.

Use a local mail sink or another isolated provider-approved sign-in method with an existing verified subject. Confirm that sign-in issues a new session, the protected user endpoint returns the original subject, and authorized Payments reads retain the original group and allocation totals. Record the restored signer or explicit reauthentication method, the outcome of an unrelated-group read, and shutdown of the rehearsal services. Record an observed service recovery time and the source cutoff alongside the owner's accepted targets. The PostgreSQL regressions run in `make test-backend-owned-pg`.
