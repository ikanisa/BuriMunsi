from dataclasses import asdict, replace
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from l04_alert_checkpoint import acknowledge, incidents, ingest, initialize, pending, status
from test_l04_alert_rules import BASE

T = 1_800_000_000
FAIL = replace(BASE, reconciliation_unavailable=5)


class Checkpoint(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / 'l04.db'
        initialize(self.path)

    def sample(self, at, signals=BASE, **overrides):
        return ingest(self.path, at, {**asdict(signals), **overrides})

    def test_restart_preserves_pending_without_repaging(self):
        self.assertEqual(self.sample(T, FAIL)['new'], 1)
        before = pending(self.path)
        self.assertEqual(self.sample(T + 300, FAIL)['new'], 0)
        command = [sys.executable, str(Path(__file__).with_name('l04_alert_checkpoint.py')),
                   str(self.path), 'pending']
        self.assertIn(before[0]['id'], subprocess.check_output(command, text=True))
        self.assertEqual(pending(self.path), before)
        self.assertEqual(before[0]['severity'], 'page')
        self.assertEqual(set(before[0]), {'id','category','severity','window_end'})

    def test_concurrent_same_window_one_durable_event(self):
        with ThreadPoolExecutor(2) as pool:
            answers = list(pool.map(lambda _: self.sample(T, FAIL), range(2)))
        self.assertEqual({r['status'] for r in answers}, {'accepted', 'duplicate'})
        self.assertEqual(len(pending(self.path)), 1)

    def test_same_or_stale_window(self):
        self.sample(T, FAIL)
        self.assertEqual(self.sample(T, FAIL)['status'], 'duplicate')
        with self.assertRaises(ValueError):
            self.sample(T, BASE)
        with self.assertRaises(ValueError):
            self.sample(T - 300, BASE)
        self.assertEqual(len(pending(self.path)), 1)

    def test_recovery_creates_new_episode_without_erasing_old_pending(self):
        self.sample(T, FAIL)
        self.sample(T + 300)
        self.sample(T + 600, FAIL)
        first, second = pending(self.path)
        self.assertNotEqual(first['id'], second['id'])
        self.assertTrue(acknowledge(self.path, first['id']))
        self.assertFalse(acknowledge(self.path, first['id']))
        self.assertEqual(pending(self.path), [second])

    def test_outbox_full_rolls_back_entire_window(self):
        self.sample(T, FAIL)
        with patch('l04_alert_checkpoint.PENDING_LIMIT', 1):
            with self.assertRaises(ValueError):
                self.sample(T + 300, BASE, privacy_event=True)
        self.assertEqual(len(pending(self.path)), 1)
        self.assertEqual(self.sample(T + 300, BASE, privacy_event=True)['new'], 1)

    def test_blind_then_quiet_does_not_end_reconciliation_episode(self):
        self.sample(T, FAIL)
        self.sample(T + 300, BASE, telemetry_available=False, privacy_event=True)
        self.sample(T + 600, BASE, reconciliation_responses=2)
        self.sample(T + 900, FAIL)
        self.assertEqual([r['category'] for r in pending(self.path)],
                         ['api-unavailable', 'privacy', 'telemetry-blind'])

    def test_gap_requires_explicit_blind_windows(self):
        self.sample(T, FAIL)
        with self.assertRaises(ValueError):
            self.sample(T + 600, FAIL)
        self.sample(T + 300, BASE, telemetry_available=False)
        self.assertEqual(self.sample(T + 600, FAIL)['new'], 0)
        self.assertEqual([x['category'] for x in pending(self.path)],
                         ['api-unavailable', 'telemetry-blind'])

    def test_invalid_fields_rejected_without_persistence(self):
        with self.assertRaises(ValueError):
            self.sample(T, BASE, raw_body='must never be retained')
        with self.assertRaises(ValueError):
            self.sample(T + 1)
        with self.assertRaises(ValueError):
            self.sample(T, BASE, privacy_event=1)
        self.assertEqual(pending(self.path), [])
        self.assertEqual(self.sample(T)['status'], 'accepted')

    def test_missing_and_shared_or_unsupported_checkpoint_fail_closed(self):
        with self.assertRaises(FileNotFoundError):
            pending(self.path.with_name('absent.db'))
        self.path.chmod(0o644)
        with self.assertRaises(ValueError):
            pending(self.path)
        self.path.chmod(0o600)
        with sqlite3.connect(self.path) as db:
            db.execute('PRAGMA user_version=999')
        with self.assertRaises(ValueError):
            pending(self.path)

    def test_initialize_never_replaces_and_symlink_not_followed(self):
        self.sample(T, FAIL)
        with self.assertRaises(FileExistsError):
            initialize(self.path)
        link = self.path.with_name('alias.db')
        link.symlink_to(self.path)
        with self.assertRaises(ValueError):
            pending(link)
        self.assertEqual(len(pending(self.path)), 1)

    def test_status_reports_durable_position_without_sample_contents(self):
        self.assertEqual(status(self.path), {'last_window_end': None, 'pending_count': 0})
        self.sample(T, FAIL)
        self.assertEqual(status(self.path), {'last_window_end': T, 'pending_count': 1})

    def test_incidents_distinguishes_delivery_ack_from_recovery(self):
        self.assertEqual(incidents(self.path), {'last_window_end': None,
                         'open_incidents': {}, 'pending_by_category': {}})
        self.sample(T, FAIL)
        f = pending(self.path)[0]
        seen = incidents(self.path)
        self.assertEqual(seen, {'last_window_end': T,
                         'open_incidents': {'api-unavailable': 'page'},
                         'pending_by_category': {'api-unavailable': 1}})
        self.assertTrue(acknowledge(self.path, f['id']))
        self.assertEqual(incidents(self.path), {**seen, 'pending_by_category': {}})

    def test_incidents_reports_resolved_but_undelivered_notifications(self):
        self.sample(T, FAIL)
        self.sample(T + 300)
        self.sample(T + 600, FAIL)
        self.sample(T + 900)
        self.assertEqual(incidents(self.path), {'last_window_end': T + 900,
                         'open_incidents': {},
                         'pending_by_category': {'api-unavailable': 2}})

    def test_incidents_restart_cli_keeps_blind_api_and_privacy_visible(self):
        self.sample(T, FAIL)
        self.sample(T + 300, telemetry_available=False, privacy_event=True)
        for row in pending(self.path):
            self.assertTrue(acknowledge(self.path, row['id']))
        cmd = [sys.executable, str(Path(__file__).with_name('l04_alert_checkpoint.py')),
               str(self.path), 'incidents']
        # A mode-0400 checkpoint must be readable without write permission.
        self.path.chmod(0o400)
        before = self.path.read_bytes()
        out = json.loads(subprocess.check_output(cmd, text=True))
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(out, {'last_window_end': T + 300, 'pending_by_category': {},
                         'open_incidents': {'api-unavailable': 'page',
                                            'telemetry-blind': 'page',
                                            'privacy': 'halt'}})

    def test_bad_cli_input_is_not_echoed(self):
        command = [sys.executable, str(Path(__file__).with_name('l04_alert_checkpoint.py')),
                   str(self.path), 'ingest', str(T)]
        sample = b'{"missed_jobs": 0, "missed_jobs":"do-not-echo"}'
        r = subprocess.run(command, input=sample, capture_output=True)
        self.assertEqual(r.returncode, 1)
        self.assertNotIn(b'do-not-echo', r.stderr + r.stdout)
        self.assertEqual(pending(self.path), [])


if __name__ == '__main__':
    unittest.main()
