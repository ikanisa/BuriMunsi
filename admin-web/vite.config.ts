import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import {burimunsiAdminBrand, collectAdminBrand} from './src/product-brand.mjs';

const assetBase = process.env.ADMIN_ASSET_BASE || '/';
const brand = process.env.VITE_ADMIN_PRODUCT === 'burimunsi' ? burimunsiAdminBrand : collectAdminBrand;
if (assetBase !== './' && !/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(assetBase)) {
  throw new Error('ADMIN_ASSET_BASE must be ./ or an absolute, same-origin directory path');
}

export default defineConfig({
  base: assetBase,
  envDir: false,
  plugins: [react(), {
    name: 'admin-brand',
    transformIndexHtml: (html) => html
      .replace(collectAdminBrand.name, brand.name)
      .replace(collectAdminBrand.description, brand.description)
      .replace(collectAdminBrand.icon, brand.icon),
  }],
  // The content-addressed _build directory provides immutable versioning.
  // A fixed entry name lets the Admin host safely identify missing entry files.
  build: {rolldownOptions: {output: {entryFileNames: 'assets/admin-entry.js'}}},
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/foundation/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: [...configDefaults.exclude, '**/._*'],
    restoreMocks: true,
  },
});
