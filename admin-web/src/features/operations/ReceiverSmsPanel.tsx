import {useCallback, useState} from 'react';
import {useSession} from '../../session/SessionProvider';
import {hasScopedAdminAuthority} from '../../session/ownerIdentity';
import {canDisplaySessionRecords, canReadSmsEvidence} from '../../session/sessionContext';
import {Button, Card, ErrorState, LoadingState} from '../../ui';
import {receiptLabels, reasonLabels} from '../overview/smsOversightContract';
import {MomoCell, MomoTable, momoReadOptions} from './MomoRecordViews';
import {MomoSourceRevealPanel} from './MomoSourceRevealPanel';
import {formatTime} from './OperationsRecords';
import {receiverCollections, receiverPage, processingLabels, type ReceiverInboxCheck} from './receiverSmsContract';
import {useOperationRead} from './useOperationRead';
import {inboxReadClock,useInboxFreshness} from './inboxFreshness';

export function ReceiverSmsPanel({simplePayments = false}: {simplePayments?: boolean} = {}) {
  const session = useSession(), {request, user} = session;
  const enabled = canDisplaySessionRecords(session) && canReadSmsEvidence(user);
  const scopedCollection = simplePayments && user && hasScopedAdminAuthority(user) ? user.adminIdentity?.collectionId : undefined;
  const authority = JSON.stringify([session.epoch,session.status,user?.id,user?.sessionId,user?.role,scopedCollection,
    [...(user?.permissions ?? [])].sort()]);
  const load = useCallback(async (signal: AbortSignal) => receiverCollections(await request('momo/observations/collections', {signal})), [request]);
  // This phone Admin was issued one collection. The metadata API still rechecks its live scope on every read.
  const {result, retry} = useOperationRead(authority, enabled && !scopedCollection, load, {...momoReadOptions, live:false});
  const [selection, setSelection] = useState('');
  if (!enabled) return null;
  if (!scopedCollection && !result) return <LoadingState label="Loading receiver collections" layout="table" />;
  if (result?.status === 'error') return <ErrorState message={result.message} onRetry={retry} />;
  const groups = result?.value ?? [];
  const collection = scopedCollection ?? (groups.find(item => item.collectionId === selection) ?? groups[0])?.collectionId;
  if (!collection) return <Card><p>No receiver collections are available for this account.</p></Card>;
  return <Card className="operations-records">{groups.length > 1 && <label>Collection <select className="admin-input" value={collection} onChange={event => setSelection(event.target.value)}>
    {groups.map(item => <option key={item.collectionId} value={item.collectionId}>{item.label}</option>)}</select></label>}
    <CollectionReceipts key={JSON.stringify([authority, collection])} group={collection} simplePayments={simplePayments} />
  </Card>;
}

function CollectionReceipts({group, simplePayments}: {group: string; simplePayments: boolean}) {
  const session = useSession(), request = session.request, permissions = session.user?.permissions ?? [];
  const [cursors, setCursors] = useState<(string | null)[]>([null]), [source, setSource] = useState<string | null>(null);
  const cursor = cursors.at(-1);
  const load = useCallback(async (signal: AbortSignal) => {
    const query = new URLSearchParams({collectionId: group, limit: '25', includeProcessing: '1'});
    if (cursor) query.set('cursor', cursor);
    const started=inboxReadClock();
    const page=receiverPage(await request('momo/observations?' + query, {signal}), group);
    return {page,started};
  }, [request, group, cursor]);
  const {result, retry} = useOperationRead(JSON.stringify([session.epoch, group, cursor, permissions]), true, load, {...momoReadOptions, pollMs: 5000, collectionId: group});
  const sample=session.status==='authenticated' && result?.status==='success' ? {check:result.value.page.inboxCheck,asOf:result.value.page.asOf,started:result.value.started} : null;
  const {fresh}=useInboxFreshness(sample);
  const refresh = () => {setSource(null); setCursors([null]); retry();};
  if (!result) return <LoadingState label="Loading receiver SMS" layout="table" />;
  if (result.status === 'error') return <ErrorState message={result.message} onRetry={refresh} />;
  const page = result.value.page, check = page.inboxCheck, selected = page.items.find(item => item.sourceId === source);
  const canReveal = permissions.includes('sms.reveal'), financial = permissions.includes('payments.read'), showReference = financial && !simplePayments;
  const headings = ['Received by server · Kigali', 'Processing', ...(showReference ? ['Payment reference'] : []), ...(financial ? ['Payer SMS'] : []),
    ...(canReveal ? ['Source'] : [])];
  return <div className="admin-content-enter"><div className="operations-toolbar"><h2>{simplePayments ? 'M-Money SMS' : 'Receiver SMS'}</h2><Button icon="refresh" onClick={refresh}>Refresh receiver</Button></div>
    <InboxCompleteness check={check} fresh={fresh} simplePayments={simplePayments} />
    {page.items.length ? <MomoTable name="Android receiver observations" headings={headings} compact>{page.items.map(item => <tr key={item.sourceId} role="row">
      <MomoCell label="Received by server · Kigali">{formatTime(item.admittedAt)}</MomoCell><MomoCell label="Processing">
        {simplePayments && ['posted', 'reversed', 'unmatched'].includes(item.processing) ? 'Parsed' : processingLabels[item.processing]}
      </MomoCell>
      {showReference && <MomoCell label="Payment reference">{item.paymentReference ?? '—'}</MomoCell>}
      {financial && <MomoCell label="Payer SMS">{item.payerStatus ? receiptLabels[item.payerStatus] : 'No receipt recorded'}{item.payerReason && <div>{reasonLabels[item.payerReason]}</div>}</MomoCell>}
      {canReveal && <MomoCell label="Source">{item.retentionState === 'retained' ? <Button onClick={() => setSource(item.sourceId)}>Review source</Button> : 'Unresolved'}</MomoCell>}
    </tr>)}</MomoTable> : <p>No receiver SMS were recorded in this collection.</p>}
    {(cursor || page.nextCursor) && <div className="operations-pagination"><Button disabled={!cursor} onClick={() => {setSource(null); setCursors(values => values.slice(0,-1));}}>Previous</Button>
      <Button disabled={!page.nextCursor} onClick={() => {setSource(null); setCursors(values => [...values,page.nextCursor]);}}>Next</Button></div>}
    {canReveal && selected?.bodySha256 && <MomoSourceRevealPanel source={{raw_sms_id:selected.sourceId,body_sha256:selected.bodySha256}} observationGroup={group} enabled />}
  </div>;
}

function InboxCompleteness({check,fresh,simplePayments}: {check:ReceiverInboxCheck;fresh:boolean;simplePayments:boolean}) {
  const historical = check.state === 'verified' && !fresh;
  const label = check.state === 'verified'
    ? historical ? 'Last inbox match is out of date. A new inbox check is needed.' : 'Admin phone inboxes matched at the last check.'
    : {unknown:'Waiting for Admin phone inbox checks',checking:'Checking Admin phone inboxes',
      incomplete:simplePayments ? 'SMS sync pending' : 'Reconciliation pending'}[check.state];

  return <section aria-label="Inbox completeness"><h3>Inbox completeness</h3>
    <p role="status">{label}{check.checkedAt && <> · {formatTime(check.checkedAt)} Kigali</>}</p>
    {check.candidateCount !== null && <p>{historical && 'At the last check: '}{check.candidateCount} eligible phone inbox entries · {check.missingCount ?? 'Unknown'} missing · {check.pendingCount ?? 'Unknown'} pending</p>}
    {!historical && check.headsMatch !== null && <p>{check.headsMatch ? 'The latest eligible SMS on each participating phone matched its latest parsed SMS.' : 'At least one phone’s latest eligible SMS differed from its latest parsed SMS.'}</p>}
  </section>;
}
