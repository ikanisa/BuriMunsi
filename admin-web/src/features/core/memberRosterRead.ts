import {normalizeLoginPhone} from '../../session/phonePasscode';
import {AdminRequestError} from '../../api/client';
import {isSafeCount, memberMobileNumber, parseMemberRosterPage} from './contracts';
import type {AdminRequest, DataRow} from './types';

const pageSize = 100;
export const rosterUnavailable = 'The member records could not be verified. Try again.';
class RosterChanged extends Error {}

async function readRoster(request: AdminRequest, signal: AbortSignal): Promise<DataRow[]> {
  const rows: DataRow[] = [], seen = new Set<string>();
  let total: number | undefined;
  do {
    signal.throwIfAborted();
    const offset = rows.length;
    if (offset > 2147483647) throw new Error(rosterUnavailable);
    const query = new URLSearchParams({directory:'roster', country:'RW', limit:String(pageSize), offset:String(offset), sort:'created_at_asc'});
    const data = await request('core/members?' + query, {signal}).catch((error: unknown) => {
      signal.throwIfAborted();
      if (error instanceof AdminRequestError && error.statusCode === 503) {
        throw new AdminRequestError('Members are temporarily unavailable. Try again.');
      }
      throw new AdminRequestError(rosterUnavailable);
    });
    signal.throwIfAborted();
    if (total !== undefined && isSafeCount(data.total) && total !== data.total) throw new RosterChanged();
    const page = parseMemberRosterPage(data, pageSize, offset);
    total = page.total;
    for (const row of page.rows) {
      if (row.member_type !== 'direct' && row.member_type !== 'app') throw new Error(rosterUnavailable);
      const previous = rows.at(-1);
      if (seen.has(row.id) || previous && (row.created_at < previous.created_at ||
          row.created_at === previous.created_at && row.id <= previous.id)) throw new RosterChanged();
      seen.add(row.id);
      rows.push(row);
    }
  } while (rows.length < total);
  return rows;
}

/** Each page verifies its own count and rows. Restart once if the live roster moved between pages. */
export async function readCompleteRoster(request: AdminRequest, signal: AbortSignal) {
  try {
    return await readRoster(request, signal);
  } catch (error) {
    if (!(error instanceof RosterChanged)) throw error;
    return readRoster(request, signal);
  }
}

const fold = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();
const words = (value: string) => fold(value).match(/[\p{L}\p{N}]+/gu) ?? [];

export function matchesMemberName(name: string, query: string) {
  const fragments = words(query), names = words(name);
  const joined = names.join('');
  return fragments.length > 0 && fragments.every(fragment => joined.includes(fragment));
}

const phoneInput = /^[+\d\s().-]+$/u;
const digitsOnly = (value: string) => value.replace(/\D/gu,'');

export function comparableMemberPhone(phone: string) {
  try {return digitsOnly(normalizeLoginPhone(phone));} catch {return digitsOnly(phone);}
}

export function matchesMemberPhone(phone: string, query: string) {
  if (!phoneInput.test(query)) return false;
  const digits = digitsOnly(query);
  if (!digits) return false;
  const canonical = comparableMemberPhone(phone);
  if (query.trim().startsWith('+')) return canonical.startsWith(digits);
  if (/^00[1-9]/u.test(digits) && canonical.startsWith(digits.slice(2))) return true;
  if (digits.startsWith('0') && /^2507\d{8}$/u.test(canonical) && ('0' + canonical.slice(3)).startsWith(digits)) return true;
  return canonical.includes(digits);
}

/** Compile one visible-column query for the complete authorized roster. */
export function rosterSearch(query: string): (row: DataRow) => boolean {
  const value = fold(query).trim();
  if (!value) return () => true;
  const typed: {column:'member_type'|'membership_status'; value:string}[] = [];
  const terms = value.replace(/\b(status|type):([^\s]+)/gu, (_,column,term) => {
    typed.push({column:column === 'status' ? 'membership_status' : 'member_type',value:term});
    return ' ';
  }).replace(/\b(without|with)\s+groups?\b/gu, (_,word) => {
    typed.push({column:'membership_status',value:word === 'with' ? 'active' : 'inactive'});
    return ' ';
  });
  const numberRun = /\+?\d(?:[\d\s().-]*\d)?/gu;
  const numbers = terms.match(numberRun) ?? [], fragments = words(terms.replace(numberRun,' '));
  const names = fragments.filter(term => {
    if (term === 'active' || term === 'inactive') typed.push({column:'membership_status',value:term});
    else if (term === 'direct' || term === 'app') typed.push({column:'member_type',value:term});
    else return true;
    return false;
  });
  return row => {
    if (!typed.every(test => row[test.column] === test.value)) return false;
    if (numbers.length) {
      const phone = memberMobileNumber(row);
      if (!numbers.every(number => (/^\d+$/u.test(number) && row.title.includes(number)) ||
          phone !== null && matchesMemberPhone(phone,number))) return false;
    }
    if (!names.length) return numbers.length > 0 || typed.length > 0;
    const name = row.display_name_recorded ? words(String(row.display_name)).join('') : '';
    return names.every(fragment => name.includes(fragment));
  };
}
