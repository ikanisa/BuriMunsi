import {useState} from 'react';
import {act, fireEvent, render, screen, within} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {CoreListPage} from '../../src/features/core/CoreListPage';
import {comparableMemberPhone, matchesMemberPhone, readCompleteRoster, rosterSearch} from '../../src/features/core/memberRosterRead';
import {readRosterCriteria, rosterLocation, safeRosterReturn} from '../../src/features/core/memberRosterLocation';
import type {AdminRequest, DataRow} from '../../src/features/core/types';
import fixture from './canonical-core-fixtures.json';

function member(index: number, changes: Record<string,unknown> = {}): DataRow {
  const id = '70000000-0000-4000-8000-' + String(index).padStart(12,'0'), collectId = String(index).padStart(6,'0');
  const name = 'Directory member ' + index;
  return {...fixture.members.rows[0],id,person_id:id,collect_user_id:id,public_id:collectId,title:collectId,subtitle:name,display_name:name,
    membership_status:'active',phone_e164:null,whatsapp_number:null,momo_number:null,...changes};
}
const roster = (count:number) => Array.from({length:count}, (_,index) => member(index + 1));
const page = (rows:readonly DataRow[],total:number) => ({...fixture.members,rows,total});
const offsetOf = (path:string) => Number(new URL(path,'https://fixture.invalid').searchParams.get('offset'));
function Directory({request, start='?sort=public_id_asc', visit=vi.fn()}: {request:AdminRequest; start?:string; visit?:(path:string)=>void}) {
  const [search,setSearch] = useState(start);
  return <CoreListPage area="members" scopedMember permissions={['users.read']} actorId="fixture-member-staff" principalId={null}
    role="staff" authorityKey="directory-fixture" financialModel="canonical_evidence_ledger" request={request} locationSearch={search}
    navigate={path => {visit(path); if (path.split('?')[0] === '/admin/members') setSearch(new URL(path,'https://fixture.invalid').search);}} />;
}

describe('complete scoped member roster', () => {
  it('checks the whole authorized roster before exposing rows and searches across API and table pages without further reads', async () => {
    const records = roster(103);
    const selectedName = 'Élodie Jean-Claude';
    records[102] = member(103,{display_name:selectedName,subtitle:selectedName,momo_number:'0788000512',member_type:'direct'});
    let finish!: (value:Record<string,unknown>)=>void;
    const later = new Promise<Record<string,unknown>>(resolve => {finish = resolve;});
    const request = vi.fn((path:string) => offsetOf(path) === 0 ? Promise.resolve(page(records.slice(0,100),103)) : later);
    const visit = vi.fn();
    render(<Directory request={request} visit={visit} />);
    expect(await screen.findByText('Loading members')).toBeVisible();
    expect(screen.queryByText('Directory member 1')).toBeNull();
    await act(async () => {finish(page(records.slice(100),103));});
    const table = screen.getByRole('table',{name:'Members'}), search = screen.getByRole('textbox',{name:'Search Members'});
    expect(within(table).getByText('000001')).toBeVisible();
    expect(within(table).queryByText(selectedName)).toBeNull();
    expect(screen.getByText('Page 1 of 5')).toBeVisible();
    for (const input of ['claud ELO','jeancla','000103','+250 (788) 000-512','elo 0788 000 512','type:direct status:active élo']) {
      fireEvent.change(search,{target:{value:input}});
      expect(within(table).getAllByRole('row')).toHaveLength(2);
      expect(within(table).getByText(selectedName)).toBeVisible();
    }
    fireEvent.click(screen.getByRole('button',{name:'Search'}));
    expect(visit).toHaveBeenLastCalledWith('/admin/members?search=type%3Adirect+status%3Aactive+%C3%A9lo&sort=public_id_asc');
    fireEvent.click(screen.getByRole('button',{name:'View 000103'}));
    const destination = new URL(visit.mock.lastCall![0],'https://fixture.invalid');
    expect(destination.pathname).toBe('/admin/members/' + records[102].id);
    expect(safeRosterReturn(destination.searchParams.get('returnTo'))).toBe(visit.mock.calls.at(-2)![0]);
    fireEvent.click(screen.getByRole('button',{name:'Clear search'}));
    fireEvent.click(screen.getByRole('button',{name:'Next page'}));
    expect(within(table).getByText('000026')).toBeVisible();
    expect(screen.queryByRole('button',{name:'Filter Open'})).toBeNull();
    expect(request.mock.calls.map(([path]) => offsetOf(path))).toEqual([0,100]);
    for (const [path] of request.mock.calls) {
      expect([...new URL(path,'https://fixture.invalid').searchParams.keys()].sort()).toEqual(['country','directory','limit','offset','sort']);
    }
  });

  it('combines independent popup filters, sorts every matching record and preserves the criteria for a profile return', async () => {
    const records = [member(1,{display_name:'Éliane Kabera',phone_e164:'+250788001251'}),
      member(2,{display_name:'Eliane Kabera',momo_number:'0788001252'}),member(3,{display_name:'Eliane Rwema'}),
      member(4,{display_name:'Unrelated'}),member(5,{display_name:'Éliane Kabera',membership_status:'inactive',active_groups:0,amount:'0 groups'})];
    const request = vi.fn(async () => page(records,records.length)), visit = vi.fn();
    render(<Directory request={request} visit={visit}/>);
    const table = await screen.findByRole('table',{name:'Members'});
    const filterText = (column:string, text:string) => {
      fireEvent.click(screen.getByRole('button',{name:'Filter ' + column}));
      const editor = within(screen.getByRole('dialog',{name:'Filter ' + column}));
      fireEvent.change(editor.getByRole('searchbox',{name:'Contains'}),{target:{value:text}});
      fireEvent.click(editor.getByRole('button',{name:'Apply filter'}));
    };
    filterText('Name on MoMo','kab él');
    filterText('Mobile number','0788 001');
    fireEvent.click(screen.getByRole('button',{name:'Filter Status'}));
    const status = within(screen.getByRole('dialog',{name:'Filter Status'}));
    fireEvent.click(status.getByRole('checkbox',{name:'Active'}));
    fireEvent.click(status.getByRole('button',{name:'Apply filter'}));
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button',{name:'Sort Mobile number ascending'}));
    fireEvent.click(screen.getByRole('button',{name:'Sort Mobile number descending'}));
    expect(within(within(table).getAllByRole('row')[1]).getByText('000002')).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'View 000002'}));
    const back = new URL(visit.mock.lastCall![0],'https://fixture.invalid').searchParams.get('returnTo');
    expect(safeRosterReturn(back)).toBe(back);
    const result = readRosterCriteria(back!.split('?')[1]);
    expect(result.sort).toEqual({key:'phone',direction:'desc'});
    expect(result.filters.get('full_name')?.text).toBe('kab él');
    expect(result.filters.get('phone')?.text).toBe('0788 001');
    expect(result.filters.get('status')?.choices).toEqual(['active']);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('applies an updated search during the pending refresh to the last verified roster and then its replacement', async () => {
    const initial = [member(1,{display_name:'Charles'}),member(2,{display_name:'Danielle'})];
    let finish!: (value:Record<string,unknown>)=>void;
    const fresh = new Promise<Record<string,unknown>>(resolve => {finish=resolve;});
    const request = vi.fn().mockResolvedValueOnce(page(initial,initial.length)).mockReturnValueOnce(fresh);
    render(<Directory request={request}/>);
    const table = await screen.findByRole('table',{name:'Members'});
    fireEvent.click(screen.getByRole('button',{name:'Refresh Members'}));
    fireEvent.change(screen.getByRole('textbox',{name:'Search Members'}),{target:{value:'dani'}});
    expect(table).toHaveAttribute('aria-busy','true');
    expect(within(table).queryByText('Charles')).toBeNull();
    expect(within(table).getByText('Danielle')).toBeVisible();
    await act(async () => {finish(page([member(1,{display_name:'Daniela'})],1));});
    expect(within(table).getByText('Daniela')).toBeVisible();
    expect(within(table).queryByText('Danielle')).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(['0788000512','788000512','250788000512','+250788000512','00250 788 000-512'])('normalizes the recorded Rwanda format %s across local and international searches', stored => {
    expect(comparableMemberPhone(stored)).toBe('250788000512');
    for (const query of ['0788 000-512','788000512','+250 (788) 000-512','00250 788 000 512','000512']) {
      expect(matchesMemberPhone(stored,query)).toBe(true);
    }
    expect(matchesMemberPhone(stored,'+256788000512')).toBe(false);
  });

  it('supports an international contact and only matches fields actually displayed in the directory', () => {
    const one = member(12,{phone_e164:'+256700123456',momo_number:'0788000512',momo_pay_code:'452718'});
    expect(rosterSearch('+256 (700) 123 456')(one)).toBe(true);
    expect(rosterSearch('0788000512')(one)).toBe(false);
    expect(rosterSearch('452718')(one)).toBe(false);
    expect(rosterSearch('status:inactive')(one)).toBe(false);
    expect(rosterSearch('...')(one)).toBe(false);
    expect(rosterSearch('000012')(one)).toBe(true);
    expect(rosterSearch('003')(member(3))).toBe(true);
  });

  it.each(['total','id','order'])('restarts once on inter-page %s drift and rejects a second incompatible read', async change => {
    const records = roster(101), first = page(records.slice(0,100),101);
    const last = change === 'total' ? page([],100) : page([change === 'id' ? records[0] : member(101,{created_at:'2020-01-01T00:00:00.000Z'})],101);
    const request = vi.fn(async (path:string) => offsetOf(path) === 0 ? first : last);
    await expect(readCompleteRoster(request,new AbortController().signal)).rejects.toThrow();
    expect(request.mock.calls.map(([path]) => offsetOf(path))).toEqual([0,100,0,100]);
  });

  it('accepts a consistent replacement after one live total change and stops reading on an aborted scope', async () => {
    const records=roster(201), first=page(records.slice(0,100),201);
    const recovered=vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(page([],0)).mockResolvedValueOnce(page([],0));
    await expect(readCompleteRoster(recovered,new AbortController().signal)).resolves.toEqual([]);
    const controller = new AbortController();
    const aborted = vi.fn(async (path:string) => {
      if (offsetOf(path) === 0) return first;
      controller.abort(); return page(records.slice(100,200),201);
    });
    await expect(readCompleteRoster(aborted,controller.signal)).rejects.toMatchObject({name:'AbortError'});
    expect(aborted.mock.calls.map(([path]) => offsetOf(path))).toEqual([0,100]);
  });

  it('only restores a supported directory return and rejects unknown routes, duplicate parameters and unsupported filter input', () => {
    const old = '/admin/users?search=Alice&sort=public_id_asc&status=active&page=2';
    const normalized = '/admin/members?search=Alice&status=active&sort=public_id_asc&page=2';
    expect(safeRosterReturn(old)).toBe(normalized);
    expect(rosterLocation(readRosterCriteria(normalized.split('?')[1]))).toBe(normalized);
    for (const unsafe of ['https://elsewhere.invalid/admin/members','//elsewhere.invalid/admin/members','/admin/members/../users',
      '/admin/members?search=x&search=y','/admin/members?secret=x','/admin/members#private']) expect(safeRosterReturn(unsafe)).toBe('/admin/members');
    expect(readRosterCriteria('?filters=' + encodeURIComponent('[["operator","any","private"],["status","any",["owner"]]]')).filters.size).toBe(0);
  });
});
