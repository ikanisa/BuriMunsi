import unittest
from dataclasses import replace
from l04_alert_rules import Signals, decide, newly_open

BASE = Signals(100,0,0,0,0,0,False,False,True)
class Rules(unittest.TestCase):
    def test_healthy_no_alert(self):
        self.assertEqual(decide(BASE), {})
    def test_absolute_503_threshold(self):
        self.assertEqual(decide(replace(BASE,unavailable=4)), {})
        self.assertEqual(decide(replace(BASE,unavailable=5)), {'api-unavailable':'page'})
    def test_relative_503_threshold_with_minimum_sample(self):
        self.assertEqual(decide(replace(BASE,responses=9,unavailable=1)), {})
        self.assertEqual(decide(replace(BASE,responses=10,unavailable=1)), {'api-unavailable':'page'})
    def test_scheduler(self):
        self.assertEqual(decide(replace(BASE,missed_jobs=2)), {})
        self.assertEqual(decide(replace(BASE,missed_jobs=3)), {'scheduler-dispatch':'page'})
    def test_queue(self):
        self.assertEqual(decide(replace(BASE,queue_oldest_seconds=899)), {})
        self.assertEqual(decide(replace(BASE,queue_oldest_seconds=900)), {'queue-age':'page'})
    def test_missing_receipt_evidence(self):
        self.assertEqual(decide(replace(BASE,overdue_receipt_checks=1)), {'receipt-coverage':'page'})
    def test_integrity_and_privacy_halt_independent_of_metrics(self):
        for sig in [replace(BASE,duplicate_postings=1), replace(BASE,unexplained_difference=True)]:
            self.assertEqual(decide(sig), {'ledger-integrity':'halt'})
        self.assertEqual(decide(replace(BASE,privacy_event=True,telemetry_available=False)), {'privacy':'halt','telemetry-blind':'page'})
    def test_no_delivery_on_repeated_open_episode_and_reopens_after_recovery(self):
        state = decide(replace(BASE,unavailable=5))
        mock_delivery = []
        for previous, current in [({},state),(state,state),(state,{}),({},state)]:
            mock_delivery.extend(newly_open(previous,current).items())
        self.assertEqual(mock_delivery,[('api-unavailable','page'),('api-unavailable','page')])
    def test_impossible_counts_rejected(self):
        with self.assertRaises(ValueError): decide(replace(BASE,responses=1,unavailable=2))
        with self.assertRaises(ValueError): decide(replace(BASE,overdue_receipt_checks=-1))
        with self.assertRaises(ValueError): decide(replace(BASE,privacy_event='raw text must never be accepted'))
    def test_telemetry_failure_is_not_clearance(self):
        self.assertEqual(decide(replace(BASE,telemetry_available=False)), {'telemetry-blind':'page'})
