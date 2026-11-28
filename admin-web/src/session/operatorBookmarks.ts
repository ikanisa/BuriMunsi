import {containsControl, isId} from '../features/core/contracts';
import {paymentId} from '../features/operations/canonicalPaymentAnalysis';

export interface WorkspaceBookmark {
  kind: 'workspace';
  path: string;
  label: string;
}

const rosterKeys = {search: 200, filters: 1400, status: 32, sort: 80, page: 16};
const paymentKeys = {q: 80, payment: 160, status: 64, direction: 16, offset: 16, search: 200,
  sort: 80, page: 16, view: 32, source: 32, dataset: 32};
const transactionKeys = {q: 80, search: 200, status: 64, sort: 80, page: 16, view: 32};

function permittedQuery(params: URLSearchParams, keys: Record<string, number>) {
  const seen = new Set<string>();
  for (const [key, value] of params) {
    if (!Object.hasOwn(keys, key) || seen.has(key) || value.length > keys[key] || containsControl(value)) return false;
    seen.add(key);
  }
  return true;
}

function rosterList(path: string) {
  const pathname = path.split('?', 1)[0];
  return (pathname === '/admin/members' || pathname === '/admin/users') &&
    permittedQuery(new URLSearchParams(path.slice(pathname.length)), rosterKeys);
}

/** Only recorded read routes can be delivered into an existing operator window. */
export function readWorkspaceBookmark(path: string): WorkspaceBookmark | null {
  if (!path.startsWith('/admin') || path.length > 16384 || containsControl(path, true) || path.includes('\\') || path.includes('#')) return null;
  const rawPath = path.split('?', 1)[0];
  const pathname = rawPath.replace(/\/$/, '');
  const search = path.slice(rawPath.length);
  const params = new URLSearchParams(search);
  path = pathname + search;
  let label: string;
  if (path === '/admin') label = 'Home';
  else if (path === '/admin/security') label = 'Account security';
  else if (path === '/admin/admin-users') label = 'Team';
  else if (path === '/admin/licenses') label = 'Open-source notices';
  else if (rosterList(path)) label = 'Members';
  else if (pathname === '/admin/payments' && permittedQuery(params, paymentKeys)) {
    const payment = params.get('payment');
    if (payment !== null && !paymentId.safeParse(payment).success) return null;
    label = payment ? 'Payment details' : 'Payments';
  } else if (pathname === '/admin/transactions' && permittedQuery(params, transactionKeys)) label = 'Payments';
  else {
    const [, admin, section, id, subpage, ...rest] = pathname.split('/');
    if (admin !== 'admin' || !isId(id) || rest.length) return null;
    if (section === 'transactions' && subpage === undefined && !params.size) label = 'Payment details';
    else if ((section === 'members' || section === 'users') &&
        (subpage === undefined || section === 'members' && subpage === 'statement') &&
        permittedQuery(params, {returnTo: 16384})) {
      const back = params.get('returnTo');
      if (back !== null && (containsControl(back, true) || back.includes('\\') || back.includes('#') || !rosterList(back))) return null;
      label = subpage ? 'Member statement' : 'Member details';
    } else return null;
  }
  return {kind: 'workspace', path, label};
}

export type DesktopDestination = WorkspaceBookmark | {kind: 'document'; path: string; label: string};

export function readDesktopDestination(targetURL: string | null | undefined, origin: string): DesktopDestination | null {
  if (!targetURL?.startsWith(origin + '/')) return null;
  const target = targetURL.slice(origin.length);
  if (target === '/privacy' || target === '/privacy/') return {kind: 'document', path: '/privacy', label: 'Privacy and data use'};
  if (target === '/privacy/account-deletion' || target === '/privacy/account-deletion/') {
    return {kind: 'document', path: '/privacy/account-deletion', label: 'Account deletion'};
  }
  return readWorkspaceBookmark(target.startsWith('/#/') ? target.slice(2) : target);
}
