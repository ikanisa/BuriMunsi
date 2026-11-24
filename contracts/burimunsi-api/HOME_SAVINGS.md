# Standalone Home savings summary

`GET /v1/burimunsi/home?include=savings` opts in to the `homeSavings` response
schema; `GET /home`, login, and session requests keep their existing wire shape.
This is only available in standalone Payments mode. The read uses the same
current, scoped `records.read` authorization and snapshot as Home; it does not
request SMS permission or expose raw sources. Responses are not cacheable over
HTTP. Missing or unqualified amounts are null, not zero.

- `outgoingPaymentsRwf` is the exact principal of **recorded outgoing
  payments** in the current collection's canonical Payments table. It is not
  lifetime wallet outflow, an available balance, fees, or bank settlement.
  It is unavailable if no outgoing payment is recorded or if the sum is
  outside the safe whole-RWF wire range. Incoming rows, raw/SMS records,
  and predecessor ledger views are not summed.
- `lifetimeContributionsRwf` remains unavailable: standalone incoming
  payment recording and member attribution do not establish an effective
  posted contribution or a complete predecessor contribution bridge.
- `latestWalletBalanceRwf` remains unavailable: the canonical payment row
  does not hold validated, retained original wallet-balance evidence. A
  parser's raw output or a calculation from partial inflows/outflows is not
  proof.
- `reconciliationStatus` is `unavailable` until independently verified
  opening balances, movements, fees/reversals and wallet evidence establish
  scope. This candidate does not assert reconciliation or a mismatch.

A future authoritative wallet projection should persist only a validated
wallet scalar and verified original-source time and identity at the existing
fenced parse completion, using a new reviewed additive change. It should not
copy the predecessor Home migration, rewrite old events, or read historical raw
SMS to populate this summary without a separately approved plan.
