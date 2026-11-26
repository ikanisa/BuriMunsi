import {AdminRequestError} from '../../api/client';
import {Link} from 'react-router';
import { useCallback, useMemo, useState, type ComponentProps } from 'react';
import { CompactText, Button, Card, EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from '../../ui';
import {useOperationRead} from '../operations/useOperationRead';
import { containsControl, formatField, formatMoney, label, memberMobileNumber, parseCorePage, parseMemberRosterPage, paymentReference } from './contracts';
import { coreListAction } from './coreRecordActions';
import {MemberDirectoryActions, MemberDirectoryViews} from './MemberDirectory';
import {baseSorts, listLocation, listStatuses, readFilters, type Filters} from './coreListFilters';
import type { CoreArea, DataRow, FeatureAccess, FinancialModel } from './types';
import { AREA_TITLES, CORE_PERMISSIONS } from './types';
import './core.css';

type ListProps = FeatureAccess & { area: CoreArea; locationSearch?: string; allowMutations?: boolean; paymentsWorkspace?: boolean;
  simplePayments?: boolean; scopedMember?: boolean; memberActions?: ComponentProps<typeof MemberDirectoryActions> };

const PAGE_SIZE = 25;
const recordsUnavailable = 'The records could not be verified or the service is unavailable.';
const descriptions: Record<CoreArea, string> = {
  groups: 'Explore group records and membership.', users: 'Find people with or without a group membership.',
  members: '', payees: 'Review group payment receivers.',
  transactions: 'Review recorded payment evidence and its status.', ledgers: 'Review contribution records and ledger status.',
};

function recordLocation(area: CoreArea, id: string, returnTo: string): string {
  const query = new URLSearchParams({ returnTo });
  return `/admin/${area}/${id}?${query.toString()}`;
}

function tone(status: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  if (['active', 'confirmed', 'reconciled', 'confirmation_recorded', 'posted', 'contribution'].includes(status)) return 'success';
  if (['pending', 'recorded', 'draft', 'ambiguous'].includes(status)) return 'warning';
  if (['suspended', 'archived', 'rejection_recorded', 'evidence_conflict', 'reversed', 'deleted'].includes(status)) return 'danger';
  return 'neutral';
}

function columns(area: CoreArea, model: FinancialModel): { label: string; compact?: boolean; value: (row: DataRow) => string }[] {
  switch (area) {
    case 'groups': return [
      { label: 'Group', compact: true, value: row => row.title }, { label: 'Slug', compact: true, value: row => formatField('slug', row.slug) },
      { label: 'Members', value: row => formatField('active_members', row.active_members) },
      { label: 'Type', value: row => label(String(row.collection_type)) }, { label: 'Visibility', value: row => label(String(row.visibility)) },
    ];
    case 'users': case 'members': return [
      { label: 'Collect ID', value: row => row.title }, { label: 'Name on MoMo', compact: true, value: row => row.display_name_recorded ? String(row.display_name) : 'Not recorded' },
      { label: 'Type', value: row => formatField('member_type', row.member_type) },
      area === 'members' ? {label: 'Mobile number', value: row => formatField('mobile_number', memberMobileNumber(row))} :
        {label: 'MoMo number / code', value: row => formatField('momo_number_or_code', row.momo_number ?? row.momo_pay_code)},
      { label: 'Contributed', value: row => formatMoney(row.total_contributed_rwf) },
    ];
    case 'payees': return [
      { label: 'Payee', compact: true, value: row => row.title }, { label: 'Group', compact: true, value: row => String(row.group_name) },
      { label: 'Provider', value: row => formatField('network', row.network) }, { label: 'MoMo number / code', value: row => row.amount },
    ];
    case 'transactions': return [
      { label: 'Reference', compact: true, value: row => model === 'canonical_evidence_ledger' ? paymentReference(row) : row.title }, { label: 'Group', compact: true, value: row => String(row.group_name) },
      { label: 'Receiver', compact: true, value: row => formatField('payee_label', row.payee_label) },
      { label: 'Amount', value: row => formatMoney(row.amount_rwf) }, { label: 'Allocated', value: row => formatMoney(row.allocated_amount_rwf) },
    ];
    case 'ledgers': return [
      { label: 'Record', compact: true, value: row => row.title }, { label: 'Group', compact: true, value: row => String(row.group_name) },
      { label: 'Amount', value: row => row.signed_amount_rwf !== undefined ? formatMoney(row.signed_amount_rwf, true) : formatMoney(row.debit_rwf) },
      { label: 'Recorded', value: row => formatField('created_at', row.created_at) },
    ];
  }
}

export function CoreListPage({ area, request, permissions, actorId, role, authorityKey, financialModel, navigate, locationSearch = '',
  allowMutations = false, paymentsWorkspace = false, simplePayments = false, scopedMember = false, memberActions }: ListProps) {
  const allowed = permissions.includes(CORE_PERMISSIONS[area]);
  const roster = scopedMember && area === 'members' && financialModel === 'canonical_evidence_ledger';
  const filter = useMemo(() => readFilters(locationSearch, area, financialModel, roster), [locationSearch, area, financialModel, roster]);
  const [draftState, setDraftState] = useState({ base: filter.search, value: filter.search });
  const draft = draftState.base === filter.search ? draftState.value : filter.search;
  const offset = (filter.page - 1) * PAGE_SIZE;
  const query = new URLSearchParams({search: filter.search, status: filter.status, limit: String(PAGE_SIZE),
    offset: String(offset), sort: filter.sort, country: 'RW'});
  if (roster) query.set('directory', 'roster');
  const path = `core/${area}?${query}`;
  const load = useCallback(async (signal: AbortSignal) => {
    const data = await request(path, {signal}).catch((error: unknown) => {
      const temporarilyUnavailable = roster && error instanceof AdminRequestError && error.statusCode === 503;
      throw new AdminRequestError(temporarilyUnavailable ? 'Members are temporarily unavailable. Try again.' : recordsUnavailable);
    });
    return roster ? parseMemberRosterPage(data, PAGE_SIZE, offset, filter.status)
      : parseCorePage(data, area, financialModel, PAGE_SIZE, offset, filter.status);
  }, [request, path, roster, area, financialModel, offset, filter.status]);
  const {result, retry, refreshing} = useOperationRead(JSON.stringify([authorityKey, actorId, financialModel, path]), allowed, load,
    {retainDuringRefresh: roster, reuseSettledOnResume: roster, invalidResponse: recordsUnavailable});
  const page = result?.status === 'success' ? result.value : null;

  const update = (changes: Partial<Filters>) => navigate(listLocation(area, { ...filter, ...changes }, paymentsWorkspace));
  const tableColumns = columns(area, financialModel).filter(column => !simplePayments || column.label !== 'Contributed');
  const memberDirectory = area === 'members' || area === 'users';
  const title = memberDirectory ? 'Members' : AREA_TITLES[area];
  const action = coreListAction({area, role, permissions, financialModel, allowed, allowMutations});
  return <>
    {!paymentsWorkspace && <PageHeader title={title} subtitle={descriptions[area]} actions={roster && allowed ? <>
      <Button icon="refresh" aria-label="Refresh Members" title="Refresh Members" loading={!result || refreshing} onClick={retry} />
      {memberActions && <MemberDirectoryActions {...memberActions} />}</> :
      action ? <Button type="button" onClick={() => navigate(action.path)}>{action.label}</Button> : undefined} />}
    {allowed && memberDirectory && !roster && <MemberDirectoryViews area={area} />}
    {!allowed ? <ErrorState title="Access unavailable" message="Your account does not have permission to view this page." /> : <Card>
      <div className="core-toolbar">
        {!memberDirectory && !paymentsWorkspace && <div><h2>{AREA_TITLES[area]} list</h2><p>Search and review records</p></div>}
        <form className="core-search" onSubmit={event => { event.preventDefault(); const value = draft.trim(); if (value.length <= 200 && !containsControl(value)) update({ search: value, page: 1 }); }}>
          <label className="core-visually-hidden" htmlFor={`search-${area}`}>Search {paymentsWorkspace ? 'payments' : AREA_TITLES[area]}</label>
          <input id={`search-${area}`} className="admin-input" value={draft} onChange={event => setDraftState({ base: filter.search, value: event.target.value })} maxLength={200} placeholder={paymentsWorkspace ? 'Payment reference' : memberDirectory ? 'Search by name or ID' : 'Search records'} />
          <Button type="submit">Search</Button>
          <Button type="button" onClick={() => { setDraftState({ base: '', value: '' }); update({ search: '', status: '', sort: 'created_at_desc', page: 1 }); }}>Clear</Button>
        </form>
      </div>
      <div className="core-filters">
        <label>Status <select className="admin-input" value={filter.status} onChange={event => update({ status: event.target.value, page: 1 })}>
          <option value="">All statuses</option>{listStatuses(area, financialModel, roster).map(value => <option key={value} value={value}>{label(value)}</option>)}
        </select></label>
        <label>Sort by <select className="admin-input" value={filter.sort} onChange={event => update({ sort: event.target.value, page: 1 })}>
          {baseSorts[area].flatMap(([field, name]) => [<option key={`${field}_asc`} value={`${field}_asc`}>{name} · ascending</option>, <option key={`${field}_desc`} value={`${field}_desc`}>{name} · descending</option>])}
        </select></label>
      </div>
      {!result ? <LoadingState label={`Loading ${AREA_TITLES[area].toLowerCase()}`} layout="table" /> :
       result.status === 'error' ? <ErrorState message={result.message} onRetry={retry} /> :
       !page || page.rows.length === 0 ? <EmptyState title="No records found" description="Change your search or filters and try again." /> : <>
        <div className="admin-table-wrap admin-content-enter" role="region" aria-label={`${AREA_TITLES[area]} records`} aria-busy={refreshing || undefined} tabIndex={0}>
          <table className={paymentsWorkspace ? "admin-table operations-receipt-table" : "admin-table"} role="table"><thead role="rowgroup"><tr role="row">{tableColumns.map(column => <th role="columnheader" scope="col" key={column.label}><CompactText cell>{column.label}</CompactText></th>)}<th role="columnheader" scope="col">Status</th>{!paymentsWorkspace && <th role="columnheader" scope="col">Open</th>}</tr></thead>
            <tbody role="rowgroup">{page.rows.map(row => {
              const href = recordLocation(area, row.id, listLocation(area, filter, paymentsWorkspace));
              const status = roster ? String(row.membership_status) : row.status;
              return <tr key={row.id} role="row">{tableColumns.map((column, index) => {
                const value = column.value(row);
                const text = column.compact ? <CompactText cell>{value}</CompactText> : value;
                return <td role="cell" key={column.label}>{paymentsWorkspace && <span className="operations-receipt-field" aria-hidden="true">{column.label}</span>}{paymentsWorkspace && index === 0 ?
                <Link className="operations-link payments-record-link" to={href}>{text}</Link> : text}</td>;
              })}
                <td role="cell">{paymentsWorkspace && <span className="operations-receipt-field" aria-hidden="true">Status</span>}<StatusBadge tone={tone(status)}>{label(status)}</StatusBadge></td>{!paymentsWorkspace &&
                  <td role="cell"><Button type="button" onClick={() => navigate(href)} aria-label={`View ${area === 'transactions' && financialModel === 'canonical_evidence_ledger' ? paymentReference(row) : row.title}`}>View</Button></td>}
              </tr>;
            })}</tbody>
          </table>
        </div>
        <div className="core-pager"><span>Showing {(filter.page - 1) * PAGE_SIZE + 1}–{(filter.page - 1) * PAGE_SIZE + page.rows.length} of {page.total}</span><div><Button type="button" disabled={filter.page <= 1} onClick={() => update({ page: filter.page - 1 })}>Previous</Button><span aria-current="page">{filter.page}</span><Button type="button" disabled={filter.page * PAGE_SIZE >= page.total} onClick={() => update({ page: filter.page + 1 })}>Next</Button></div></div>
       </>}
    </Card>}
  </>;
}
