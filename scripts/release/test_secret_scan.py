import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import secret_scan as scan


class ReviewedHistory(unittest.TestCase):
    def setUp(self):
        storage = tempfile.TemporaryDirectory()
        self.addCleanup(storage.cleanup)
        self.root = Path(storage.name)
        self.commit, self.tree = 'a' * 40, 'b' * 40
        self.hit = {'Commit': self.commit, 'File': 'sample.txt', 'RuleID': 'example',
                    'StartLine': 2, 'EndLine': 2, 'Secret': 'synthetic', 'Match': 'a synthetic marker'}
        review = {'reviewedSource': self.commit, 'reviewedTree': self.tree, 'scannerVersion': scan.VERSION,
                  'policySha256': hashlib.sha256(scan.POLICY).hexdigest(),
                  'commitDigests': scan.history_group_digests([self.hit])}
        directory = self.root / 'scripts/release'
        directory.mkdir(parents=True)
        (directory / 'reviewed-history.json').write_text(json.dumps(review))

    def verify(self, findings, code=19, tree=None):
        with patch.object(scan, 'ROOT', self.root), patch.object(
                scan, 'git_output', side_effect=[self.commit.encode(), (tree or self.tree).encode()]):
            scan.verify_history_report(json.dumps(findings).encode(), code, self.root, {})

    def test_exact_private_disposition_and_duplicate_observation(self):
        self.verify([self.hit])
        self.verify([self.hit, self.hit])

    def test_changed_and_additional_observations_block(self):
        for field, value in [('Secret', 'different'), ('Match', 'a different span'),
                             ('Commit', 'c' * 40), ('StartLine', 1), ('EndLine', 4),
                             ('File', 'other.txt'), ('RuleID', 'other')]:
            with self.subTest(field=field), self.assertRaises(scan.Refused):
                self.verify([self.hit, {**self.hit, field: value}])

    def test_missing_observation_wrong_tree_and_exit_mismatch_block(self):
        with self.assertRaises(scan.Refused):
            self.verify([], 0)
        with self.assertRaises(scan.Refused):
            self.verify([self.hit], tree='d' * 40)
        with self.assertRaises(scan.Refused):
            self.verify([self.hit], 0)
