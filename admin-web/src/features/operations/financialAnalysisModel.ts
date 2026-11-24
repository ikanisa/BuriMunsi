import type {ReactNode} from 'react';

export interface FinancialColumn<T> {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'date' | 'category';
  value: (row: T) => string | number | null;
  render?: (row: T) => ReactNode;
  options?: readonly {value: string; label: string}[];
  align?: 'start' | 'end';
}
export interface FinancialSort {key: string; direction: 'asc' | 'desc'}
export interface ColumnFilter {
  presence: 'any' | 'blank' | 'present';
  text: string;
  min: string;
  max: string;
  choices: readonly string[];
}
export type ColumnFilters = ReadonlyMap<string, ColumnFilter>;
export const emptyFilter: ColumnFilter = {presence:'any', text:'', min:'', max:'', choices:[]};

const collator = new Intl.Collator('en', {numeric:true, sensitivity:'base'});
const numberFormat = new Intl.NumberFormat('en-GB', {maximumFractionDigits:20});
const dateFormat = new Intl.DateTimeFormat('en-GB', {dateStyle:'medium', timeZone:'Africa/Kigali'});
const timeFormat = new Intl.DateTimeFormat('en-GB', {dateStyle:'medium', timeStyle:'short', timeZone:'Africa/Kigali'});
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
const day = 86_400_000;
type Value = string | number | null;
type Kind = FinancialColumn<unknown>['kind'];

// The Admin's recorded calendar dates use Kigali time. Numeric timestamps are Unix milliseconds.
function dateValue(value: string | number): number | null {
  const at = typeof value === 'number' ? value : Date.parse(dateOnly.test(value) ? value + 'T00:00:00+02:00' : value);
  return Number.isFinite(at) && Math.abs(at) <= 8.64e15 ? at : null;
}
function comparable(value: Value, kind: Kind): Value {
  if (value === null || typeof value === 'string' && !value.trim()) return null;
  if (kind === 'date') return dateValue(value);
  if (kind === 'number') {const number = Number(value); return Number.isFinite(number) ? number : null;}
  return String(value).trim();
}
function folded(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase('en');
}

export function initialColumnFilters<T>(columns: readonly FinancialColumn<T>[], initial?: Readonly<Record<string,string>>): ColumnFilters {
  const filters = new Map<string,ColumnFilter>();
  for (const column of columns) {
    const value = initial && Object.hasOwn(initial,column.key) ? initial[column.key]?.trim() : '';
    if (!value) continue;
    if (column.kind === 'text') filters.set(column.key,{...emptyFilter,text:value});
    if (column.kind === 'category') filters.set(column.key,{...emptyFilter,choices:[value]});
  }
  return filters;
}
export function hasCriteria(filter: ColumnFilter): boolean {
  return filter.presence !== 'any' || !!filter.text.trim() || !!filter.min || !!filter.max || filter.choices.length > 0;
}
export function describeColumnFilter<T>(column: FinancialColumn<T>, filter: ColumnFilter): string {
  if (filter.presence === 'blank') return 'Blank';
  const parts: string[] = [];
  if (column.kind === 'text' && filter.text) parts.push('Contains “' + filter.text + '”');
  if (column.kind === 'category' && filter.choices.length) {
    const labels = new Map(column.options?.map(option => [option.value,option.label]));
    parts.push(filter.choices.map(value => labels.get(value) ?? value).join(', '));
  }
  if (column.kind === 'number' || column.kind === 'date') {
    const calendar = column.kind === 'date';
    const display = (raw: string) => calendar ? dateFormat.format(dateValue(raw)!) : numberFormat.format(Number(raw));
    if (filter.min && filter.max && comparable(filter.min,column.kind) === comparable(filter.max,column.kind)) {
      parts.push((calendar ? '' : '= ') + display(filter.min));
    } else {
      if (filter.min) parts.push((calendar ? 'From ' : '≥ ') + display(filter.min));
      if (filter.max) parts.push((calendar ? 'Through ' : '≤ ') + display(filter.max));
    }
  }
  if (filter.presence === 'present') parts.push('Non-blank');
  return parts.join(' · ');
}
export function rangeError(filter: ColumnFilter, kind: Kind): string | undefined {
  if (filter.presence === 'blank' || (kind !== 'date' && kind !== 'number')) return;
  const from = comparable(filter.min,kind), through = comparable(filter.max,kind);
  if (filter.min && from === null || filter.max && through === null) return kind === 'date' ? 'Enter a valid date.' : 'Enter a valid number.';
  if (from !== null && through !== null && from > through) {
    return kind === 'date' ? 'Enter an end date on or after the start date.' : 'The maximum must be at least the minimum.';
  }
}

function columnPredicate<T>(column: FinancialColumn<T>, filter: ColumnFilter) {
  const {kind} = column;
  const needle = folded(filter.text.trim());
  const minimum = comparable(filter.min,kind), maximum = comparable(filter.max,kind);
  const choices = new Set(filter.choices);
  return (row: T): boolean => {
    const value = comparable(column.value(row),kind);
    if (filter.presence === 'blank') return value === null;
    if (value === null) return false;
    if (kind === 'text') return !needle || folded(String(value)).includes(needle);
    if (kind === 'category') return !choices.size || choices.has(String(value));
    if (typeof value !== 'number') return false;
    if (typeof minimum === 'number' && value < minimum) return false;
    if (typeof maximum !== 'number') return true;
    return kind === 'date' ? value < maximum + day : value <= maximum;
  };
}

export function analyzeFinancialRows<T>(rows: readonly T[], columns: readonly FinancialColumn<T>[], filters: ColumnFilters,
    sort?: FinancialSort): readonly T[] {
  const predicates = columns.flatMap(column => {
    const filter = filters.get(column.key);
    return filter && hasCriteria(filter) ? [columnPredicate(column,filter)] : [];
  });
  const matches = predicates.length ? rows.filter(row => predicates.every(test => test(row))) : rows;
  const column = sort && columns.find(item => item.key === sort.key);
  if (!column || !sort) return matches;
  const direction = sort.direction === 'asc' ? 1 : -1;
  return matches.map((row,index) => ({row,index,value:comparable(column.value(row),column.kind)}))
    .sort((left,right) => {
      const a = left.value, b = right.value;
      if (a === null || b === null) return a === b ? left.index - right.index : a === null ? 1 : -1;
      const compared = typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a),String(b));
      return direction * compared || left.index - right.index;
    }).map(item => item.row);
}

export function categoryChoices<T>(column: FinancialColumn<T>, rows: readonly T[], selected: readonly string[]) {
  const options = new Map((column.options ?? []).map(item => [item.value,item.label]));
  const values = new Set(selected);
  for (const row of rows) {
    const value = comparable(column.value(row),'category');
    if (value !== null) values.add(String(value));
  }
  return [...values].map(value => ({value, label:options.get(value) ?? value})).sort((a,b) => collator.compare(a.label,b.label));
}

export function formatAnalysisCell<T>(column: FinancialColumn<T>, row: T): string {
  const raw = column.value(row), value = comparable(raw,column.kind);
  if (value === null) return '—';
  if (column.kind === 'date') return (typeof raw === 'string' && dateOnly.test(raw) ? dateFormat : timeFormat).format(Number(value));
  if (column.kind === 'number') return numberFormat.format(Number(value));
  return column.options?.find(option => option.value === value)?.label ?? String(value);
}
