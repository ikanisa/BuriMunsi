"""Only synthetic carrier, authorization, payment and release evidence is used here."""
import copy
import datetime as dt
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
import production_qualification_test as historical

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS.parents[2] / 'scripts'))
import qualify_production as q
import release_guard
import standalone_payments as payments


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class StandaloneRelease(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name).resolve()
        self.now = dt.datetime.now(dt.timezone.utc)
        self.binding = {'source_commit': '1' * 40, 'source_sha256': digest('native'), 'backend_sha256': digest('backend'),
                        'profile_sha256': digest('profile'), 'apk_sha256': {r: digest(r) for r in ('staff', 'internal_receiver')}}
        self.pin = payments.binding_hash(self.binding)
        self.cases = {d: self.case(d) for d in ('incoming', 'outgoing')}

    def case(self, direction):
        incoming = direction == 'incoming'
        group, member = digest('group'), digest('member')
        raw, payment, key, reference = (digest(direction + s) for s in ('raw', 'payment', 'key', 'reference'))
        original = {'capture': 'physical_android_carrier_original', 'raw_id': raw, 'body_sha256': digest(direction),
                    'group': group, 'reference': reference, 'amount_rwf': 1234, 'direction': direction,
                    'observed_at': self.now.isoformat(), 'payer_destination': digest('payer') if incoming else None}
        allocation = {'payment': payment, 'group': group, 'member_group': group, 'member': member,
                      'instruction': digest('instruction'), 'idempotency_key': key, 'expected_version': 1,
                      'result_version': 2, 'allocation_state': 'Allocated'}
        return {'approval': {'group': group, 'member': member, 'instruction': digest('instruction'), 'operator': digest('operator'),
                             'authorized': True, 'receipt_review_authorized': True, 'approved_at': self.now.isoformat()},
                'original': original,
                'payment': {**{k: original[k] for k in ('raw_id', 'body_sha256', 'group', 'reference', 'amount_rwf', 'direction')},
                            'table': 'burimunsi.payments', 'id': payment, 'version': 1, 'allocation_state': 'Unallocated',
                            'matching_rows': 1, 'unresolved_conflicts': 0},
                'allocation': allocation,
                'retry': {**{k: allocation[k] for k in ('payment', 'group', 'member', 'idempotency_key', 'expected_version', 'result_version')},
                          'matching_allocations': 1},
                'statement': {'payment': payment, 'group': group, 'member': member, 'reference': reference, 'amount_rwf': 1234,
                              'direction': direction, 'matching_rows': 1, 'other_member_rows': 0},
                'payer': {'payment': payment, 'group': group, 'outcome': 'delivered' if incoming else 'not_applicable',
                          'reason': None if incoming else 'outgoing', 'destination': original['payer_destination'],
                          'provider_delivery': digest('carrier-readback') if incoming else None, 'notices_dispatched': int(incoming)}}

    def ref(self, name, doc):
        raw = json.dumps(doc).encode()
        path = self.base / name
        path.write_bytes(raw)
        return {'path': name, 'sha256': hashlib.sha256(raw).hexdigest()}

    def witness(self):
        cases = {d: {stage: self.ref(d + '-' + stage + '.json', {'format': 'burimunsi.standalone.payment-stage.v1',
                    'binding_sha256': self.pin, 'direction': d, 'stage': stage, 'facts': facts})
                    for stage, facts in stages.items()} for d, stages in self.cases.items()}
        return {'format': 'burimunsi.standalone.payment-journey.v1', 'binding': self.binding, 'cases': cases}

    def test_exact_standalone_and_historical_product_policies(self):
        current = release_guard.policy('BuriMunsi-standalone', 'promotion')
        old = release_guard.policy('BuriMunsi', 'promotion')
        self.assertEqual(current['artifact_ids'], old['artifact_ids'])
        self.assertEqual(current['requirements']['phone_journeys'], payments.CHECK_SCOPE)
        self.assertEqual(old['requirements']['canonical_writer'], 'real_collect_ledger')
        self.assertNotEqual(current['requirements']['canonical_writer'], old['requirements']['canonical_writer'])
        receipt = self.witness()
        self.assertEqual(len(payments.verify(receipt, self.base, self.binding, self.now)), 14)
        altered = copy.deepcopy(self.binding)
        altered['apk_sha256']['staff'] = digest('another release')
        with self.assertRaises(ValueError):
            payments.verify(receipt, self.base, altered, self.now)
        (self.base / 'incoming-original.json').write_bytes(b'{}')
        with self.assertRaises(ValueError):
            payments.verify(receipt, self.base, self.binding, self.now)

    def test_independently_pinned_negative_cases(self):
        changes = [('approval','authorized',False),('original','capture','emulator'),('payment','table','app.ledger'),
                   ('payment','raw_id',digest('another original')),('payment','unresolved_conflicts',1),
                   ('allocation','member_group',digest('another group')),('allocation','expected_version',2),
                   ('retry','idempotency_key',digest('rekey')),('retry','matching_allocations',2),
                   ('statement','other_member_rows',1),('statement','amount_rwf',12),
                   ('payer','outcome','gateway_accepted'),('payer','destination',digest('member phone'))]
        for stage, field, value in changes:
            with self.subTest(stage=stage, field=field):
                old = self.cases['incoming'][stage][field]
                self.cases['incoming'][stage][field] = value
                with self.assertRaises(ValueError):
                    payments.verify(self.witness(), self.base, self.binding, self.now)
                self.cases['incoming'][stage][field] = old
        self.cases['outgoing']['payer']['notices_dispatched'] = 1
        with self.assertRaises(ValueError):
            payments.verify(self.witness(), self.base, self.binding, self.now)

    def test_authorized_skip_and_release_owner_approval_are_bound(self):
        item = self.cases['incoming']
        item['original']['payer_destination'] = None
        item['payer'].update(outcome='skipped', reason='unverified_destination', destination=None, provider_delivery=None, notices_dispatched=0)
        self.assertEqual(len(payments.verify(self.witness(), self.base, self.binding, self.now)), 14)
        auth = {'format':'burimunsi.standalone.release-approval.v1', 'binding_sha256':self.pin, 'approved':True,
                'role':'responsible_release_owner', 'approver':digest('owner'), 'approved_at':self.now.isoformat()}
        payments.approval(auth, self.binding, self.now)
        with self.assertRaises(ValueError):
            payments.approval({**auth, 'approved': False}, self.binding, self.now)
        with self.assertRaises(ValueError):
            payments.approval({**auth, 'binding_sha256': digest('other APKs')}, self.binding, self.now)

    def test_signed_role_upgrade_and_standalone_witness_pass_through_native_qualification(self):
        # Reuse actual same-signer upgrade and independently designated APK fixtures.
        old = historical.ProductionQualification()
        old.setUp()
        self.addCleanup(old.doCleanups)
        self.base, self.now = old.base, old.now
        self.binding = {**old.binding, 'source_commit':'0' * 40}
        self.pin = payments.binding_hash(self.binding)
        self.cases = {d:self.case(d) for d in ('incoming','outgoing')}
        checks = {name:{'scope':scope, 'status':'PASS', 'evidence':[self.ref(name + '.json', {'executed':True})]}
                  for name, scope in q.STANDALONE_CHECKS.items() if name != 'installed_update'}
        checks['installed_update'] = old.doc['checks']['installed_update']
        checks['phone_journeys']['evidence'] = [self.ref('standalone-journey.json', self.witness())]
        auth = {'format':'burimunsi.standalone.release-approval.v1','binding_sha256':self.pin, 'approved':True,
                'role':'responsible_release_owner', 'approver':digest('owner'), 'approved_at':self.now.isoformat()}
        checks['operations_authorization']['evidence'] = [self.ref('release-owner.json', auth)]
        manifest = self.ref('uat-standalone.json', {'format':'burimunsi.standalone.production-uat.v1',
                            'checked_at':self.now.isoformat(), **self.binding, 'checks':checks})
        result = q.live_evidence(self.base / manifest['path'], manifest['sha256'], self.binding, self.now, mode='standalone')
        self.assertEqual(set(result['checks']),set(q.STANDALONE_CHECKS))
        self.assertEqual(len(result['artifacts']),len(q.STANDALONE_CHECKS)+14)

    def test_standalone_uat_refuses_a_legacy_only_manifest(self):
        path = self.base / 'legacy.json'
        path.write_text(json.dumps({'format':'collect.burimunsi.production-uat.v1', 'checks':q.CHECKS}))
        with self.assertRaises(ValueError):
            q.live_evidence(path, hashlib.sha256(path.read_bytes()).hexdigest(), self.binding, self.now, mode='standalone')


if __name__ == '__main__':
    unittest.main()
