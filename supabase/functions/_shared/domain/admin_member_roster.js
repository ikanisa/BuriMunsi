import {ApiError} from './core.js';
import {iso} from './admin_record_values.js';

const columns={public_id:'public_id',full_name:'name_key',phone:'phone_key',member_type:'member_type',status:'membership_status'};
const choices={member_type:['app','direct'],status:['active','inactive']};
const printable=value=>typeof value==='string'&&value.length<=200&&!/[\u0000-\u001f\u007f]/u.test(value);
const invalid=()=>{throw new ApiError(400,'invalid_filter','These member filters are unavailable.');};
const fold=value=>value.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();
const words=value=>fold(value).match(/[\p{L}\p{N}]+/gu)??[];

function directoryConditions(search,rawFilters){
  const clauses=[],args=[];
  function add(sql,...values){clauses.push(sql);args.push(...values);}
  function nameTerms(value){for(const term of words(value))add('strpos(name_key,?)>0',term);}
  function phoneTerm(value,alsoId=false){
    const digits=value.replace(/\D/g,'');
    if(!digits||!/^[+\d\s().-]+$/u.test(value)){add('false');return;}
    let condition='strpos(phone_key,?)>0',bindings=[digits];
    if(value.trim().startsWith('+'))condition='starts_with(phone_key,?)';
    else if(/^00[1-9]/u.test(digits)){condition='(starts_with(phone_key,?) OR strpos(phone_key,?)>0)';bindings=[digits.slice(2),digits];}
    else if(digits.startsWith('0')){condition="((starts_with(phone_key,'2507') AND starts_with('0'||substr(phone_key,4),?)) OR strpos(phone_key,?)>0)";bindings=[digits,digits];}
    if(alsoId&&/^\d+$/u.test(value)){condition='('+condition+' OR strpos(public_id,?)>0)';bindings.push(value);}
    add(condition,...bindings);
  }
  if(search){
    let terms=fold(search).replace(/\b(status|type):([^\s]+)/gu,(_,key,value)=>{
      add((key==='status'?'membership_status':'member_type')+'=?',value);return ' ';
    }).replace(/\b(without|with)\s+groups?\b/gu,(_,word)=>{add('membership_status=?',word==='with'?'active':'inactive');return ' ';});
    terms=terms.replace(/\+?\d(?:[\d\s().-]*\d)?/gu,number=>{phoneTerm(number,true);return ' ';});
    for(const term of words(terms)){
      if(choices.status.includes(term))add('membership_status=?',term);
      else if(choices.member_type.includes(term))add('member_type=?',term);
      else add('strpos(name_key,?)>0',term);
    }
    if(!clauses.length)add('false');
  }
  if(rawFilters){
    if(rawFilters.length>4096)invalid();
    let filters;try{filters=JSON.parse(rawFilters);}catch{invalid();}
    if(!Array.isArray(filters)||filters.length>5)invalid();
    const seen=new Set();
    for(const item of filters){
      if(!Array.isArray(item)||item.length!==3)invalid();
      const [key,presence,value]=item;
      if(!Object.hasOwn(columns,key)||seen.has(key)||!['any','blank','present'].includes(presence))invalid();
      seen.add(key);
      const column=columns[key];
      if(presence!=='any')add('nullif('+column+",'') IS "+(presence==='blank'?'':'NOT ')+'NULL');
      if(Object.hasOwn(choices,key)){
        if(!Array.isArray(value)||value.length>2||!value.every(choice=>choices[key].includes(choice)))invalid();
        if(presence!=='blank'&&value.length)add(column+' IN ('+value.map(()=>'?').join(',')+')',...value);
      }else{
        if(!printable(value))invalid();
        if(presence==='blank'||!value)continue;
        if(key==='full_name'){if(words(value).length)nameTerms(value);else add('false');}
        else if(key==='phone')phoneTerm(value);
        else add('strpos(public_id,?)>0',value.toLowerCase());
      }
    }
  }
  return {where:clauses.length?' WHERE '+clauses.map(c=>'('+c+')').join(' AND '):'',args};
}

const stripPhone=column=>"regexp_replace("+column+",'[ ()-]','','g')";
function rwandaPhone(column){
  const simple=stripPhone(column);
  return "length("+column+")<=40 AND "+column+" ~ '^[+0-9 ()-]+$' AND "+simple+" ~ '^(0|([+]?[2]50|00250))?7[2389][0-9]{7}$'";
}

// Hash only the scoped fields that this directory can display or export. Ledger/balance
// detail and unrelated groups do not participate in directory pagination or search.
export async function readMemberRosterWindow(env,groupId,url,{limit,offset,sort,search}){
  if(url.searchParams.get('window')!=='1'||url.searchParams.get('directory')!=='roster')invalid();
  const revision=url.searchParams.get('revision');
  if(revision!==null&&!/^[0-9a-f]{64}$/.test(revision))invalid();
  const match=/^(.+)_(asc|desc)$/u.exec(sort);
  if(!match||!(match[1]==='created_at'||Object.hasOwn(columns,match[1])))invalid();
  const order=(match[1]==='created_at'?'created_at':columns[match[1]])+' '+match[2]+' NULLS LAST,id '+match[2];
  const {where,args}=directoryConditions(search,url.searchParams.get('columns'));
  const [response]=await env.DB.batch([env.DB.prepare(`WITH scoped AS MATERIALIZED (
    SELECT u.id,u.public_id,u.full_name,u.member_type,u.created_at,
      CASE WHEN m.active=1 THEN 'active' ELSE 'inactive' END AS membership_status,
      CASE WHEN u.phone ~ '^[+][1-9][0-9]{6,14}$' OR (${rwandaPhone('u.phone')}) THEN u.phone
        WHEN ${rwandaPhone('u.momo_number')} THEN u.momo_number END AS phone
    FROM memberships m JOIN collections g ON g.id=m.collection_id JOIN users u ON u.id=m.user_id
    WHERE m.collection_id=? AND g.status='active' AND u.member_type IN ('direct','app')
  ), facts AS (
    SELECT count(*)::int AS total,
      encode(sha256(convert_to(jsonb_build_array(?::text,coalesce(string_agg(encode(sha256(convert_to(
        jsonb_build_array(id,public_id,full_name,member_type,created_at,membership_status,phone)::text,'UTF8')),'hex'),'' ORDER BY id),''))::text,'UTF8')),'hex') AS revision
    FROM scoped
  ), visible AS (
    SELECT scoped.*,nullif(regexp_replace(lower(normalize(full_name,NFKD)),'[^[:alnum:]]','','g'),'') AS name_key,
      CASE WHEN phone IS NULL THEN NULL ELSE
        CASE WHEN ${stripPhone('phone')} ~ '^0[1-9][0-9]{8}$' THEN '250'||substr(${stripPhone('phone')},2)
             WHEN ${stripPhone('phone')} ~ '^[1-9][0-9]{8}$' THEN '250'||${stripPhone('phone')}
             ELSE regexp_replace(${stripPhone('phone')},'^(00|[+])','') END END AS phone_key
    FROM scoped
  ), matched AS MATERIALIZED (SELECT * FROM visible${where}),
  page AS (SELECT * FROM matched ORDER BY ${order} LIMIT ? OFFSET ?)
  SELECT facts.*,(SELECT count(*)::int FROM matched) AS matching,page.*
  FROM facts LEFT JOIN page ON true ORDER BY ${order}`).bind(groupId,groupId,...args,limit,offset)]);
  const first=response.results[0];
  if(revision!==null&&revision!==first.revision)throw new ApiError(409,'member_roster_changed','The member directory changed. Refresh to review its current records.');
  const items=response.results.filter(row=>row.id!==null).map(row=>({id:row.id,publicId:row.public_id,name:row.full_name,
    type:row.member_type,status:row.membership_status,phone:row.phone,createdAt:iso(row.created_at)}));
  return {items,total:first.total,matching:first.matching,revision:first.revision,offset,limit};
}
