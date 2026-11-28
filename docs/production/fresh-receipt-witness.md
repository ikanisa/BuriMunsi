# Verify a fresh MoMo receipt without making a test payment

Use the next **ordinary, already-authorized incoming payment** observed by the designated wallet operator. Do not initiate, forward, import or replay a transfer for this check. This procedure does not replace human UAT or bank settlement reconciliation.

1. Record the start of observation (Kigali time with offset), group, wallet, enrolled Admin app build and capture status. Record only that live listening was enabled; do not open or force a sync as a substitute for passive capture.
2. After the wallet operator independently confirms a new payment and its native receipt, preserve the provider reference, amount and original event time in the protected evidence record. Confirm the payment was not part of a historical import. Set the exclusive end after normal background processing has had time to finish. Use a single observation window, no longer than one day.
3. An authorized custodian runs [the read-only SQL](../../scripts/qa/fresh_receipt_witness.sql) from an existing scoped role that can see the canonical payments and original SMS custody for the verified group. Use trusted database transport and keep all inputs, output and errors private; a database server may log the statement. Check that the session can see a known in-scope SMS-linked payment first using a window around that control. If the control does not return three ones, stop; a zero here is not proof of absence. Never change grants, role claims, configuration or policies to make this check work.
4. Store the seven psql bindings in a private file (mode 0600), each in the form `\set name 'value'`: `collection_id`, `receiving_account_id`, `provider`, `provider_reference`, `amount_rwf`, `start`, `end`. Use the exact reference including leading zeroes. Keep the file outside Git, do not place values on the command line, and load it in the same session:

   ```sh
   umask 077
   psql -XqAt -v ON_ERROR_STOP=1 -f "$PRIVATE/witness-bindings.psql" \
     -f scripts/qa/fresh_receipt_witness.sql \
     > "$PRIVATE/witness-result.json" 2> "$PRIVATE/witness-errors.log"
   ```

5. Require exit zero and exactly one JSON result. Three ones mean one matching canonical incoming payment, created in the same window, with one linked in-scope SMS custody record stored in that window. After ordinary processing settles, the operator records a second matching scoped readback for the same reference, without causing a replay. Separately record the Admin's payment detail and member allocation if applicable. A zero, mismatch, unavailable role or query error is unresolved; do not declare payment loss or repeat any financial operation. Record which observation is missing and preserve original identities.

Public engineering reports should contain only the observation window, build/source identity, status and aggregate counts, not the reference, sender, amount, customer details or source ID. This check cannot prove device live-listening on its own, a complete inbox or allocation, bank settlement, or independent human acceptance.
