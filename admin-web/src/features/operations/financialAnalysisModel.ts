import type {ReactNode} from 'react';
import {analyzeFinancialRows as analyzePaymentRows, comparable, hasCriteria}
  from '../../../../supabase/functions/_shared/domain/burimunsi/payment-analysis-shared.mjs';
export {hasCriteria};

export interface FinancialColumn<T> {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'date' | 'category';
  value: (row: T) => string | number | null;
  render?: (row: T) => ReactNode;
  options?: readonly {value: string; label: string}[];
  align?: 'start' | 'end';
  exactInteger?: boolean;
  matchText?: (value: string, query: string) => boolean;
  filterable?: boolean;
  sortable?: boolean;
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

function exactInteger(value: string | number | null) {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  const raw = value.trim();
  if (!/^[+-]?(?:\d{1,31}|\d{1,3}(?:,\d{3})+)$/u.test(raw)) return null;
  const digits = raw.replaceAll(',', '');
  return digits.replace(/^[+-]/u, '').length <= 31 ? BigInt(digits) : null;
}

export function analyzeFinancialRows<T>(rows: readonly T[], columns: readonly FinancialColumn<T>[],
  filters: ColumnFilters, sort?: FinancialSort) {
  const standardFilters = new Map(filters);
  const customPredicates = columns.flatMap(column => {
    if (column.filterable === false) standardFilters.delete(column.key);
    const filter = standardFilters.get(column.key);
    if (!filter || !hasCriteria(filter)) return [];
    if (column.kind === 'number' && column.exactInteger) {
      standardFilters.delete(column.key);
      const min = exactInteger(filter.min), max = exactInteger(filter.max);
      return [(row: T) => {
        const value = exactInteger(column.value(row));
        return filter.presence === 'blank' ? value === null :
          value !== null && (min === null || value >= min) && (max === null || value <= max);
      }];
    }
    const match = column.kind === 'text' ? column.matchText : undefined;
    if (!match) return [];
    standardFilters.delete(column.key);
    const needle = filter.text.trim();
    return [(row: T) => {
      const value = comparable(column.value(row), 'text');
      return filter.presence === 'blank' ? value === null : value !== null && (!needle || match(String(value), needle));
    }];
  });
  const eligible = customPredicates.length ? rows.filter(row => customPredicates.every(test => test(row))) : rows;
  const orderedColumn = sort && columns.find(column => column.key === sort.key && column.sortable !== false);
  if (orderedColumn?.kind !== 'number' || !orderedColumn.exactInteger) {
    return analyzePaymentRows(eligible, columns, standardFilters, orderedColumn ? sort : undefined);
  }
  const matching = analyzePaymentRows(eligible, columns, standardFilters);
  const asc = sort?.direction === 'asc';
  return matching.map(row => ({row, value: exactInteger(orderedColumn.value(row))})).sort((left, right) => {
    const {value: a} = left, {value: b} = right;
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return (a < b) === asc ? -1 : 1;
  }).map(entry => entry.row);
}

export function initialColumnFilters<T>(columns: readonly FinancialColumn<T>[], initial?: Readonly<Record<string,string>>): ColumnFilters {
  const filters = new Map<string,ColumnFilter>();
  for (const column of columns) {
    const value = initial && Object.hasOwn(initial,column.key) ? initial[column.key]?.trim() : '';
    if (!value || column.filterable === false) continue;
    if (column.kind === 'text') filters.set(column.key,{...emptyFilter,text:value});
    if (column.kind === 'category') filters.set(column.key,{...emptyFilter,choices:[value]});
  }
  return filters;
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
    const comparableBound = (bound: string) => column.exactInteger ? exactInteger(bound) : comparable(bound, column.kind);
    const min = comparableBound(filter.min), max = comparableBound(filter.max);
    const display = (value: string | number | bigint) => calendar ? dateFormat.format(Number(value)) :
      numberFormat.format(typeof value === 'bigint' ? value : Number(value));
    if (min !== null && max !== null && min === max) {
      parts.push((calendar ? '' : '= ') + display(min));
    } else {
      if (min !== null) parts.push((calendar ? 'From ' : '≥ ') + display(min));
      if (max !== null) parts.push((calendar ? 'Through ' : '≤ ') + display(max));
    }
  }
  if (filter.presence === 'present') parts.push('Non-blank');
  return parts.join(' · ');
}
export function rangeError(filter: ColumnFilter, {kind, exactInteger: wholeAmount}: Pick<FinancialColumn<unknown>, 'kind' | 'exactInteger'>): string | undefined {
  if (filter.presence === 'blank' || (kind !== 'date' && kind !== 'number')) return;
  const parse = (value: string) => wholeAmount ? exactInteger(value) : comparable(value, kind);
  const from = parse(filter.min), through = parse(filter.max);
  if (filter.min && from === null || filter.max && through === null) {
    return kind === 'date' ? 'Enter a valid date.' : wholeAmount ? 'Enter a whole number.' : 'Enter a valid number.';
  }
  if (from !== null && through !== null && from > through) {
    return kind === 'date' ? 'Enter an end date on or after the start date.' : 'The maximum must be at least the minimum.';
  }
}

export function categoryChoices<T>(column: FinancialColumn<T>, rows: readonly T[], selected: readonly string[]) {
  const options = new Map((column.options ?? []).map(item => [item.value,item.label]));
  const values = new Set([...options.keys(), ...selected]);
  for (const row of rows) {
    const value = comparable(column.value(row),'category');
    if (value !== null) values.add(String(value));
  }
  return [...values].map(value => ({value, label:options.get(value) ?? value})).sort((a,b) => collator.compare(a.label,b.label));
}

export function formatAnalysisCell<T>(column: FinancialColumn<T>, row: T): string {
  const raw = column.value(row);
  const value = column.kind === 'number' && column.exactInteger ? exactInteger(raw) : comparable(raw,column.kind);
  if (value === null) return '—';
  if (column.kind === 'date') return (typeof raw === 'string' && dateOnly.test(raw) ? dateFormat : timeFormat).format(Number(value));
  if (column.kind === 'number') return numberFormat.format(typeof value === 'bigint' ? value : Number(value));
  return column.options?.find(option => option.value === value)?.label ?? String(value);
}
