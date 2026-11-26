import {useCallback, useLayoutEffect, useRef} from 'react';
import {z} from 'zod';
import {verifySensitiveAccess} from '../../app/sensitive-access';
import {useSession, type AdminUser, type SessionContextValue} from '../../session/SessionProvider';
import {hasScopedAdminAuthority} from '../../session/ownerIdentity';
import {LoadingState} from '../../ui';
import {paymentId as paymentIdSchema} from './canonicalPaymentAnalysis';
import {revealMomoSource} from './momoSourceReveal';
import {receiverEvidenceItem} from './receiverSmsContract';
import {useOperationRead} from './useOperationRead';

const linkedEvidence = z.object({paymentId:paymentIdSchema,groupId:paymentIdSchema,evidence:receiverEvidenceItem.nullable()}).strict();
type EvidenceLink = {paymentId: string; group: string; sourceId: string};

export function mayViewPaymentSms(user: AdminUser | null, group: string | null | undefined): user is AdminUser {
  return !!user && !!group && user.financialModel === 'canonical_evidence_ledger' && hasScopedAdminAuthority(user) &&
    user.adminIdentity?.collectionId === group && ['payments.read','sms.read','sms.reveal'].every(permission => user.permissions.includes(permission));
}

export function CanonicalPaymentEvidence(link: EvidenceLink) {
  const session = useSession(), {epoch,user,status} = session;
  if ((status !== 'authenticated' && status !== 'rechecking') || !mayViewPaymentSms(user,link.group)) return null;
  const authority = JSON.stringify([epoch,user.id,user.sessionId,user.principalId,user.accountId,[...user.permissions].sort(),
    link.group,link.paymentId,link.sourceId]);
  return <OriginalSms key={authority} {...link} authority={authority} session={session} />;
}

function OriginalSms({paymentId,group,sourceId,authority,session}: EvidenceLink & {authority:string;session:SessionContextValue}) {
  const live = useRef<SessionContextValue | null>(null);
  const dispatched = useRef(false);
  useLayoutEffect(() => {live.current = session; return () => {live.current = null;};}, [session]);

  const load = useCallback(async (signal: AbortSignal) => {
    const access = live.current, actor = access?.user;
    if (!access || !actor) throw new Error('Account access changed.');
    const current = () => !signal.aborted && live.current?.status === 'authenticated' &&
      live.current.isCurrentAuthority(access.epoch,actor.id,actor.sessionId) && mayViewPaymentSms(live.current.user,group);
    if (!current() || dispatched.current) throw new Error('Original SMS unavailable.');
    const payload = await access.request('burimunsi/payments/'+paymentId+'/sms-evidence',{signal});
    if (!current()) throw new Error('Account access changed.');
    const response = linkedEvidence.parse(payload), evidence = response.evidence;
    if (response.paymentId !== paymentId || response.groupId !== group ||
        evidence && (evidence.sourceId !== sourceId || (evidence.retentionState === 'retained') !== !!evidence.bodySha256)) {
      throw new Error('The linked SMS could not be verified.');
    }
    if (!evidence?.bodySha256 || evidence.retentionState !== 'retained') return null;
    const source = {raw_sms_id:evidence.sourceId, body_sha256:evidence.bodySha256};
    const original = await revealMomoSource({source, observationGroup:group, enabled:true, signal,
      financialModel:actor.financialModel, identity:actor, isCurrent:current, verifyFresh:() => verifySensitiveAccess(access,actor),
      request:(path,options) => {
        // The audited read has no receipt lookup. Only an explicit retry may send it again for this open payment.
        if (!current() || dispatched.current) throw new Error('Original SMS unavailable.');
        dispatched.current = true;
        return access.request(path,options);
      }}, 'View SMS from payment details');
    return original.body;
  }, [group,paymentId,sourceId]);
  const {result,retry} = useOperationRead(authority,true,load,{reuseSettledOnResume:true});
  const user = session.user;
  if (session.status !== 'authenticated' || !user || !session.isCurrentAuthority(session.epoch,user.id,user.sessionId)) return null;
  return <section className="payment-detail-evidence" aria-label="Original SMS"><h3>Original SMS</h3>
    {!result ? <LoadingState label="Loading original SMS" /> : result.status === 'error' ? <p role="alert">
      The original SMS could not be verified. <button type="button" className="operations-link"
        onClick={() => {dispatched.current = false; retry();}}>Try again</button></p> :
      result.value === null ? <p>The original SMS is unavailable for this payment.</p> :
        <p className="payment-sms-body">{result.value}</p>}
  </section>;
}
