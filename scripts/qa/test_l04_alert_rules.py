import unittest
from dataclasses import replace
from l04_alert_rules import Signals, advance, decide

BASE = Signals(100,0,0,0,0,0,False,False,True)
class Rules(unittest.TestCase):
    def test_healthy_no_alert(self):
        self.assertEqual(decide(BASE), {})
    def test_absolute_503_threshold(self):
        self.assertEqual(decide(replace(BASE,reconciliation_unavailable=4)), {})
        self.assertEqual(decide(replace(BASE,reconciliation_unavailable=5)), {'api-unavailable':'page'})
    def test_relative_503_threshold_with_minimum_sample(self):
        self.assertEqual(decide(replace(BASE,reconciliation_responses=9,reconciliation_unavailable=1)), {})
        self.assertEqual(decide(replace(BASE,reconciliation_responses=10,reconciliation_unavailable=1)), {'api-unavailable':'page'})
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
        failing = replace(BASE, reconciliation_unavailable=5)
        active, delivered = {}, []
        for sample in (failing, failing, BASE, failing):
            result = advance(active, sample)
            delivered.extend(result.notify.items())
            active = result.active
        self.assertEqual(delivered,[('api-unavailable','page'),('api-unavailable','page')])

    def test_other_healthy_routes_cannot_dilute_reconciliation_rate(self):
        target = replace(BASE, reconciliation_responses=10, reconciliation_unavailable=4)
        self.assertEqual(advance({}, target).notify, {'api-unavailable':'page'})
        # No global responses field: callers cannot pass a mixed-lane
        # denominator separately from this alert's explicitly scoped counters.
        with self.assertRaises(TypeError):
            replace(target, responses=1521)

    def test_blind_window_does_not_reopen_same_api_episode(self):
        failure = replace(BASE, reconciliation_responses=10, reconciliation_unavailable=4)
        blind = replace(BASE, reconciliation_responses=0, telemetry_available=False)
        first = advance({}, failure)
        self.assertEqual(first.notify, {'api-unavailable':'page'})
        missing = advance(first.active, blind)
        self.assertEqual(missing.notify, {'telemetry-blind':'page'})
        self.assertEqual(missing.active, {'api-unavailable':'page','telemetry-blind':'page'})
        self.assertEqual(advance(missing.active, blind).notify, {})
        same = advance(missing.active, failure)
        self.assertEqual(same.active, {'api-unavailable':'page'})
        self.assertEqual(same.notify,{})
        recovered = advance(same.active, BASE)
        self.assertEqual(recovered.active,{})
        self.assertEqual(advance(recovered.active, failure).notify, {'api-unavailable':'page'})

    def test_quiet_lane_preserves_api_incident_but_resolves_blindness(self):
        opened = advance({}, replace(BASE, reconciliation_unavailable=5))
        prior = advance(opened.active, replace(BASE,telemetry_available=False))
        quiet = advance(prior.active, replace(BASE,reconciliation_responses=0))
        self.assertEqual(quiet.active, {'api-unavailable':'page'})
        self.assertEqual(quiet.notify, {})

    def test_independent_integrity_and_privacy_halts_notify_during_blindness(self):
        observed = advance({}, replace(BASE, duplicate_postings=1, telemetry_available=False))
        self.assertEqual(observed.notify, {'ledger-integrity':'halt','telemetry-blind':'page'})
        second = advance(observed.active, replace(BASE,privacy_event=True,telemetry_available=False))
        self.assertEqual(second.notify, {'privacy':'halt'})
        self.assertEqual(second.active, {'ledger-integrity':'halt','telemetry-blind':'page','privacy':'halt'})

    def test_impossible_counts_rejected(self):
        with self.assertRaises(ValueError): decide(replace(BASE,reconciliation_responses=1,reconciliation_unavailable=2))
        with self.assertRaises(ValueError): decide(replace(BASE,overdue_receipt_checks=-1))
        with self.assertRaises(ValueError): decide(replace(BASE,privacy_event='raw text must never be accepted'))
    def test_telemetry_failure_is_not_clearance(self):
        self.assertEqual(decide(replace(BASE,telemetry_available=False)), {'telemetry-blind':'page'})
