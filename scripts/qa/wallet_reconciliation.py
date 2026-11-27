"""Compare a custodian's canonical payment export with an independent wallet statement."""
import argparse
import csv
import hashlib
import json
import os
import re
import sys
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


SCOPE = ('collection_id', 'receiving_account_id', 'provider')
COMMON = set(SCOPE) | {'currency', 'occurred_at', 'provider_reference', 'direction', 'amount_rwf'}
WALLET = COMMON | {'kind', 'fee_rwf', 'original_reference'}
CANONICAL = COMMON | {'allocation_state'}
WALLET_DAY_ZONE = ZoneInfo('Africa/Kigali')


def instant(value):
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise ValueError('invalid cutoff or event time') from None
    if dt.tzinfo is None:
        raise ValueError('cutoffs and event times must include the UTC offset')
    return dt.astimezone(timezone.utc)


def rwf(value, *, signed=False):
    if not re.fullmatch(r'-?[0-9]{1,30}' if signed else r'[0-9]{1,30}', value):
        raise ValueError('expected a whole amount in RWF')
    return int(value)


def file_hash(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1048576), b''):
            h.update(block)
    return h.hexdigest()


def read_entries(path, columns, scope, start, end):
    with path.open(encoding='utf-8-sig', newline='') as source:
        reader = csv.DictReader(source, strict=True)
        if set(reader.fieldnames or ()) != columns or len(reader.fieldnames) != len(columns):
            raise ValueError('incorrect or duplicated CSV headers')
        for row in reader:
            if None in row or None in row.values():
                raise ValueError(f'incorrect column count at line {reader.line_num}')
            if tuple(row[k] for k in SCOPE) != scope or row['currency'] != 'RWF':
                raise ValueError(f'wrong wallet, provider, group or currency at line {reader.line_num}')
            if row['direction'] not in ('incoming', 'outgoing'):
                raise ValueError(f'invalid direction at line {reader.line_num}')
            row['amount_rwf'] = rwf(row['amount_rwf'])
            if row['amount_rwf'] == 0:
                raise ValueError(f'zero movement at line {reader.line_num}')
            occurred = instant(row['occurred_at']) if row['occurred_at'] else None
            row['wallet_day'] = occurred.astimezone(WALLET_DAY_ZONE).date() if occurred else None
            if occurred is not None:
                if not start <= occurred < end:
                    raise ValueError(f'event outside the stated cutoff at line {reader.line_num}')
            elif columns == WALLET:
                raise ValueError(f'missing wallet event time at line {reader.line_num}')
            if columns == WALLET:
                kind = row['kind']
                if kind not in ('payment', 'fee', 'reversal'):
                    raise ValueError(f'invalid statement movement at line {reader.line_num}')
                row['fee_rwf'] = rwf(row['fee_rwf'])
                if kind == 'fee' and row['fee_rwf']:
                    raise ValueError(f'standalone fee also has an embedded fee at line {reader.line_num}')
            elif row['allocation_state'] not in ('allocated', 'unallocated'):
                raise ValueError(f'invalid allocation at line {reader.line_num}')
            row['line'] = reader.line_num
            yield row


def reconcile(canonical, wallet, original, scope, start, end, opening, closing, *, statement_row_count=None):
    if start >= end or any(not item.strip() for item in scope):
        raise ValueError('provide a nonempty scope and increasing cutoffs')
    if statement_row_count is not None and (type(statement_row_count) is not int or statement_row_count < 0):
        raise ValueError('statement row count must be a nonnegative whole number')
    digests = {k: file_hash(p) for k, p in
               [('canonical', canonical), ('wallet_csv', wallet), ('wallet_original', original)]}
    if digests['canonical'] in (digests['wallet_csv'], digests['wallet_original']) or original.stat().st_size == 0:
        raise ValueError('supply an independent nonempty statement')

    issues = []
    def flag(reason, *, source=(), payments=()):
        issues.append({'reason': reason, 'wallet_lines': [r['line'] for r in source],
                       'canonical_lines': [r['line'] for r in payments]})

    wallet_refs, payment_refs = defaultdict(list), defaultdict(list)
    allocations = Counter()
    totals = Counter()
    for row in read_entries(canonical, CANONICAL, scope, start, end):
        allocations[row['allocation_state']] += 1
        if not row['occurred_at']:
            flag('payment_time_unknown', payments=[row])
        if row['provider_reference'].strip():
            payment_refs[row['provider_reference']].append(row)
        else:
            flag('payment_reference_missing', payments=[row])

    fee_rows, reversal_rows = [], []
    observed_statement_rows = 0
    for row in read_entries(wallet, WALLET, scope, start, end):
        observed_statement_rows += 1
        totals[row['direction']] += row['amount_rwf']
        totals['embedded_fees'] += row['fee_rwf']
        if row['provider_reference'].strip():
            wallet_refs[row['provider_reference']].append(row)
        else:
            flag('wallet_reference_missing', source=[row])
        if row['kind'] == 'fee':
            fee_rows.append(row)
        elif row['kind'] == 'reversal':
            reversal_rows.append(row)
    if statement_row_count is not None and observed_statement_rows != statement_row_count:
        flag('statement_row_count_differs')
    if not totals:
        flag('empty_statement_requires_independent_confirmation')
    for row in fee_rows:
        if row['direction'] == 'incoming':
            flag('incoming_fee_requires_review', source=[row])
            continue
        parent = wallet_refs.get(row['original_reference'], [])
        if any(p['fee_rwf'] for p in parent):
            flag('fee_may_be_counted_twice', source=[*parent, row])
    for row in reversal_rows:
        flag('reversal_requires_original_review',
             source=[*wallet_refs.get(row['original_reference'], []), row])

    matched = 0
    for ref in sorted(payment_refs.keys() | wallet_refs.keys()):
        payments, source = payment_refs.get(ref, []), wallet_refs.get(ref, [])
        if len(source) > 1 or len(payments) > 1:
            flag('duplicate_reference', source=source, payments=payments)
        elif not source:
            flag('only_in_canonical_payments', payments=payments)
        elif source[0]['kind'] != 'payment':
            if payments:
                flag('canonical_payment_for_fee_or_reversal', source=source, payments=payments)
        elif not payments:
            flag('only_in_wallet_statement', source=source)
        elif any(payments[0][k] != source[0][k] for k in ('direction', 'amount_rwf')):
            flag('direction_or_amount_differs', source=source, payments=payments)
        elif payments[0]['wallet_day'] is None:
            continue  # payment_time_unknown was already recorded for this line.
        elif payments[0]['wallet_day'] != source[0]['wallet_day']:
            flag('event_business_date_differs', source=source, payments=payments)
        else:
            matched += 1

    calculated = opening + totals['incoming'] - totals['outgoing'] - totals['embedded_fees']
    if calculated != closing:
        flag('closing_balance_difference')
    if digests != {k: file_hash(p) for k, p in
                   [('canonical', canonical), ('wallet_csv', wallet), ('wallet_original', original)]}:
        raise ValueError('a source file changed during reconciliation')
    return {'result': 'exceptions' if issues else 'matched', 'sha256': digests,
            'scope': dict(zip(SCOPE, scope)), 'currency': 'RWF',
            'start_inclusive': start.isoformat(), 'end_exclusive': end.isoformat(),
            'matched_payments': matched, 'allocation_counts': dict(allocations),
            'statement_row_control': {'expected': statement_row_count, 'observed': observed_statement_rows,
                                      'verified': (observed_statement_rows == statement_row_count
                                                   if statement_row_count is not None else None)},
            'wallet_rwf': {'opening': opening, 'incoming_including_adjustments': totals['incoming'],
                           'outgoing_including_adjustments': totals['outgoing'],
                           'embedded_fees': totals['embedded_fees'], 'calculated_closing': calculated,
                           'statement_closing': closing, 'difference': calculated - closing},
            'exceptions': issues}


def save(path, report):
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as temp:
        try:
            json.dump(report, temp, indent=2, allow_nan=False)
            temp.write('\n')
            temp.flush()
            os.fsync(temp.fileno())
            os.link(temp.name, path)
        finally:
            os.unlink(temp.name)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for key in ('canonical', 'wallet', 'original', 'output'):
        p.add_argument('--' + key, type=Path, required=True)
    for key in (*SCOPE, 'start', 'end', 'opening', 'closing'):
        p.add_argument('--' + key.replace('_', '-'), required=True)
    p.add_argument('--statement-row-count', help='Independently witnessed expected CSV movement count')
    args = p.parse_args()
    try:
        result = reconcile(args.canonical, args.wallet, args.original, tuple(getattr(args, k) for k in SCOPE),
                           instant(args.start), instant(args.end), rwf(args.opening, signed=True),
                           rwf(args.closing, signed=True), statement_row_count=(
                               rwf(args.statement_row_count) if args.statement_row_count is not None else None))
        save(args.output, result)
    except (OSError, ValueError, csv.Error, OverflowError) as e:
        print('Reconciliation could not complete. ' + (str(e) if type(e) is ValueError and
              not isinstance(e, UnicodeError) and not str(e).startswith('Invalid isoformat') else
              'Check the inputs and the new private output path.'), file=sys.stderr)
        return 2
    print(f"{result['matched_payments']} matched payments, {len(result['exceptions'])} exceptions.")
    return 0 if result['result'] == 'matched' else 3


if __name__ == '__main__':
    sys.exit(main())
