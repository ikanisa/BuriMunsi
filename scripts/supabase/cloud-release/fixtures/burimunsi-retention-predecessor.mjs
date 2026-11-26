import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const read = path => readFile(new URL(path,import.meta.url),'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const migration = '../../../../supabase/migrations/';

// Reuse the pinned 17 November metadata, then reconstruct the nine later
// catalog extensions. This fixture contains schema descriptors only.
export async function beforeCatalogMaterialization() {
  const [initial] = JSON.parse(await read('./observation-processing-retention-predecessors.json'));
  const columns = (await read(migration + '20261120104500_collect_payment_reference_authority.sql')).split('$columns$')[1];
  const initialBody = initial.definition.split('$function$')[1];
  assert.equal(initialBody.split(columns).length, 2);
  let body = initialBody.replace(columns, () => columns.replace('"revision"', '"revision",\n        "payment_reference"'));
  const extensions = JSON.parse(await read('./burimunsi-retention-catalog-additions.json'));
  for (const {expression, materialized} of extensions) {
    body = materialized
      ? `WITH prior(base) AS MATERIALIZED (${body}) SELECT ${expression} FROM prior`
      : `SELECT ${expression} FROM (${body}) prior(base)`;
  }
  assert.equal(hash(body), 'c2f0d9c6cdb45e05f5fcb0e11b75086763b8e2ada9874946b3f6b0a4195d1778');
  return body;
}
