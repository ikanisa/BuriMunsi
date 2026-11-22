import {MANAGED_SUPABASE_ORIGIN, resolveDeploymentProfile} from './deployment-profile.js';

export const COLLECT_SUPABASE_ORIGIN = MANAGED_SUPABASE_ORIGIN;
export const COLLECT_PROJECT_REF = new URL(COLLECT_SUPABASE_ORIGIN).hostname.split('.')[0];

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function field(env, name) {
  if (!Object.hasOwn(env, name)) return null;
  const value = env[name];
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new Error('Invalid ' + name);
  return value;
}

function dictionary(env, name) {
  const raw = field(env, name);
  if (raw === null) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid ' + name);
  }
  if (!value || Array.isArray(value) || typeof value !== 'object' || typeof value.default !== 'string' ||
      !value.default || value.default !== value.default.trim()) {
    throw new Error('Invalid ' + name);
  }
  return value.default;
}

function key(value, type, fixture) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 16384 || /[\s\x00-\x1f]/.test(value)) {
    throw new Error('Missing configured ' + type + ' key');
  }
  const serviceKey = new RegExp('^sb_' + type + '_[A-Za-z0-9_-]+$');
  const legacyKey = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  if (!fixture && !serviceKey.test(value) && !legacyKey.test(value)) throw new Error('Invalid configured ' + type + ' key');
  return value;
}

export function configurePublicRuntimeEnv(input) {
  const env = {...input};
  const profile = resolveDeploymentProfile(env);
  if (env.SUPABASE_INTERNAL_URL !== undefined) throw new Error('Supabase origin overrides are not supported');
  if (env.SUPABASE_URL !== undefined && env.SUPABASE_URL !== COLLECT_SUPABASE_ORIGIN) {
    throw new Error('Unexpected Supabase project');
  }
  if (env.COLLECT_DEPLOYMENT_PROFILE === undefined) return env;

  const qualificationFixture = env.APP_ENVIRONMENT === 'test' && profile.environment === 'qualification';
  if (env.APP_ENVIRONMENT !== profile.environment && !qualificationFixture) throw new Error('Deployment environment mismatch');
  if (env.ADMIN_ORIGIN !== undefined && env.ADMIN_ORIGIN !== profile.admin_origin) {
    throw new Error('Admin origin does not match deployment');
  }
  if (env.ADMIN_ORIGINS !== undefined && env.ADMIN_ORIGINS !== profile.admin_origin) {
    throw new Error('Admin origins do not match deployment');
  }
  const allowed = [profile.admin_origin, profile.member_api_origin, profile.public_origin];
  if (env.ALLOWED_ORIGINS !== undefined && env.ALLOWED_ORIGINS.split(',').some(origin => !allowed.includes(origin))) {
    throw new Error('Browser origin does not match deployment');
  }
  env.ADMIN_ORIGIN = profile.admin_origin;
  env.ADMIN_ORIGINS = profile.admin_origin;
  env.ALLOWED_ORIGINS = [...new Set(allowed)].join(',');
  return env;
}

// The signed SMS hook needs the database target policy without the application keys.
function databaseTarget(env) {
  const url = field(env, 'SUPABASE_URL');
  const explicit = field(env, 'COLLECT_DATABASE_URL');
  const database = explicit ?? field(env, 'SUPABASE_DB_URL');
  if (!url || !database) throw new Error('Supabase origin and database must be configured');

  const db = new URL(database);
  const fixture = env.APP_ENVIRONMENT === 'test' && loopbackHosts.has(db.hostname);
  if (!['postgres:', 'postgresql:'].includes(db.protocol) || !db.username || !db.password || db.hash) {
    throw new Error('Invalid database configuration');
  }

  // Only the reserved provider URL may advertise require or prefer. The driver
  // receives no URL overrides and verifies certificates for non-loopback hosts.
  const options = [...db.searchParams];
  const allowedSslModes = explicit === null ? ['verify-full', 'require', 'prefer'] : ['verify-full'];
  if (options.length > 1 || options.some(([name, value]) => name !== 'sslmode' || !allowedSslModes.includes(value))) {
    throw new Error('Database connection overrides are not permitted');
  }

  if (!fixture) {
    const direct = db.hostname === 'db.' + COLLECT_PROJECT_REF + '.supabase.co';
    const pooler = db.hostname.endsWith('.pooler.supabase.com') &&
      decodeURIComponent(db.username).endsWith('.' + COLLECT_PROJECT_REF);
    if ((!direct && !pooler) || db.pathname !== '/postgres' || !['', '5432', '6543'].includes(db.port)) {
      throw new Error('Database project identity mismatch');
    }
  }
  db.search = '';
  return {url, db, fixture};
}

export function normalizeDatabaseTarget(input) {
  return databaseTarget(configurePublicRuntimeEnv(input)).db.href;
}

export function normalizeRuntimeEnv(input) {
  const env = configurePublicRuntimeEnv(input);
  const {url, db, fixture} = databaseTarget(env);
  const issuer = field(env, 'SUPABASE_AUTH_ISSUER');
  if (issuer !== null && issuer !== url + '/auth/v1') throw new Error('Auth issuer must use the public Supabase origin');
  env.SUPABASE_AUTH_ISSUER = url + '/auth/v1';
  for (const name of ['AUTH_ANONYMOUS_ENABLED', 'AUTH_SMS_ENABLED', 'AUTH_WHATSAPP_ENABLED']) {
    if (env[name] !== undefined && !['true', 'false'].includes(env[name])) throw new Error('Invalid ' + name);
  }

  const publicDefault = dictionary(env, 'SUPABASE_PUBLISHABLE_KEYS');
  const secretDefault = dictionary(env, 'SUPABASE_SECRET_KEYS');
  const publicKey = field(env, 'SUPABASE_PUBLISHABLE_KEY') ?? publicDefault ?? field(env, 'SUPABASE_ANON_KEY');
  const serverKey = field(env, 'SUPABASE_SECRET_KEY') ?? secretDefault ?? field(env, 'SUPABASE_SERVICE_ROLE_KEY');
  env.COLLECT_DATABASE_URL = db.href;
  env.SUPABASE_PUBLISHABLE_KEY = key(publicKey, 'publishable', fixture);
  env.SUPABASE_SECRET_KEY = key(serverKey, 'secret', fixture);
  env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SECRET_KEY;
  return env;
}

export function isGoogleProviderNavigation(request) {
  return request.method === 'GET' && new URL(request.url).pathname === '/v1/auth/google/callback' &&
    request.headers.get('Origin') === COLLECT_SUPABASE_ORIGIN && request.headers.get('Sec-Fetch-Mode') === 'navigate' &&
    request.headers.get('Sec-Fetch-Dest') === 'document';
}
