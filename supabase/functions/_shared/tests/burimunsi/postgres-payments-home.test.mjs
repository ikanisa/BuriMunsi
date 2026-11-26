import assert from 'node:assert/strict';
import test from 'node:test';
import {readPaymentsHome} from '../../domain/burimunsi/postgres-payments.js';

const group = 'group-1';
const asOf = '2026-11-26T00:00:00Z';
const counts = {payments: '0', members: '0', unallocated: '0'};
const summary = {lifetime_contributions: '1000.00', outgoing: '250', latest_wallet_balance: '750.000',
  reconciliation_status: 'reconciled'};
const home = {paymentCount: 0, memberCount: 0, unallocatedCount: 0, recentPayments: [], asOf};

function recordedSql(totals) {
  const queries = [];
  const sql = {async unsafe(query, params) {
    assert.deepEqual(params, [group]);
    queries.push(query);
    return queries.length === 1 ? totals : [];
  }};
  return {sql, queries};
}

test('legacy Home reads keep their original shape without consulting savings', async () => {
  const {sql, queries} = recordedSql([counts]);
  assert.deepEqual(await readPaymentsHome(sql, group, asOf, {}), home);
  assert.equal(queries.length, 2);
  assert.doesNotMatch(queries[0], /private\.burimunsi_home_savings|sum\(amount_rwf\)/);
});

test('enhanced Home reads the scoped summary and outgoing in the same SQL statement', async () => {
  const {sql, queries} = recordedSql([{...counts, ...summary}]);
  assert.deepEqual(await readPaymentsHome(sql, group, asOf, {}, {includeSavings: true}), {
    ...home, savings: {lifetimeContributionsRwf: 1000, outgoingPaymentsRwf: 250, latestWalletBalanceRwf: 750,
      reconciliationStatus: 'reconciled'},
  });
  assert.equal(queries.length, 2);
  assert.match(queries[0], /sum\(amount_rwf\) FILTER \(WHERE direction='outgoing'\)/);
  assert.match(queries[0], /private\.burimunsi_home_savings\(\$1\)/);
});

test('real zero, missing evidence and over-range totals remain distinct', async () => {
  const {sql} = recordedSql([{...counts, lifetime_contributions: '9007199254740992', outgoing: null,
    latest_wallet_balance: '0.000', reconciliation_status: 'unavailable'}]);
  const {savings} = await readPaymentsHome(sql, group, asOf, {}, {includeSavings: true});
  assert.deepEqual(savings, {lifetimeContributionsRwf: null, outgoingPaymentsRwf: null, latestWalletBalanceRwf: 0,
    reconciliationStatus: 'unavailable'});
});

test('malformed numeric evidence and absent or duplicate summary rows fail closed', async () => {
  const row = {...counts, ...summary};
  for (const totals of [[], [row, row], [{...row, latest_wallet_balance: '999999999999999.01'}],
    [{...row, lifetime_contributions: '-1'}]]) {
    const {sql} = recordedSql(totals);
    await assert.rejects(readPaymentsHome(sql, group, asOf, {}, {includeSavings: true}), /invalid_snapshot/);
  }
});
