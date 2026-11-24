/* eslint-disable no-control-regex -- Reject control characters in operator search input. */
import {useCallback, useState, type FormEvent} from 'react';
import {Link, useSearchParams} from 'react-router';
import {useSession} from '../../session/SessionProvider';
import {canDisplaySessionRecords, canReadSmsEvidence} from '../../session/sessionContext';
import {Button, Card, StatusBadge} from '../../ui';
import {parseSmsPage, type Page, type SmsReceipt} from './contracts';
import {formatStatus, formatTime} from './OperationsRecords';
import {MomoCell, MomoPager, MomoResult, MomoTable, momoReadOptions} from './MomoRecordViews';
import {useOperationRead} from './useOperationRead';
import {paymentViewLocation} from './paymentLocations';

export function UploadedSms() {
  const session = useSession(), request = session.request, [params, setParams] = useSearchParams();
  const querySearch = params.getAll('search').length === 1 ? params.get('search') ?? '' : '';
  const queryOffset = params.getAll('offset').length === 1 ? params.get('offset') ?? '' : '';
  const search = querySearch.length <= 200 && !/[\x00-\x1f\x7f]/.test(querySearch) ? querySearch : '';
  const offset = /^\d{1,10}$/.test(queryOffset) && Number(queryOffset) <= 2147483647 &&
    Number(queryOffset) % 25 === 0 ? Number(queryOffset) : 0;
  const [draft,setDraft] = useState({search,value:search});
  const setFilter = (value: string, nextOffset: number) => {
    const next = new URLSearchParams({view:'sms',source:'app'});
    if (value) next.set('search', value);
    if (nextOffset) next.set('offset', String(nextOffset));
    setParams(next);
  };
  const returnParams = new URLSearchParams();
  if (search) returnParams.set('search', search);
  if (offset) returnParams.set('offset', String(offset));
  const pathname = paymentViewLocation('sms', {source:'app'}) + (returnParams.size ? '&' + returnParams : '');
  const load = useCallback(async (signal: AbortSignal) => {
    const query = new URLSearchParams({source_kind: 'capture', limit: '25', offset: String(offset)});
    if (search) query.set('search', search);
    const page = parseSmsPage(await request(`sms/receipts?${query}`, {signal}), offset);
    if (page.rows.some((row) => row.source_kind !== 'capture')) throw new Error('Source mismatch.');
    return page;
  }, [offset, search, request]);
  const {result, retry} = useOperationRead(`${session.epoch}:capture:${search}:${offset}`, canDisplaySessionRecords(session) && canReadSmsEvidence(session.user), load, {...momoReadOptions, pollMs: 30_000});
  const input = draft.search === search ? draft.value : search;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (input.length <= 200 && !/[\x00-\x1f\x7f]/.test(input)) setFilter(input.trim(),0);
  };
  return <Card className="operations-records"><div className="operations-toolbar"><h2>App uploads</h2><form className="operations-search" onSubmit={submit}><label className="admin-sr-only" htmlFor="momo-sms-search">Search incoming SMS</label><input id="momo-sms-search" className="admin-input" value={input} maxLength={200} onChange={(event) => setDraft({search,value:event.target.value})} placeholder="User name, member ID or receipt ID" /><Button type="submit">Search</Button></form><Button onClick={retry}>Refresh</Button></div>
    <p className="operations-note">Updates automatically while this page is visible. An upload does not confirm payment or settlement.</p>
    <MomoResult result={result} retry={retry} empty={(page: Page<SmsReceipt>) => page.rows.length === 0 && page.offset === 0}>{(page) => <>{page.rows.length > 0 && <MomoTable name="Incoming mobile-money SMS" headings={['App user', 'Member ID', 'SMS time · Kigali', 'Uploaded · Kigali', 'Status']} compact>
      {page.rows.map((row) => <tr key={row.id} role="row">
        <MomoCell label="App user"><Link className="operations-link" to={`/admin/sms-receipts/capture/${row.id}?${new URLSearchParams({returnTo:pathname})}`}>{row.display_name ?? 'App user'}</Link></MomoCell>
        <MomoCell label="Member ID">{row.public_id ?? 'Not recorded'}</MomoCell>
        <MomoCell label="SMS time · Kigali">{formatTime(row.received_at)}</MomoCell>
        <MomoCell label="Uploaded · Kigali">{formatTime(row.created_at)}</MomoCell>
        <MomoCell label="Status"><StatusBadge>{formatStatus(row.status)}</StatusBadge></MomoCell>
      </tr>)}</MomoTable>}<MomoPager page={page} change={value => setFilter(search,value)} /></>}</MomoResult>
  </Card>;
}
