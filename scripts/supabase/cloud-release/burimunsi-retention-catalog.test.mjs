import assert from 'node:assert/strict';
import {beforeCatalogMaterialization} from './fixtures/burimunsi-retention-predecessor.mjs';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import pg from '../node_modules/pg/lib/index.js';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const migration = '../../../supabase/migrations/';


// Interpret each original descriptor append directly in JavaScript. Never
// execute, plan or EXPLAIN the unbounded predecessor, even in this fixture.
function expectedCatalog(sql) {
  sql = sql.trim();
  if (sql.startsWith('SELECT $catalog$')) return JSON.parse(sql.split('$catalog$')[1]);
  let prior, expression;
  const cte = 'WITH prior(base) AS MATERIALIZED (';
  if (sql.startsWith(cte)) {
    const separator = sql.lastIndexOf(') SELECT ');
    prior = sql.slice(cte.length, separator);
    expression = sql.slice(separator + ') SELECT '.length, -' FROM prior'.length);
  } else {
    const separator = sql.indexOf(' FROM (');
    assert.ok(separator > 0 && sql.endsWith(') prior(base)'));
    prior = sql.slice(separator + ' FROM ('.length, -') prior(base)'.length);
    expression = sql.slice('SELECT '.length, separator);
  }
  const catalog = expectedCatalog(prior);
  const appends = [...expression.matchAll(/\(base->'([^']+)'\)\s*\|\|\s*'((?:[^']|'')*)'::jsonb/g)];
  assert.equal(appends.length, expression.split('jsonb_set(').length - 1);
  assert.ok(appends.length > 0);
  for (const [, key, literal] of appends) {
    assert.ok(Array.isArray(catalog[key]));
    catalog[key] = catalog[key].concat(JSON.parse(literal.replaceAll("''", "'")));
  }
  return catalog;
}

test('the complete e76 catalog reads inside the budget and retains every descriptor and privilege', async t => {
  const fixture = await startOwnedPg17({
    prefix: 'collect-pg-transfer-', initialUser: 'fixture_bootstrap', clusterName: 'burimunsi_retention_fixture',
  });
  const db = new pg.Client({host: fixture.socket, port: fixture.port, database: 'postgres', user: fixture.initialUser});
  t.after(async () => {
    try { await db.end(); } finally { assert.equal((await fixture.close()).removed, true); }
  });
  await db.connect();
  const body = await beforeCatalogMaterialization();
  const expected = expectedCatalog(body);
  await db.query(`
    CREATE ROLE postgres;
    CREATE SCHEMA private AUTHORIZATION postgres;
    SET ROLE postgres;
    CREATE TABLE private.collect_fence_control(singleton boolean, mode text, project_ref text);
    INSERT INTO private.collect_fence_control VALUES (true, 'open', 'rrlduytparvsjfmegalh');
    CREATE FUNCTION private._collect_fence_require_operator() RETURNS void LANGUAGE sql AS $$ SELECT $$;
    CREATE FUNCTION private._retention_manifest_catalog_v2() RETURNS jsonb
      LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $original$${body}$original$;
    REVOKE ALL ON FUNCTION private._retention_manifest_catalog_v2() FROM PUBLIC;`);
  const sql = await read(migration + '20261124075523_burimunsi_materialize_retention_catalog.sql');
  const identity = `SELECT oid, proowner, proacl::text, proconfig, prolang, provolatile, prosecdef
    FROM pg_proc WHERE oid = 'private._retention_manifest_catalog_v2()'::regprocedure`;
  const before = (await db.query(identity)).rows;
  await assert.rejects(db.query(sql), {code: '55000', message: 'retention_catalog_fence_required'});
  await db.query('ROLLBACK');
  await db.query("UPDATE private.collect_fence_control SET mode = 'fenced'");
  await db.query(sql);
  assert.deepEqual((await db.query(identity)).rows, before);

  await db.query("SET statement_timeout = '1500ms'");
  const start = performance.now();
  const {catalog: result, digest} = (await db.query(`
    WITH checked AS MATERIALIZED (SELECT private._retention_manifest_catalog_v2() AS catalog)
    SELECT catalog, encode(sha256(convert_to(catalog::text,'UTF8')),'hex') AS digest FROM checked`)).rows[0];
  const elapsedMs = Math.round(performance.now() - start);
  assert.deepEqual(result, expected);
  t.diagnostic(JSON.stringify({elapsedMs, catalogSha256:digest, privateClasses: result.private_classes.length, copyClasses: result.copy_classes.length}));
  await assert.rejects(db.query(sql), {code: '55000', message: 'retention_catalog_predecessor_changed'});
  await db.query('ROLLBACK');
});
