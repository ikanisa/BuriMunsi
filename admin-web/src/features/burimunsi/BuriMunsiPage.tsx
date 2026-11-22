import {featureAuthorityKey} from '../../app/authority';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Card, EmptyState, ErrorState, LoadingState, PageHeader } from '../../ui';
import { sensitiveVerificationDeadline, useSession, type SessionContextValue } from '../../session/SessionProvider';
import {canManageOperatorAccess} from '../../session/ownerIdentity';
import {verificationProofTime} from '../../session/sessionPolicy';
import { clearPending, type PendingIdentity } from '../core/pendingAttempt';
import { parseBuriScopes, type BuriDirectory, type BuriProvisioning, type BuriScope } from './contracts';
import { GUARDED_OPERATOR_FAMILY, parseBuriOutcome, parseBuriPending, type BuriPending } from './recovery';
import { OperatorPreparation } from './OperatorApprovalPreview';
import { readBuriDirectory } from './operatorApproval';
import {listBuriMutationAttempts, readNativeReviewDirectory, type NativeAccessContext} from './nativeAccess';
import {BuriDirectoryView} from './BuriDirectoryView';
import { NativeRevocationPanel } from './NativeRevocationPanel';
import { NativeProvisioningPanel } from './NativeProvisioningPanel';
import '../core/core.css';

export interface BuriMunsiPageProps {
  onBack?: () => void; onVerify?: () => void;
  operatorPreparationEnabled?: boolean;
  operatorApprovalEnabled?: boolean;
  nativeAdministrationEnabled?: boolean;
  /** Defaults off pending backend deployment and mixed-client qualification. */ nativeRevocationEnabled?: boolean;
  /** Independently gated until secret handling and the backend are qualified. */ nativePinEnabled?: boolean;
  /** Independently gated until protected token delivery is qualified. */ nativeGrantEnabled?: boolean;
  /** Review never reads or modifies retained operation checkpoints or offers actions. */ readOnlyReview?: boolean;
  verificationLabel?: string;
}
type GroupAttempt = BuriPending & {family: string};
type ScopeData = {scope: string; proofAt: string; groups: BuriScope[]; pending: GroupAttempt[]};
type GroupData = {scope: string; proofAt: string; collectionId: string; directory: BuriDirectory; provisioning: BuriProvisioning | null; provisioningError: boolean};

export function BuriMunsiPage(props: BuriMunsiPageProps) {
  const session = useSession(), user = session.user;
  const scope = JSON.stringify([session.status, session.verificationMode, user && featureAuthorityKey(session.epoch, user), user?.ownerIdentity, user?.adminIdentity, user?.mfaRequired, props.readOnlyReview ?? false]);
  return <BuriMunsiAccess key={scope} {...props} session={session} scope={scope} />;
}

function BuriMunsiAccess({session, scope, onBack, onVerify, operatorPreparationEnabled = false, operatorApprovalEnabled = false, nativeAdministrationEnabled = false, nativeRevocationEnabled = false, nativePinEnabled = false, nativeGrantEnabled = false, readOnlyReview = false, verificationLabel}: BuriMunsiPageProps & {session: SessionContextValue; scope: string}) {
  const user = session.user, epoch = session.epoch;
  const usesPasscode = session.verificationMode === 'passcode';
  const scopedPhone = usesPasscode && !!user?.accountId;
  const proofLabel = usesPasscode ? 'passcode' : 'email';
  const hasPendingVerification = () => !usesPasscode && session.sensitiveEmailRecovery() !== null;
  const identity: PendingIdentity | null = user ? {id: user.id, sessionId: user.sessionId, email: user.email, role: user.role, permissions: user.permissions, expiresAt: user.expiresAt} : null;
  const owner = !!user && session.status === 'authenticated' && session.verificationMode !== 'authenticator' && user.financialModel === 'canonical_evidence_ledger' && canManageOperatorAccess(user);
  const allowed = owner && ['admin_users.manage', 'receivers.manage', 'receivers.read'].every(permission => user!.permissions.includes(permission));
  const authority = useRef(scope), selectedRef = useRef(''), busy = useRef(false), liveSession = useRef(session), revokeGate = useRef(nativeRevocationEnabled), pinGate = useRef(nativePinEnabled), grantGate = useRef(nativeGrantEnabled), reviewGate = useRef(readOnlyReview), approvalGate = useRef(operatorApprovalEnabled), nativeAdminGate = useRef(nativeAdministrationEnabled);
  useLayoutEffect(() => {authority.current = scope; return () => {authority.current = '';};}, [scope]);
  useLayoutEffect(() => {liveSession.current = session;}, [session]);
  useLayoutEffect(() => {revokeGate.current = nativeRevocationEnabled;}, [nativeRevocationEnabled]);
  useLayoutEffect(() => {pinGate.current = nativePinEnabled;}, [nativePinEnabled]);
  useLayoutEffect(() => {grantGate.current = nativeGrantEnabled;}, [nativeGrantEnabled]);
  useLayoutEffect(() => {approvalGate.current = operatorApprovalEnabled;}, [operatorApprovalEnabled]);
  useLayoutEffect(() => {nativeAdminGate.current = nativeAdministrationEnabled;}, [nativeAdministrationEnabled]);
  useLayoutEffect(() => {reviewGate.current = readOnlyReview;}, [readOnlyReview]);
  const [, setProofTick] = useState(0);
  const proofDeadline = user && session.verificationMode !== 'authenticator' ? sensitiveVerificationDeadline(user, 'supabase') : null;
  useEffect(() => {
    if (proofDeadline === null) return;
    const timer = window.setTimeout(() => setProofTick(value => value + 1), Math.max(0, proofDeadline - Date.now() + 1));
    return () => window.clearTimeout(timer);
  }, [proofDeadline, scope]);
  const active = () => !!user && authority.current === scope && allowed && session.isCurrentAuthority(epoch, user.id, user.sessionId);
  const fresh = () => !!user && active() && !hasPendingVerification() && session.isRecentSensitiveVerification(epoch, user.id, user.sessionId);
  const [data, setData] = useState<ScopeData | null>(null), [selected, setSelected] = useState(''), [group, setGroup] = useState<GroupData | null>(null), [outcomes, setOutcomes] = useState<Record<string, string>>({});
  const [state, setState] = useState<'ready' | 'loading'>('ready'), [message, setMessage] = useState('');
  const freshView = !!user && allowed && session.isCurrentAuthority(epoch, user.id, user.sessionId) && !hasPendingVerification() && session.isRecentSensitiveVerification(epoch, user.id, user.sessionId);
  const proofTime = user && verificationProofTime(user);
  const scopeData = data?.scope === scope && data.proofAt === proofTime && freshView ? data : null;
  const groupData = group?.scope === scope && group.proofAt === proofTime && group.collectionId === selected && freshView ? group : null;
  const displayedGroup = useRef<GroupData | null>(null);
  useLayoutEffect(() => {
    displayedGroup.current = groupData;
    return () => {displayedGroup.current = null;};
  }, [groupData]);
  const currentProofTime = () => liveSession.current.user && verificationProofTime(liveSession.current.user);
  const proofCurrent = (verifiedAt: string) => fresh() && currentProofTime() === verifiedAt;
  const groupCurrent = (collection: string, verifiedAt: string) => selectedRef.current === collection && proofCurrent(verifiedAt);
  const currentAction = () => !reviewGate.current && !!groupData && displayedGroup.current === groupData &&
    groupCurrent(groupData.collectionId, groupData.proofAt);
  const recheck = async () => {
    const recheckProof = usesPasscode ? session.recheckSensitivePasscode : session.recheckSensitiveEmailVerification;
    if (!active() || hasPendingVerification() || !await recheckProof?.() || !fresh()) throw new Error(`Verify your current owner ${proofLabel} before continuing.`);
    const verifiedAt = currentProofTime();
    if (!verifiedAt) throw new Error('Verification unavailable');
    return verifiedAt;
  };
  const verifyAction = async () => {
    if (!currentAction()) return false;
    try {await recheck(); return currentAction();} catch {return false;}
  };
  const loadScopes = async () => {
    if (!identity || !allowed || busy.current || !active()) return; busy.current = true; setState('loading'); setMessage(''); setData(null); setGroup(null); setOutcomes({});
    try {
      const verifiedAt = await recheck();
      const [response, attempts] = await Promise.all([
        session.request('momo/native-setup'),
        readOnlyReview ? [] : listBuriMutationAttempts(identity),
      ]);
      const allGroups = parseBuriScopes(response);
      const groups = scopedPhone ? allGroups.filter(item => item.id === user?.adminIdentity?.collectionId) : allGroups;
      const pending = attempts.map(attempt => ({...parseBuriPending(attempt), family: attempt.family}));
      if (new Set(pending.map(value => `${value.kind}:${value.requestId}`)).size !== pending.length || !proofCurrent(verifiedAt)) throw new Error('Access changed');
      const initial = pending.find(value => groups.some(item => item.id === value.collectionId))?.collectionId ?? (groups.length === 1 ? groups[0].id : '');
      setData({scope, proofAt: verifiedAt, groups, pending}); setSelected(initial); selectedRef.current = initial; setGroup(null); setOutcomes({});
    } catch {if (active()) {setData(null); setGroup(null); setMessage(scopedPhone ? 'Group access could not be loaded. Try again.' : `Owner verification, prepared groups or retained requests could not be confirmed. Verify your ${proofLabel} and try again.`);}}
    finally {busy.current = false; if (active()) setState('ready');}
  };
  const loadGroup = async () => {
    if (!scopeData || !selected || !scopeData.groups.some(item => item.id === selected) || busy.current || !fresh()) return;
    const collection = selected; busy.current = true; setState('loading'); setMessage('');
    try {
      const verifiedAt = await recheck();
      const current = () => groupCurrent(collection, scopeData.proofAt);
      if (verifiedAt !== scopeData.proofAt || !current()) throw new Error('Authority changed');
      const directory = await readBuriDirectory(session.request, collection, operatorApprovalEnabled && !readOnlyReview, current);
      if (!current()) throw new Error('Authority changed');
      let provisioning: BuriProvisioning | null = null, provisioningError = false;
      try {
        const negotiate = (nativeAdministrationEnabled || nativeRevocationEnabled || nativePinEnabled) && !readOnlyReview;
        provisioning = await readNativeReviewDirectory(session.request, collection, negotiate, current);
      } catch {provisioningError = true;}
      if (!current()) throw new Error('Authority changed');
      setGroup({scope, proofAt: verifiedAt, collectionId: collection, directory, provisioning, provisioningError});
    } catch {if (active()) {setGroup(null); setMessage('The selected group or its BuriMunsi access could not be verified.');}}
    finally {busy.current = false; if (active()) setState('ready');}
  };
  const checkOriginal = async (pending: GroupAttempt) => {
    if (reviewGate.current || !identity || !scopeData || pending.collectionId !== selected || busy.current || !fresh()) return; const collection = selected, index = `${pending.kind}:${pending.requestId}`; busy.current = true; setState('loading'); setMessage('');
    try {
      const verifiedAt = await recheck();
      const current = () => !reviewGate.current && groupCurrent(collection, scopeData.proofAt);
      if (verifiedAt !== scopeData.proofAt || !current()) throw new Error('Authority changed');
      const query = new URLSearchParams({collectionId: collection}), path = pending.kind === 'operator' ? 'burimunsi/operators' : 'burimunsi/provisioning';
      const result = parseBuriOutcome(await session.request(`${path}/requests/${pending.requestId}?${query}`), pending);
      if (!current()) throw new Error('Authority changed');
      if (result !== 'not_found' && (pending.kind === 'operator' ||
          pending.kind === 'provisioning' && ['revoke_installation', 'set_pin'].includes(String(pending.intent.operation)))) {
        await clearPending(identity, pending.family, `${pending.collectionId}:${pending.principalId}`, pending.requestId, undefined, undefined,
          retained => current() && retained.permission === 'admin_users.manage' && JSON.stringify(retained.intent) === JSON.stringify(pending.intent));
        if (!current()) return;
        setData(previous => previous?.scope === scope ? {...previous, pending: previous.pending.filter(item => item !== pending)} : previous);
        setMessage(pending.family === 'burimunsi.operator' ? 'The original operator approval was recorded.' :
          pending.family === GUARDED_OPERATOR_FAMILY ? 'The original operator approval was recorded. Check saved approval to finish any shared recovery.' :
          result === 'cancelled' ? 'The original native request was cancelled. Check native requests to finish any shared recovery.' : pending.intent.operation === 'set_pin' ? 'The original PIN setup was recorded. Check native requests to finish any shared recovery.' : 'The original installation revocation was recorded. Check native requests to finish any shared recovery.');
        return;
      }
      setOutcomes(previous => ({...previous, [index]: result === 'not_found' ? 'No receipt was found. This does not establish failure; keep the original request reference.' : result === 'cancelled' ? 'The original request was recorded as cancelled.' : 'The original request was recorded. Return to its original workflow for any remaining delivery or recovery.'}));
    } catch {if (active()) setOutcomes(previous => ({...previous, [index]: 'The original request could not be verified. Keep its reference and check again.'}));}
    finally {busy.current = false; if (active()) setState('ready');}
  };
  const nativeContractConfirmed = groupData?.provisioning?.provisioningContract === 2;
  const revocationEnabled = nativeContractConfirmed && (nativeAdministrationEnabled || nativeRevocationEnabled);
  const pinEnabled = nativeContractConfirmed && (nativeAdministrationEnabled || nativePinEnabled);
  const selectedGroup = scopeData?.groups.find(item => item.id === selected);
  const groupContext = user && identity && groupData && !readOnlyReview ? {
    request: session.request, user, identity, collectionId: groupData.collectionId,
  } : undefined;
  const approvalContext: NativeAccessContext | undefined = groupContext && groupData && operatorApprovalEnabled ? {
    ...groupContext, enabled: groupData.directory.approvalContract === 2,
    isEnabled: () => approvalGate.current && !reviewGate.current,
    isCurrent: currentAction, verifyFresh: verifyAction,
  } : undefined;
  const resetGroup = (notice: string) => {
    setData(null); setGroup(null); setSelected(''); selectedRef.current = ''; setOutcomes({});
    setMessage(notice);
  };
  const header = <PageHeader title="BuriMunsi access" subtitle="Review operator and native installation access." actions={onBack ? <Button type="button" onClick={onBack}>Back to team</Button> : undefined} />;
  if (!user || session.status !== 'authenticated') return <>{header}<ErrorState title="Sign-in required" message="Sign in to view this workspace." /></>;
  if (!owner) return <>{header}<ErrorState title={scopedPhone ? 'Admin access unavailable' : 'Owner identity unavailable'} message={scopedPhone ? 'Your account needs Admin access to this group.' : 'A protected owner identity bound to this session is required to open BuriMunsi access.'} /></>;
  if (!allowed) return <>{header}<ErrorState title="Access unavailable" message={scopedPhone ? 'Your Admin account needs team and receiving-phone permissions.' : 'Your owner account needs current team and receiving-phone permissions.'} /></>;
  return <>{header}<Card><div className="core-detail"><h2>{scopedPhone ? 'Group access' : 'Owner verification'}</h2>{!scopedPhone && <p>Access requires the protected owner and a recent {proofLabel} verification.</p>}
    {message && <p role="alert">{message}</p>}{state === 'loading' && <LoadingState label="Checking BuriMunsi access" />}
    {!freshView && !scopedPhone && <p>Verify your current owner {proofLabel} before viewing these records.</p>}
    {hasPendingVerification() && <p>Resolve the original verification request before continuing.</p>}
    <Button type="button" disabled={state !== 'ready' || hasPendingVerification()} onClick={() => void loadScopes()}>{scopeData ? 'Refresh prepared groups' : scopedPhone ? 'Load groups' : 'Check verification and load groups'}</Button>{onVerify && !freshView && !scopedPhone && <Button type="button" disabled={state !== 'ready'} onClick={onVerify}>{verificationLabel ?? `Verify ${proofLabel}`}</Button>}
  </div></Card>
  {scopeData && <><Card><div className="core-detail"><h2>Prepared groups</h2>{scopeData.groups.length === 0 ? <EmptyState title="No prepared groups" description="Prepare a receiving group before reviewing BuriMunsi access." /> : <>
    <label>Group<select className="admin-input" value={selected} disabled={state !== 'ready'} onChange={event => {setSelected(event.target.value); selectedRef.current = event.target.value; setGroup(null); setOutcomes({});}}><option value="">Select a group</option>{scopeData.groups.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
    {selected && <><p>Recorded scope: {selectedGroup?.enabled ? 'enabled' : 'not enabled'} · {selectedGroup?.paired ? 'receiving phone paired' : 'no receiving phone paired'}.</p><Button type="button" disabled={state !== 'ready'} onClick={() => void loadGroup()}>Load group access</Button></>}
    </>}{!readOnlyReview && scopeData.pending.filter(item => !scopeData.groups.some(group => group.id === item.collectionId)).map(item => <p role="alert" key={`${item.kind}:${item.requestId}`}>A retained request belongs to unavailable group <code>{item.collectionId}</code>. Keep its original reference: <code>{item.requestId}</code>.</p>)}</div></Card>
    {!readOnlyReview && selected && scopeData.pending.filter(item => item.collectionId === selected).map(item => <Card key={`${item.kind}:${item.requestId}`}><div className="core-detail"><h2>Original {item.kind === 'operator' ? 'approval' : 'native setup'} request</h2><p>Request reference: <code>{item.requestId}</code></p><p>Account: {item.principalId}</p><Button type="button" disabled={state !== 'ready'} onClick={() => void checkOriginal(item)}>Check original request</Button>{outcomes[`${item.kind}:${item.requestId}`] && <p role="status">{outcomes[`${item.kind}:${item.requestId}`]}</p>}</div></Card>)}
    {groupData && <BuriDirectoryView directory={groupData.directory} provisioning={groupData.provisioning} provisioningError={groupData.provisioningError} phoneAccounts={scopedPhone} />}
    {!readOnlyReview && groupData && (operatorPreparationEnabled || operatorApprovalEnabled) && <OperatorPreparation
      key={`approval:${scope}:${selected}:${groupData.proofAt}`} directory={groupData.directory} context={approvalContext}
      phoneAccounts={scopedPhone}
      blocked={state !== 'ready' || scopeData.pending.some(item => item.collectionId === selected)}
      onRecorded={requestId => {
        setData(previous => previous?.scope === scope ? {...previous, pending: previous.pending.filter(item => item.family !== GUARDED_OPERATOR_FAMILY || item.requestId !== requestId)} : previous);
        setGroup(null); setOutcomes({}); setMessage('Operator access was recorded. Reload the group to see the current approval.');
      }} />}
    {groupContext && groupData?.provisioning && <NativeRevocationPanel key={`${scope}:${selected}:${groupData.proofAt}`} directory={groupData.provisioning} context={{
      ...groupContext, enabled: revocationEnabled, isEnabled: () => !reviewGate.current && nativeContractConfirmed && (revokeGate.current || nativeAdminGate.current),
      isCurrent: currentAction, verifyFresh: verifyAction,
    }} onResolved={status => resetGroup(status === 'recorded' ? 'The original installation revocation was recorded. Load groups to refresh access.' : 'The original native request was cancelled. Load groups to refresh access.')} />}
    {groupContext && groupData?.provisioning && <NativeProvisioningPanel key={`${scope}:${selected}:${groupData.proofAt}:${nativePinEnabled}:${nativeGrantEnabled}`} directory={groupData.provisioning}
      pinContext={{...groupContext,
        enabled: pinEnabled, isEnabled: () => !reviewGate.current && nativeContractConfirmed && (pinGate.current || nativeAdminGate.current),
        isCurrent: currentAction, verifyFresh: verifyAction, isVisible: () => document.visibilityState === 'visible'}}
      grantContext={{...groupContext,
        enabled: nativeGrantEnabled, isEnabled: () => grantGate.current,
        isCurrent: currentAction, verifyFresh: verifyAction, isVisible: () => document.visibilityState === 'visible'}}
      onResolved={status => resetGroup(status === 'recorded' ? 'The original PIN setup was recorded. Load groups to refresh access.' : status === 'cancelled' ? 'The original native request was cancelled. Load groups to refresh access.' : 'The local delivery record was closed. Load groups to refresh access.')} />}
    {!readOnlyReview && !revocationEnabled && !pinEnabled && !nativeGrantEnabled &&
      <p className="core-note">Native PIN setup and installation changes are currently unavailable.</p>}
  </>}
  </>;
}
