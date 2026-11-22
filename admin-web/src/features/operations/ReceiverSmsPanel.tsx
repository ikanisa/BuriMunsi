import {useCallback, useState} from 'react';
import {useSession} from '../../session/SessionProvider';
import {canDisplaySessionRecords} from '../../session/sessionContext';
import {Button, Card, ErrorState, LoadingState} from '../../ui';
import {receiptLabels, reasonLabels} from '../overview/smsOversightContract';
import {MomoTable, momoReadOptions} from './MomoRecordViews';
import {MomoSourceRevealPanel} from './MomoSourceRevealPanel';
import {formatTime} from './OperationsRecords';
import {receiverCollections, receiverPage, processingLabels} from './receiverSmsContract';
import {useOperationRead} from './useOperationRead';

export function ReceiverSmsPanel() {
  const session = useSession(), request = session.request;
  const enabled = canDisplaySessionRecords(session) && !!session.user?.permissions.includes('sms.read');
  const load = useCallback(async () => receiverCollections(await request('momo/observations/collections')), [request]);
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
  const load = useCallback(async () => {
    const query = new URLSearchParams({collectionId: group, limit: '25', includeProcessing: '1'});
    if (cursor) query.set('cursor', cursor);
    return receiverPage(await request('momo/observations?' + query), group);
  }, [request, group, cursor]);
  const {result, retry} = useOperationRead(JSON.stringify([session.epoch, group, cursor, permissions]), true, load, {...momoReadOptions, pollMs: 5000, collectionId: group});
  const refresh = () => {setSource(null); setCursors([null]); retry();};
  if (!result) return <LoadingState label="Loading receiver SMS" />;
  if (result.status === 'error') return <ErrorState message={result.message} onRetry={refresh} />;
  const page = result.value, check = page.inboxCheck, selected = page.items.find(item => item.sourceId === source);
  const canReveal = permissions.includes('sms.reveal'), financial = permissions.includes('payments.read');
  const headings = ['Received by server · Kigali', 'Processing', ...(financial ? ['Payment reference','Payer SMS'] : []), ...(canReveal ? ['Source'] : [])];
  return <><div className="operations-toolbar"><h2>Receiver SMS</h2><Button icon="refresh" onClick={refresh}>Refresh receiver</Button></div>
    <section aria-label="Inbox completeness"><h3>Inbox completeness</h3>
      <p role="status">{{unknown:'No current receiver evidence',checking:'Checking the inbox',incomplete:'Reconciliation pending',verified:'Inbox matched at the last check'}[check.state]}
        {check.checkedAt && <> · {formatTime(check.checkedAt)} Kigali</>}</p>
      {check.candidateCount !== null && <p>{check.candidateCount} eligible SMS · {check.missingCount ?? 'Unknown'} missing · {check.pendingCount ?? 'Unknown'} pending</p>}
      {check.headsMatch !== null && <p>{check.headsMatch ? 'The latest eligible handset SMS and parsed SMS matched.' : 'The latest eligible handset SMS and parsed SMS differed.'}</p>}
    </section>
    {page.items.length ? <MomoTable name="Android receiver observations" headings={headings}>{page.items.map(item => <tr key={item.sourceId}>
      <td>{formatTime(item.admittedAt)}</td><td>{processingLabels[item.processing]}</td>
      {financial && <><td>{item.paymentReference ?? '—'}</td><td>{item.payerStatus ? receiptLabels[item.payerStatus] : 'No receipt recorded'}{item.payerReason && <div>{reasonLabels[item.payerReason]}</div>}</td></>}
      {canReveal && <td>{item.retentionState === 'retained' ? <Button onClick={() => setSource(item.sourceId)}>Review source</Button> : 'Unresolved'}</td>}
    </tr>)}</MomoTable> : <p>No receiver SMS were recorded in this collection.</p>}
    {(cursor || page.nextCursor) && <div className="operations-pagination"><Button disabled={!cursor} onClick={() => {setSource(null); setCursors(values => values.slice(0,-1));}}>Previous</Button>
      <Button disabled={!page.nextCursor} onClick={() => {setSource(null); setCursors(values => [...values,page.nextCursor]);}}>Next</Button></div>}
    {canReveal && selected?.bodySha256 && <MomoSourceRevealPanel source={{raw_sms_id:selected.sourceId,body_sha256:selected.bodySha256}} observationGroup={group} enabled />}
  </>;
}
