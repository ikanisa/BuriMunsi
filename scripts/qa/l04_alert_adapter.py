"""Convert a closed, aggregate monitoring window into an offline L04 sample.

This boundary has no log fetcher, credentials, endpoint calls or alert delivery.
An exporter must establish completeness; use null when it cannot.
"""
import argparse
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

from l04_alert_checkpoint import LIMIT, MAX_COUNTER, MAX_EPOCH, _unique_pairs, ingest


# Contract operation for POST /v1/burimunsi/sms/observations/reconcile-batch.
# Legacy reconcile, status polling and unrelated API traffic are not included.
PROTECTED = 'observationReconcileBatch'
WATCH = {'missed_jobs', 'queue_oldest_seconds', 'overdue_receipt_checks'}
HARD = {'duplicate_postings', 'unexplained_difference', 'privacy_event'}


def _shape(record, expected):
    if type(record) is not dict or record.keys() != expected:
        raise ValueError('unexpected aggregate shape')


def _count(value):
    if type(value) is not int or not 0 <= value <= MAX_COUNTER:
        raise ValueError('invalid aggregate count')
    return value


def _flag(value):
    if type(value) is not bool:
        raise ValueError('invalid aggregate flag')
    return value


def adapt(envelope, now):
    _shape(envelope, {'version', 'window_start', 'window_end', 'telemetry', 'incidents'})
    if type(envelope['version']) is not int or envelope['version'] != 1:
        raise ValueError('unknown input version')
    start, end = envelope['window_start'], envelope['window_end']
    if (type(start) is not int or type(end) is not int or start < 0
            or not 0 < end <= min(MAX_EPOCH, now) or end % 300 or end - start != 300):
        raise ValueError('invalid or still-open window')

    incidents = envelope['incidents']
    _shape(incidents, HARD)
    sample = {key: _flag(incidents[key]) for key in HARD - {'duplicate_postings'}}
    sample['duplicate_postings'] = _count(incidents['duplicate_postings'])
    telemetry = envelope['telemetry']
    sample['telemetry_available'] = telemetry is not None
    if telemetry is None:
        sample.update(dict.fromkeys(WATCH | {'reconciliation_responses',
                                            'reconciliation_unavailable'}, 0))
        return end, sample
    _shape(telemetry, WATCH | {'operations'})
    sample.update({key: _count(telemetry[key]) for key in WATCH})
    operations = telemetry['operations']
    if (type(operations) is not dict or not 1 <= len(operations) <= 64
            or PROTECTED not in operations):
        raise ValueError('expected explicit protected route bucket')
    for label, row in operations.items():
        if type(label) is not str or not re.fullmatch('[A-Za-z][A-Za-z0-9]{0,63}', label):
            raise ValueError('invalid route operation label')
        _shape(row, {'responses', 'http_503'})
        if _count(row['http_503']) > _count(row['responses']):
            raise ValueError('invalid response counts')
    sample['reconciliation_responses'] = operations[PROTECTED]['responses']
    sample['reconciliation_unavailable'] = operations[PROTECTED]['http_503']
    return end, sample


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('checkpoint', type=Path)
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(LIMIT + 1)
        if len(raw) > LIMIT:
            raise ValueError('sample too large')
        end, sample = adapt(json.loads(raw, object_pairs_hook=_unique_pairs), time.time())
        result = ingest(args.checkpoint, end, sample)
    except (OSError, ValueError, sqlite3.Error, TypeError, RecursionError):
        print('aggregate window refused; verify source coverage and checkpoint',
              file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
