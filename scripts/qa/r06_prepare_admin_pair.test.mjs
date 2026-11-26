import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {artifactIdentity} from '../../admin-web/scripts/build-identity.mjs';
import {packagePwa, verifyPwaPackage} from '../../admin-web/scripts/package-pwa.mjs';
import {sha256} from '../../admin-web/scripts/pwa-assets.mjs';
import {burimunsiAdminBrand as brand} from '../../admin-web/src/product-brand.mjs';
import {versionedStatic} from '../../deploy/platform-admin/src/static-recovery.js';
import {prepareAdminPair} from './r06_prepare_admin_pair.mjs';

const control = ['index.html', 'manifest.json', 'custom-sw.js', 'version.json', '_headers', '_redirects', 'robots.txt'];
const entry = 'assets/admin-entry.js';
const lazy = 'assets/admin-lazy.js';
async function build(root, label) {
  const raw = join(root, label + '-raw');
  const output = join(root, label);
  await fs.mkdir(join(raw, 'assets'), {recursive: true});
  await fs.mkdir(join(raw, 'icons'));
  await fs.copyFile(new URL('../../admin-web/public/' + brand.icon, import.meta.url), join(raw, brand.icon));
  await fs.writeFile(join(raw, 'index.html'),
    `<!doctype html><title>${brand.name}</title><meta name="description" content="${brand.description}"><link href="./${brand.icon}"><script type="module" src="./${entry}"></script>`);
  await fs.writeFile(join(raw, entry), `export const release = "${label}";`);
  await fs.writeFile(join(raw, lazy), `export const chunk = "${label}";`);
  const {assetId} = await packagePwa(raw, output);
  const receipt = JSON.stringify({format:'collect.react-admin.build.v1', hosted_verified:false, files:await artifactIdentity(output)});
  await fs.writeFile(output + '.json', receipt);
  return {output, pin:sha256(receipt), assetId};
}

async function samples(t) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'buri-r06-pair-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const [old, next] = await Promise.all([build(root, 'older-release'), build(root, 'newer-release')]);
  return {root, old, next, args:[old.output, old.pin, next.output, next.pin]};
}

test('original packages miss the other lazy asset; paired copies serve exact bytes across both switches', async t => {
  const {root, old, next, args} = await samples(t);
  const target = join(root, 'rehearsal');
  const report = await prepareAdminPair(...args, target);
  assert.equal(report.status, 'static-inventory-compatible');
  assert.equal(report.deployable, false);
  assert.equal(report.hosted_acceptance, false);
  assert.equal(report.promotion.identical, 3);
  assert.equal(report.rollback.identical, 3);
  assert.deepEqual(JSON.parse(await fs.readFile(join(target, 'pair.json'), 'utf8')), report);
  for (const [side, active, retained] of [['baseline', old, next], ['candidate', next, old]]) {
    for (const file of control) {
      assert.deepEqual(await fs.readFile(join(target, side, file)), await fs.readFile(join(active.output, file)));
    }
    const name = '_build/' + retained.assetId + '/' + lazy;
    const request = new Request('https://example.invalid/' + name);
    const fileServer = dir => ({fetch: async () => {
      try { return new Response(await fs.readFile(join(dir, name)), {headers:{'Content-Type':'text/javascript'}}); }
      catch { return new Response('fixture shell fallback', {headers:{'Content-Type':'text/html'}}); }
    }});
    assert.equal((await versionedStatic(request, fileServer(active.output))).status, 404);
    const response = await versionedStatic(request, fileServer(join(target, side)));
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await fs.readFile(join(retained.output, name)));
    await assert.rejects(verifyPwaPackage(join(target, side)), /cache inventory/);
  }
});

test('wrong pin, changed asset, overlapping or previously-owned output are refused', async t => {
  const {root, old, next, args} = await samples(t);
  const target = join(root, 'rehearsal');
  await assert.rejects(prepareAdminPair(old.output, next.pin, next.output, next.pin, target), /pin/);
  await assert.rejects(prepareAdminPair(...args, join(old.output,'do-not-create')), /separate/);
  await assert.rejects(prepareAdminPair(...args, old.output), /separate/);
  await fs.mkdir(target);
  await fs.writeFile(join(target,'existing'), 'preserve me');
  await assert.rejects(prepareAdminPair(...args, target), {code:'EEXIST'});
  assert.equal(await fs.readFile(join(target,'existing'),'utf8'), 'preserve me');
  const altered = join(old.output,'_build',old.assetId,lazy);
  await fs.appendFile(altered,'altered');
  const absent = join(root,'absent');
  await assert.rejects(prepareAdminPair(...args, absent), /differs/);
  await assert.rejects(fs.stat(absent), {code:'ENOENT'});
});
