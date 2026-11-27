import {useCallback, useEffect, useMemo, useRef, useState, type ComponentProps} from 'react';
import {Button, Card, ErrorState, LoadingState, PageHeader, StatusBadge} from '../../ui';
import {FinancialAnalysisTable, type FinancialColumn} from '../operations/FinancialAnalysisTable';
import {useOperationRead} from '../operations/useOperationRead';
import {containsControl, label, memberMobileNumber} from './contracts';
import {MemberDirectoryActions} from './MemberDirectory';
import {comparableMemberPhone, matchesMemberName, matchesMemberPhone, rosterSearch, rosterUnavailable} from './memberRosterRead';
import {readRosterCriteria, rosterLocation, type RosterCriteria} from './memberRosterLocation';
import {readRosterExport, readRosterWindow, rosterWindowParams, startRoster, type VisibleMember} from './memberRosterWindow';
import type {FeatureAccess} from './types';
import './memberRoster.css';

type RosterProps = FeatureAccess & {locationSearch?:string; memberActions?:ComponentProps<typeof MemberDirectoryActions>};
const rowKey = (row: VisibleMember) => row.id;
const emptyRows: readonly VisibleMember[] = [];
const recordedName = (row: VisibleMember) => row.display_name_recorded ? String(row.display_name) : null;
const fields: readonly FinancialColumn<VisibleMember>[] = [
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

export function MemberRosterPage(props:RosterProps) {
  const {authorityKey,actorId,principalId,role,financialModel}=props;
  return <ScopedRoster key={JSON.stringify([authorityKey,actorId,principalId,role,financialModel])} {...props}/>;
}

function ScopedRoster({request,permissions,navigate,locationSearch='',memberActions}:RosterProps) {
  const allowed = permissions.includes('users.read');
  const criteria = useMemo(() => readRosterCriteria(locationSearch),[locationSearch]);
  const [initial] = useState(() => rosterWindowParams(criteria).toString());
  const baselineQuery=useRef(initial);
  const load = useCallback(async (signal:AbortSignal) => {
    const query=baselineQuery.current;
    return {...await startRoster(request,signal,new URLSearchParams(query)),query};
  },[request]);
  const {result,refreshing,retry} = useOperationRead('directory/'+initial,allowed,load,
    {retainDuringRefresh:true,reuseSettledOnResume:true,invalidResponse:rosterUnavailable});
  const location = rosterLocation(criteria);
  const [draft,setDraft] = useState<{location:string; value:string; pending:string[]}>({location,value:criteria.search,pending:[]});
  let value = draft.value;
  if (draft.location !== location) {
    // A router acknowledgement may arrive after the next keystroke. External navigation restores its own query.
    const committed = draft.pending.indexOf(location);
    if (committed < 0) value = criteria.search;
    setDraft({location,value,pending:committed < 0 ? [] : draft.pending.slice(committed + 1)});
  }
  const search = value.trim();
  const liveCriteria = {...criteria,search,page:search === criteria.search ? criteria.page : 1};
  const returnTo = rosterLocation(liveCriteria);
  const update = (changes: Partial<RosterCriteria>) => {
    const destination = rosterLocation({...liveCriteria,...changes});
    setDraft(current => (current.pending.at(-1) ?? current.location) === destination ? current :
      {...current,pending:[...current.pending,destination]});
    navigate(destination);
  };
  const baseline = result?.status==='success' ? result.value : null;
  const remote = baseline?.kind==='remote' ? baseline.page : null;
  const [debounced,setDebounced]=useState<{committed:string; value:string}|null>(null);
  useEffect(()=>{
    if (!remote || search===criteria.search) return;
    const timer=setTimeout(()=>setDebounced({committed:criteria.search,value:search}),180);
    return ()=>clearTimeout(timer);
  },[remote,search,criteria.search]);
  const submitted=search===criteria.search;
  const requestedSearch=submitted?search:debounced?.committed===criteria.search?debounced.value:criteria.search;
  const query = rosterWindowParams({...liveCriteria,search:requestedSearch}).toString();
  const loadPage = useCallback((signal:AbortSignal) => readRosterWindow(request,signal,new URLSearchParams(query),remote!.revision),
    [request,query,remote]);
  const selected = useOperationRead(JSON.stringify([query,remote?.revision]),!!remote && query!==baseline?.query,loadPage,
    {reuseSettledOnResume:true,invalidResponse:rosterUnavailable});
  const window = query===baseline?.query ? remote : selected.result?.status==='success' ? selected.result.value : null;
  const legacy = baseline?.kind==='legacy' ? baseline.rows : null;
  const matching = useMemo(() => {
    if (!legacy) return window?.rows ?? emptyRows;
    const found = search ? legacy.filter(rosterSearch(search)) : legacy;
    return criteria.sort.key === 'created_at' && criteria.sort.direction === 'desc' ? [...found].reverse() : found;
  },[legacy,window,search,criteria.sort.key,criteria.sort.direction]);
  const refresh=()=>{baselineQuery.current=query;retry();};
  const controls={filters:criteria.filters,sort:criteria.sort,onCriteria:(filters:RosterCriteria['filters'],sort:RosterCriteria['sort']) => update({filters,sort,page:1})};
  const columns = useMemo<readonly FinancialColumn<VisibleMember>[]>(() => [...fields,
    {key:'open',label:'Open',kind:'text',value:() => null,filterable:false,sortable:false,
      render:row => <Button aria-label={'View ' + row.title} onClick={() => navigate('/admin/members/' + row.id + '?' + new URLSearchParams({returnTo}))}>View</Button>},
  ],[navigate,returnTo]);

  return <>
    <PageHeader title="Members" actions={allowed && <>
      <Button icon="refresh" aria-label="Refresh Members" title="Refresh Members" loading={!result || refreshing} onClick={refresh} />
      {baseline && <RosterExport key={remote?.revision ?? 'legacy'} request={request} revision={remote?.revision} legacy={legacy} />}
      {memberActions && <MemberDirectoryActions {...memberActions} />}
    </>} />
    {!allowed ? <ErrorState title="Access unavailable" message="Your account does not have permission to view this page." /> :
      <Card className="member-roster">{!result ? <LoadingState layout="table" label="Loading members" /> :
        result.status === 'error' ? <ErrorState message={result.message} onRetry={retry} /> :
        <FinancialAnalysisTable label="Members" rows={matching} columns={columns} rowKey={rowKey}
          unfilteredTotal={legacy?.length} page={liveCriteria.page} onPageChange={page => update({page})}
          criteria={controls} remote={remote ? {...controls,total:remote.total,matching:window?.matching ?? null,
            refreshing:!window && !selected.result, error:selected.result?.status==='error' ?
              <ErrorState message={selected.result.message} onRetry={refresh}/> : undefined} : undefined}
          loadingLabel="Loading members" refreshing={refreshing}
          search={<form className="member-roster-search" role="search" aria-label="Members" onSubmit={event => {
            event.preventDefault();
            const submitted = new FormData(event.currentTarget).get('search');
            if (typeof submitted === 'string' && submitted.length <= 200 && !containsControl(submitted)) update({search:submitted.trim(),page:1});
          }}>
            <label className="core-visually-hidden" htmlFor="member-roster-search">Search Members</label>
            <input className="admin-input" id="member-roster-search" name="search" placeholder="Name, Collect ID or mobile number"
              autoComplete="off" maxLength={200} value={value} onChange={event => {
                const typed = event.target.value;
                if (!containsControl(typed)) setDraft(current => ({...current,value:typed}));
              }} />
            <Button type="submit" icon="search" aria-label="Search" title="Search" />
            {value && <Button icon="close" aria-label="Clear search" title="Clear search" onClick={() => {
              setDraft(current => ({...current,value:''})); update({search:'',page:1});
            }} />}
          </form>} />}
      </Card>}
  </>;
}


function RosterExport({request,revision,legacy}:{request:RosterProps['request'];revision?:string;legacy:readonly VisibleMember[]|null}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const flight=useRef<AbortController|null>(null);
  useEffect(()=>()=>{flight.current?.abort();},[request,revision,legacy]);
  async function download(){
    if(flight.current)return;
    const controller=new AbortController(); flight.current=controller;setBusy(true);setError('');
    try{
      const rows=revision?await readRosterExport(request,controller.signal,revision):legacy;
      controller.signal.throwIfAborted();
      if(!rows)throw new Error();
      const quote=(value:string)=>'"'+(/^(?:\s*[=+@\-＝＋＠－]|[\t\r\n])/u.test(value)?"'":'')+value.replaceAll('"','""')+'"';
      const csv=['Collect ID,Name on MoMo,Type,Mobile number,Status',...rows.map(row=>
        [row.title,recordedName(row)??'',String(row.member_type),memberMobileNumber(row)??'',String(row.membership_status)].map(quote).join(','))];
      const url=URL.createObjectURL(new Blob(['\uFEFF'+csv.join('\r\n')+'\r\n'],{type:'text/csv;charset=utf-8'}));
      const link=document.createElement('a');link.href=url;link.download='burimunsi-members'+(revision?'-'+revision.slice(0,12):'')+'.csv';
      try{link.click();}finally{setTimeout(()=>URL.revokeObjectURL(url),0);}
    }catch{if(!controller.signal.aborted)setError('The full directory could not be verified. Refresh Members and try again.');}
    finally{flight.current=null;if(!controller.signal.aborted)setBusy(false);}
  }
  return <><Button onClick={()=>void download()} loading={busy}>Export all members</Button>{error&&<span role="alert">{error}</span>}</>;
}
