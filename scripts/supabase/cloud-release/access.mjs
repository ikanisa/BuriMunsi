import {readFileSync,lstatSync,realpathSync,mkdirSync,writeFileSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {dirname,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {loadProviderRoot} from '../managed-cloud-migrations/provider-ca.mjs';

export const PROJECT='rrlduytparvsjfmegalh';
export const ROOT=fileURLToPath(new URL('../../../build/managed-release',import.meta.url));

function createPrivateEvidenceDirectory(){
 const parent=dirname(ROOT);
 if(realpathSync(dirname(parent))!==dirname(parent))throw Error('release_evidence_path_invalid');
 for(const path of [parent,ROOT]){
  try{mkdirSync(path,{mode:0o700});}catch(error){if(error?.code!=='EEXIST')throw error;}
  const stat=lstatSync(path);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||
     (stat.mode&(path===ROOT?0o077:0o022))!==0||realpathSync(path)!==path)
   throw Error('private_release_evidence_directory_required');
 }
}

export const sha=value=>createHash('sha256').update(value).digest('hex');
export function record(name,value){
 if(!/^[a-z0-9_.-]+$/.test(name))throw Error('invalid_record_name');
 createPrivateEvidenceDirectory();
 const fd=openSync(join(ROOT,name),'wx',0o600);
 try{writeFileSync(fd,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 const parent=openSync(ROOT,'r');
 try{fsyncSync(parent);}finally{closeSync(parent);}
}
export async function connect(){
 const path=process.env.BURIMUNSI_DB_PASSWORD_FILE;
 if(!path||!isAbsolute(path)||realpathSync(path)!==path)throw Error('private_credential_required');
 const s=lstatSync(path);
 if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||(s.mode&0o077)!==0||s.uid!==process.getuid())
  throw Error('private_credential_required');
 return connectWithPassword(readFileSync(path,'utf8').trim());
}
export async function connectWithPassword(password){
 const {Client}=createRequire(import.meta.url)('pg');
 const client=new Client({host:'aws-0-eu-north-1.pooler.supabase.com',port:5432,user:'postgres.'+PROJECT,
  password,database:'postgres',ssl:{ca:loadProviderRoot(),rejectUnauthorized:true},
  connectionTimeoutMillis:15000,statement_timeout:90000,application_name:'collect_cloud_release_20261117'});
 client.on('error',()=>{});await client.connect();
 const i=(await client.query("select session_user,current_user,current_database(),current_setting('server_version_num')::int as version,(select project_ref from private.collect_fence_control where singleton) project")).rows[0];
 if(i.session_user!=='postgres'||i.current_user!=='postgres'||i.current_database!=='postgres'||Math.floor(i.version/10000)!==17||i.project!==PROJECT){await client.end();throw Error('cloud_identity_mismatch');}
 return client;
}
export async function management(path,options={}){
 if(!/^[a-z0-9_/?=&.-]+$/i.test(path))throw Error('invalid_management_path');
 const token=execFileSync('/usr/bin/security',['find-generic-password','-s','Supabase CLI','-a','supabase','-w'],{encoding:'utf8'}).trim();
 const r=await fetch('https://api.supabase.com/v1/projects/'+PROJECT+'/'+path,{...options,headers:{Authorization:'Bearer '+token,...options.headers},redirect:'error',signal:AbortSignal.timeout(90000)});
 const bytes=Buffer.from(await r.arrayBuffer());
 if(!r.ok){const e=Error('management_request_failed_'+r.status);e.status=r.status;throw e;}
 return {status:r.status,bytes,json:()=>JSON.parse(bytes.toString('utf8'))};
}
