import {useCallback} from 'react';
import {z} from 'zod';
import {useSession} from '../../session/SessionProvider';
import {canReadSmsEvidence} from '../../session/sessionContext';
import {ErrorState, LoadingState} from '../../ui';
import {receiptLabels, reasonLabels} from '../overview/smsOversightContract';
import {Facts} from './OperationsRecords';
import {MomoSourceRevealPanel} from './MomoSourceRevealPanel';
import {processingLabels, receiverEvidenceItem} from './receiverSmsContract';
import {paymentId as paymentIdSchema, paymentTime} from './canonicalPaymentAnalysis';
import {useOperationRead} from './useOperationRead';

const linkedEvidence = z.object({paymentId:paymentIdSchema,groupId:paymentIdSchema,evidence:receiverEvidenceItem.nullable()}).strict();
type EvidenceLink = {paymentId: string; group: string; sourceId: string};

export function CanonicalPaymentEvidence(link: EvidenceLink) {
  const {epoch, user, status, isCurrentAuthority} = useSession();
  if (status !== 'authenticated' || !user || !canReadSmsEvidence(user) || !user.permissions.includes('payments.read') ||
      (user.adminIdentity && user.adminIdentity.collectionId !== link.group) ||
      !isCurrentAuthority(epoch,user.id,user.sessionId)) return null;
  const authority = JSON.stringify([epoch,user.id,user.sessionId,user.role,user.principalId,user.adminIdentity?.collectionId,
    [...user.permissions].sort(),link.group,link.paymentId,link.sourceId]);
  return <ScopedCanonicalPaymentEvidence key={authority} {...link} authority={authority} />;
}

function ScopedCanonicalPaymentEvidence({paymentId,group,sourceId,authority}: EvidenceLink & {authority:string}) {
  const {epoch,request,user,isCurrentAuthority} = useSession();
  const actor = user?.id, sessionId = user?.sessionId;
  const load = useCallback(async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!actor || !sessionId || !isCurrentAuthority(epoch,actor,sessionId)) throw new Error('Evidence access changed.');
    const value = await request('burimunsi/payments/'+paymentId+'/sms-evidence',{signal});
    signal.throwIfAborted();
    if (!isCurrentAuthority(epoch,actor,sessionId)) throw new Error('Evidence access changed.');
    const response = linkedEvidence.parse(value);
    const evidence = response.evidence;
    if (response.paymentId !== paymentId || response.groupId !== group ||
        evidence && (evidence.sourceId !== sourceId || (evidence.retentionState==='retained') !== !!evidence.bodySha256)) {
      throw new Error('The selected payment evidence changed.');
    }
    return evidence;
  }, [actor,epoch,group,isCurrentAuthority,paymentId,request,sessionId,sourceId]);
  const {result,retry} = useOperationRead(authority,true,load,{invalidResponse:'The linked SMS could not be verified.'});
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
