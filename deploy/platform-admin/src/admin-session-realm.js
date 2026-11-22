import {BURIMUNSI_ADMIN_ORIGIN} from '../../../supabase/functions/_shared/burimunsi-standalone.js';

export {BURIMUNSI_ADMIN_ORIGIN};

export const PRODUCTION_ADMIN_ORIGIN = 'https://platform-admin.collect.ikanisa.com';
export const QA_ADMIN_ORIGIN = 'https://admin-supabase-qa.collect.ikanisa.com';
export const BURIMUNSI_ADMIN_PROFILE_ID = 'burimunsi-admin-production';

export const ADMIN_COOKIE = '__Host-collect_admin';
export const MANAGED_ADMIN_COOKIE = '__Host-collect_admin_rrlduytparvsjfmegalh';
export const BURIMUNSI_ADMIN_COOKIE = '__Host-burimunsi_admin_rrlduytparvsjfmegalh';

export function adminCookieNameForOrigin(origin) {
  if (origin === PRODUCTION_ADMIN_ORIGIN) return MANAGED_ADMIN_COOKIE;
  if (origin === QA_ADMIN_ORIGIN) return ADMIN_COOKIE;
  if (origin === BURIMUNSI_ADMIN_ORIGIN) return BURIMUNSI_ADMIN_COOKIE;
  return null;
}
