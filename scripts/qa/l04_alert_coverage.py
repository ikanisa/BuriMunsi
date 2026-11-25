"""Construct L04 input only if independent ingress and invocation counts agree.

This is an offline input gate. It does not obtain or attest to live telemetry.
"""
from l04_alert_adapter import PROTECTED, WATCH, _count, _flag, _shape, adapt

BUCKET = {'responses', 'http_503'}
SOURCE = BUCKET | {'complete', 'path_verified', 'malformed'}
ROUTE = 'POST /v1/burimunsi/sms/observations/reconcile-batch'


def _source(record):
    _shape(record, SOURCE)
    n = _count(record['responses'])
    failures = _count(record['http_503'])
    malformed = _count(record['malformed'])
    complete = _flag(record['complete'])
    path = _flag(record['path_verified'])
    if failures > n:
        raise ValueError('invalid route counts')
    return (n, failures) if complete and path and malformed == 0 else None


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
    if report['health'] is not None:
        _shape(report['health'], WATCH)
        for v in report['health'].values():
            _count(v)
    ingress = None if report['ingress'] is None else _source(report['ingress'])
    invocations = None if report['invocations'] is None else _source(report['invocations'])
    if ingress is not None and ingress == invocations and report['health'] is not None:
        data['telemetry'] = {**report['health'], 'operations': {
            PROTECTED: dict(zip(('responses', 'http_503'), ingress))}}
    adapt(data, now)
    return data
