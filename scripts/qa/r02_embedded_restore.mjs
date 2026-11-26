// BuriMunsi R02 synthetic fixture only. No connection strings are accepted.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = Buffer.from('synthetic opaque object, no member data\n');
const expected = {
  payments: [
    {id:'payment-001', source_id:'receipt-001', direction:'incoming', amount:'9007199254740991'},
    {id:'payment-002', source_id:'receipt-002', direction:'outgoing', amount:'73'},
  ],
  allocations: [{payment_id:'payment-001', attempt_id:'attempt-001', status:'pending'}],
  unresolved: [{source_id:'receipt-003', state:'held', object_sha256:hash(object)}],
  totals: [{direction:'incoming', amount:'9007199254740991'}, {direction:'outgoing', amount:'73'}],
  dispatches: '0',
};

async function snapshot(db) {
  const rows = async sql => (await db.query(sql)).rows;
  return {
    payments: await rows('SELECT id, source_id, direction, amount::text FROM payments ORDER BY id'),
    allocations: await rows('SELECT payment_id, attempt_id, status FROM allocations ORDER BY attempt_id'),
    unresolved: await rows('SELECT source_id, state, object_sha256 FROM unresolved ORDER BY source_id'),
    totals: await rows('SELECT direction, sum(amount)::text AS amount FROM payments GROUP BY direction ORDER BY direction'),
    dispatches: (await rows('SELECT count(*)::text AS n FROM dispatch')).at(0).n,
  };
}

async function verify(db, storagePath) {
  const restored = await snapshot(db);
  for (const key of Object.keys(expected)) {
    assert.deepEqual(restored[key], expected[key], 'Mismatch in ' + key);
  }
  assert.equal(hash(await fs.readFile(storagePath)), expected.unresolved[0].object_sha256,
    'Mismatch in Storage bytes');
}

async function checkRollback(db, file, sql, failsOn) {
  await db.exec('BEGIN');
  try {
    await db.exec(sql);
    await assert.rejects(verify(db, file), new RegExp('Mismatch in ' + failsOn));
  } finally {
    await db.exec('ROLLBACK');
  }
  await verify(db, file);
}

export async function runRestore(PGlite) {
  const directory = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'buri-r02-'));
  let source, restored;
  const started = performance.now();
  try {
    const archive = join(directory, 'synthetic-snapshot.tar');
    const originalStorage = join(directory, 'synthetic-custody');
    const restoreStorage = join(directory, 'restored-object');
    await fs.writeFile(originalStorage, object, {flag:'wx', mode:0o600});
    source = await PGlite.create();
    await source.exec(`
      CREATE TABLE payments(id text PRIMARY KEY, source_id text UNIQUE NOT NULL,
        direction text NOT NULL CHECK (direction IN ('incoming','outgoing')),
        amount bigint NOT NULL CHECK (amount > 0));
      CREATE TABLE allocations(payment_id text PRIMARY KEY REFERENCES payments(id),
        attempt_id text UNIQUE NOT NULL, status text NOT NULL);
      CREATE TABLE unresolved(source_id text PRIMARY KEY, state text NOT NULL, object_sha256 text NOT NULL);
      CREATE TABLE dispatch(id text PRIMARY KEY);
      INSERT INTO payments VALUES ('payment-001','receipt-001','incoming',9007199254740991),
        ('payment-002','receipt-002','outgoing',73);
      INSERT INTO allocations VALUES ('payment-001','attempt-001','pending');
    `);
    await source.query('INSERT INTO unresolved VALUES ($1,$2,$3)',
      ['receipt-003','held',expected.unresolved[0].object_sha256]);
    await verify(source, originalStorage);
    const backup = Buffer.from(await (await source.dumpDataDir('none')).arrayBuffer());
    const pin = hash(backup);
    await fs.writeFile(archive, backup, {flag:'wx', mode:0o600});
    // Advance the source after capture: reopening the original instance or
    // rebuilding today's data would not qualify as restoring the cutoff.
    await source.exec("UPDATE payments SET amount=74 WHERE id='payment-002'");
    assert.equal((await snapshot(source)).totals[1].amount, '74');
    await source.close();
    source = null;

    const retainedBackup = await fs.readFile(archive);
    assert.equal(hash(retainedBackup), pin);
    await fs.copyFile(originalStorage, restoreStorage, fs.constants.COPYFILE_EXCL);
    restored = await PGlite.create({loadDataDir:new Blob([retainedBackup])});
    const engine = (await restored.query('SHOW server_version')).rows[0].server_version;
    await verify(restored, restoreStorage);
    const localElapsedMs = Math.round(performance.now() - started);

    await checkRollback(restored, restoreStorage,
      "UPDATE payments SET source_id='receipt-other' WHERE id='payment-001'", 'payments');
    await checkRollback(restored, restoreStorage,
      "UPDATE allocations SET attempt_id='attempt-other' WHERE payment_id='payment-001'", 'allocations');
    await checkRollback(restored, restoreStorage,
      "UPDATE unresolved SET state='closed' WHERE source_id='receipt-003'", 'unresolved');
    await checkRollback(restored, restoreStorage, "INSERT INTO dispatch VALUES ('dispatch-fixture')", 'dispatches');
    await assert.rejects(verify(restored, join(directory, 'missing-object')), {code:'ENOENT'});
    await fs.writeFile(restoreStorage, Buffer.alloc(object.length, 0x41));
    await assert.rejects(verify(restored, restoreStorage), /Mismatch in Storage bytes/);
    await verify(restored, originalStorage);
    return {status:'pass', scope:'embedded synthetic checkpoint restore', engine,
      observed_local_elapsed_ms:localElapsedMs, positives:1, rejected_perturbations:6,
      external_dispatch:'not configured; fixture dispatch table empty',
      hosted_backup_verified:false, hosted_restore_verified:false};
  } finally {
    if (source) await source.close();
    if (restored) await restored.close();
    await fs.rm(directory, {recursive:true, force:true});
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const pkg = process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : '@electric-sql/pglite';
  const {PGlite} = await import(pkg);
  console.log(JSON.stringify(await runRestore(PGlite)));
}
