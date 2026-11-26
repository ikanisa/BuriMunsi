# Standalone Home savings summary

`GET /v1/burimunsi/home?include=savings` opts in to the existing `homeSavings`
response schema through `collect-api`. `GET /v1/burimunsi/home` and the Home
snapshot included in native login or session keep their existing response shapes.
Hosted Admin's `GET /api/admin/burimunsi/home` continues to return its Home counts
and recent payments.

The savings selector is available in standalone Payments mode. `RecordsService`
revalidates the caller's `records.read` access in the scoped read snapshot and
`readPaymentsHome` reads `private.burimunsi_home_savings` and the outgoing sum in
one SQL statement. Responses use `Cache-Control: no-store`. The projection returns
only the amounts and reconciliation status, with no raw SMS or source identities.

- `outgoingPaymentsRwf` is the exact principal of **recorded outgoing
  payments** in the current collection's canonical Payments table. It is not
  lifetime wallet outflow, an available balance, fees, or bank settlement.
  It is unavailable if no outgoing payment is recorded or if the sum is
  outside the safe whole-RWF wire range. Incoming rows, raw/SMS records,
  and predecessor ledger views are not summed.
- `lifetimeContributionsRwf` uses effective posted member contributions in the
  authorized collection. Each included amount requires matching payment,
  membership and ledger evidence and an effective, unreversed posting.
- `latestWalletBalanceRwf` uses the latest eligible, retained wallet-balance
  amount for the configured receiving account. The amount must come from
  validated provider SMS evidence with trusted source timing and wallet lineage.
  It describes the balance reported by that SMS.
- `reconciliationStatus` can be `reconciled` or `mismatch` when an independently
  verified provider statement covers the same wallet and exact movements,
  all three amounts are available, and the opening balance, fees and other
  adjustments leave the existing lifetime contributions minus recorded outgoing
  comparison applicable. Three available amounts can still have status
  `unavailable` when coverage is unproved.

The API converts PostgreSQL whole-RWF values exactly within the existing safe
integer range. A supported zero is returned as `0`. Missing, unqualified or
out-of-range evidence produces `null` for that amount. A malformed summary or
inconsistent reconciliation result fails the read. Deploy the database helper
before the `collect-api` source that reads it. This change uses the existing v64
wire shape.
