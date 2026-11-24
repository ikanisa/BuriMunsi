// Run both custody reads with the Edge driver on the owned receipt fixture.
import assert from 'node:assert/strict';
import postgres from 'npm:postgres@3.4.7';
import {PostgresPostingCustody} from '../../../../supabase/functions/_shared/domain/burimunsi/postgres-posting-custody.js';

const [socket, portText] = Deno.args;
assert.match(socket, /^\/(?:private\/)?tmp\/collect-pg-transfer-[a-zA-Z0-9]+\/s$/);
const port = Number(portText);
assert.ok(Number.isInteger(port) && port >= 51000 && port <= 60999);
const {group, key, expect} = await new Response(Deno.stdin.readable).json();
const sql = postgres({host: socket, port, database: 'postgres', user: 'collect_fixture', max: 1, ssl: false,
  prepare: false, onnotice() {}, types: {whole: {to: 20, from: [20,1700], serialize: String, parse: Number}}});
try {
  const [target] = await sql.unsafe("SELECT inet_server_addr() IS NULL AS local, current_setting('cluster_name') AS name, current_setting('server_version_num')::int/10000 AS major");
  assert.deepEqual({...target}, {local: true, name: 'collect_synthetic_fixture', major: 17});
  const custody = new PostgresPostingCustody({db: {applicationWork: {assert: async () => {}}}, groupId: group,
    namespace: {origin: 'https://fixture.invalid', bucket: 'private-evidence'}, qualificationOnly: true,
    decrypt: () => assert.fail('journal read must not decrypt an SMS')});
  await sql.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE collect_runtime');
    const previous = await custody.journal(tx, key, expect);
    const current = await custody.keyedObservationJournal(tx, key, expect);
    assert.deepEqual(current, previous);
    assert.ok(Number.isSafeInteger(current.put.size));
  });
  console.log('verified');
} finally {
  await sql.end();
}
