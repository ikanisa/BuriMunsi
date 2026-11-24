import {useCallback} from 'react';
import {useSession} from '../../session/SessionProvider';
import {canReadSmsEvidence} from '../../session/sessionContext';
import {ErrorState, LoadingState} from '../../ui';
import {receiptLabels, reasonLabels} from '../overview/smsOversightContract';
import {Facts} from './OperationsRecords';
import {MomoSourceRevealPanel} from './MomoSourceRevealPanel';
import {processingLabels, receiverPage} from './receiverSmsContract';
import {paymentTime} from './canonicalPaymentAnalysis';
import {useOperationRead} from './useOperationRead';

export function CanonicalPaymentEvidence({group, sourceId}: {group: string; sourceId: string}) {
  const {epoch, request, user} = useSession();
  const enabled = canReadSmsEvidence(user) && !!user?.permissions.includes('payments.read');
  const load = useCallback(async (signal: AbortSignal) => {
    const cursors = new Set<string>(), seen = new Set<string>();
    let cursor: string | null = null;
    do {
      signal.throwIfAborted();
      const query = new URLSearchParams({collectionId: group, limit: '25', includeProcessing: '1'});
      if (cursor) query.set('cursor', cursor);
      const page = receiverPage(await request('momo/observations?' + query, {signal}), group);
      signal.throwIfAborted();
      for (const item of page.items) {
        if (seen.has(item.sourceId)) throw new Error('The SMS evidence list changed.');
        seen.add(item.sourceId);
        if (item.sourceId === sourceId) return item;
      }
      cursor = page.nextCursor;
      if (cursor) {
        if (!page.items.length || cursors.has(cursor)) throw new Error('The SMS evidence list changed.');
        cursors.add(cursor);
      }
    } while (cursor);
    return null;
  }, [group, request, sourceId]);
  const {result, retry} = useOperationRead(JSON.stringify([epoch, group, sourceId]), enabled, load);
  if (!enabled) return null;
  const evidence = result?.status === 'success' ? result.value : null;
  return <section aria-label="Linked SMS"><h3>Linked SMS</h3>
    {!result ? <LoadingState label="Loading linked SMS" /> : result.status === 'error' ? <ErrorState message={result.message} onRetry={retry} /> :
      evidence ? <><Facts items={[['Received (Kigali)', paymentTime(evidence.admittedAt)], ['Processing', processingLabels[evidence.processing]],
        ['Payer SMS', <>{evidence.payerStatus ? receiptLabels[evidence.payerStatus] : 'No receipt recorded'}
          {evidence.payerReason && <div>{reasonLabels[evidence.payerReason]}</div>}</>],
        ['Source', evidence.retentionState === 'retained' ? 'Retained' : 'Unresolved']]} />
        {user?.permissions.includes('sms.reveal') && evidence.retentionState === 'retained' && evidence.bodySha256 &&
          <MomoSourceRevealPanel source={{raw_sms_id: evidence.sourceId, body_sha256: evidence.bodySha256}} observationGroup={group} enabled />}
      </> : <p>This linked SMS is unavailable in the current collection.</p>}
  </section>;
}
