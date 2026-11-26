import {Fragment, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode} from 'react';
import {CompactText, Button, Dialog, Icon, LoadingState} from '../../ui';
import {validPaymentAmountBound} from '../../../../supabase/functions/_shared/domain/burimunsi/payment-analysis-shared.mjs';
import {useFocusScope} from '../../ui/useFocusScope';
import {analyzeFinancialRows, categoryChoices, describeColumnFilter, emptyFilter, formatAnalysisCell, hasCriteria, initialColumnFilters, rangeError,
  type ColumnFilter, type FinancialColumn, type FinancialSort} from './financialAnalysisModel';
import './financialAnalysis.css';

export type {FinancialColumn, FinancialSort} from './financialAnalysisModel';
export interface FinancialAnalysisTableProps<T> {
  rows: readonly T[];
  columns: readonly FinancialColumn<T>[];
  rowKey: (row: T) => string;
  initialSort?: FinancialSort;
  initialFilters?: Readonly<Record<string,string>>;
  expanded?: {key: string; content: ReactNode} | null;
  label?: string;
  pageSize?: number;
  page?: number;
  onPageChange?: (page: number) => void;
  summary?: (matching: readonly T[]) => ReactNode;
  actions?: ReactNode;
  remote?: {filters: ReadonlyMap<string,ColumnFilter>; sort: FinancialSort; total: number | null; matching: number | null;
    refreshing?: boolean; error?: ReactNode; onCriteria: (filters: ReadonlyMap<string,ColumnFilter>,sort: FinancialSort)=>void};
}

function FilterEditor<T>({column, rows, active, close, apply, remote}: {
  column: FinancialColumn<T>; rows: readonly T[]; active: ColumnFilter; close: () => void; apply: (filter: ColumnFilter) => void; remote?:boolean;
}) {
  const [draft,setDraft] = useState<ColumnFilter>(active);
  const [error,setError] = useState('');
  const formId = useId();
  const options = useMemo(() => column.kind === 'category' ? categoryChoices(column,rows,active.choices,remote) : [],[column,rows,active.choices,remote]);
  const update = (changes: Partial<ColumnFilter>) => {setDraft(current => ({...current,...changes})); setError('');};
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const invalid = remote && column.kind==='number' && draft.presence!=='blank' &&
      (!validPaymentAmountBound(draft.min) || !validPaymentAmountBound(draft.max)) ? 'Enter a number that can be compared exactly.' : rangeError(draft,column.kind);
    if (invalid) {setError(invalid); return;}
    apply(draft.presence === 'blank' ? {...emptyFilter,presence:'blank'} : {...draft,text:draft.text.trim()});
  };
  const range = column.kind === 'date' || column.kind === 'number';
  return <Dialog open placement="picker" title={'Filter ' + column.label} onClose={close} footer={<>
    <Button onClick={() => apply(emptyFilter)}>Clear filter</Button>
    <Button onClick={close}>Cancel</Button>
    <Button variant="primary" type="submit" form={formId}>Apply filter</Button>
  </>}>
    <form id={formId} className="financial-filter-form" onSubmit={submit}>
      <fieldset className="financial-filter-choices"><legend>Values</legend>
        {([['any','All values'],['blank','Blank only'],['present','Non-blank only']] as const).map(([value,label]) =>
          <label key={value}><input type="radio" name={formId+'-presence'} value={value}
            checked={draft.presence === value} onChange={() => update({presence:value})} />{label}</label>)}
      </fieldset>
      {draft.presence !== 'blank' && <>
        {column.kind === 'text' && <label>Contains<input className="admin-input" type="search" autoComplete="off" maxLength={remote ? 200 : undefined}
          value={draft.text} onChange={event => update({text:event.target.value})} /></label>}
        {range && <div className="financial-filter-range">
          {(['min','max'] as const).map((key,index) => <label key={key}>
            {column.kind === 'date' ? ['From','Through'][index] : ['Minimum','Maximum'][index]}
            <input className="admin-input" type={column.kind} step={column.kind === 'number' ? 'any' : undefined}
              value={draft[key]} onChange={event => update({[key]:event.target.value})}
              aria-invalid={error ? true : undefined} aria-describedby={error ? formId + '-error' : undefined} />
          </label>)}
        </div>}
        {column.kind === 'category' && <fieldset className="financial-filter-choices">
          <legend>Match any selected value</legend>
          {options.length ? options.map(option => <label key={option.value}><input type="checkbox" checked={draft.choices.includes(option.value)}
            onChange={event => update({choices:event.target.checked ? [...draft.choices,option.value] : draft.choices.filter(value => value !== option.value)})} />
            {option.label}</label>) : <p>No non-blank values.</p>}
        </fieldset>}
      </>}
      {error && <p role="alert" id={formId + '-error'} className="admin-field-error">{error}</p>}
    </form>
  </Dialog>;
}

export function FinancialAnalysisTable<T>({rows, columns, rowKey, initialSort, initialFilters, expanded, label='Payment activity',
    pageSize=25, page, onPageChange, summary, actions, remote}: FinancialAnalysisTableProps<T>) {
  const [localSort,setSort] = useState(initialSort);
  const sort=remote?.sort ?? localSort;
  const [localFilters,setFilters] = useState(() => initialColumnFilters(columns,initialFilters));
  const filters=remote?.filters ?? localFilters;
  const [editing,setEditing] = useState<string | null>(null);
  const filterOpener = useRef<HTMLButtonElement | null>(null), filterHeaders = useRef(new Map<string,HTMLButtonElement>());
  const [navigation,setNavigation] = useState<{position:number; given?:number; revealed?:string}>({position:page ?? 1,given:page});
  const [maximized,setMaximized] = useState(false);
  const panel = useRef<HTMLDivElement>(null), expandControl = useRef<HTMLButtonElement>(null);
  const instance = useId();
  useFocusScope(maximized,panel,() => setMaximized(false),expandControl);
  const matching = useMemo(() => remote ? rows : analyzeFinancialRows(rows,columns,filters,sort),[rows,columns,filters,sort,remote]);
  const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 25;
  const total = remote ? remote.total : rows.length, matched = remote ? remote.matching : matching.length;
  const count = matched === null ? null : Math.max(1,Math.ceil(matched / size));
  const selected = expanded?.key;
  const selectedIndex = !remote && selected && selected !== navigation.revealed ? matching.findIndex(row => rowKey(row) === selected) : -1;
  const revealed = selected && selectedIndex >= 0 ? selected : selected ? navigation.revealed : undefined;
  const bookmark = Object.is(page,navigation.given) ? navigation.position : page ?? navigation.position;
  const requested = selectedIndex >= 0 ? Math.floor(selectedIndex / size) + 1 : bookmark;
  const current = count === null ? (page ?? navigation.position) : Math.max(1,Math.min(count,Number.isFinite(requested) ? Math.trunc(requested) : 1));
  if (navigation.position !== current || navigation.revealed !== revealed || !Object.is(navigation.given,page)) {
    setNavigation({position:current,given:page,revealed});
  }
  const offset = (current - 1) * size;
  const visible = remote ? rows : matching.slice(offset,offset + size);
  const activeColumns = columns.filter(column => filters.has(column.key));
  const editor = columns.find(column => column.key === editing);
  const changePage = (next: number) => {
    if (page === undefined) setNavigation(previous => ({...previous,position:next}));
    else if (next !== page) onPageChange?.(next);
  };
  const lastPage = useRef(1), corrected = useRef('');
  useEffect(() => {
    const correction = count === null || page === undefined || page === current ? '' : String(page) + '/' + current;
    if (page === undefined && lastPage.current !== current || correction && corrected.current !== correction) onPageChange?.(current);
    lastPage.current = current;
    corrected.current = correction;
  },[page,current,onPageChange,count]);
  const apply = (column: string, filter: ColumnFilter) => {
    const next = new Map(filters);
    if (hasCriteria(filter)) next.set(column,filter); else next.delete(column);
    if (remote) remote.onCriteria(next,remote.sort);
    else {setFilters(next); changePage(1);}
    setEditing(null);
    // Clearing a filter removes its chip. The column still provides a keyboard return destination.
    if (filterOpener.current?.closest('.financial-analysis-filters') && !next.has(column)) {
      queueMicrotask(() => filterHeaders.current.get(column)?.focus({preventScroll:true}));
    }
  };
  const clearAll = () => {
    if (remote) remote.onCriteria(new Map(),remote.sort);
    else {setFilters(new Map()); changePage(1);}
  };
  const sortBy = (column: FinancialColumn<T>, direction: FinancialSort['direction']) => {
    const next = {key:column.key,direction};
    if (remote) remote.onCriteria(filters,next);
    else {setSort(next); changePage(1);}
  };
  const loading = count === null && !remote?.error;
  return <div ref={panel} className={'financial-analysis' + (maximized ? ' financial-analysis--expanded' : '')}
    role={maximized ? 'dialog' : undefined} aria-modal={maximized || undefined} aria-label={maximized ? label : undefined}>
    <div className="financial-analysis-tools">
      {total !== null && matched !== null && <span className="financial-analysis-count" role="status">
        {activeColumns.length ? matched + ' of ' + total : total}{total === 1 ? ' record' : ' records'}</span>}
      <button ref={expandControl} type="button" className="financial-analysis-expand" onClick={() => setMaximized(value => !value)}
        aria-label={maximized ? 'Restore table' : 'Expand table'} aria-expanded={maximized}>
        <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d={maximized ?
          'M2 7h5V2m6 0v5h5M2 13h5v5m6 0v-5h5' : 'M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4'} /></svg>
        {maximized ? 'Restore' : 'Expand'}</button>
      {actions}
    </div>
    {activeColumns.length > 0 && <div className="financial-analysis-filters" role="group" aria-label="Applied filters">
      {activeColumns.map((column,index) => {
        const criteria = describeColumnFilter(column,filters.get(column.key)!);
        const descriptionId = instance + '-criteria-' + index;
        return <button key={column.key} type="button" aria-label={'Edit ' + column.label + ' filter'} aria-describedby={descriptionId}
          title={column.label + ' · ' + criteria} aria-haspopup="dialog" onClick={event => {filterOpener.current=event.currentTarget;setEditing(column.key);}}>
          <span className="financial-analysis-chip">{column.label}{/^[=≥≤]/u.test(criteria) ? ' ' : ' · '}<span id={descriptionId}>{criteria}</span></span>
          <Icon name="filter" /></button>;
      })}
      <button type="button" className="financial-analysis-clear" onClick={clearAll}>Clear all filters</button>
    </div>}
    <div className="financial-analysis-scroll" role="region" aria-label={label + ' table scroll area'} tabIndex={0}>
      <table className="financial-analysis-grid" aria-label={label} aria-busy={loading || remote?.refreshing || undefined}>
        <thead><tr>{columns.map((column,index) => {
          const selectedSort = sort?.key === column.key ? sort.direction : undefined;
          const next = selectedSort === 'asc' ? 'desc' : 'asc';
          const filtered = filters.has(column.key), filteredId = instance + '-filtered-' + index;
          return <th key={column.key} scope="col" aria-label={column.label}
            className={column.align === 'end' || !column.align && column.kind === 'number' ? 'financial-analysis-number' : undefined}
            aria-sort={selectedSort ? selectedSort === 'asc' ? 'ascending' : 'descending' : undefined}>
            <div className="financial-analysis-heading">
              <button type="button" className="financial-analysis-sort" onClick={() => sortBy(column,next)}
                aria-label={'Sort ' + column.label + (next === 'asc' ? ' ascending' : ' descending')}>
                <CompactText>{column.label}</CompactText><span className="financial-analysis-sort-mark" data-direction={selectedSort} aria-hidden="true">
                  {selectedSort === 'asc' ? '↑' : selectedSort === 'desc' ? '↓' : '↕'}</span>
              </button>
              <button type="button" className="financial-analysis-filter" data-filtered={filtered || undefined}
                aria-label={'Filter ' + column.label} aria-haspopup="dialog" aria-expanded={editing === column.key}
                ref={element => {if (element) filterHeaders.current.set(column.key,element); else filterHeaders.current.delete(column.key);}}
                aria-describedby={filtered ? filteredId : undefined} onClick={event=>{filterOpener.current=event.currentTarget;setEditing(column.key);}}><Icon name="filter" /></button>
              {filtered && <span className="financial-analysis-sr" id={filteredId}>Filter applied</span>}
            </div>
          </th>;
        })}</tr></thead>
        <tbody className={count === null ? undefined : 'admin-content-enter'}>{visible.map(row => {
          const key = rowKey(row);
          return <Fragment key={key}><tr>{columns.map(column => {
            const value = column.render ? column.render(row) : formatAnalysisCell(column,row);
            const compact = typeof value === 'string' && (column.kind === 'text' || column.kind === 'category');
            return <td key={column.key} data-kind={column.kind}
            className={column.align === 'end' || !column.align && column.kind === 'number' ? 'financial-analysis-number' : undefined}>
            <div className="financial-analysis-value">{compact ? <CompactText cell>{value}</CompactText> : value}</div>
          </td>;})}</tr>
          {expanded?.key === key && <tr className="financial-analysis-detail-row"><td colSpan={columns.length}>
            <div className="financial-analysis-detail">{expanded.content}</div>
          </td></tr>}</Fragment>;
        })}
        {!visible.length && count !== null && <tr><td colSpan={Math.max(1,columns.length)} className="financial-analysis-empty">
          <span>{activeColumns.length ? 'No matching records.' : 'No records.'}</span></td></tr>}
        </tbody>
      </table>
    </div>
    {loading && <LoadingState label="Loading payments" layout="table" />}
    {remote?.error}
    {summary && <div className="financial-analysis-summary admin-content-enter">{summary(matching)}</div>}
    {count !== null && count > 1 && <nav className="financial-analysis-pager" aria-label={label + ' pages'}>
      <span>Page {current} of {count}</span>
      <button type="button" aria-label="Previous page" disabled={current === 1} onClick={() => changePage(current - 1)}>Previous</button>
      <button type="button" aria-label="Next page" disabled={current === count} onClick={() => changePage(current + 1)}>Next</button>
    </nav>}
    {editor && <FilterEditor key={editor.key} column={editor} rows={rows} remote={!!remote} active={filters.get(editor.key) ?? emptyFilter}
      close={() => setEditing(null)} apply={filter => apply(editor.key,filter)} />}
  </div>;
}
