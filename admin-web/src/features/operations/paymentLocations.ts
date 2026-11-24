import {safeAdminReturnLocation} from '../../session/returnLocation';
import {canReadSmsEvidence} from '../../session/sessionContext';
import type {AdminUser} from '../../session/sessionResponses';

export const paymentsPath = '/admin/payments';
export type PaymentView = 'recorded' | 'sms' | 'attention';
export type ReceiptSource = 'android' | 'app' | 'member';

export const paymentViews = [
  {id: 'recorded', label: 'Recorded'}, {id: 'sms', label: 'SMS & receipts'}, {id: 'attention', label: 'Needs attention'},
] as const;
export const receiptSources = [
  {id: 'android', label: 'Android receiver'}, {id: 'app', label: 'App uploads'}, {id: 'member', label: 'Member submitted'},
] as const;

type PaymentAccess = Pick<AdminUser, 'role' | 'permissions' | 'authMethod'>;

export function canReadMemberReceipts(access: PaymentAccess): boolean {
  return access.permissions.includes('payments.read') &&
    (access.authMethod !== 'phone_passcode' || canReadSmsEvidence(access));
}

export function canOpenPaymentView(view: PaymentView, access: PaymentAccess) {
  const {permissions} = access;
  if (view === 'recorded') return permissions.includes('payments.read');
  if (view === 'attention') return permissions.includes('reconciliations.read');
  return canOpenReceiptSource('member', access) || canReadSmsEvidence(access);
}

export function canOpenReceiptSource(source: ReceiptSource, access: PaymentAccess) {
  return source === 'member' ? canReadMemberReceipts(access) : canReadSmsEvidence(access);
}

export function paymentViewLocation(view: PaymentView, options?: {source?: ReceiptSource; momo?: boolean}) {
  const params = new URLSearchParams();
  if (view !== 'recorded') params.set('view', view);
  if (view === 'recorded' && options?.momo) params.set('dataset', 'momo');
  if (view === 'sms' && options?.source) params.set('source', options.source);
  return paymentsPath + (params.size ? '?' + params : '');
}

/** Detail links can only return to a matching canonical list, never anywhere under the workspace. */
export function safePaymentListReturn(raw: string | null | undefined, view: PaymentView, source?: ReceiptSource) {
  const candidate = safeAdminReturnLocation(raw);
  if (!candidate) return null;
  const url = new URL(candidate, 'https://admin.invalid'), params = url.searchParams;
  const keys = [...params.keys()];
  const allowed = view === 'recorded' ? ['search', 'status', 'sort', 'page'] : view === 'attention'
    ? ['view', 'search', 'status', 'page'] : ['view', 'source', 'search', 'status', 'offset'];
  if (url.pathname !== paymentsPath || new Set(keys).size !== keys.length ||
      keys.some(key => !allowed.includes(key)) ||
      params.get('view') !== (view === 'recorded' ? null : view) ||
      view === 'sms' && params.get('source') !== source) return null;
  return candidate;
}
