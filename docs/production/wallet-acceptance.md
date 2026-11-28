# Verify a BuriMunsi wallet cutoff

Use one group, receiving account, provider and currency for each comparison. The operator obtains the original MoMo statement independently from the wallet custodian, confirms its ownership and records the opening and closing balance at the two cutoffs. Use explicit offsets. The start is inclusive and the end exclusive.

## Export the recorded payments

Use the authorized custodian's read-only database connection. Enter the group, wallet and provider using the identifiers verified with the operator. The query returns the canonical payment amounts, allocation and references for that wallet, including rows whose event time still needs placement.

```sh
umask 077
psql -Xq -v ON_ERROR_STOP=1 \
  -v collection_id="$GROUP_ID" -v receiving_account_id="$WALLET_ID" -v provider="$PROVIDER" \
  -v start="$START" -v end="$END" -f scripts/qa/wallet_payments_export.sql > "$PRIVATE/payments.csv"
```

## Normalize the independent statement

Preserve the provider original. Write a UTF-8 CSV with this header. Use the original provider reference exactly, including leading zeroes. The group, receiving account and provider identify the verified wallet.

```csv
collection_id,receiving_account_id,provider,currency,occurred_at,provider_reference,direction,amount_rwf,kind,fee_rwf,original_reference
```

Use `RWF`, an offset-aware event time, a positive whole amount and the actual movement direction (`incoming` or `outgoing`). For a `payment`, record the principal and any separately stated embedded fee. For a separately booked `fee` or `reversal`, record its own amount, movement direction and original reference when available. Enter an explicit zero embedded fee when appropriate. The operator checks how the provider reports charges before normalizing. Keep outgoing standalone charges as fees; an incoming fee row stays in the totals but requires review as a possible refund or a coding error. If supported by the provider record, normalize a confirmed refund as a reversal and retain its original reference. Retain the total number of source rows and all adjustments across both boundaries. Derive the expected CSV movement count independently from the original, documenting any rows split, combined or excluded. Pass that witnessed count with `--statement-row-count`. Do not simply count the CSV you are testing.

```sh
python3 scripts/qa/wallet_reconciliation.py \
  --canonical "$PRIVATE/payments.csv" --wallet "$PRIVATE/wallet.csv" --original "$ORIGINAL" \
  --collection-id "$GROUP_ID" --receiving-account-id "$WALLET_ID" --provider "$PROVIDER" \
  --start "$START" --end "$END" --opening "$OPENING_RWF" --closing "$CLOSING_RWF" \
  --statement-row-count "$WITNESSED_CSV_MOVEMENT_COUNT" \
  --output "$PRIVATE/wallet-reconciliation.json"
```

Exit 0 means the supplied rows match by reference, direction, amount and Kigali business date, and the statement balances agree. Different time offsets or minute precision on the same Kigali date do not by themselves prevent a match. If a provider statement instead uses settlement dates, evidence the timing difference separately; do not change source timestamps to force a match. If the optional statement-row count is omitted, the report records an unverified count; even a verified count does not prove transcription accuracy. Exit 3 produces a private exception report with the physical CSV line numbers. Exit 2 means the comparison could not complete. Reversals require the original transaction and operator review. An unallocated payment can match the provider statement. The designated operator checks the member attribution, tests an authorized same-group allocation and its same-key retry, and reads the member statement. Record who reviewed the original, the cutoff and any exceptions. If the release makes a bank-settlement claim, obtain the corresponding independent bank statement and verify the actual settlement cutoff separately.

For one new ordinary payment rather than a full wallet cutoff, use the [fresh receipt witness](fresh-receipt-witness.md).
