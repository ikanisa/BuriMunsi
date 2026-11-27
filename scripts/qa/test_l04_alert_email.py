from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, replace
from email.message import EmailMessage
from pathlib import Path
import smtplib
import tempfile
import unittest
from unittest.mock import Mock

from l04_alert_checkpoint import ingest, initialize, pending
from l04_alert_email import acknowledge_reply, deliver
from test_l04_alert_rules import BASE


class MailHandoff(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / 'checkpoint'
        initialize(self.path)
        ingest(self.path, 1800000000, asdict(replace(BASE, reconciliation_unavailable=5)))
        self.event = pending(self.path)[0]['id']
        self.relay = Mock()
        self.relay.send_message.return_value = {}
        self.sender = 'alerts@example.invalid'

    def send(self, role='primary'):
        return deliver(self.path, self.event, role, role + '@example.invalid', self.sender, self.relay)

    def reply(self, role, **overrides):
        msg = EmailMessage()
        for key, val in ({'From': role + '@example.invalid',
                         'In-Reply-To': f'<burimunsi.{self.event}.{role}@example.invalid>'} | overrides).items():
            msg[key] = val
        msg.set_content('I acknowledge this synthetic incident.')
        path = self.path.with_name(role + '.eml')
        path.write_bytes(msg.as_bytes())
        return acknowledge_reply(self.path, self.event, role, self.sender, path)

    def test_two_confirmations_and_private_reference(self):
        self.assertEqual(self.send(), 'relay_accepted')
        self.assertEqual(self.send('backup'), 'relay_accepted')
        self.assertEqual(self.reply('primary'), 1)
        self.assertEqual(self.reply('primary'), 1)
        self.assertEqual(len(pending(self.path)), 1)
        with self.assertRaises(ValueError):
            self.reply('backup', From='unrelated@example.invalid')
        with self.assertRaises(ValueError):
            self.reply('backup', **{'Auto-Submitted': 'auto-replied'})
        self.assertEqual(self.reply('backup'), 2)
        self.assertEqual(pending(self.path), [])

    def test_parallel_invocations_and_lost_response_do_not_resend(self):
        self.relay.send_message.side_effect = smtplib.SMTPServerDisconnected('synthetic')
        with ThreadPoolExecutor(2) as pool:
            self.assertEqual(list(pool.map(lambda _: self.send(), range(2))), ['unknown', 'unknown'])
        self.relay.send_message.assert_called_once()
        with self.assertRaises(ValueError):
            deliver(self.path, self.event, 'primary', 'new@example.invalid', self.sender, self.relay)
        self.relay.send_message.side_effect = None
        self.assertEqual(self.send('backup'), 'relay_accepted')
        self.assertEqual(len(pending(self.path)), 1)

    def test_definite_rejection_permits_explicit_retry(self):
        self.relay.send_message.side_effect = smtplib.SMTPDataError(550, b'synthetic')
        self.assertEqual(self.send(), 'rejected')
        self.relay.send_message.side_effect = None
        self.assertEqual(self.send(), 'relay_accepted')
        self.assertEqual(self.send(), 'relay_accepted')
        self.assertEqual(self.relay.send_message.call_count, 2)
