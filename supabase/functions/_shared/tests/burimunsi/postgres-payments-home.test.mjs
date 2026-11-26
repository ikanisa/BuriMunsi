import assert from 'node:assert/strict';
import test from 'node:test';
import {readOptionalPaymentsHome,readPaymentsHome} from '../../domain/burimunsi/postgres-payments.js';

const group = 'group-1';
const asOf = '2026-11-26T00:00:00Z';
const counts = {payments: '0', members: '0', unallocated: '0', summary_rows: '1', id: null};
const summary = {lifetime_contributions: '1000.00', outgoing: '250', latest_wallet_balance: '750.000',
  reconciliation_status: 'reconciled'};
const home = {paymentCount: 0, memberCount: 0, unallocatedCount: 0, recentPayments: [], asOf};

function recordedSql(totals) {
  const queries = [];
  const sql = {async unsafe(query, params) {
    assert.deepEqual(params, [group]);
    queries.push(query);
    return totals;
  }};
  return {sql, queries};
}

test('legacy Home reads keep their original shape without consulting savings', async () => {
  const {sql, queries} = recordedSql([counts]);
  assert.deepEqual(await readPaymentsHome(sql, group, asOf, {}), home);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /LIMIT 3/);
  assert.doesNotMatch(queries[0], /private\.burimunsi_home_savings|sum\(amount_rwf\)/);
});

test('enhanced Home reads the scoped summary and outgoing in the same SQL statement', async () => {
  const {sql, queries} = recordedSql([{...counts, ...summary}]);
  assert.deepEqual(await readPaymentsHome(sql, group, asOf, {}, {includeSavings: true}), {
    ...home, savings: {lifetimeContributionsRwf: 1000, outgoingPaymentsRwf: 250, latestWalletBalanceRwf: 750,
      reconciliationStatus: 'reconciled'},
  });
  assert.equal(queries.length, 1);
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

test('Admin Home reports exact directional totals and limits SMS balance to the authorized projection', async () => {
  const totals = {...counts, incoming:'9007199254740993', outgoing:'0', latest_sms_balance:'0'};
  const granted = recordedSql([totals]);
  assert.deepEqual(await readPaymentsHome(granted.sql, group, asOf, {canAnalyzeSms:true}, {adminTotals:true}), {
    ...home, paymentTotals:{incomingRwf:'9007199254740993',outgoingRwf:'0',latestSmsBalanceRwf:0,walletGapRwf:'9007199254740993'},
  });
  assert.match(granted.queries[0], /sum\(amount_rwf\) FILTER \(WHERE direction='incoming'\)/);
  assert.match(granted.queries[0], /private\.burimunsi_admin_home_sms_balance\(\$1\)/);
  const restricted = recordedSql([totals]);
  assert.deepEqual(await readPaymentsHome(restricted.sql, group, asOf, {canAnalyzeSms:false}, {adminTotals:true}), {
    ...home, paymentTotals:{incomingRwf:'9007199254740993',outgoingRwf:'0'},
  });
  assert.doesNotMatch(restricted.queries[0], /private\.burimunsi_admin_home_sms_balance/);
});

test('native and browser wallet projections use their own scoped SMS reader and exact signed differences', async () => {
  for (const options of [{includeWallet:true},{adminTotals:true}]) {
    for (const [incoming,outgoing,balance,latestSmsBalanceRwf,walletGapRwf] of [
      ['38050','12100','2990.00',2990,'22960'],
      ['0','0','0',0,'0'],
      ['10','8','2',2,'0'],
      ['2','10','1',1,'-9'],
      ['0','0',null,null,null],
      ['0','0','9007199254740992',null,null],
      ['0','9'.repeat(38),'9007199254740991',Number.MAX_SAFE_INTEGER,'-100000000000000000000009007199254740990'],
    ]) {
      const {sql,queries}=recordedSql([{...counts,incoming,outgoing,latest_sms_balance:balance}]);
      const result=await readPaymentsHome(sql,group,asOf,{canAnalyzeSms:true},options);
      assert.deepEqual(result,{...home,paymentTotals:{incomingRwf:incoming,outgoingRwf:outgoing,latestSmsBalanceRwf,walletGapRwf}});
      assert.match(queries[0],/FROM burimunsi\.payments WHERE collection_id=\$1/);
      assert.match(queries[0],/coalesce\(sum\(amount_rwf\) FILTER \(WHERE direction='outgoing'\),0\)::text/);
      const native=/FROM private\.burimunsi_home_savings\(\$1\)/,browser=/private\.burimunsi_admin_home_sms_balance\(\$1\)/;
      assert.match(queries[0],options.includeWallet?native:browser);
      assert.doesNotMatch(queries[0],options.includeWallet?browser:native);
    }
    // Access to payment source links alone does not grant the balance or difference.
    const {sql,queries}=recordedSql([{...counts,incoming:'0',outgoing:'0',latest_sms_balance:'750'}]);
    const result=await readPaymentsHome(sql,group,asOf,{showSms:true},options);
    assert.deepEqual(result.paymentTotals,{incomingRwf:'0',outgoingRwf:'0'});
    assert.doesNotMatch(queries[0],/private\./);
  }
});

test('wallet projection rejects malformed movement totals and malformed balance evidence',async()=>{
  for (const row of [{incoming:'00'}, {incoming:'1.0'}, {incoming:2}, {outgoing:'1'.repeat(39)},
    {outgoing:null}, {outgoing:'-1'}, {latest_sms_balance:undefined}, {latest_sms_balance:'73.001'}]) {
    const {sql}=recordedSql([{...counts,incoming:'1',outgoing:'0',latest_sms_balance:'1',...row}]);
    await assert.rejects(readPaymentsHome(sql,group,asOf,{canAnalyzeSms:true},{includeWallet:true}),/invalid_snapshot/);
  }
});

test('malformed numeric evidence and absent or duplicate summary rows fail closed', async () => {
  const row = {...counts, ...summary};
  for (const totals of [[], [{...row, summary_rows: '2'}], [{...row, latest_wallet_balance: '999999999999999.01'}],
    [{...row, lifetime_contributions: '-1'}]]) {
    const {sql} = recordedSql(totals);
    await assert.rejects(readPaymentsHome(sql, group, asOf, {}, {includeSavings: true}), /invalid_snapshot/);
  }
});

test('optional savings budget restores the snapshot settings while authority failures stay fatal', async () => {
  for(const error of [Object.assign(Error('canceling statement due to statement timeout'),{code:'57014'}),
    Object.assign(Error('out of date database schema'),{code:'42883'}),Object.assign(Error('access denied'),{code:'42501'}),
    Object.assign(Error('canceling statement due to user request'),{code:'57014'})]){
    const queries=[];
    const sql={async unsafe(query){
      queries.push(query);
      if(query.includes('private.burimunsi_home_savings'))throw error;
      return [counts];
    }};
    if(error.code==='42501'||error.message.endsWith('user request')){
      await assert.rejects(readOptionalPaymentsHome(sql,group,asOf,{}),e=>e===error);
      assert.equal(queries.length,2);
      continue;
    }
    assert.deepEqual(await readOptionalPaymentsHome(sql,group,asOf,{}),home);
    assert.match(queries[0],/^SAVEPOINT .*statement_timeout='450ms'$/);
    assert.match(queries[2],/^ROLLBACK TO SAVEPOINT .*RELEASE SAVEPOINT /);
    assert.doesNotMatch(queries[3],/burimunsi_home_savings/);
  }
});
