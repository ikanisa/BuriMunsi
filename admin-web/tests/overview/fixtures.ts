export function canonicalFixture(unallocated = 1) {
  const labels = {
    users: 'Users', groups: 'Groups', active_members: 'Active members', payees: 'Payees',
    transactions: 'Transactions', app_users: 'App users', direct_users: 'Direct users',
    admin_users: 'Admin users', staff_users: 'Staff users', active_payees: 'Active payees',
    unallocated_transactions: 'Unallocated transactions', ledger_entries: 'Ledger entries',
    reversed_entries: 'Reversal entries', payment_evidence: 'Retained payment evidence',
  };
  const amountLabels = {total_recorded_rwf: 'Recorded evidence amount',
    total_reconciled_rwf: 'Reconciled evidence amount', total_unallocated_rwf: 'Unallocated evidence amount',
    total_net_contributions_rwf: 'Net recorded contributions'};
  const counts = Object.fromEntries(Object.keys(labels).map((key) => [key, key === 'unallocated_transactions' ? unallocated : 1]));
  const amounts = Object.fromEntries(Object.keys(amountLabels).map((key) => [key, '9007199254740993']));
  return {contract_version: 2, model: 'canonical_evidence_ledger', country_code: 'RW',
    measured_at: '2026-11-16T23:00:00.000Z', counts, amounts,
    contribution_basis: 'reconciled_evidence_entries', collected_basis: 'retained_received_evidence',
    reconciliations_available: true, metrics: Object.entries({...labels, ...amountLabels}).map(([key, label]) => ({
      key, label, status: 'measured', value: String(counts[key] ?? amounts[key]),
    }))};
}
