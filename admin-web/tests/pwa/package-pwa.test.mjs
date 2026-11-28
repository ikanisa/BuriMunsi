import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { packagePwa, verifyPwaPackage } from '../../scripts/package-pwa.mjs';
import { renderWorker, sha256, templatePath } from '../../scripts/pwa-assets.mjs';
import {sourceIdentity} from '../../scripts/build-identity.mjs';
import {burimunsiAdminBrand as brand} from '../../src/product-brand.mjs';

const iconDirectory = fileURLToPath(new URL('../../public/icons/', import.meta.url));
const desktopPreview = fileURLToPath(new URL('../../public/screenshots/admin-desktop.webp', import.meta.url));

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'collect-admin-pwa-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const input = path.join(base, 'vite');
  const output = path.join(base, 'candidate');
  await fs.mkdir(path.join(input, 'assets'), { recursive: true });
  await fs.cp(iconDirectory, path.join(input, 'icons'), {recursive: true});
  await fs.mkdir(path.join(input, 'screenshots'));
  await fs.copyFile(desktopPreview, path.join(input, 'screenshots/admin-desktop.webp'));
  await fs.writeFile(path.join(input, 'assets/admin-entry.js'), 'import "./chunk-xyz.js";');
  await fs.writeFile(path.join(input, 'assets/chunk-xyz.js'), 'console.log("synthetic chunk")');
  await fs.writeFile(path.join(input, 'assets/app-def.css'), 'body { color: black; }');
  await fs.writeFile(path.join(input, 'index.html'), `<!doctype html><html><head>
    <title>BuriMunsi Admin</title><meta name="description" content="BuriMunsi group savings administration.">
    <link rel="icon" href="./icons/burimunsi-432.png">
    <link rel="apple-touch-icon" sizes="192x192" href="./icons/burimunsi-192.png">
    <link rel="manifest" href="./manifest.json"><link rel="stylesheet" href="./assets/app-def.css">
    <script type="module" src="./assets/admin-entry.js"></script></head><body><div id="root"></div></body></html>`);
  return { base, input, output };
}

test('packages exact versioned assets with a static-only, unqualified worker', async (t) => {
  const { input, output } = await fixture(t);
  const result = await packagePwa(input, output);
  assert.match(result.assetId, /^[a-f0-9]{64}$/);
  assert.equal(result.qualificationComplete, false);
  const html = await fs.readFile(path.join(output, 'index.html'), 'utf8');
  assert.match(html, new RegExp(`/_build/${result.assetId}/assets/admin-entry\\.js`));
  const entry = html.match(/src="([^"]+admin-entry\.js)"/)?.[1];
  const manifestUrl = html.match(/href="([^"]+manifest\.json)"/)?.[1];
  assert.equal(new URL(entry, 'https://admin.example.test/admin/groups/one').pathname, `/_build/${result.assetId}/assets/admin-entry.js`);
  assert.equal(new URL(manifestUrl, 'https://admin.example.test/admin/groups/one').pathname, '/manifest.json');
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'BuriMunsi Admin');
  assert.equal(manifest.scope, '.');
  assert.equal(manifest.start_url, '.');
  const manifestEntry = 'https://admin.example.test/manifest.json';
  assert.equal(new URL(manifest.id, manifestEntry).href, new URL(manifest.start_url, manifestEntry).href);
  assert.deepEqual(manifest.launch_handler, {client_mode: 'focus-existing'});
  assert.equal(manifest.lang, 'en');
  assert.deepEqual(manifest.categories, ['finance', 'business']);
  assert.deepEqual(manifest.shortcuts.map(shortcut => shortcut.name), ['Home', 'Members', 'Payments']);
  assert.deepEqual(manifest.shortcuts.map(shortcut => new URL(shortcut.url, manifestEntry).href), [
    'https://admin.example.test/#/admin',
    'https://admin.example.test/#/admin/members',
    'https://admin.example.test/#/admin/payments',
  ]);
  assert.ok(manifest.shortcuts.every(shortcut => shortcut.description && shortcut.icons[0].src === manifest.icons[0].src));
  const touchIcon = html.match(/rel="apple-touch-icon" sizes="192x192" href="([^"]+)"/)?.[1];
  assert.equal(new URL(touchIcon, 'https://admin.example.test/admin/members').href,
    new URL(manifest.icons[0].src, manifestEntry).href);
  const worker = await fs.readFile(path.join(output, 'custom-sw.js'), 'utf8');
  assert.match(worker, /credentials: 'omit'/);
  assert.match(worker, /crypto\.subtle\.digest\('SHA-256'/);
  assert.doesNotMatch(worker, /\bskipWaiting\s*\(|\bclients\.claim\s*\(/);
  assert.deepEqual(await verifyPwaPackage(output), { cacheEntries: 11 });
  await assert.rejects(packagePwa(input, output), { code: 'EEXIST' });
});

test('the BuriMunsi PWA binds its own identity and excludes Collect app associations', async (t) => {
  const { input, output } = await fixture(t);
  await assert.rejects(packagePwa(input, output, {publicBuild: {
    deployment_profile: {id: 'collect-managed-production'},
    backend: 'supabase', public_build_config_sha256: 'a'.repeat(64),
  }}), /bound public Supabase build configuration/);
  const {assetId} = await packagePwa(input, output, {publicBuild: {
    deployment_profile: {id: 'burimunsi-admin-production'},
    backend: 'supabase', public_build_config_sha256: 'a'.repeat(64),
  }});
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, brand.name);
  const expectedIcons = [
    ['burimunsi-192.png', 192, 'any'],
    ['burimunsi-512.png', 512, 'any'],
    ['burimunsi-maskable-512.png', 512, 'maskable'],
  ];
  assert.equal(manifest.icons.length, expectedIcons.length);
  for (const [index, [filename, size, purpose]] of expectedIcons.entries()) {
    const src = `./_build/${assetId}/icons/${filename}`;
    assert.deepEqual(manifest.icons[index], {src, sizes: `${size}x${size}`, type: 'image/png', purpose});
    const bytes = await fs.readFile(path.join(output, src));
    assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
    assert.equal(bytes[25], 2, 'The launcher image must be opaque RGB');
  }
  assert.deepEqual(manifest.screenshots, [{
    src: `./_build/${assetId}/screenshots/admin-desktop.webp`, sizes: '1440x900', type: 'image/webp',
    form_factor: 'wide', label: 'BuriMunsi Admin Home showing group totals and recent incoming and outgoing payments.',
  }]);
  const preview = await fs.readFile(path.join(output, manifest.screenshots[0].src));
  assert.equal(preview.toString('ascii', 0, 4), 'RIFF');
  assert.equal(preview.toString('ascii', 8, 12), 'WEBP');
  assert.doesNotMatch(await fs.readFile(path.join(output, '_headers'), 'utf8'), /api\.collect\.ikanisa\.com/);
  const associations = path.join(output, '.well-known');
  await fs.mkdir(associations);
  for (const name of ['assetlinks.json', 'apple-app-site-association']) await fs.writeFile(path.join(associations, name), '{}');
  await assert.rejects(verifyPwaPackage(output), /Invalid Admin cache inventory/);
});

test('rejects a changed packaged asset and reserved API files', async (t) => {
  const { input, output } = await fixture(t);
  const result = await packagePwa(input, output);
  await fs.writeFile(path.join(output, '_build', result.assetId, 'assets/admin-entry.js'), 'changed');
  await assert.rejects(verifyPwaPackage(output), /integrity failed/);
  await fs.mkdir(path.join(input, 'api'));
  await fs.writeFile(path.join(input, 'api/private.json'), '{}');
  await assert.rejects(packagePwa(input, `${output}-other`), /reserved or sensitive/);
});

test('rejects even correctly rehashed changes to installed identity, launch and shortcut routing', async (t) => {
  const { input, output } = await fixture(t);
  await packagePwa(input, output);
  const manifestPath = path.join(output, 'manifest.json');
  const workerPath = path.join(output, 'custom-sw.js');
  const originalManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const worker = await fs.readFile(workerPath, 'utf8');
  const template = await fs.readFile(templatePath, 'utf8');
  const urls = JSON.parse(worker.match(/const CACHE_URLS = (\[[^\n]*\]);/)[1]);
  const hashes = JSON.parse(worker.match(/const CACHE_HASHES = (\{[^\n]*\});/)[1]);
  const changes = [
    manifest => { manifest.id = '/second-app'; },
    manifest => { manifest.launch_handler.client_mode = 'navigate-new'; },
    manifest => { manifest.shortcuts[1].url = './#/admin/payments'; },
    manifest => { manifest.screenshots[0].src = 'https://example.test/admin.webp'; },
  ];
  for (const change of changes) {
    const manifest = structuredClone(originalManifest);
    change(manifest);
    const contents = JSON.stringify(manifest, null, 2) + '\n';
    await fs.writeFile(manifestPath, contents);
    hashes['./manifest.json'] = sha256(contents);
    await fs.writeFile(workerPath, renderWorker(template, urls, hashes).worker);
    await assert.rejects(verifyPwaPackage(output), /Admin entry and cache differ/);
  }
});

test('a failed asset copy removes only the newly reserved package', async (t) => {
  const { input, output } = await fixture(t);
  t.mock.method(fs, 'copyFile', async () => {
    throw new Error('synthetic asset copy failure');
  }, { times: 1 });
  await assert.rejects(packagePwa(input, output), /synthetic asset copy failure/);
  await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
  assert((await fs.lstat(path.join(input, 'assets/admin-entry.js'))).isFile());
  assert.equal((await packagePwa(input, output)).qualificationComplete, false);
});

test('rejects a changed worker, hosting rules, and unbound static files', async (t) => {
  const { input, output } = await fixture(t);
  await packagePwa(input, output);
  const worker = path.join(output, 'custom-sw.js');
  const originalWorker = await fs.readFile(worker);
  await fs.appendFile(worker, '\n// different worker bytes\n');
  await assert.rejects(verifyPwaPackage(output), /audited template/);
  await fs.writeFile(worker, originalWorker);

  const headers = path.join(output, '_headers');
  const originalHeaders = await fs.readFile(headers);
  await fs.writeFile(headers, '/*\n  X-Robots-Tag: index\n');
  await assert.rejects(verifyPwaPackage(output), /hosting rules/);
  await fs.writeFile(headers, originalHeaders);

  await fs.writeFile(path.join(output, 'unexpected.txt'), 'unbound static file');
  await assert.rejects(verifyPwaPackage(output), /cache inventory/);
});

test('rejects an absolute Vite asset base and an unapproved icon', async (t) => {
  const { input, output } = await fixture(t);
  const htmlPath = path.join(input, 'index.html');
  const html = await fs.readFile(htmlPath, 'utf8');
  await fs.writeFile(htmlPath, html.replace('./assets/admin-entry.js', '/assets/admin-entry.js'));
  await assert.rejects(packagePwa(input, output), /relative Vite asset base/);
  await fs.writeFile(htmlPath, html);
  const desktopIcon = path.join(input, 'icons/burimunsi-512.png');
  const opaque = await fs.readFile(desktopIcon);
  await fs.writeFile(desktopIcon, 'incorrect launcher art');
  await assert.rejects(packagePwa(input, output), /approved asset/);
  await fs.writeFile(desktopIcon, opaque);
  await fs.writeFile(path.join(input, 'icons/burimunsi-432.png'), 'not the approved icon');
  await assert.rejects(packagePwa(input, output), /approved asset/);
});

test('refuses to package a substituted desktop preview', async (t) => {
  const {input, output} = await fixture(t);
  await fs.writeFile(path.join(input, 'screenshots/admin-desktop.webp'), 'different preview');
  await assert.rejects(packagePwa(input, output), /approved screenshot/);
});

test('binds a local refactor with unstaged removals and requires explicit build inputs', async (t) => {
  const tmp = await fs.realpath(os.tmpdir());
  const base = await fs.mkdtemp(path.join(tmp, 'collect-admin-source-'));
  t.after(() => fs.rm(base, {recursive: true, force: true}));
  const git = (...args) => execFileSync('git', args, {cwd: base, stdio: 'pipe'});
  git('init', '--quiet', '--template=');
  const {build} = JSON.parse(await fs.readFile(new URL('../../scripts/source-inputs.json', import.meta.url), 'utf8'));
  const required = build.filter(name => !build.some(other => other.startsWith(name + '/')));
  const removed = 'admin-web/src/old-page.tsx';
  for (const name of [...required, removed]) {
    const file = path.join(base, name);
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, name);
  }
  git('add', '--all');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'Fixture');

  const before = await sourceIdentity(base);
  assert.equal(before.clean, true);
  await fs.unlink(path.join(base, removed));
  const after = await sourceIdentity(base);
  assert.equal(after.clean, false);
  assert.notEqual(after.sha256, before.sha256);
  git('add', '--all');
  assert.deepEqual(await sourceIdentity(base), after);

  await fs.unlink(path.join(base, 'admin-web/src/main.tsx'));
  await assert.rejects(sourceIdentity(base), /React Admin build inputs missing.*admin-web\/src\/main\.tsx/);
});
