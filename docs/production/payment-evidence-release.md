# Payments evidence and listing release

When Payments reports conflicting receipt evidence, the authorized operator opens the payment in Web Payments and records its group, receiving wallet, provider reference, original payment ID, amount and current allocation. The Web detail shows the hold. Existing native releases keep their two allocation states and receive a conflict response if they attempt assignment.

The authorized Admin uses the existing protected SMS evidence and inbox review routes to identify the original and contradictory receipts. Retain their two source IDs, capture and provider timestamps, original ciphertext/object digests, linked parser attempt IDs and outcomes in the restricted case. Record the allocation request and payer-confirmation attempt ID if one exists. Share only the evidence that the finance reviewer is already authorized to receive.

The wallet custodian compares the disputed reference against the original issuer statement and records the independently evidenced movement and decision under the existing finance reconciliation procedure. Escalate any necessary attribution or financial correction to the designated release and finance owners with that case reference. Version `20261127222536` keeps the original amount, both source records and the original Allocated or Unallocated state. The hold persists through recapture, an exact duplicate and retry. Clearing a hold or posting a correction requires its own authorized, evidence-preserving change. [Wallet acceptance](wallet-acceptance.md)

A conflict before a payer confirmation is armed suppresses the send. A confirmation already armed retains its original attempt, message and idempotency identities. Operators reconcile that same attempt through the existing gateway and per-part carrier status procedure. Keep an uncertain outcome open until authoritative evidence arrives.

## Qualify the candidate locally

Run these commands from the checkout with the repository's PostgreSQL 17, Node, Deno and cached locked dependencies.

```sh
node scripts/supabase/cloud-release/apply.mjs --payment-evidence plan
node --experimental-transform-types --test --test-name-pattern='standalone capture' scripts/supabase/cloud-release/burimunsi-automatic-receipt-e2e.test.mjs
```

The first command reconstructs all 128 predecessor entries from retained migration bytes. The 28 November 2026 Kigali readback ended at `20261126170200` with ordered SHA-256 `b23a11e79ae226be50b3f7450b02652e0075f09a4ee6f41426b3b8011e53a441`. The plan prints the candidate source digest and expected 129-entry history digest. The second command rehearses the managed migration journal and independent readback on a disposable database, the financial and notification flows, and the deployed native driver on an isolated Unix socket.

## Approved managed release

The release owner confirms the exact candidate, the current database recovery copy and access to it, the protected original-SMS and parser records, the restricted role grants, and the operator authorization for the window. Use the established scheduler and admission drain to reach the fenced state. Preserve original in-flight or uncertain external attempts. The database connection uses the existing project-bound TLS release transport and private database credential file.

1. Run `node scripts/supabase/cloud-release/apply.mjs --payment-evidence inspect`. Record the fingerprint, source, epoch, mode and the protected-data and grants digests in the private release file. The snapshot covers original ciphertext, payment rows, source-job outcomes and payer-confirmation identities. The command checks that the operator can see the complete protected relations.
2. Run `node scripts/supabase/cloud-release/apply.mjs --payment-evidence apply PREIMAGE PRIVATE_DIRECTORY` with that exact fenced fingerprint and an existing private operator evidence directory. The release mechanism locks the migration ledger and fence, rechecks the approved predecessor, verifies the guard triggers, force-RLS policy and custody digests, and journals the exact migration bytes in the same transaction. A second database session verifies the resulting history and protection.
3. If the commit or response was interrupted, run `node scripts/supabase/cloud-release/apply.mjs --payment-evidence reconcile PREIMAGE PRIVATE_DIRECTORY` while still fenced. A recorded successor can advance to application checks. A confirmed predecessor can be reviewed for a separate explicit attempt. Preserve the original intent and readback evidence.
4. Deploy the matching Edge and Web candidate using the established release flow. With the authorized test group, verify a scoped Admin and Staff read, the canonical Kigali movement date, a withheld disputed assignment, and the existing allocation receipt readback. The release owner records results before reopening the wider rollout.
