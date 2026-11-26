// Offline inventory check. This does not observe a Worker, authorize a
// deployment, exercise a browser, or certify an authenticated rollback.
import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifactIdentity, readBuildFile } from '../../admin-web/scripts/build-identity.mjs';
import { sha256 } from '../../admin-web/scripts/pwa-assets.mjs';

const DIGEST = /^[a-f0-9]{64}$/;
const BUILD_PATH = /^_build\/[a-f0-9]{64}\/[A-Za-z0-9._/-]+$/;
const safePath = name => BUILD_PATH.test(name) &&
  name.split('/').every(part => part && part !== '.' && part !== '..');

export function requiredAssets(files, version) {
  if (typeof version !== 'string' || !DIGEST.test(version)) throw new Error('Invalid build version');
  const all = new Map();
  for (const entry of files) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Invalid asset inventory');
    const [name, digest] = entry;
    if (typeof name !== 'string' || !safePath(name) || typeof digest !== 'string' || !DIGEST.test(digest) || all.has(name)) {
      throw new Error('Invalid asset inventory');
    }
    all.set(name, digest);
  }
  const prefix = `_build/${version}/`;
  const required = new Map([...all].filter(([name]) => name.startsWith(prefix)));
  if (!required.has(prefix + 'assets/admin-entry.js')) throw new Error('Missing Admin entry');
  return {all, required};
}

export function compare(baseline, candidate) {
  const compareDirection = (from, to) => {
    const out = {required: from.required.size, identical: 0, missing: 0, different_bytes: 0};
    for (const [name, digest] of from.required) {
      if (!to.all.has(name)) out.missing++;
      else if (to.all.get(name) !== digest) out.different_bytes++;
      else out.identical++;
    }
    return out;
  };
  const promotion = compareDirection(baseline, candidate);
  const rollback = compareDirection(candidate, baseline);
  return {promotion, rollback,
    status: [promotion, rollback].every(x => x.required > 0 && x.identical === x.required) ?
      'static-inventory-compatible' : 'static-inventory-gap',
    hosted_acceptance: false};
}

export async function loadPackage(directory, pin) {
  if (typeof pin !== 'string' || !DIGEST.test(pin)) throw new Error('Expected independently retained receipt digest');
  const root = resolve(directory);
  if (await fs.realpath(root) !== root) throw new Error('Expected physical artifact root');
  const raw = await readBuildFile(root + '.json');
  if (sha256(raw) !== pin) throw new Error('Build receipt does not match its pin');
  const receipt = JSON.parse(raw);
  const files = await artifactIdentity(root);
  if (receipt.format !== 'collect.react-admin.build.v1' ||
      receipt.hosted_verified !== false ||
      JSON.stringify(receipt.files) !== JSON.stringify(files)) {
    throw new Error('Artifact differs from the pinned build receipt');
  }
  const meta = JSON.parse(await readBuildFile(join(root, 'version.json')));
  if (meta.frontend !== 'react-vite') throw new Error('Expected the React Admin build');
  return {version: meta.asset_manifest_sha256,
    ...requiredAssets(files.filter(([name]) => name.startsWith('_build/')), meta.asset_manifest_sha256)};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [oldRoot, oldPin, newRoot, newPin, ...rest] = process.argv.slice(2);
    if (rest.length || !oldRoot || !newRoot) throw new Error('Expected both artifact roots and receipt pins');
    const [oldBuild, newBuild] = await Promise.all([loadPackage(oldRoot, oldPin), loadPackage(newRoot, newPin)]);
    if (oldBuild.version === newBuild.version) throw new Error('Expected two distinct build versions');
    const result = compare(oldBuild, newBuild);
    console.log(JSON.stringify({...result, baseline: oldBuild.version, candidate: newBuild.version}));
    process.exitCode = result.status === 'static-inventory-compatible' ? 0 : 3;
  } catch {
    // Do not echo private paths, file content, or arbitrary receipt fields.
    console.error('Unable to verify both pinned Admin artifact inventories.');
    process.exitCode = 2;
  }
}
