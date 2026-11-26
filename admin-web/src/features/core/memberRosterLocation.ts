import {emptyFilter, type ColumnFilter, type ColumnFilters, type FinancialSort} from '../operations/financialAnalysisModel';
import {containsControl} from './contracts';

const rosterPath = '/admin/members';
const sortKeys = ['created_at','public_id','full_name','member_type','phone','status'];
const textKeys = ['public_id','full_name','phone'];
const categoryValues: Record<string,readonly string[]> = {member_type:['direct','app'],status:['active','inactive']};
type FilterEntry = [string, ColumnFilter['presence'], string | readonly string[]];
export interface RosterCriteria {search:string; filters:ColumnFilters; sort:FinancialSort; page:number}

const validText = (value: unknown): value is string => typeof value === 'string' && value.length <= 200 && !containsControl(value);
function readColumns(encoded: string | null): Map<string,ColumnFilter> {
  const filters = new Map<string,ColumnFilter>();
  if (!encoded || encoded.length > 1400) return filters;
  try {
    const entries: unknown = JSON.parse(encoded);
    if (!Array.isArray(entries) || entries.length > 5) return filters;
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 3) continue;
      const [key,presence,value] = entry;
      if (typeof key !== 'string' || !['any','blank','present'].includes(presence) || filters.has(key)) continue;
      if (textKeys.includes(key) && validText(value) && (presence !== 'any' || value.trim())) {
        filters.set(key,{...emptyFilter,presence,text:presence === 'blank' ? '' : value.trim()});
      } else if (Object.hasOwn(categoryValues,key) && Array.isArray(value) &&
        value.length <= categoryValues[key].length && value.every(item => categoryValues[key].includes(item)) &&
        (presence !== 'any' || value.length)) {
        filters.set(key,{...emptyFilter,presence,choices:presence === 'blank' ? [] : [...new Set(value)]});
      }
    }
  } catch { /* An unrecognized filter cannot broaden the authenticated roster itself. */ }
  return filters;
}

export function readRosterCriteria(search: string): RosterCriteria {
  const params = new URLSearchParams(search), rawSort = params.get('sort') ?? '';
  const key = rawSort.slice(0,rawSort.lastIndexOf('_')), direction = rawSort.slice(rawSort.lastIndexOf('_') + 1);
  const sort: FinancialSort = sortKeys.includes(key) && (direction === 'asc' || direction === 'desc') ?
    {key,direction} : {key:'created_at', direction:'desc'};
  const filters = readColumns(params.get('filters')), status = params.get('status');
  if (status && categoryValues.status.includes(status)) filters.set('status',{...emptyFilter,choices:[status]});
  const page = Number(params.get('page') ?? 1), query = params.get('search') ?? '';
  return {search:validText(query) ? query.trim() : '', filters, sort,
    page:Number.isSafeInteger(page) && page >= 1 && page <= 85899346 ? page : 1};
}

export function rosterLocation({search,sort,filters,page}: RosterCriteria) {
  const params = new URLSearchParams();
  if (search) params.set('search',search);
  const entries: FilterEntry[] = [];
  for (const [key,filter] of filters) {
    if (key === 'status' && filter.presence === 'any' && filter.choices.length === 1) params.set('status',filter.choices[0]);
    else entries.push([key,filter.presence,textKeys.includes(key) ? filter.text : filter.choices]);
  }
  if (entries.length) params.set('filters',JSON.stringify(entries));
  if (sort.key !== 'created_at' || sort.direction !== 'desc') params.set('sort',sort.key + '_' + sort.direction);
  if (page > 1) params.set('page',String(page));
  const query = params.toString();
  return query ? rosterPath + '?' + query : rosterPath;
}

export function safeRosterReturn(raw?: string | null) {
  if (!raw || raw.length > 16384 || containsControl(raw,true) || raw.includes('\\') || raw.includes('#')) return rosterPath;
  const question = raw.indexOf('?'), path = question < 0 ? raw : raw.slice(0,question);
  if (path !== rosterPath && path !== '/admin/users') return rosterPath;
  const search = question < 0 ? '' : raw.slice(question + 1), keys = [...new URLSearchParams(search).keys()];
  if (keys.some(key => !['search','filters','status','sort','page'].includes(key)) || new Set(keys).size !== keys.length) return rosterPath;
  return rosterLocation(readRosterCriteria(search));
}
