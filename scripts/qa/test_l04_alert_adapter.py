"""Synthetic checks for the aggregate-to-checkpoint integration."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from l04_alert_adapter import PROTECTED, adapt
from l04_alert_checkpoint import initialize, ingest, pending, status


def window(end=600):
    return {'version': 1, 'window_start': end - 300, 'window_end': end,
            'telemetry': {'missed_jobs': 0, 'queue_oldest_seconds': 0,
                          'overdue_receipt_checks': 0,
                          'operations': {PROTECTED: {'responses': 10, 'http_503': 0}}},
            'incidents': {'duplicate_postings': 0, 'unexplained_difference': False,
                          'privacy_event': False}}


class AlertAdapterTests(unittest.TestCase):
    def test_protected_operation_only(self):
        packet = window()
        ops = packet['telemetry']['operations']
        ops[PROTECTED]['http_503'] = 1
        ops['observationReconcileStatus'] = {'responses': 900, 'http_503': 500}
        ops['observationReconcile'] = {'responses': 200, 'http_503': 0}
        end, sample = adapt(packet, 600)
        self.assertEqual((end, sample['reconciliation_responses'],
                          sample['reconciliation_unavailable']), (600, 10, 1))

    def test_missing_and_zero_are_different(self):
        packet = window()
        ops = packet['telemetry']['operations']
        ops.pop(PROTECTED)
        with self.assertRaises(ValueError):
            adapt(packet, 600)
        ops[PROTECTED] = {'responses': 0, 'http_503': 0}
        self.assertTrue(adapt(packet, 600)[1]['telemetry_available'])
        packet['telemetry'] = None
        self.assertFalse(adapt(packet, 600)[1]['telemetry_available'])

    def test_reject_shapes_types_and_impossible_counts(self):
        mutations = (
            lambda p: p.update(version=True),
            lambda p: p['incidents'].update(privacy_event=1),
            lambda p: p['telemetry'].update(missed_jobs=False),
            lambda p: p['telemetry']['operations'][PROTECTED].update(http_503=11),
            lambda p: p['telemetry']['operations'][PROTECTED].update(body='private'),
            lambda p: p['telemetry']['operations'].update({'/path?id=private':
                                                           {'responses': 2, 'http_503': 0}}),
        )
        for i, mutate in enumerate(mutations):
            with self.subTest(mutation=i):
                packet = window()
                mutate(packet)
                with self.assertRaises(ValueError):
                    adapt(packet, 600)

    def test_reject_misaligned_future_and_non_five_minute_windows(self):
        for packet in (window(601), window(900), {**window(), 'window_start': 0}):
            with self.subTest(window_end=packet['window_end']):
                with self.assertRaises(ValueError):
                    adapt(packet, 600)

    def test_blind_window_does_not_clear_api_episode_and_keeps_privacy_halt(self):
        with tempfile.TemporaryDirectory() as base:
            checkpoint = Path(base) / 'state.db'
            initialize(checkpoint)
            first = window()
            first['telemetry']['operations'][PROTECTED]['http_503'] = 5
            ingest(checkpoint, *adapt(first, 600))
            second = window(900)
            second['telemetry'] = None
            second['incidents']['privacy_event'] = True
            ingest(checkpoint, *adapt(second, 900))
            third = copy.deepcopy(first)
            third.update(window_start=900, window_end=1200)
            ingest(checkpoint, *adapt(third, 1200))
            self.assertCountEqual([x['category'] for x in pending(checkpoint)],
                                  ['api-unavailable', 'telemetry-blind', 'privacy'])

    def test_cli_never_echoes_invalid_content_or_advances_checkpoint(self):
        with tempfile.TemporaryDirectory() as base:
            checkpoint = Path(base) / 'state.db'
            initialize(checkpoint)
            cmd = [sys.executable, str(Path(__file__).with_name('l04_alert_adapter.py')),
                   str(checkpoint)]
            for raw in (b'{"private_example":"not-for-output","version":1,"version":1}',
                        b'private_example' * 800):
                result = subprocess.run(cmd, input=raw, capture_output=True, check=False)
                self.assertEqual(result.returncode, 1)
                self.assertNotIn(b'private_example', result.stderr + result.stdout)
                self.assertIsNone(status(checkpoint)['last_window_end'])
            result = subprocess.run(cmd, input=json.dumps(window()).encode(),
                                    capture_output=True, check=True)
            self.assertEqual(json.loads(result.stdout), {'status': 'accepted', 'new': 0})
            self.assertEqual(status(checkpoint)['last_window_end'], 600)
