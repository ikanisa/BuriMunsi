"""Deliver one pending L04 event to a configured primary and backup over TLS SMTP."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
from email import policy
from email.headerregistry import Address
from email.message import EmailMessage
from email.parser import BytesHeaderParser
import hashlib
import os
from pathlib import Path
import smtplib
import ssl
import sys

from l04_alert_checkpoint import _connect, _verify


def mailbox(value):
    address = Address(addr_spec=value)
    if not address.username or not address.domain or any(c.isspace() for c in value):
        raise ValueError('invalid mailbox')
    return address.addr_spec


def deliver(path, event_id, role, recipient, sender, relay):
    if role not in ('primary', 'backup'):
        raise ValueError('unknown on-call role')
    key = hashlib.sha256(recipient.encode()).hexdigest()
    # Reserve before handing any bytes to the transport. A crash after DATA
    # cannot establish whether the relay accepted the original message.
    with closing(_connect(path)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        _verify(db)
        event = db.execute('SELECT category,severity,window_end FROM pending WHERE event_id=?',
                           (event_id,)).fetchone()
        if event is None:
            raise ValueError('unknown pending incident')
        db.execute('CREATE TABLE IF NOT EXISTS mail_handoff (event_id TEXT, role TEXT, '
                   'destination_sha256 TEXT NOT NULL, state TEXT NOT NULL, '
                   'PRIMARY KEY(event_id,role))')
        prior = db.execute('SELECT destination_sha256,state FROM mail_handoff WHERE event_id=? AND role=?',
                           (event_id, role)).fetchone()
        if prior is not None:
            if prior[0] != key:
                raise ValueError('the original handoff has a different recipient')
            return prior[1]
        if db.execute('SELECT 1 FROM mail_handoff WHERE event_id=? AND destination_sha256=?',
                      (event_id, key)).fetchone():
            raise ValueError('two distinct operators required')
        message = EmailMessage()
        message['From'], message['To'] = sender, recipient
        message['Message-ID'] = f'<burimunsi.{event_id}.{role}@{Address(addr_spec=sender).domain}>'
        message['Subject'] = f'BuriMunsi {event[1]} · {event[0]}'
        utc = datetime.fromtimestamp(event[2], timezone.utc).isoformat()
        message.set_content(f'Incident {event_id}\nCategory {event[0]}\nSeverity {event[1]}\n'
                            f'Window ended {utc}\n\nPlease acknowledge this incident in the private on-call channel.')
        db.execute('INSERT INTO mail_handoff VALUES (?,?,?,?)', (event_id, role, key, 'unknown'))
    try:
        outcome = 'rejected' if relay.send_message(message) else 'relay_accepted'
    except (smtplib.SMTPRecipientsRefused, smtplib.SMTPSenderRefused, smtplib.SMTPDataError):
        # A definitive negative SMTP reply permits a later explicit retry.
        outcome = 'rejected'
    except (OSError, smtplib.SMTPException):
        return 'unknown'
    with closing(_connect(path)) as db, db:
        if outcome == 'rejected':
            db.execute('DELETE FROM mail_handoff WHERE event_id=? AND role=?', (event_id, role))
        else:
            db.execute('UPDATE mail_handoff SET state=? WHERE event_id=? AND role=?',
                       (outcome, event_id, role))
    return outcome


def acknowledge_reply(path, event_id, role, sender, original):
    """File a reviewed affirmative reply exported from the private recipient mailbox."""
    with original.open('rb') as f:
        raw = f.read(2_000_001)
    if len(raw) > 2_000_000 or role not in ('primary', 'backup'):
        raise ValueError('invalid private receipt')
    headers = BytesHeaderParser(policy=policy.default).parsebytes(raw)
    expected = f'<burimunsi.{event_id}.{role}@{Address(addr_spec=sender).domain}>'
    if (headers.get_all('In-Reply-To') != [expected] or len(headers.get_all('From', [])) != 1
            or len(headers['From'].addresses) != 1 or headers['From'].defects
            or headers.get('Auto-Submitted', 'no').lower() != 'no'):
        raise ValueError('reply does not match the original handoff')
    address = headers['From'].addresses[0].addr_spec
    key = hashlib.sha256(address.encode()).hexdigest()
    proof = hashlib.sha256(raw).hexdigest()
    with closing(_connect(path)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        _verify(db)
        row = db.execute('SELECT destination_sha256 FROM mail_handoff WHERE event_id=? AND role=?',
                         (event_id, role)).fetchone()
        if not row or row[0] != key:
            raise ValueError('reply does not match the designated operator')
        db.execute('CREATE TABLE IF NOT EXISTS mail_ack (event_id TEXT, role TEXT, '
                   'reply_sha256 TEXT UNIQUE, PRIMARY KEY(event_id,role))')
        previous = db.execute('SELECT reply_sha256 FROM mail_ack WHERE event_id=? AND role=?',
                              (event_id, role)).fetchone()
        if previous and previous[0] != proof:
            raise ValueError('the original acknowledgement is already recorded')
        if not previous:
            db.execute('INSERT INTO mail_ack VALUES(?,?,?)', (event_id, role, proof))
        count = db.execute("""
            SELECT count(DISTINCT h.destination_sha256)
            FROM mail_ack a JOIN mail_handoff h USING(event_id,role)
            WHERE a.event_id=? AND a.role IN ('primary','backup') AND a.reply_sha256 IS NOT NULL
        """, (event_id,)).fetchone()[0]
        if count == 2:
            db.execute('DELETE FROM pending WHERE event_id=?', (event_id,))
    return count


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('checkpoint')
    p.add_argument('event_id', help='Stable ID from the private checkpoint pending list')
    p.add_argument('--ack', choices=['primary','backup'], help='File an operator-confirmed reply')
    p.add_argument('--reply', type=Path, help='Verified original email from the private mailbox')
    a = p.parse_args()
    try:
        sender = mailbox(os.environ['BURI_ALERT_FROM'])
        if a.ack or a.reply:
            if not (a.ack and a.reply):
                raise ValueError('provide both the role and its original reply')
            count = acknowledge_reply(a.checkpoint, a.event_id, a.ack, sender, a.reply)
            print(f'{count} of 2 operator acknowledgements recorded.')
            return 0
        primary, backup = (mailbox(os.environ['BURI_ALERT_' + k]) for k in ('PRIMARY', 'BACKUP'))
        if primary.casefold() == backup.casefold():
            raise ValueError('two distinct operators required')
        outcomes = {}
        for role, address in [('primary', primary), ('backup', backup)]:
            try:
                with smtplib.SMTP_SSL(os.environ['BURI_ALERT_SMTP_HOST'],
                                      int(os.environ.get('BURI_ALERT_SMTP_PORT', 465)),
                                      timeout=12, context=ssl.create_default_context()) as smtp:
                    if 'BURI_ALERT_SMTP_USER' in os.environ:
                        smtp.login(os.environ['BURI_ALERT_SMTP_USER'], os.environ['BURI_ALERT_SMTP_PASSWORD'])
                    outcomes[role] = deliver(a.checkpoint, a.event_id, role, address, sender, smtp)
            except (OSError, smtplib.SMTPException):
                outcomes.setdefault(role, 'connection_failed')
        for role, state in outcomes.items():
            print(role, state)
        return 0 if all(s == 'relay_accepted' for s in outcomes.values()) else 3
    except Exception:
        print('Private handoff incomplete. Check the original incident and relay records.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
