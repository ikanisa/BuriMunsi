"""Offline L04 alert decision example. No network, credentials or real records."""
from collections.abc import Mapping
from dataclasses import dataclass

@dataclass(frozen=True)
class Signals:
    responses: int
    unavailable: int
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
    if s.unavailable > s.responses:
        raise ValueError('invalid response counts')
    alerts = {}
    if s.duplicate_postings or s.unexplained_difference:
        alerts['ledger-integrity'] = 'halt'
    if s.privacy_event:
        alerts['privacy'] = 'halt'
    if not s.telemetry_available:
        alerts['telemetry-blind'] = 'page'
        return alerts
    if s.unavailable >= 5 or (s.responses >= 10 and 10 * s.unavailable >= s.responses):
        alerts['api-unavailable'] = 'page'
    if s.missed_jobs >= 3:
        alerts['scheduler-dispatch'] = 'page'
    if s.queue_oldest_seconds >= 900:
        alerts['queue-age'] = 'page'
    if s.overdue_receipt_checks:
        alerts['receipt-coverage'] = 'page'
    return alerts

def newly_open(previous: Mapping[str, str], current: Mapping[str, str]) -> dict:
    return {k: v for k, v in current.items() if previous.get(k) != v}
