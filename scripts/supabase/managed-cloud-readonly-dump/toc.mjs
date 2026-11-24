// Bounded streaming inspection of pg_restore --list. It retains only selected
// schema flags, fixed coverage flags and byte counts, never discovered names, SQL, or complete TOC output.
export const MAX_TOC_BYTES=8*1024*1024,MAX_TOC_LINE_BYTES=16*1024;
export const DUMP_TOC_SCHEMAS=Object.freeze(['app','private','collect_sms','auth','storage','supabase_migrations','burimunsi']);
export const BURIMUNSI_RECOVERY_TABLES=Object.freeze([
 'burimunsi.raw_sms','burimunsi.payments','private.burimunsi_allocation_receipts','private.burimunsi_command_receipts',
 'private.burimunsi_unresolved_observations','private.burimunsi_held_observation_sources','private.burimunsi_verified_inbox_recoveries'
]);
const requiredTables=new Set(BURIMUNSI_RECOVERY_TABLES);
export class TocError extends Error{constructor(code){super(code);this.name='TocError';this.code=code;}}
const fail=c=>{throw new TocError(c);};
export function createTocScanner(){
 let pending=Buffer.alloc(0),total=0,ended=false;const schemas=new Set(),tables=new Set(),data=new Set();
 function line(b){
  const text=b.toString('utf8');
  const schema=/^[0-9]+;\s+[0-9]+\s+[0-9]+\s+SCHEMA\s+-\s+([a-z_]+)\s+\S/.exec(text);
  if(schema&&DUMP_TOC_SCHEMAS.includes(schema[1]))schemas.add(schema[1]);
  const table=/^[0-9]+;\s+[0-9]+\s+[0-9]+\s+(TABLE DATA|TABLE)\s+([a-z_]+)\s+([a-z_]+)\s+\S/.exec(text);
  if(table){const name=table[2]+'.'+table[3];if(requiredTables.has(name))(table[1]==='TABLE'?tables:data).add(name);}
 }
 function append(part){if(pending.length+part.length>MAX_TOC_LINE_BYTES)fail('toc_line_bound_exceeded');const old=pending;pending=Buffer.concat([old,part]);old.fill(0);}
 return {
  push(chunk){if(ended||!Buffer.isBuffer(chunk))fail('toc_input_refused');total+=chunk.length;if(!Number.isSafeInteger(total)||total>MAX_TOC_BYTES)fail('toc_bound_exceeded');
   let start=0;for(;;){const i=chunk.indexOf(10,start);if(i<0)break;append(chunk.subarray(start,i));line(pending);pending.fill(0);pending=Buffer.alloc(0);start=i+1;}
   if(start<chunk.length)append(chunk.subarray(start));
  },
  finish(required,requireBuriMunsi=false){if(ended||!Array.isArray(required)||required.some(x=>!DUMP_TOC_SCHEMAS.includes(x))||typeof requireBuriMunsi!=='boolean')fail('toc_input_refused');ended=true;
   if(pending.length)line(pending);pending.fill(0);pending=Buffer.alloc(0);if(required.some(x=>!schemas.has(x)))fail('required_schemas_missing');
   if(requireBuriMunsi&&(!schemas.has('burimunsi')||BURIMUNSI_RECOVERY_TABLES.some(x=>!tables.has(x)||!data.has(x))))fail('required_recovery_tables_missing');
   return {bytes:total};
  },
  clear(){pending.fill(0);pending=Buffer.alloc(0);ended=true;}
 };
}
