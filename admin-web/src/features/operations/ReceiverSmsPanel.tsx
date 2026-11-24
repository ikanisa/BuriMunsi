import {useCallback, useState, useSyncExternalStore} from 'react';
import {useSession} from '../../session/SessionProvider';
import {canDisplaySessionRecords} from '../../session/sessionContext';
import {Button, Card, ErrorState, LoadingState} from '../../ui';
import {receiptLabels, reasonLabels} from '../overview/smsOversightContract';
import {MomoCell, MomoTable, momoReadOptions} from './MomoRecordViews';
import {MomoSourceRevealPanel} from './MomoSourceRevealPanel';
import {formatTime} from './OperationsRecords';
import {receiverCollections, receiverPage, processingLabels, type ReceiverInboxCheck} from './receiverSmsContract';
import {useOperationRead} from './useOperationRead';

export function ReceiverSmsPanel() {
  const session = useSession(), request = session.request;
  const enabled = canDisplaySessionRecords(session) && !!session.user?.permissions.includes('sms.read');
  const load = useCallback(async (signal: AbortSignal) => receiverCollections(await request('momo/observations/collections', {signal})), [request]);
  const {result, retry} = useOperationRead(String(session.epoch), enabled, load, {...momoReadOptions, live:false});
  const [selection, setSelection] = useState('');
  if (!enabled) return null;
  if (!result) return <LoadingState label="Loading receiver collections" />;
  if (result.status === 'error') return <ErrorState message={result.message} onRetry={retry} />;
  const groups = result.value, group = groups.find(item => item.collectionId === selection) ?? groups[0];
  if (!group) return <Card><p>No receiver collections are available for this account.</p></Card>;
  return <Card className="operations-records">{groups.length > 1 && <label>Collection <select className="admin-input" value={group.collectionId} onChange={event => setSelection(event.target.value)}>
    {groups.map(item => <option key={item.collectionId} value={item.collectionId}>{item.label}</option>)}</select></label>}
    <CollectionReceipts key={JSON.stringify([session.epoch, group.collectionId])} group={group.collectionId} />
  </Card>;
}

function CollectionReceipts({group}: {group: string}) {
  const session = useSession(), request = session.request, permissions = session.user?.permissions ?? [];
  const [cursors, setCursors] = useState<(string | null)[]>([null]), [source, setSource] = useState<string | null>(null);
  const cursor = cursors.at(-1);
  const load = useCallback(async (signal: AbortSignal) => {
    const query = new URLSearchParams({collectionId: group, limit: '25', includeProcessing: '1'});
    if (cursor) query.set('cursor', cursor);
    return receiverPage(await request('momo/observations?' + query, {signal}), group);
  }, [request, group, cursor]);
  const {result, retry} = useOperationRead(JSON.stringify([session.epoch, group, cursor, permissions]), true, load, {...momoReadOptions, pollMs: 5000, collectionId: group});
  const refresh = () => {setSource(null); setCursors([null]); retry();};
  if (!result) return <LoadingState label="Loading receiver SMS" />;
  if (result.status === 'error') return <ErrorState message={result.message} onRetry={refresh} />;
  const page = result.value, check = page.inboxCheck, selected = page.items.find(item => item.sourceId === source);
  const canReveal = permissions.includes('sms.reveal'), financial = permissions.includes('payments.read');
  const headings = ['Received by server · Kigali', 'Processing', ...(financial ? ['Payment reference','Payer SMS'] : []), ...(canReveal ? ['Source'] : [])];
  return <><div className="operations-toolbar"><h2>Receiver SMS</h2><Button icon="refresh" onClick={refresh}>Refresh receiver</Button></div>
    <InboxCompleteness key={JSON.stringify([check.state, check.checkedAt])} check={check} asOf={page.asOf} receivedAt={result.receivedAt} />
    {page.items.length ? <MomoTable name="Android receiver observations" headings={headings} compact>{page.items.map(item => <tr key={item.sourceId} role="row">
      <MomoCell label="Received by server · Kigali">{formatTime(item.admittedAt)}</MomoCell><MomoCell label="Processing">{processingLabels[item.processing]}</MomoCell>
      {financial && <><MomoCell label="Payment reference">{item.paymentReference ?? '—'}</MomoCell><MomoCell label="Payer SMS">{item.payerStatus ? receiptLabels[item.payerStatus] : 'No receipt recorded'}{item.payerReason && <div>{reasonLabels[item.payerReason]}</div>}</MomoCell></>}
      {canReveal && <MomoCell label="Source">{item.retentionState === 'retained' ? <Button onClick={() => setSource(item.sourceId)}>Review source</Button> : 'Unresolved'}</MomoCell>}
    </tr>)}</MomoTable> : <p>No receiver SMS were recorded in this collection.</p>}
    {(cursor || page.nextCursor) && <div className="operations-pagination"><Button disabled={!cursor} onClick={() => {setSource(null); setCursors(values => values.slice(0,-1));}}>Previous</Button>
      <Button disabled={!page.nextCursor} onClick={() => {setSource(null); setCursors(values => [...values,page.nextCursor]);}}>Next</Button></div>}
    {canReveal && selected?.bodySha256 && <MomoSourceRevealPanel source={{raw_sms_id:selected.sourceId,body_sha256:selected.bodySha256}} observationGroup={group} enabled />}
  </>;
}

// Match the Android receiver's five-minute positive-proof window. Use the
// server timestamps to calculate the report's age when the page was generated.
const INBOX_PROOF_MAX_AGE_MS = 5 * 60 * 1000;

function InboxCompleteness({check, asOf, receivedAt}: {check: ReceiverInboxCheck; asOf: string; receivedAt: number}) {
  const age = check.checkedAt === null ? NaN : Date.parse(asOf) - Date.parse(check.checkedAt);
  const responseDeadline = check.state === 'verified' && age >= 0 && age < INBOX_PROOF_MAX_AGE_MS
    ? Math.round(receivedAt * 1000) + INBOX_PROOF_MAX_AGE_MS - age : null;
  // Polling or replaying the same proof must not reset its initial window.
  const [firstDeadline] = useState(responseDeadline);
  const deadline = responseDeadline === null || firstDeadline === null ? null : Math.min(firstDeadline, responseDeadline);
  const subscribe = useCallback((changed: () => void) => {
    if (deadline === null) return () => {};
    let timer: number | undefined;
    const sync = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      const remaining = deadline - Date.now();
      if (remaining > 0) timer = window.setTimeout(sync, remaining);
      changed();
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('pageshow', sync);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
      window.removeEventListener('pageshow', sync);
    };
  }, [deadline]);
  const fresh = useSyncExternalStore(subscribe, () => deadline !== null && Date.now() < deadline);
  const historical = check.state === 'verified' && !fresh;
  const label = check.state === 'verified'
    ? historical ? 'Last inbox match is out of date. A new inbox check is needed.' : 'Admin phone inboxes matched at the last check.'
    : {unknown:'Waiting for Admin phone inbox checks',checking:'Checking Admin phone inboxes',incomplete:'Reconciliation pending'}[check.state];

  return <section aria-label="Inbox completeness"><h3>Inbox completeness</h3>
    <p role="status">{label}{check.checkedAt && <> · {formatTime(check.checkedAt)} Kigali</>}</p>
    {check.candidateCount !== null && <p>{historical && 'At the last check: '}{check.candidateCount} eligible phone inbox entries · {check.missingCount ?? 'Unknown'} missing · {check.pendingCount ?? 'Unknown'} pending</p>}
    {!historical && check.headsMatch !== null && <p>{check.headsMatch ? 'The latest eligible SMS on each participating phone matched its latest parsed SMS.' : 'At least one phone’s latest eligible SMS differed from its latest parsed SMS.'}</p>}
  </section>;
}
