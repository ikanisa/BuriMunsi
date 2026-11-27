import {z} from 'zod';
import {isId} from './contracts';
import {AdminRequestError} from '../../api/client';
import {readRosterCriteria, type RosterCriteria} from './memberRosterLocation';
import {readCompleteRoster} from './memberRosterRead';
import type {AdminRequest, DataRow} from './types';

export type VisibleMember = Pick<DataRow,'id'|'title'|'created_at'> & Record<string,unknown>;
const revision = z.string().regex(/^[0-9a-f]{64}$/);
const schema = z.object({revision, offset:z.number().int().nonnegative(),limit:z.number().int().min(1).max(100),
  total:z.number().int().nonnegative().max(2147483647),matching:z.number().int().nonnegative(),
  items:z.array(z.object({id:z.string().refine(isId),publicId:z.string().regex(/^\d{6}$/),name:z.string().nullable(),
    type:z.enum(['direct','app']),status:z.enum(['active','inactive']),phone:z.string().nullable(),createdAt:z.iso.datetime()}).strict()).max(100)}).strict();

export function rosterWindowParams(criteria:RosterCriteria,limit=25,offset=(criteria.page-1)*limit) {
  const params = new URLSearchParams({directory:'roster',window:'1',country:'RW',limit:String(limit),offset:String(offset),
    sort:criteria.sort.key+'_'+criteria.sort.direction});
  if (criteria.search) params.set('search',criteria.search);
  if (criteria.filters.size) params.set('columns',JSON.stringify(Array.from(criteria.filters,([key,filter])=>
    [key,filter.presence,key==='member_type'||key==='status'?filter.choices:filter.text])));
  return params;
}

function verifyPage(data:Record<string,unknown>,query:URLSearchParams) {
  const page = schema.parse(data);
  if (page.offset!==Number(query.get('offset')) || page.limit!==Number(query.get('limit')) ||
      page.matching>page.total || page.items.length!==Math.min(page.limit,Math.max(0,page.matching-page.offset)) ||
      (query.has('revision') && page.revision!==query.get('revision')) || new Set(page.items.map(row=>row.id)).size!==page.items.length) {
    throw new Error('The member directory page could not be verified.');
  }
  const rows:VisibleMember[]=page.items.map(row=>({id:row.id,title:row.publicId,created_at:row.createdAt,display_name:row.name,
    display_name_recorded:!!row.name,member_type:row.type,membership_status:row.status,phone_e164:row.phone}));
  return {rows,total:page.total,matching:page.matching,revision:page.revision};
}

export async function startRoster(request:AdminRequest,signal:AbortSignal,query:URLSearchParams) {
  let data:Record<string,unknown>;
  try {data=await request('core/members?'+query,{signal});} catch(error) {
    if (error instanceof AdminRequestError && error.statusCode===503) throw new AdminRequestError('Members are temporarily unavailable. Try again.');
    if (!(error instanceof AdminRequestError) || error.statusCode!==400 || error.code!=='invalid_filter') throw error;
    return {kind:'legacy' as const,rows:await readCompleteRoster(request,signal)};
  }
  signal.throwIfAborted();
  // A predecessor adapter may return its original canonical envelope with no window support.
  if (!('revision' in data) && data.contract_version===2 && data.model==='canonical_evidence_ledger' && Array.isArray(data.rows)) {
    const reusable=query.get('offset')==='0' && data.rows.length===Math.min(100,Number(data.total));
    return {kind:'legacy' as const,rows:await readCompleteRoster(request,signal,reusable?data:undefined)};
  }
  return {kind:'remote' as const,page:verifyPage(data,query)};
}

export async function readRosterWindow(request:AdminRequest,signal:AbortSignal,query:URLSearchParams,expected:string) {
  const params=new URLSearchParams(query);params.set('revision',expected);
  try {
    const data=await request('core/members?'+params,{signal});
    signal.throwIfAborted();
    return verifyPage(data,params);
  } catch(error) {
    if (error instanceof AdminRequestError && error.statusCode===503) throw new AdminRequestError('Members are temporarily unavailable. Try again.');
    if (error instanceof AdminRequestError && error.code==='member_roster_changed') {
      throw new AdminRequestError('The member directory changed. Refresh Members to continue.');
    }
    throw error;
  }
}

export async function readRosterExport(request:AdminRequest,signal:AbortSignal,expected:string) {
  const rows:VisibleMember[]=[], seen=new Set<string>();
  const criteria=readRosterCriteria('?sort=public_id_asc');
  let total:number|undefined;
  do {
    const page=await readRosterWindow(request,signal,rosterWindowParams(criteria,100,rows.length),expected);
    if ((total!==undefined&&total!==page.total)||page.matching!==page.total) throw new Error('The member directory changed.');
    total=page.total;
    for (const row of page.rows) {
      if (seen.has(row.id)) throw new Error('The member directory changed.');
      seen.add(row.id);rows.push(row);
    }
  } while(rows.length<total);
  return rows;
}
