import test from 'node:test';
import assert from 'node:assert/strict';
import {bindNativeResponse, validateNativeQuery} from '../../domain/burimunsi/wire/native-contract.mjs';

const binding = {
  requestId: '11111111-1111-4111-8111-111111111111', generation: '1',
  installationId: 'installation-1', groupId: 'group-1', actorId: 'actor-1',
};
const snapshot = {memberCount: 0, unallocatedCount: 0, paymentCount: 0,
  asOf: '2026-11-22T12:28:06.000Z', recentPayments: []};
const bind = paymentTotals => bindNativeResponse({operation: 'homeWallet'}, binding, null, {...snapshot,paymentTotals});

test('the wallet selector extends Home without changing the legacy savings selector', () => {
  assert.equal(validateNativeQuery('home','').include,undefined);
  assert.equal(validateNativeQuery('home','include=savings').include,'savings');
  assert.equal(validateNativeQuery('home','include=wallet').include,'wallet');
  assert.throws(() => validateNativeQuery('home','include=wallet&include=savings'), {code: 'CONTRACT_QUERY_DUPLICATE'});
  assert.throws(() => validateNativeQuery('home','include=wallet&extra=1'), {code: 'CONTRACT_QUERY'});
  assert.throws(() => bindNativeResponse({operation:'homeSavings'},binding,null,
    {...snapshot,paymentTotals:{incomingRwf:'0',outgoingRwf:'0'}}));
});

test('the native wallet report preserves precision, silence and an unavailable balance', () => {
  const totals = {incomingRwf:'9007199254740993',outgoingRwf:'9007199254740992'};
  for (const paymentTotals of [
    totals,
    {...totals,latestSmsBalanceRwf:null,walletGapRwf:null},
    {...totals,latestSmsBalanceRwf:0,walletGapRwf:'1'},
    {...totals,latestSmsBalanceRwf:1,walletGapRwf:'0'},
    {...totals,latestSmsBalanceRwf:2,walletGapRwf:'-1'},
  ]) assert.deepEqual(bind(paymentTotals).data.paymentTotals,paymentTotals);
  assert.throws(() => bind({...totals,latestSmsBalanceRwf:0,walletGapRwf:'0'}), {code: 'CONTRACT_STATE'});
  assert.throws(() => bind({...totals,latestSmsBalanceRwf:null,walletGapRwf:'1'}), {code: 'CONTRACT_STATE'});
  assert.throws(() => bind({...totals,walletGapRwf:'1'}), {code: 'CONTRACT_STATE'});
  assert.throws(() => bind({...totals,latestSmsBalanceRwf:0}), {code: 'CONTRACT_STATE'});
  assert.throws(() => bind({...totals,walletGapRwf:'1\n'}), {code: 'CONTRACT_AMOUNT'});
});
