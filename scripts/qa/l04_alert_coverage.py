"""Construct L04 input only if independent ingress and invocation counts agree.

This is an offline input gate. It does not obtain or attest to live telemetry.
"""
from l04_alert_adapter import PROTECTED, WATCH, _count, _flag, _shape, adapt

BUCKET = {'responses', 'http_503'}
WINDOW = {'window_start', 'window_end'}
SOURCE = BUCKET | WINDOW | {'route', 'complete', 'path_verified', 'malformed'}
HEALTH = WINDOW | {'counters', 'complete'}
ROUTE = 'POST /v1/burimunsi/sms/observations/reconcile-batch'


def _matches_window(record, window):
    start, end = (record[key] for key in ('window_start', 'window_end'))
    if type(start) is not int or type(end) is not int or start < 0 or end - start != 300 or end % 300:
        raise ValueError('invalid evidence window')
    return (start, end) == window


def _source(record, window):
    _shape(record, SOURCE)
    n = _count(record['responses'])
    failures = _count(record['http_503'])
    malformed = _count(record['malformed'])
    complete = _flag(record['complete'])
    path = _flag(record['path_verified'])
    same_window = _matches_window(record, window)
    if type(record['route']) is not str:
        raise ValueError('invalid evidence route')
    if failures > n:
        raise ValueError('invalid route counts')
    return (n, failures) if (same_window and record['route'] == ROUTE
                              and complete and path and malformed == 0) else None


def _health(record, window):
    _shape(record, HEALTH)
    _shape(record['counters'], WATCH)
    counters = {key: _count(value) for key, value in record['counters'].items()}
    same_window = _matches_window(record, window)
    complete = _flag(record['complete'])
    return counters if same_window and complete else None


def build(report, now):
    """Ingress means responses at the client-facing boundary. Invocation
    logs alone can omit failures that happened before function execution."""
    _shape(report, {'window_start', 'window_end', 'route', 'ingress',
                    'invocations', 'health', 'incidents'})
    if report['route'] != ROUTE:
        raise ValueError('wrong integration route')
    data = dict(version=1, window_start=report['window_start'],
                window_end=report['window_end'], incidents=report['incidents'],
                telemetry=None)
    window = (report['window_start'], report['window_end'])
    health = None if report['health'] is None else _health(report['health'], window)
    ingress = None if report['ingress'] is None else _source(report['ingress'], window)
    invocations = None if report['invocations'] is None else _source(report['invocations'], window)
    if ingress is not None and ingress == invocations and health is not None:
        data['telemetry'] = {**health, 'operations': {
            PROTECTED: dict(zip(('responses', 'http_503'), ingress))}}
    adapt(data, now)
    return data
