import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { artifactIdentity } from '../../admin-web/scripts/build-identity.mjs';
import { sha256 } from '../../admin-web/scripts/pwa-assets.mjs';
import { compare, loadPackage, requiredAssets } from './r06_compare_admin_assets.mjs';

const A = 'a'.repeat(64), B = 'b'.repeat(64), HASH = '1'.repeat(64), OTHER = '2'.repeat(64);
const asset = (version, name = 'assets/admin-entry.js', digest = HASH) => [`_build/${version}/${name}`, digest];
const OLD = [asset(A), asset(A, 'assets/lazy.js')];
const NEW = [asset(B), asset(B, 'assets/lazy.js')];
const inv = (files, version) => requiredAssets(files, version);

test('identical bytes under different URLs do not prevent version skew in either direction', () => {
  const r = compare(inv(OLD, A), inv(NEW, B));
  assert.equal(r.status, 'static-inventory-gap');
  assert.equal(r.hosted_acceptance, false);
  assert.equal(r.promotion.missing, 2);
  assert.equal(r.rollback.missing, 2);
});

test('carrying old files protects promotion only; rollback must separately carry new files', () => {
  const r = compare(inv(OLD, A), inv([...NEW, ...OLD], B));
  assert.deepEqual(r.promotion, {required: 2, identical: 2, missing: 0, different_bytes: 0});
  assert.equal(r.rollback.missing, 2);
  const paired = compare(inv([...OLD, ...NEW], A), inv([...NEW, ...OLD], B));
  assert.equal(paired.status, 'static-inventory-compatible');
  assert.equal(paired.hosted_acceptance, false);
});

test('wrong bytes at a retained URL are not counted as compatible', () => {
  const r = compare(inv(OLD, A), inv([...NEW, asset(A), asset(A, 'assets/lazy.js', OTHER)], B));
  assert.equal(r.promotion.different_bytes, 1);
  assert.equal(r.promotion.missing, 0);
});

test('rejects malformed paths, missing entry and duplicate URLs', () => {
  assert.throws(() => inv([...OLD, OLD[0]], A), /inventory/);
  assert.throws(() => inv([...OLD, asset(A, 'assets/../x')], A), /inventory/);
  assert.throws(() => inv([...OLD, asset(A, 'assets//x')], A), /inventory/);
  assert.throws(() => inv([], A), /entry/);
});

test('requires the pinned receipt and rehashes exact local files', async t => {
  const base = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'buri-r06-'));
  t.after(() => fs.rm(base, {recursive: true, force: true}));
  const root = join(base, 'site'), entry = join(root, OLD[0][0]);
  await fs.mkdir(join(root, '_build', A, 'assets'), {recursive: true});
  await fs.writeFile(entry, 'export default 1;');
  await fs.writeFile(join(root, 'version.json'), JSON.stringify({frontend: 'react-vite', asset_manifest_sha256: A}));
  const raw = JSON.stringify({format: 'collect.react-admin.build.v1',
    hosted_verified: false, files: await artifactIdentity(root)});
  const pin = sha256(raw);
  await fs.writeFile(root + '.json', raw);
  assert.equal((await loadPackage(root, pin)).required.size, 1);
  await assert.rejects(loadPackage(root, OTHER), /pin/);
  await fs.writeFile(entry, 'export default 2;');
  await assert.rejects(loadPackage(root, pin), /differs/);
});
