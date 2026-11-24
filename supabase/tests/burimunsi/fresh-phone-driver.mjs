// Use the pinned production PostgreSQL driver solely on the owned local fixture.
import assert from 'node:assert/strict';
import {dirname} from 'node:path';
import postgres from 'npm:postgres@3.4.7';
import {qualifyNativeReads} from './fresh-phone-reads.mjs';

assert.equal(Deno.args.length,4);
const [socket,rawPort,database,source]=Deno.args;
assert.match(socket,/^\/(?:private\/)?tmp\/collect-pg-transfer-[a-zA-Z0-9]+\/s$/);
assert.equal(await Deno.realPath(socket),socket);
assert.match(database,/^collect_archive_[a-f0-9]{24}_test$/);
assert.match(source,/^[a-f0-9]{64}$/);
const port=Number(rawPort);
assert.ok(/^\d{1,5}$/.test(rawPort)&&Number.isInteger(port)&&port>0&&port<=65535);
const root=dirname(socket);
for(const path of [root,socket]){
  const stat=await Deno.lstat(path);
  assert.ok(stat.isDirectory&&(stat.mode&0o777)===0o700&&stat.uid===Deno.uid());
}
const [,data,,reportedPort,reportedSocket]=(await Deno.readTextFile(root+'/db/postmaster.pid')).split('\n');
assert.deepEqual([data,reportedPort,reportedSocket],[root+'/db',rawPort,socket]);

const integer=value=>{
  const number=Number(value);
  assert.ok(/^-?\d+(?:\.0+)?$/.test(value)&&Number.isSafeInteger(number));
  return number;
};
const options={host:socket,port,database,password:'',ssl:false,prepare:false,connect_timeout:5,idle_timeout:20,
  onnotice(){},types:{whole:{to:20,from:[20,1700],serialize:String,parse:integer}}};
const businessStatements=[];
const runtime=postgres({...options,user:'postgres',max:1,debug:(_pid,query)=>businessStatements.push(query)});
const competing=postgres({...options,user:'postgres',max:2});
const admission=postgres({...options,user:'postgres',max:5});
const inspector=postgres({...options,user:'collect_test',max:1});
try{
  const [target]=await runtime`SELECT current_database() AS db,current_user AS role,current_setting('cluster_name') AS cluster,
    current_setting('server_version_num')::integer/10000 AS major,
    inet_server_addr() IS NULL AND current_setting('listen_addresses')='' AS socket_only`;
  assert.deepEqual({...target},{db:database,role:'postgres',cluster:'collect_archive_next_fixture',major:17,socket_only:true});
  console.log('PASS cached pinned postgres.js 3.4.7 on verified owned PG17 Unix socket only');
  await qualifyNativeReads({pool:runtime,competingPool:competing,admissionPool:admission,businessStatements,source,inspect:(sql,values)=>inspector.unsafe(sql,values)});
}finally{
  await Promise.all([runtime,competing,admission,inspector].map(pool=>pool.end({timeout:5})));
}
