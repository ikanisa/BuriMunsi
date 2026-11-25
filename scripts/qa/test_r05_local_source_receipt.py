from pathlib import Path
import json
from subprocess import CompletedProcess, TimeoutExpired
from tempfile import TemporaryDirectory
from unittest import TestCase
from r05_local_source_receipt import qualify, save


class ReceiptTests(TestCase):
    def test_keeps_pass_fail_blocked_and_never_claims_hosted_checks(self):
        calls = []
        def run(argv, root):
            calls.append(argv)
            if len(calls) == 3:
                raise TimeoutExpired(argv, 120)
            return CompletedProcess(argv, len(calls)-1, stdout=b'never record test output')

        r = qualify(Path('.'), run=run, identify=lambda _: '0'*40)
        self.assertEqual(r['result']['source'], 'PASS')
        self.assertEqual(r['result']['design'], 'FAIL')
        self.assertEqual(r['result']['offline-alerts'], 'BLOCKED')
        self.assertTrue(all(r['result'][k] == 'NOT RUN' for k in ('hosted-ci', 'admin', 'android')))
        self.assertNotIn('never record', json.dumps(r))

    def test_refuses_changed_worktree(self):
        counter = iter(("a", "b"))
        with self.assertRaises(ValueError):
            qualify(Path('.'), run=lambda argv, root: CompletedProcess(argv, 0),
                    identify=lambda _: next(counter))
    def test_private_non_overwriting_receipt(self):
        with TemporaryDirectory() as tmp:
            p = Path(tmp) / 'result.json'
            save(p, {'test': 'passed'})
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                save(p, {'test': 'different'})
            self.assertEqual(json.loads(p.read_text()), {'test': 'passed'})
            self.assertEqual(list(Path(tmp).iterdir()), [p])
