// Shared browser/Edge parity for canonical payment filters. No I/O, auth, or UI.
const collator = new Intl.Collator('en', {numeric:true, sensitivity:'base'});
export function hasCriteria(filter) {
  return filter.presence !== 'any' || !!filter.text.trim() || !!filter.min || !!filter.max || filter.choices.length > 0;
}
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
const day = 86_400_000;

// The Admin's recorded calendar dates use Kigali time. Numeric timestamps are Unix milliseconds.
export function dateValue(value) {
  const at = typeof value === 'number' ? value : Date.parse(dateOnly.test(value) ? value + 'T00:00:00+02:00' : value);
  return Number.isFinite(at) && Math.abs(at) <= 8.64e15 ? at : null;
}
export function comparable(value, kind) {
  if (value == null || typeof value === 'string' && !value.trim()) return null;
  if (kind === 'date') return dateValue(value);
  if (kind === 'number') {const number = Number(value); return Number.isFinite(number) ? number : null;}
  return String(value).trim();
}
function folded(value) {
  return value.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase('en');
}

export function paymentInstant(raw) {
  const text = raw?.trim();
  if (!text) return null;
  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  const ymd = /^(\d{4})([-/])(\d{2})\2(\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(text);
  const dmy = /^(\d{2})([-/])(\d{2})\2(\d{4})[T ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(text);
  let day, clock, seconds, fraction = '', zone = '+02:00';
  if (iso) {
    [,day,clock] = iso; seconds = iso[3] ?? '00'; fraction = iso[4] ?? ''; zone = iso[5];
  } else if (ymd) {
    day = [ymd[1],ymd[3],ymd[4]].join('-'); clock = ymd[5]; seconds = ymd[6] ?? '00';
  } else if (dmy && (Number(dmy[1]) > 12 || dmy[1] === dmy[3])) {
    day = [dmy[4],dmy[3],dmy[1]].join('-'); clock = dmy[5]; seconds = dmy[6] ?? '00';
  } else return null;
  const wall = day + 'T' + clock + ':' + seconds + '.' + fraction.slice(1,4).padEnd(3,'0');
  const check = Date.parse(wall + 'Z');
  if (!Number.isFinite(check) || new Date(check).toISOString().slice(0,23) !== wall) return null;
  const value = Date.parse(wall + zone);
  return Number.isFinite(value) ? value : null;
}

export function paymentEventInstant(row) {
  return paymentInstant(Object.hasOwn(row,'occurredAt') ? row.occurredAt : row.atRaw);
}

function columnPredicate(column, filter) {
  const {kind} = column;
  const needle = folded(filter.text.trim());
  const minimum = comparable(filter.min,kind), maximum = comparable(filter.max,kind);
  const choices = new Set(filter.choices);
  return row => {
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

export function analyzeFinancialRows(rows, columns, filters, sort) {
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


const recordedContact = value => typeof value === 'string' && value.trim() ? value : null;
export function paymentMemberName(row) {
  return (row.memberId ? recordedContact(row.memberName) : null) ?? recordedContact(row.payerNameRaw);
}
export function paymentMemberNumber(row) {
  return (row.memberId ? recordedContact(row.memberPhone) : null) ?? recordedContact(row.payerPhoneRaw);
}

const columns = [
  {key:'reference', kind:'text', value:r=>r.ftId},
  {key:'time', kind:'date', value:paymentEventInstant},
  {key:'amount', kind:'number', value:r=>r.amountRwf},
  {key:'direction', kind:'category', value:r=>r.direction, choices:['incoming','outgoing']},
  {key:'allocation', kind:'category', value:r=>r.state, choices:['allocated','unallocated']},
  {key:'memberName', kind:'text', value:paymentMemberName},
  {key:'memberNumber', kind:'text', value:paymentMemberNumber},
  // Keep the original query keys for already open Admin releases.
  {key:'counterparty', kind:'text', value:r=>r.payerNameRaw},
  {key:'member', kind:'text', value:r=>r.memberName},
  {key:'counterpartyId', kind:'text', value:r=>r.payerPhoneRaw},
  {key:'memberPhone', kind:'text', value:r=>r.memberPhone},
];
const smsColumn = {key:'sms', kind:'category', value:r=>r.sourceId ? 'linked' : 'none', choices:['linked','none']};
const allowed = showSms => showSms ? [...columns,smsColumn] : columns;
function decimalParts(raw) {
  const match=/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) return null;
  const fraction=match[3] ?? match[4] ?? '';
  const digits=((match[2] ?? '')+fraction).replace(/^0+/,'');
  if (!digits) return '0';
  const significant=digits.replace(/0+$/,'');
  const exponent=Number(match[5] ?? 0)-fraction.length+digits.length-significant.length;
  if (!Number.isSafeInteger(exponent)) return null;
  return (match[1]==='-'?'-':'')+significant+'e'+exponent;
}

export function validPaymentAmountBound(raw) {
  if (!raw || raw.length > 40) return !raw;
  const normalized=decimalParts(raw);
  const value=Number(raw);
  return normalized!==null && Number.isFinite(value) && Math.abs(value)<=Number.MAX_SAFE_INTEGER &&
    normalized===decimalParts(String(value));
}

const calendarDate = raw => dateOnly.test(raw) && Number.isFinite(Date.parse(raw)) && new Date(raw).toISOString().slice(0,10) === raw;
const fail = () => {throw new TypeError('Invalid Payments analysis query.');};
function exact(object, keys) {
  if (!object || typeof object !== 'object' || Array.isArray(object) ||
      Object.keys(object).length !== keys.length || !keys.every(key=>Object.hasOwn(object,key))) fail();
}
export function parsePaymentAnalysisQuery(value, showSms) {
  const revision=value?.revision;
  exact(value,['q','offset','limit','filters','sort',...(revision!==undefined?['revision']:[])]);
  if(revision!==undefined && (typeof revision!=='string'||!/^[a-f0-9]{64}$/.test(revision)))fail();
  const {q,offset,limit,filters,sort}=value;
  const definitions = new Map(allowed(showSms).map(column=>[column.key,column]));
  if (typeof q !== 'string' || q.length > 80 || !Number.isSafeInteger(offset) || offset < 0 || offset % 25 ||
      limit !== 25 || !Array.isArray(filters) || filters.length > definitions.size) fail();
  exact(sort,['key','direction']);
  if (!definitions.has(sort.key) || !['asc','desc'].includes(sort.direction)) fail();
  const seen = new Set();
  for (const filter of filters) {
    exact(filter,['key','presence','text','min','max','choices']);
    const {key,presence,text,min,max,choices}=filter;
    const column=definitions.get(key);
    if (!column || seen.has(key) || !['any','blank','present'].includes(presence) || typeof text!=='string' || text.length > 200 ||
        typeof min!=='string'||min.length > 40||typeof max!=='string'||max.length > 40||!Array.isArray(choices)) fail();
    if ((column.kind!=='text' && text) || (!['number','date'].includes(column.kind) && (min||max)) ||
        choices.length > (column.choices?.length ?? 0) || (choices.length && (!choices.every(x=>column.choices.includes(x)) ||
        new Set(choices).size!==choices.length)) || (presence==='blank' && (text||min||max||choices.length))) fail();
    if (column.kind==='number' && (!validPaymentAmountBound(min) || !validPaymentAmountBound(max))) fail();
    if (column.kind==='date' && ((min && !calendarDate(min)) || (max && !calendarDate(max)))) fail();
    const lower=min?comparable(min,column.kind):null, upper=max?comparable(max,column.kind):null;
    if ((min&&lower===null)||(max&&upper===null)||(lower!==null&&upper!==null&&lower>upper)) fail();
    seen.add(key);
  }
  return {q,offset,limit,filters,sort,...(revision!==undefined&&{revision})};
}

export function analyzeCanonicalPaymentRows(rows, filters, sort, showSms) {
  return analyzeFinancialRows(rows, allowed(showSms), new Map(filters.map(({key,...value})=>[key,value])), sort);
}
