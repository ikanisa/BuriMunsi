import {useCallback, type ReactNode} from 'react';
import {isJsonObject} from '../../api/contracts';
import {useSession} from '../../session/SessionProvider';
import {canDisplaySessionRecords, canReadSmsEvidence} from '../../session/sessionContext';
import {ErrorState, LoadingState} from '../../ui';
import {isInternalSmsReference, parseCoreRow} from '../core/contracts';
import {parseReconciliationDetail} from '../reconciliation/contracts';
import {parseSmsDetail} from './contracts';
import {formatMomoAmount} from './MomoRecordViews';
import {parseMomoDetail} from './momoContracts';
import {Facts, formatStatus, formatTime} from './OperationsRecords';
import {useOperationRead} from './useOperationRead';

const display = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;
type Fact = [string, ReactNode];

/** Fetch the selected record only. The list stays usable if this independent read fails. */
export function PaymentActivityFacts({kind, id}: {kind: 'payment' | 'momo' | 'capture' | 'reconciliation'; id: string}) {
  const session = useSession(), {user, request} = session;
  const actor = user?.id, canExtract = user?.role !== 'staff' && !!user?.permissions.includes('sms.extract');
  const principal = user?.principalId, role = user?.role, grants = JSON.stringify(user?.permissions ?? []);
  const allowed = !!user && canDisplaySessionRecords(session) && (kind === 'capture' ? canReadSmsEvidence(user) : kind === 'reconciliation' ?
    user.permissions.includes('reconciliations.read') && user.permissions.includes('users.read') : user.permissions.includes('payments.read'));
  const load = useCallback(async (signal: AbortSignal): Promise<Fact[]> => {
    if (!actor) throw new Error('Session unavailable.');
    if (kind === 'capture') {
      const raw = await request(`sms/receipts/capture/${id}?limit=25&offset=0`, {signal});
      const {resource} = parseSmsDetail(raw, 'capture', id, actor, canExtract);
      return [['Submitted by', resource.display_name], ['Member ID', resource.public_id],
        ['Received · Kigali', formatTime(resource.received_at)], ['Uploaded · Kigali', formatTime(resource.created_at)],
        ['Evidence', formatStatus(resource.evidence_level)], ['Extraction', formatStatus(resource.extraction_status)]];
    }
    if (kind === 'momo') {
      const {transaction} = parseMomoDetail(await request(`momo/transactions/${id}`, {signal}), id);
      return [['MoMo reference', transaction.provider_transaction_id], ['Amount', formatMomoAmount(transaction.amount_minor, transaction.currency)],
        ['Credited amount', formatMomoAmount(transaction.credited_amount_minor)], ['Group', transaction.group_name],
        ['Receiver', transaction.recipient_name], ['Member', transaction.member_name], ['Payer', transaction.payer_name],
        ['Transaction time · Kigali', formatTime(transaction.transaction_at ?? transaction.created_at)]];
    }
    let payment;
    if (kind === 'reconciliation') {
      if (!principal || !role) throw new Error('Payment review unavailable.');
      const raw = await request(`reconciliations/${id}?limit=25&offset=0`, {signal});
      payment = parseReconciliationDetail(raw,'canonical_evidence_ledger',id,actor,principal,JSON.parse(grants) as string[],role).resource;
    } else {
      const raw = await request(`operations/transactions/${id}`, {signal});
      if (raw.contract_version !== 2 || raw.model !== 'canonical_evidence_ledger' || raw.resource_type !== 'transactions' ||
          raw.current_actor_id !== actor || typeof raw.can_manage !== 'boolean' || !isJsonObject(raw.resource) || raw.resource.id !== id) {
        throw new Error('Payment unavailable.');
      }
      payment = parseCoreRow('transactions', 'canonical_evidence_ledger', raw.resource);
    }
    const amount = Number(payment.amount_rwf), allocated = Number(payment.allocated_amount_rwf);
    return [['Recorded amount', formatMomoAmount(amount)], ['Allocated amount', formatMomoAmount(allocated)],
      ['Unallocated amount', formatMomoAmount(amount - allocated)], ['Group', display(payment.group_name)], ['Receiver', display(payment.payee_label)],
      ['Provider reference', isInternalSmsReference(payment.provider_reference) ? null : display(payment.provider_reference)], ['Payer', display(payment.payer_name)],
      ['Observed · Kigali', formatTime(display(payment.observed_at))]];
  }, [actor, canExtract, grants, id, kind, principal, request, role]);
  const {result,retry} = useOperationRead(JSON.stringify([session.epoch,actor,principal,role,grants,kind,id]), allowed, load);
  if (!allowed) return null;
  if (!result) return <LoadingState label="Loading record details" />;
  if (result.status === 'error') return <ErrorState title="Record details unavailable" message={result.message} onRetry={retry} />;
  return <Facts items={result.value} />;
}
