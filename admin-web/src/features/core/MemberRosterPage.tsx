import {useCallback, useMemo, useState, type ComponentProps} from 'react';
import {Button, Card, ErrorState, LoadingState, PageHeader, StatusBadge} from '../../ui';
import {FinancialAnalysisTable, type FinancialColumn} from '../operations/FinancialAnalysisTable';
import {useOperationRead} from '../operations/useOperationRead';
import {containsControl, label, memberMobileNumber} from './contracts';
import {MemberDirectoryActions} from './MemberDirectory';
import {comparableMemberPhone, matchesMemberName, matchesMemberPhone, rosterSearch, readCompleteRoster, rosterUnavailable} from './memberRosterRead';
import {readRosterCriteria, rosterLocation, type RosterCriteria} from './memberRosterLocation';
import type {DataRow, FeatureAccess} from './types';
import './memberRoster.css';

type RosterProps = FeatureAccess & {locationSearch?:string; memberActions?:ComponentProps<typeof MemberDirectoryActions>};
const rowKey = (row: DataRow) => row.id;
const emptyRows: readonly DataRow[] = [];
const recordedName = (row: DataRow) => row.display_name_recorded ? String(row.display_name) : null;
const fields: readonly FinancialColumn<DataRow>[] = [
  {key:'public_id',label:'Collect ID',kind:'text',value:row => row.title},
  {key:'full_name',label:'Name on MoMo',kind:'text',value:recordedName,matchText:matchesMemberName,
    render:row => recordedName(row) ?? 'Not recorded'},
  {key:'member_type',label:'Type',kind:'category',value:row => String(row.member_type),
    options:[{value:'direct',label:'Direct'},{value:'app',label:'App'}]},
  {key:'phone',label:'Mobile number',kind:'text',value:row => {
    const phone = memberMobileNumber(row);
    return phone === null ? null : comparableMemberPhone(phone);
  },matchText:matchesMemberPhone,render:row => memberMobileNumber(row) ?? 'Not recorded'},
  {key:'status',label:'Status',kind:'category',value:row => String(row.membership_status),
    options:[{value:'active',label:'Active'},{value:'inactive',label:'Inactive'}],
    render:row => <StatusBadge tone={row.membership_status === 'active' ? 'success' : 'neutral'}>{label(String(row.membership_status))}</StatusBadge>},
];

export function MemberRosterPage({request, permissions, authorityKey, actorId, principalId, role, financialModel, navigate, locationSearch = '', memberActions}: RosterProps) {
  const allowed = permissions.includes('users.read');
  const load = useCallback((signal: AbortSignal) => readCompleteRoster(request,signal),[request]);
  const {result,refreshing,retry} = useOperationRead(JSON.stringify(['member-roster',authorityKey,actorId,principalId,role,financialModel]),allowed,load,
    {retainDuringRefresh:true,reuseSettledOnResume:true,invalidResponse:rosterUnavailable});
  const criteria = useMemo(() => readRosterCriteria(locationSearch),[locationSearch]);
  const [draft,setDraft] = useState({base:criteria.search,value:criteria.search});
  if (draft.base !== criteria.search) setDraft({base:criteria.search,value:criteria.search});
  const search = (draft.base === criteria.search ? draft.value : criteria.search).trim();
  const liveCriteria = {...criteria,search,page:search === criteria.search ? criteria.page : 1};
  const returnTo = rosterLocation(liveCriteria);
  const update = (changes: Partial<RosterCriteria>) => navigate(rosterLocation({...liveCriteria,...changes}));
  const rows = result?.status === 'success' ? result.value : emptyRows;
  const matching = useMemo(() => {
    const found = search ? rows.filter(rosterSearch(search)) : rows;
    // The API delivered (created_at, id) ascending. Keep both legacy created-date bookmark directions.
    return criteria.sort.key === 'created_at' && criteria.sort.direction === 'desc' ? [...found].reverse() : found;
  },[rows,search,criteria.sort.key,criteria.sort.direction]);
  const columns = useMemo<readonly FinancialColumn<DataRow>[]>(() => [...fields,
    {key:'open',label:'Open',kind:'text',value:() => null,filterable:false,sortable:false,
      render:row => <Button aria-label={'View ' + row.title} onClick={() => navigate('/admin/members/' + row.id + '?' + new URLSearchParams({returnTo}))}>View</Button>},
  ],[navigate,returnTo]);

  return <>
    <PageHeader title="Members" actions={allowed && <>
      <Button icon="refresh" aria-label="Refresh Members" title="Refresh Members" loading={!result || refreshing} onClick={retry} />
      {memberActions && <MemberDirectoryActions {...memberActions} />}
    </>} />
    {!allowed ? <ErrorState title="Access unavailable" message="Your account does not have permission to view this page." /> :
      <Card className="member-roster">{!result ? <LoadingState layout="table" label="Loading members" /> :
        result.status === 'error' ? <ErrorState message={result.message} onRetry={retry} /> :
        <FinancialAnalysisTable label="Members" rows={matching} columns={columns} rowKey={rowKey}
          unfilteredTotal={rows.length} page={liveCriteria.page} onPageChange={page => update({page})}
          criteria={{filters:criteria.filters,sort:criteria.sort,onCriteria:(filters,sort) => update({filters,sort,page:1})}}
          loadingLabel="Loading members" refreshing={refreshing}
          search={<form className="member-roster-search" role="search" aria-label="Members" onSubmit={event => {
            event.preventDefault(); update({page:1});
          }}>
            <label className="core-visually-hidden" htmlFor="member-roster-search">Search Members</label>
            <input className="admin-input" id="member-roster-search" placeholder="Name, Collect ID or mobile number"
              autoComplete="off" maxLength={200} value={draft.value} onChange={event => {
                if (!containsControl(event.target.value)) setDraft({base:criteria.search,value:event.target.value});
              }} />
            <Button type="submit" icon="search" aria-label="Search" title="Search" />
            {draft.value && <Button icon="close" aria-label="Clear search" title="Clear search" onClick={() => {
              setDraft({base:criteria.search,value:''}); update({search:'',page:1});
            }} />}
          </form>} />}
      </Card>}
  </>;
}
