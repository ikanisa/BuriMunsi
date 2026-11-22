import {burimunsiAdminBrand, collectAdminBrand} from './product-brand.mjs';

export const isBuriMunsiAdmin = import.meta.env.VITE_ADMIN_PRODUCT === 'burimunsi';
export const adminBrand = isBuriMunsiAdmin ? burimunsiAdminBrand : collectAdminBrand;
