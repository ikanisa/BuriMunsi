import {paymentsPath} from '../operations/paymentLocations';
import {containsControl, STATUSES} from './contracts';
import type {CoreArea, FinancialModel} from './types';

export const baseSorts: Record<CoreArea, readonly [string, string][]> = {
  groups: [['created_at', 'Created'], ['title', 'Group'], ['active_members', 'Members'], ['status', 'Status']],
  users: [['created_at', 'Created'], ['public_id', 'Collect ID'], ['member_type', 'Type'], ['status', 'Status']],
  members: [['created_at', 'Created'], ['public_id', 'Collect ID'], ['member_type', 'Type'], ['status', 'Status']],
  payees: [['created_at', 'Created'], ['label', 'Payee'], ['group_title', 'Group'], ['status', 'Status']],
  transactions: [['created_at', 'Created'], ['group_title', 'Group'], ['observed_at', 'Observed'], ['status', 'Status']],
  ledgers: [['created_at', 'Created'], ['group_title', 'Group'], ['status', 'Status']],
};

const membershipStatuses = ['active', 'inactive'] as const;
export function listStatuses(area: CoreArea, model: FinancialModel, scopedMember = false): readonly string[] {
  return scopedMember && area === 'members' && model === 'canonical_evidence_ledger' ? membershipStatuses : STATUSES[model][area];
}

export interface Filters { search: string; status: string; sort: string; page: number }

export function readFilters(search: string, area: CoreArea, model: FinancialModel, scopedMember = false): Filters {
  const query = new URLSearchParams(search);
  const candidate = query.get('search') ?? '';
  const rawStatus = query.get('status') ?? '';
  const rawSort = query.get('sort') ?? 'created_at_desc';
  const rawPage = Number(query.get('page') ?? 1);
  const validSort = baseSorts[area].some(([field]) => rawSort === `${field}_asc` || rawSort === `${field}_desc`);
  return {
    search: candidate.length <= 200 && !containsControl(candidate) ? candidate : '',
    status: listStatuses(area, model, scopedMember).includes(rawStatus) ? rawStatus : '',
    sort: validSort ? rawSort : 'created_at_desc',
    page: Number.isSafeInteger(rawPage) && rawPage >= 1 && rawPage <= 85899346 ? rawPage : 1,
  };
}

export function listLocation(area: CoreArea, filter: Filters, paymentsWorkspace = false): string {
  const query = new URLSearchParams();
  if (filter.search) query.set('search', filter.search);
  if (filter.status) query.set('status', filter.status);
  if (filter.sort !== 'created_at_desc') query.set('sort', filter.sort);
  if (filter.page > 1) query.set('page', String(filter.page));
  const suffix = query.toString();
  return `${paymentsWorkspace ? paymentsPath : `/admin/${area}`}${suffix ? `?${suffix}` : ''}`;
}
