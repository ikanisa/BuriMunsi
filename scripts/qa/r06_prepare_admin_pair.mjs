// Build two offline rehearsal directories; this does not publish either one.
import {promises as fs} from 'node:fs';
import {dirname, join, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {artifactIdentity, readBuildFile} from '../../admin-web/scripts/build-identity.mjs';
import {verifyPwaPackage} from '../../admin-web/scripts/package-pwa.mjs';
import {sha256} from '../../admin-web/scripts/pwa-assets.mjs';
import {compare, loadPackage, requiredAssets} from './r06_compare_admin_assets.mjs';

const nested = (a, b) => a === b || a.startsWith(b + sep);

async function pinnedPackage(root, pin) {
  const inventory = await loadPackage(root, pin);
  // Inputs must be original packages, not pairs or packages with undocumented
  // extra roots. Verify the generated shell and cache manifest independently.
  await verifyPwaPackage(root);
  const raw = await readBuildFile(root + '.json');
  if (sha256(raw) !== pin) throw new Error('Input receipt changed');
  const {files} = JSON.parse(raw);
  return {...inventory, files, pin, root};
}

async function copyVerified(target, source, files) {
  for (const [name, digest] of files) {
    const bytes = await readBuildFile(join(source, name));
    if (sha256(bytes) !== digest) throw new Error('Input changed during copy');
    const output = join(target, name);
    await fs.mkdir(dirname(output), {recursive: true});
    await fs.writeFile(output, bytes, {flag: 'wx'});
  }
}

export async function prepareAdminPair(oldDirectory, oldPin, newDirectory, newPin, outDirectory) {
  const [oldRoot, newRoot, out] = [oldDirectory, newDirectory, outDirectory].map(value => resolve(value));
  if ([oldRoot, newRoot].some(root => nested(root, out) || nested(out, root)) ||
      await fs.realpath(dirname(out)) !== dirname(out)) throw new Error('Expected a separate physical output');
  const [old, next] = await Promise.all([pinnedPackage(oldRoot, oldPin), pinnedPackage(newRoot, newPin)]);
  if (old.version === next.version) throw new Error('Expected distinct builds');
  await fs.mkdir(out, {mode: 0o700});
  try {
    async function makeSide(name, active, retained) {
      const side = join(out, name);
      await fs.mkdir(side);
      await copyVerified(side, active.root, active.files);
      // Copy only the counterpart's versioned asset files. The current
      // shell, service worker, profile, and cache manifest stay byte-exact.
      await copyVerified(side, retained.root, retained.required);
      const files = await artifactIdentity(side);
      const expected = [...active.files, ...retained.required].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      if (JSON.stringify(files) !== JSON.stringify(expected)) throw new Error('Unexpected rehearsal inventory');
      const inventory = requiredAssets(files.filter(([key]) => key.startsWith('_build/')), active.version);
      return {inventory, receipt: {active: active.version, active_receipt_sha256: active.pin,
        retained: retained.version, retained_receipt_sha256: retained.pin, files}};
    }
    const baseline = await makeSide('baseline', old, next);
    const candidate = await makeSide('candidate', next, old);
    const result = compare(baseline.inventory, candidate.inventory);
    if (result.status !== 'static-inventory-compatible') throw new Error('Rehearsal gap');
    const receipt = {format: 'collect.react-admin.rehearsal-pair.v1', deployable: false,
      ...result, baseline: baseline.receipt, candidate: candidate.receipt};
    await fs.writeFile(join(out, 'pair.json'), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
    return receipt;
  } catch (error) {
    await fs.rm(out, {recursive: true, force: true});
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 5) throw new Error('Expected two packages, their receipt pins and a new output path');
    const {status, promotion, rollback, hosted_acceptance, deployable} = await prepareAdminPair(...args);
    console.log(JSON.stringify({status, promotion, rollback, hosted_acceptance, deployable}));
  } catch {
    console.error('Unable to prepare a verified offline Admin asset pair.');
    process.exitCode = 2;
  }
}
