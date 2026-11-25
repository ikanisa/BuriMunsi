"""Offline L04 alert decision example. No network, credentials or real records."""
from collections.abc import Mapping
from dataclasses import dataclass

@dataclass(frozen=True)
class Signals:
    reconciliation_responses: int
    reconciliation_unavailable: int
    missed_jobs: int
    queue_oldest_seconds: int
    overdue_receipt_checks: int
    duplicate_postings: int
    unexplained_difference: bool
    privacy_event: bool
    telemetry_available: bool

def decide(s: Signals) -> Mapping[str, str]:
    for key, value in vars(s).items():
        if key in {'unexplained_difference','privacy_event','telemetry_available'}:
            if type(value) is not bool:
                raise ValueError('invalid boolean signal')
        elif type(value) is not int or value < 0:
            raise ValueError('invalid aggregate signal')
    if s.reconciliation_unavailable > s.reconciliation_responses:
        raise ValueError('invalid reconciliation response counts')
    alerts = {}
    if s.duplicate_postings or s.unexplained_difference:
        alerts['ledger-integrity'] = 'halt'
    if s.privacy_event:
        alerts['privacy'] = 'halt'
    if not s.telemetry_available:
        alerts['telemetry-blind'] = 'page'
        return alerts
    if s.reconciliation_unavailable >= 5 or (
        s.reconciliation_responses >= 10
        and 10 * s.reconciliation_unavailable >= s.reconciliation_responses
    ):
        alerts['api-unavailable'] = 'page'
    if s.missed_jobs >= 3:
        alerts['scheduler-dispatch'] = 'page'
    if s.queue_oldest_seconds >= 900:
        alerts['queue-age'] = 'page'
    if s.overdue_receipt_checks:
        alerts['receipt-coverage'] = 'page'
    return alerts

@dataclass(frozen=True)
class Transition:
    active: Mapping[str, str]
    notify: Mapping[str, str]


def advance(previous: Mapping[str, str], s: Signals) -> Transition:
    """A blind sample cannot resolve a prior incident; a quiet API lane cannot
    prove recovery. The inputs refer to one protected five-minute window."""
    detected = decide(s)
    active = dict(previous) if not s.telemetry_available else {}
    if s.reconciliation_responses < 10 and 'api-unavailable' in previous:
        active['api-unavailable'] = previous['api-unavailable']
    active.update(detected)
    return Transition(active, {k: v for k, v in detected.items() if previous.get(k) != v})
