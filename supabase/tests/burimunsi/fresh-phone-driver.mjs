// The production driver owns both the WORK lease and the native request connection.
import assert from 'node:assert/strict';
import postgres from 'npm:postgres@3.4.7';
import {qualifyNativeReads} from './fresh-phone-reads.mjs';

const [socket, rawPort, database, source] = Deno.args;
assert.match(socket,/^\/(?:private\/)?tmp\/collect-pg-transfer-[a-zA-Z0-9]+\/s$/);
assert.match(database,/^collect_archive_[a-f0-9]{24}_test$/);
assert.match(source,/^[a-f0-9]{64}$/);
const port = Number(rawPort);
assert.ok(Number.isInteger(port) && port>0 && port<=65535);
const integer = value => {
  const number=Number(value);
  assert.ok(/^-?\d+(?:\.0+)?$/.test(value) && Number.isSafeInteger(number));
  return number;
};
const options={host:socket,port,database,ssl:false,prepare:false,max:4,connect_timeout:5,onnotice(){},
  types:{whole:{to:20,from:[20,1700],serialize:String,parse:integer}}};
const pool=postgres({...options,user:'postgres'}), inspector=postgres({...options,user:'collect_test',max:1});
try {
  const [target]=await pool`SELECT current_database() AS db, current_user AS role,current_setting('cluster_name') AS cluster,
    inet_server_addr() IS NULL AND current_setting('listen_addresses')='' AS socket_only`;
  assert.deepEqual({...target},{db:database,role:'postgres',cluster:'collect_archive_next_fixture',socket_only:true});
  console.log('Pinned postgres.js 3.4.7, verified private PostgreSQL socket');
  await qualifyNativeReads({pool,source,inspect:(sql,values)=>inspector.unsafe(sql,values)});
} finally {
  await Promise.all([pool.end(),inspector.end()]);
}
