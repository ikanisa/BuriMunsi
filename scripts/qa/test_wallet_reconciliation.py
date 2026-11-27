import csv
import tempfile
import unittest
from pathlib import Path

from wallet_reconciliation import CANONICAL, WALLET, instant, reconcile, save


class WalletTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.payments, self.wallet, self.original = (self.root / n for n in ('payments', 'wallet', 'original'))
        self.original.write_bytes(b'Independent synthetic statement fixture')
        self.row = dict(collection_id='group', receiving_account_id='wallet', provider='provider',
                        occurred_at='2026-11-27T08:15:00+02:00', currency='RWF',
                        provider_reference='001', direction='incoming', amount_rwf='200')

    def export(self, payments, wallet):
        for path, fields, rows in [(self.payments, CANONICAL, payments), (self.wallet, WALLET, wallet)]:
            with path.open('w', newline='') as f:
                writer = csv.DictWriter(f, sorted(fields))
                writer.writeheader()
                writer.writerows(rows)

    def p(self, **fields):
        return self.row | {'allocation_state': 'unallocated'} | fields

    def w(self, **fields):
        return self.row | {'kind': 'payment', 'fee_rwf': '0', 'original_reference': ''} | fields

    def check(self, close=200):
        return reconcile(self.payments, self.wallet, self.original, ('group', 'wallet', 'provider'),
                         instant('2026-11-27T00:00Z'), instant('2026-11-28T00:00Z'), 0, close)

    def test_exact_refs_allocation_and_embedded_fee(self):
        self.export([self.p(), self.p(provider_reference='002', direction='outgoing', allocation_state='allocated')],
                    [self.w(), self.w(provider_reference='002', direction='outgoing', fee_rwf='5')])
        result = self.check(-5)
        self.assertEqual((result['result'], result['matched_payments']), ('matched', 2))
        self.assertEqual(result['allocation_counts'], {'allocated': 1, 'unallocated': 1})
        self.assertEqual(len(result['sha256']), 3)

    def test_duplicates_and_missing_refs_do_not_cancel_equal_amounts(self):
        self.export([self.p(), self.p(), self.p(provider_reference='002'), self.p(provider_reference='')],
                    [self.w(), self.w(provider_reference='003')])
        r = self.check(401)
        self.assertEqual(r['matched_payments'], 0)
        self.assertEqual({i['reason'] for i in r['exceptions']}, {'duplicate_reference',
                         'payment_reference_missing', 'only_in_canonical_payments',
                         'only_in_wallet_statement', 'closing_balance_difference'})

    def test_standalone_fee_and_reversal_are_separate(self):
        self.export([self.p()], [self.w(), self.w(kind='fee', direction='outgoing', amount_rwf='4',
                    provider_reference='fee1', original_reference='001'),
                    self.w(kind='reversal', direction='outgoing', provider_reference='rev1', original_reference='001')])
        r = self.check(-4)
        self.assertEqual(r['wallet_rwf']['difference'], 0)
        self.assertEqual([i['reason'] for i in r['exceptions']], ['reversal_requires_original_review'])

    def test_incoming_fee_needs_review_even_when_statement_closes(self):
        self.export([self.p()], [self.w(), self.w(kind='fee', direction='incoming',
                    amount_rwf='4', provider_reference='fee1', original_reference='001')])
        r = self.check(204)
        self.assertEqual(r['wallet_rwf']['difference'], 0)
        self.assertEqual(r['matched_payments'], 1)
        self.assertEqual(r['result'], 'exceptions')
        self.assertEqual(r['exceptions'], [{'reason': 'incoming_fee_requires_review',
                                           'wallet_lines': [3], 'canonical_lines': []}])

    def test_valid_outgoing_standalone_fee_can_clear(self):
        self.export([self.p()], [self.w(), self.w(kind='fee', direction='outgoing',
                    amount_rwf='4', provider_reference='fee1', original_reference='001')])
        r = self.check(196)
        self.assertEqual((r['result'], r['matched_payments']), ('matched', 1))

    def test_double_reported_fee_and_imprecise_canonical_time(self):
        self.export([self.p(occurred_at='')], [self.w(fee_rwf='5'), self.w(kind='fee', direction='outgoing',
                    amount_rwf='5', provider_reference='fee1', original_reference='001')])
        r = self.check(190)
        self.assertEqual({i['reason'] for i in r['exceptions']}, {'fee_may_be_counted_twice', 'payment_time_unknown'})

    def test_direction_disagreement_preserves_source_lines(self):
        self.export([self.p(direction='outgoing')], [self.w()])
        self.assertEqual(self.check()['exceptions'], [{'reason': 'direction_or_amount_differs', 'wallet_lines': [2],
                                                       'canonical_lines': [2]}])

    def test_equal_reference_and_amount_cannot_hide_business_date_disagreement(self):
        self.export([self.p(occurred_at='2026-11-27T21:59:59Z')],
                    [self.w(occurred_at='2026-11-28T00:00:00+02:00')])
        result = self.check()
        self.assertEqual(result['wallet_rwf']['difference'], 0)
        self.assertEqual(result['matched_payments'], 0)
        self.assertEqual(result['exceptions'], [{'reason': 'event_business_date_differs',
                                               'wallet_lines': [2], 'canonical_lines': [2]}])

    def test_same_business_day_accepts_offsets_and_different_minute_precision(self):
        self.export([self.p(occurred_at='2026-11-27T22:05:34Z')],
                    [self.w(occurred_at='2026-11-28T00:05:00+02:00')])
        result = self.check()
        self.assertEqual((result['result'], result['matched_payments']), ('matched', 1))

    def test_unknown_canonical_time_is_not_a_matched_payment(self):
        self.export([self.p(occurred_at='')], [self.w()])
        result = self.check()
        self.assertEqual(result['matched_payments'], 0)
        self.assertEqual([item['reason'] for item in result['exceptions']], ['payment_time_unknown'])

    def test_wrong_scope_boundary_empty_and_fraction(self):
        for change in ({'collection_id': 'other'}, {'occurred_at': '2026-11-28T00:00:00Z'},
                       {'occurred_at': '2026-11-27T00:00:00'}, {'amount_rwf': '2.5'}):
            with self.subTest(change=change):
                self.export([], [self.w(**change)])
                with self.assertRaises(ValueError):
                    self.check()
        self.export([], [])
        self.assertEqual(self.check(0)['result'], 'exceptions')

    def test_private_report_cannot_overwrite_or_use_canonical_as_original(self):
        self.export([self.p()], [self.w()])
        output = self.root / 'report.json'
        save(output, self.check())
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            save(output, {})
        self.original = self.payments
        with self.assertRaises(ValueError):
            self.check()
