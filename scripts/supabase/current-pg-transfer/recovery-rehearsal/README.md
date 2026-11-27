# Check role linkage in an inert recovery

Run the reader inside the isolated restore environment after mounting the encrypted PostgreSQL COPY archive read-only. Pass the inventory SHA-256 from the source capture receipt. The reader authenticates the inventory and the relation bytes it consumes. It prints aggregate relationships only and makes no network requests.

```sh
python3.11 -B scripts/supabase/current-pg-transfer/recovery-rehearsal/verify_role_dump.py \
  "$recovery_mount" --inventory-sha256 "$source_inventory_sha256"
python3.11 -B -m unittest discover -s scripts/supabase/current-pg-transfer/recovery-rehearsal
```

The result covers the native account and collection, group-bound device links, Web operator, Auth identity and BFF session relationships. It reports the receiving gateway’s enablement separately from the operator’s principal and collection. Native Staff and shared approvals have different identity rules. Counts describe the restored stored relationships. A successful sign-in, enforced RLS policies and a provider signing-key restore each require their own evidence.

An exit code of 0 means the checked relationships have no broken references, 1 identifies a broken reference and 2 indicates unreadable or inconsistent source evidence. A zero count can describe an empty recovery set. Check expected account and role counts against the independent acquisition record.
