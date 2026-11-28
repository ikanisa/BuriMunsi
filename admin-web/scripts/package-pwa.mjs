import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { cacheAsset, filesUnder, renderWorker, sha256, templatePath, versionedAssetHash } from './pwa-assets.mjs';
import { faviconRedirect, hostingHeaders, robotsRules } from './pwa-hosting.mjs';
import { burimunsiAdminBrand as brand } from '../src/product-brand.mjs';
import { BURIMUNSI_ADMIN_PROFILE_ID } from '../../deploy/platform-admin/src/admin-session-realm.js';

// Opaque renditions of the approved orange-swoosh-square owner master on its
// white background. The maskable rendition keeps the wordmark inside the safe circle.
const desktopIcons = [
  {file: 'icons/burimunsi-192.png', size: 192, purpose: 'any', hash: 'f91c614d1912f9aa99960a4a19b3e6a70de652a0f431560a985bdf5de57c2d6f'},
  {file: 'icons/burimunsi-512.png', size: 512, purpose: 'any', hash: 'b7dbbe1323584c4c51b6b4919d2a19cfc56be84f548ae0b619bbca517739c7ab'},
  {file: 'icons/burimunsi-maskable-512.png', size: 512, purpose: 'maskable', hash: '12da92335356728aff82272cbf7b7a9116230f1cb80952dc98dbf7fa58a7337a'},
];
const desktopShortcuts = [
  {name: 'Home', url: './#/admin', description: 'Open the group savings overview.'},
  {name: 'Members', url: './#/admin/members', description: 'Find a member and open their statement.'},
  {name: 'Payments', url: './#/admin/payments', description: 'Review incoming and outgoing payments.'},
];
const desktopScreenshot = {
  file: 'screenshots/admin-desktop.webp',
  hash: 'a03758ddca6b3cada5843f8671d7e00f13972d82bec9aaa9a2f1d502d3600b7b',
};

function desktopManifest(prefix) {
  const icons = desktopIcons.map(({file, size, purpose}) => ({
    src: `./${prefix}${file}`, sizes: `${size}x${size}`, type: 'image/png', purpose,
  }));
  return {
    // The root start URL was also the effective ID before an explicit ID was published.
    id: '/', start_url: '.', scope: '.', name: brand.name, short_name: brand.name,
    description: brand.description, lang: 'en', dir: 'ltr', categories: ['finance', 'business'],
    display: 'standalone', background_color: '#ffffff', theme_color: '#171b20',
    launch_handler: {client_mode: 'focus-existing'},
    shortcuts: desktopShortcuts.map(shortcut => ({...shortcut, icons: [icons[0]]})),
    icons,
    screenshots: [{
      src: `./${prefix}${desktopScreenshot.file}`, sizes: '1440x900', type: 'image/webp', form_factor: 'wide',
      label: 'BuriMunsi Admin Home showing group totals and recent incoming and outgoing payments.',
    }],
  };
}

function verifyManifest(manifest, version, prefix, hashes, html) {
  if (version.pwa_manifest_version === 2) {
    return isDeepStrictEqual(manifest, desktopManifest(prefix)) &&
      desktopIcons.every(({file, hash}) => hashes[`./${prefix}${file}`] === hash) &&
      hashes[`./${prefix}${desktopScreenshot.file}`] === desktopScreenshot.hash &&
      html.includes(`rel="apple-touch-icon" sizes="192x192" href="/${prefix}${desktopIcons[0].file}"`);
  }
  // Original BuriMunsi packages have one transparent icon and no explicit ID.
  // Their original shortcut labels/targets are covered by the pinned build receipt.
  return version.pwa_manifest_version === undefined &&
    manifest.screenshots === undefined && !Object.hasOwn(hashes, `./${prefix}${desktopScreenshot.file}`) &&
    !desktopIcons.some(({file}) => Object.hasOwn(hashes, `./${prefix}${file}`)) &&
    manifest.id === undefined && manifest.name === brand.name && manifest.short_name === brand.name &&
    manifest.description === brand.description && manifest.start_url === '.' && manifest.scope === '.' &&
    manifest.display === 'standalone' && isDeepStrictEqual(manifest.icons, [{
      src: `./${prefix}${brand.icon}`, sizes: brand.iconSize, type: 'image/png', purpose: brand.iconPurpose,
    }]);
}

/**
 * Package a Vite build created with ADMIN_ASSET_BASE=./ as an unqualified
 * PWA. The destination must not exist; this function never overwrites a release.
 */
export async function packagePwa(inputDirectory, outputDirectory, { publicBuild } = {}) {
  const input = path.resolve(inputDirectory);
  const output = path.resolve(outputDirectory);
  if (input === output || output.startsWith(`${input}${path.sep}`) || input.startsWith(`${output}${path.sep}`)) {
    throw new Error('Input and output directories must be separate');
  }
  const stat = await fs.lstat(input);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid Vite build directory');
  const all = await filesUnder(input);
  if (!all.includes('index.html') || !all.includes(brand.icon) ||
      !all.includes('assets/admin-entry.js')) {
    throw new Error('Vite build must contain the Admin shell, JavaScript and product icon');
  }
  const runtime = all.filter((name) => name !== 'index.html');
  if (runtime.some((name) =>
    /^(?:api|v1|functions|privacy|account-deletion)(?:\/|$)/.test(name) ||
    /^(?:custom-sw\.js|manifest\.json|version\.json|_headers|_redirects)$/.test(name) ||
    /(?:^|\/)\.[^/]+|\.(?:pem|key|sqlite|db|sql)$/i.test(name))) {
    throw new Error('Static build contains a reserved or sensitive-looking path');
  }
  const fileHashes = Object.fromEntries(await Promise.all(runtime.map(async (name) => [
    name, sha256(await fs.readFile(path.join(input, name))),
  ])));
  if (fileHashes[brand.icon] !== brand.iconSha256 || desktopIcons.some(({file, hash}) => fileHashes[file] !== hash)) {
    throw new Error('Admin icon does not match the approved asset');
  }
  if (fileHashes[desktopScreenshot.file] !== desktopScreenshot.hash) {
    throw new Error('Admin desktop preview does not match the approved screenshot');
  }
  const assetId = versionedAssetHash(runtime.map(name => [name, fileHashes[name]]));
  const assetPrefix = `_build/${assetId}/`;
  let index = await fs.readFile(path.join(input, 'index.html'), 'utf8');
  if (!index.includes(`<title>${brand.name}</title>`) ||
      !index.includes(brand.description) || !index.includes(`./${brand.icon}`) ||
      !/src=["']\.\/assets\/admin-entry\.js["']/.test(index)) {
    throw new Error('Build must use its product Admin shell and relative Vite asset base');
  }
  // The same shell serves legacy path-style deep links as well as '/'. Rooted
  // asset URLs must resolve before the application can normalize those routes.
  index = index.replace(/(["'])\.\/(assets|icons|licenses)\//g, `$1/${assetPrefix}$2/`)
    .replace(/(["'])\.\/manifest\.json\1/g, '$1/manifest.json$1');
  if (/(?:src|href)=["'](?:\/|\.\/)?(?:assets|icons)\//.test(index) ||
      /<script\b(?![^>]*\bsrc=)/i.test(index)) {
    throw new Error('Admin shell contains an unversioned asset or inline script');
  }

  // No deployable or qualified backend claim is manufactured by this package.
  if (publicBuild && (publicBuild.backend !== 'supabase' ||
      publicBuild.deployment_profile?.id !== BURIMUNSI_ADMIN_PROFILE_ID ||
      !/^[a-f0-9]{64}$/.test(publicBuild.public_build_config_sha256 ?? ''))) {
    throw new Error('Expected a bound public Supabase build configuration');
  }
  const version = {
    ...publicBuild,
    app_name: brand.id,
    frontend: 'react-vite',
    pwa_manifest_version: 2,
    asset_manifest_sha256: assetId,
    backend: publicBuild?.backend ?? 'unconfigured',
    qualification_complete: false,
    shipping_candidate: false,
  };
  const manifest = desktopManifest(assetPrefix);
  const template = await fs.readFile(templatePath, 'utf8');
  await fs.mkdir(output); // Fails rather than overwriting any earlier candidate.
  try {
    for (const name of runtime) {
      const destination = path.join(output, assetPrefix, name);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(input, name), destination, fs.constants.COPYFILE_EXCL);
    }
    await fs.writeFile(path.join(output, 'index.html'), index, { flag: 'wx' });
    await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await fs.writeFile(path.join(output, 'version.json'), `${JSON.stringify(version, null, 2)}\n`, { flag: 'wx' });
    await fs.writeFile(path.join(output, '_headers'), hostingHeaders, { flag: 'wx' });
    await fs.writeFile(path.join(output, '_redirects'), faviconRedirect(assetPrefix + brand.icon), { flag: 'wx' });
    await fs.writeFile(path.join(output, 'robots.txt'), robotsRules, { flag: 'wx' });

    const urls = ['./', './manifest.json', './version.json', ...runtime.map((name) => `./${assetPrefix}${name}`)];
    const hashes = Object.fromEntries(await Promise.all(urls.map(async (url) => [
      url, sha256(await fs.readFile(cacheAsset(output, url))),
    ])));
    const { cacheId, worker } = renderWorker(template, urls, hashes);
    await fs.writeFile(path.join(output, 'custom-sw.js'), worker, { flag: 'wx' });
    await verifyPwaPackage(output);
    return { assetId, cacheId, files: runtime.length, qualificationComplete: false };
  } catch (error) {
    await fs.rm(output, { recursive: true, force: true });
    throw error;
  }
}

/** Verify the generated static inventory against the exact bytes on disk. */
export async function verifyPwaPackage(directory) {
  const root = path.resolve(directory);
  const version = JSON.parse(await fs.readFile(path.join(root, 'version.json'), 'utf8'));
  const worker = await fs.readFile(path.join(root, 'custom-sw.js'), 'utf8');
  const urlMatch = worker.match(/const CACHE_URLS = (\[[^\n]*\]);/);
  const hashMatch = worker.match(/const CACHE_HASHES = (\{[^\n]*\});/);
  if (!urlMatch || !hashMatch) throw new Error('Missing Admin cache manifest');
  const urls = JSON.parse(urlMatch[1]);
  const hashes = JSON.parse(hashMatch[1]);
  if (!/^[a-f0-9]{64}$/.test(version.asset_manifest_sha256 ?? '')) throw new Error('Invalid Admin asset version');
  const prefix = `_build/${version.asset_manifest_sha256}/`;
  const rootFiles = ['index.html', 'manifest.json', 'version.json', 'custom-sw.js', '_headers', '_redirects', 'robots.txt'];
  const files = await filesUnder(root);
  const assets = files.filter(name => name.startsWith(prefix));
  const expectedUrls = ['./', './manifest.json', './version.json', ...assets.map(name => `./${name}`)];
  if (!rootFiles.every(name => files.includes(name)) ||
      files.some(name => !rootFiles.includes(name) && !name.startsWith(prefix)) ||
      JSON.stringify(urls) !== JSON.stringify(expectedUrls) || Object.keys(hashes).length !== expectedUrls.length) {
    throw new Error('Invalid Admin cache inventory');
  }
  for (const url of urls) {
    const bytes = await fs.readFile(cacheAsset(root, url));
    if (sha256(bytes) !== hashes[url]) throw new Error(`Static asset integrity failed: ${url}`);
  }
  const template = await fs.readFile(templatePath, 'utf8');
  if (worker !== renderWorker(template, urls, hashes).worker) {
    throw new Error('Admin worker differs from the audited template');
  }
  if (version.frontend !== 'react-vite' || version.shipping_candidate !== false ||
      version.qualification_complete !== false || !['unconfigured', 'supabase'].includes(version.backend) ||
      (version.backend === 'supabase' && (version.deployment_profile?.id !== BURIMUNSI_ADMIN_PROFILE_ID ||
        !/^[a-f0-9]{64}$/.test(version.public_build_config_sha256 ?? '')))) {
    throw new Error('Expected an unqualified React Admin package');
  }
  const assetId = versionedAssetHash(assets.map(name => [name.slice(prefix.length), hashes['./' + name]]));
  const index = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  const icon = prefix + brand.icon;
  if (assetId !== version.asset_manifest_sha256 || !assets.includes(prefix + 'assets/admin-entry.js') ||
      !['"', "'"].some(quote => index.includes(`src=${quote}/${prefix}assets/admin-entry.js${quote}`)) ||
      hashes['./' + icon] !== brand.iconSha256 || version.app_name !== brand.id ||
      !index.includes(`<title>${brand.name}</title>`) || !index.includes(`/${icon}`) ||
      !verifyManifest(manifest, version, prefix, hashes, index)) {
    throw new Error('Admin entry and cache differ from the asset version');
  }
  const text = (name) => fs.readFile(path.join(root, name), 'utf8');
  const headers = hostingHeaders;
  if (await text('_headers') !== headers || await text('robots.txt') !== robotsRules ||
      await text('_redirects') !== faviconRedirect(icon)) {
    throw new Error('Admin hosting rules or robots policy differ from the package contract');
  }
  return { cacheEntries: urls.length };
}
