from copy import deepcopy
from unittest import TestCase
from l04_alert_adapter import PROTECTED, adapt
from l04_alert_coverage import ROUTE, build


def fixture():
    window = {'window_start': 300, 'window_end': 600}
    src = {**window, 'route': ROUTE, 'responses': 13, 'http_503': 2,
           'complete': True, 'path_verified': True, 'malformed': 0}
    return {'route': ROUTE, 'window_start': 300, 'window_end': 600,
            'ingress': src, 'invocations': deepcopy(src),
            'health': {**window, 'complete': True, 'counters': {
                'missed_jobs': 0, 'queue_oldest_seconds': 120, 'overdue_receipt_checks': 0}},
            'incidents': {'duplicate_postings': 0, 'unexplained_difference': False,
                          'privacy_event': False}}


class CoverageTests(TestCase):
    def test_independent_counts_match(self):
        self.assertEqual(build(fixture(), 600)['telemetry']['operations'][PROTECTED],
                         {'responses': 13, 'http_503': 2})

    def test_disagreement_or_incomplete_marks_blind(self):
        for key, value in [('responses', 12), ('http_503', 0), ('complete', False),
                           ('path_verified', False), ('malformed', 1)]:
            with self.subTest(key=key):
                row = fixture()
                row['invocations'][key] = value
                self.assertIsNone(build(row, 600)['telemetry'])

    def test_missing_source_or_health_never_becomes_healthy(self):
        for key in ('ingress', 'invocations', 'health'):
            row = fixture()
            row[key] = None
            row['incidents']['privacy_event'] = True
            _, sample = adapt(build(row, 600), 600)
            self.assertFalse(sample['telemetry_available'])
            self.assertTrue(sample['privacy_event'])

    def test_distinguishes_verified_zero_from_no_records(self):
        row = fixture()
        for key in ('ingress', 'invocations'):
            row[key].update(responses=0, http_503=0)
        self.assertIsNotNone(build(row, 600)['telemetry'])
        row['ingress']['complete'] = False
        self.assertIsNone(build(row, 600)['telemetry'])

    def test_no_raw_fields_or_mistyped_attestations(self):
        for bad in [{'pathname': '/raw/path'}, {'complete': 1}, {'http_503': 77}]:
            row = fixture()
            row['ingress'].update(bad)
            with self.assertRaises(ValueError):
                build(row, 600)

    def test_wrong_route_or_open_window_refused(self):
        row = fixture()
        row['route'] = 'GET /sms/observations/reconcile-batch'
        with self.assertRaises(ValueError):
            build(row, 600)
        with self.assertRaises(ValueError):
            build(fixture(), 599)

    def test_stale_or_future_input_cannot_clear_the_current_window(self):
        for lane in ('ingress', 'invocations', 'health'):
            for offset in (-300, 300):
                with self.subTest(lane=lane, offset=offset):
                    row = fixture()
                    row[lane].update(window_start=300 + offset, window_end=600 + offset)
                    row['incidents']['privacy_event'] = True
                    _, sample = adapt(build(row, 900), 900)
                    self.assertFalse(sample['telemetry_available'])
                    self.assertTrue(sample['privacy_event'])

    def test_same_counts_for_different_route_do_not_attest_coverage(self):
        for lane in ('ingress', 'invocations'):
            row = fixture()
            row[lane]['route'] = 'POST /v1/burimunsi/sms/observations/reconcile'
            self.assertIsNone(build(row, 600)['telemetry'])

    def test_health_requires_explicit_completeness(self):
        row = fixture()
        row['health']['complete'] = False
        self.assertIsNone(build(row, 600)['telemetry'])

    def test_any_partially_attached_or_mistyped_window_is_refused(self):
        for lane in ('ingress', 'invocations', 'health'):
            row = fixture()
            del row[lane]['window_end']
            with self.subTest(lane=lane), self.assertRaises(ValueError):
                build(row, 600)
            row = fixture()
            row[lane]['window_end'] = '600'
            with self.subTest(lane=lane), self.assertRaises(ValueError):
                build(row, 600)

    def test_earlier_unbound_aggregate_format_must_be_rebuilt(self):
        row = fixture()
        for lane in ('ingress', 'invocations', 'health'):
            row[lane].pop('window_start')
            row[lane].pop('window_end')
        with self.assertRaises(ValueError):
            build(row, 600)
