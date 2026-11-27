"""Local, offline L04 incident checkpoint. Accepts aggregate samples only.

The caller supplies a closed five-minute UTC window for the protected route,
and hands off each pending event using its stable ID as an idempotency key.
There is no telemetry collection, clock scheduling, alert delivery or live IO.
"""
import argparse
from contextlib import closing
from dataclasses import fields
from hashlib import sha256
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
from uuid import uuid4

from l04_alert_rules import Signals, advance

LIMIT = 8_192
PENDING_LIMIT = 256
MAX_EPOCH = 253_402_300_799
MAX_COUNTER = 2**53 - 1
SCHEMA_VERSION = 1
FIELDS = {f.name for f in fields(Signals)}


def _private(path, kind):
    s = path.lstat()
    if (s.st_uid != os.getuid() or s.st_mode & 0o077
            or not kind(s.st_mode)):
        raise ValueError('checkpoint requires private owned storage')


def _storage(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('checkpoint requires absolute path')
    _private(path.parent, stat.S_ISDIR)
    return path


def _connect(path, *, readonly=False):
    p = _storage(path)
    _private(p, stat.S_ISREG)
    return sqlite3.connect(p.as_uri() + ('?mode=ro' if readonly else '?mode=rw'), uri=True, timeout=3)


def initialize(path):
    p = _storage(path)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    # Leave any incomplete initialization in place after failure. Never
    # silently replace an existing checkpoint or notification backlog.
    with closing(_connect(p)) as db, db:
        db.executescript("""
            BEGIN IMMEDIATE;
            CREATE TABLE checkpoint(id INTEGER PRIMARY KEY CHECK(id=1),
                window_end INTEGER, input_digest TEXT);
            INSERT INTO checkpoint(id) VALUES(1);
            CREATE TABLE episode(category TEXT PRIMARY KEY, severity TEXT NOT NULL);
            CREATE TABLE pending(seq INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE, category TEXT NOT NULL,
                severity TEXT NOT NULL, window_end INTEGER NOT NULL);
            PRAGMA user_version=1;
            COMMIT;
        """)


def _verify(db):
    if db.execute('PRAGMA user_version').fetchone() != (SCHEMA_VERSION,):
        raise ValueError('unknown or incomplete checkpoint')


def _sample(window_end, data):
    if (type(window_end) is not int or not 0 < window_end <= MAX_EPOCH
            or window_end % 300):
        raise ValueError('invalid UTC five-minute window end')
    if type(data) is not dict or data.keys() != FIELDS:
        raise ValueError('expected aggregate fields only')
    for value in data.values():
        if type(value) not in (bool, int) or not 0 <= value <= MAX_COUNTER:
            raise ValueError('invalid aggregate')
    return Signals(**data), sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def ingest(path, window_end, data):
    sample, digest = _sample(window_end, data)
    with closing(_connect(path)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        _verify(db)
        previous_end, previous_digest = db.execute(
            'SELECT window_end,input_digest FROM checkpoint WHERE id=1').fetchone()
        if previous_end is not None and window_end <= previous_end:
            if window_end == previous_end and digest == previous_digest:
                return {'status': 'duplicate', 'new': 0}
            raise ValueError('stale or conflicting window')
        if previous_end is not None and window_end != previous_end + 300:
            raise ValueError('gap; enter missing windows as telemetry unavailable')
        previous = dict(db.execute('SELECT category,severity FROM episode'))
        result = advance(previous, sample)
        pending_count = db.execute('SELECT count(*) FROM pending').fetchone()[0]
        if pending_count + len(result.notify) > PENDING_LIMIT:
            raise ValueError('outbox full; preserve the sample and review pending events')
        db.execute('DELETE FROM episode')
        db.executemany('INSERT INTO episode VALUES(?,?)', result.active.items())
        db.executemany(
            'INSERT INTO pending(event_id,category,severity,window_end) VALUES(?,?,?,?)',
            ((uuid4().hex, k, v, window_end) for k, v in result.notify.items()))
        db.execute('UPDATE checkpoint SET window_end=?,input_digest=? WHERE id=1',
                   (window_end, digest))
        return {'status': 'accepted', 'new': len(result.notify)}


def pending(path):
    with closing(_connect(path)) as db:
        _verify(db)
        return [dict(zip(('id', 'category', 'severity', 'window_end'), row))
                for row in db.execute('SELECT event_id,category,severity,window_end '
                                      'FROM pending ORDER BY seq')]


def status(path):
    with closing(_connect(path)) as db, db:
        db.execute('BEGIN')
        _verify(db)
        last = db.execute('SELECT window_end FROM checkpoint WHERE id=1').fetchone()[0]
        count = db.execute('SELECT count(*) FROM pending').fetchone()[0]
        return {'last_window_end': last, 'pending_count': count}


def incidents(path):
    """Report open incidents and delivery backlog from one read snapshot."""
    with closing(_connect(path, readonly=True)) as db, db:
        db.execute('BEGIN')
        _verify(db)
        last = db.execute('SELECT window_end FROM checkpoint WHERE id=1').fetchone()[0]
        active = dict(db.execute('SELECT category,severity FROM episode'))
        backlog = dict(db.execute('SELECT category,count(*) FROM pending GROUP BY category'))
        return {'last_window_end': last, 'open_incidents': active,
                'pending_by_category': backlog}


def acknowledge(path, event_id):
    """Record a verified transport handoff once. Operator replies retire the event."""
    if (type(event_id) is not str or len(event_id) != 32
            or any(c not in '0123456789abcdef' for c in event_id)):
        raise ValueError('invalid event ID')
    with closing(_connect(path)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        _verify(db)
        # Existing version-one checkpoints acquire this receipt table on first use.
        db.execute('CREATE TABLE IF NOT EXISTS transport_handoff '
                   '(event_id TEXT PRIMARY KEY NOT NULL, recorded_utc TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
        return db.execute('INSERT OR IGNORE INTO transport_handoff(event_id) '
                          'SELECT event_id FROM pending WHERE event_id=?', (event_id,)).rowcount == 1


def _unique_pairs(pairs):
    out = {}
    for key, val in pairs:
        if key in out:
            raise ValueError('duplicate JSON field')
        out[key] = val
    return out


def main():
    arg = argparse.ArgumentParser(description=__doc__)
    arg.add_argument('checkpoint', type=Path)
    action = arg.add_subparsers(dest='action', required=True)
    action.add_parser('init')
    action.add_parser('pending')
    action.add_parser('status')
    action.add_parser('incidents')
    action.add_parser('ingest').add_argument('window_end_utc', type=int)
    action.add_parser('ack').add_argument('event_id')
    args = arg.parse_args()
    try:
        if args.action == 'init':
            initialize(args.checkpoint)
            result = {'status': 'initialized'}
        elif args.action == 'pending':
            result = {'pending': pending(args.checkpoint)}
        elif args.action == 'status':
            result = status(args.checkpoint)
        elif args.action == 'incidents':
            result = incidents(args.checkpoint)
        elif args.action == 'ack':
            result = {'transport_handoff_added': acknowledge(args.checkpoint, args.event_id)}
        else:
            raw = sys.stdin.buffer.read(LIMIT + 1)
            if len(raw) > LIMIT:
                raise ValueError('sample too large')
            result = ingest(args.checkpoint, args.window_end_utc,
                            json.loads(raw, object_pairs_hook=_unique_pairs))
    except (OSError, ValueError, sqlite3.Error, TypeError, RecursionError):
        # Avoid reflecting malformed or mistakenly supplied input in process logs.
        print('checkpoint operation refused; verify private storage and aggregate input',
              file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
