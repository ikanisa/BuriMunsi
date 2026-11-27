"""Verify hash-bound, redacted physical carrier and Payments evidence for one release."""
import hashlib
import json
import re
import subprocess
from pathlib import Path

import release_readiness as gate

CHECK_SCOPE = 'physical_carrier_to_burimunsi_payment_allocation_and_statement'
STAGES = ('approval', 'original', 'payment', 'allocation', 'retry', 'statement', 'payer')
BINDINGS = ('source_commit', 'source_sha256', 'backend_sha256', 'profile_sha256', 'apk_sha256')


def source_commit(root):
    root = Path(root).resolve(strict=True)
    def git(*args):
        return subprocess.run(['git', '-C', str(root), *args], check=True, capture_output=True,
                              timeout=20, text=True).stdout.strip()
    gate._need(Path(git('rev-parse', '--show-toplevel')).resolve() == root and
               not git('status', '--porcelain', '--untracked-files=all', '--', 'native/burimunsi', 'vendor/receiver-compat'),
               'STANDALONE_SOURCE_COMMIT_UNBOUND')
    value = git('rev-parse', '--verify', 'HEAD^{commit}')
    gate._need(re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', value), 'STANDALONE_COMMIT_WRONG')
    return value


def binding_hash(binding):
    gate._keys(binding, BINDINGS)
    gate._need(type(binding['source_commit']) is str and re.fullmatch(r'(?:[a-f0-9]{40}|[a-f0-9]{64})', binding['source_commit']),
               'STANDALONE_COMMIT_WRONG')
    for field in ('source_sha256', 'backend_sha256', 'profile_sha256'):
        gate._digest(binding[field])
    gate._keys(binding['apk_sha256'], ('staff', 'internal_receiver'))
    for value in binding['apk_sha256'].values():
        gate._digest(value)
    gate._need(len(set(binding['apk_sha256'].values())) == 2, 'STANDALONE_ROLE_ARTIFACTS_WRONG')
    return hashlib.sha256(json.dumps(binding, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def check(value):
    gate._need(value, 'STANDALONE_PAYMENT_WITNESS_WRONG')


def integer(value, minimum=0):
    check(type(value) is int and value >= minimum)
    return value


def verify_case(facts, direction, now):
    approval, original, payment, allocation, retry, statement, payer = (facts[stage] for stage in STAGES)
    gate._keys(approval, ('group', 'member', 'instruction', 'operator', 'authorized', 'receipt_review_authorized', 'approved_at'))
    for field in ('group', 'member', 'instruction', 'operator'):
        gate._digest(approval[field])
    check(approval['authorized'] is True and approval['receipt_review_authorized'] is True)
    approved_at = gate._fresh(approval['approved_at'], now)
    gate._keys(original, ('capture', 'raw_id', 'body_sha256', 'group', 'reference', 'amount_rwf', 'direction', 'observed_at', 'payer_destination'))
    for field in ('raw_id', 'body_sha256', 'reference'):
        gate._digest(original[field])
    check(original['capture'] == 'physical_android_carrier_original' and original['group'] == approval['group'] and
          original['direction'] == direction and approved_at <= gate._fresh(original['observed_at'], now))
    integer(original['amount_rwf'], 1)
    if original['payer_destination'] is not None:
        gate._digest(original['payer_destination'])
    gate._keys(payment, ('table', 'id', 'raw_id', 'body_sha256', 'group', 'reference', 'amount_rwf', 'direction',
                         'version', 'allocation_state', 'matching_rows', 'unresolved_conflicts'))
    gate._digest(payment['id'])
    check(payment['table'] == 'burimunsi.payments' and payment['allocation_state'] == 'Unallocated' and
          integer(payment['matching_rows']) == 1 and integer(payment['unresolved_conflicts']) == 0 and
          integer(payment['amount_rwf'], 1) == original['amount_rwf'] and
          all(payment[k] == original[k] for k in ('group', 'reference', 'direction', 'raw_id', 'body_sha256')))
    version = integer(payment['version'], 1)
    gate._keys(allocation, ('payment', 'group', 'member_group', 'member', 'instruction', 'idempotency_key',
                            'expected_version', 'result_version', 'allocation_state'))
    gate._digest(allocation['idempotency_key'])
    check(allocation['payment'] == payment['id'] and allocation['group'] == allocation['member_group'] == payment['group'] and
          allocation['member'] == approval['member'] and allocation['instruction'] == approval['instruction'] and
          integer(allocation['expected_version']) == version and integer(allocation['result_version']) == version + 1 and
          allocation['allocation_state'] == 'Allocated')
    gate._keys(retry, ('payment', 'group', 'member', 'idempotency_key', 'expected_version', 'result_version', 'matching_allocations'))
    check(all(retry[k] == allocation[k] for k in ('payment', 'group', 'member', 'idempotency_key')) and
          integer(retry['expected_version']) == version and integer(retry['result_version']) == version + 1 and
          integer(retry['matching_allocations']) == 1)
    gate._keys(statement, ('payment', 'group', 'member', 'reference', 'amount_rwf', 'direction', 'matching_rows', 'other_member_rows'))
    check(statement['payment'] == payment['id'] and statement['member'] == approval['member'] and
          all(statement[k] == payment[k] for k in ('group', 'reference', 'direction')) and
          integer(statement['amount_rwf'], 1) == payment['amount_rwf'] and integer(statement['matching_rows']) == 1 and
          integer(statement['other_member_rows']) == 0)
    gate._keys(payer, ('payment', 'group', 'outcome', 'reason', 'destination', 'provider_delivery', 'notices_dispatched'))
    check(payer['payment'] == payment['id'] and payer['group'] == payment['group'])
    count = integer(payer['notices_dispatched'])
    if direction == 'outgoing':
        check((payer['outcome'], payer['reason'], payer['destination'], payer['provider_delivery'], count) ==
              ('not_applicable', 'outgoing', None, None, 0))
    elif payer['outcome'] == 'delivered':
        gate._digest(payer['provider_delivery'])
        check(payer['reason'] is None and original['payer_destination'] is not None and
              payer['destination'] == original['payer_destination'] and count == 1)
    else:
        check(payer['outcome'] == 'skipped' and payer['reason'] in ('unverified_destination', 'preferences_disabled') and
              payer['destination'] is None and payer['provider_delivery'] is None and count == 0 and
              (payer['reason'] != 'unverified_destination' or original['payer_destination'] is None))
    return original['raw_id'], payment['id'], allocation['idempotency_key']


def verify(doc, base, expected, now):
    gate._keys(doc, ('format', 'binding', 'cases'))
    check(doc['format'] == 'burimunsi.standalone.payment-journey.v1' and doc['binding'] == expected)
    binding = binding_hash(expected)
    gate._keys(doc['cases'], ('incoming', 'outgoing'))
    artifacts, paths, digests, cases = [], set(), set(), []
    for direction, refs in doc['cases'].items():
        gate._keys(refs, STAGES)
        facts = {}
        for stage in STAGES:
            ref = refs[stage]
            row, path = gate._ref(Path(base), ref)
            gate._keys(row, ('format', 'binding_sha256', 'direction', 'stage', 'facts'))
            check(row['format'] == 'burimunsi.standalone.payment-stage.v1' and row['binding_sha256'] == binding and
                  row['direction'] == direction and row['stage'] == stage and path not in paths and ref['sha256'] not in digests)
            paths.add(path)
            digests.add(ref['sha256'])
            facts[stage] = row['facts']
            artifacts.append({'check': direction + '_' + stage, 'path': str(path), 'sha256': ref['sha256']})
        cases.append(verify_case(facts, direction, now))
    check(all(len(set(column)) == len(cases) for column in zip(*cases)))
    return artifacts


def approval(doc, expected, now):
    gate._keys(doc, ('format', 'binding_sha256', 'approved', 'role', 'approver', 'approved_at'))
    check(doc['format'] == 'burimunsi.standalone.release-approval.v1' and
          doc['binding_sha256'] == binding_hash(expected) and doc['approved'] is True and
          doc['role'] == 'responsible_release_owner')
    gate._digest(doc['approver'])
    gate._fresh(doc['approved_at'], now)
