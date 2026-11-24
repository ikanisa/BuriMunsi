import {useCallback, useRef, useState, type FormEvent} from 'react';
import {Link, useSearchParams} from 'react-router';
import {z} from 'zod';
import {AdminRequestError} from '../../api/client';
import {useSession} from '../../session/SessionProvider';
import {canDisplaySessionRecords, canReadSmsEvidence} from '../../session/sessionContext';
import {Button, Card, Dialog, EmptyState, ErrorState, Field, LoadingState, PageHeader, StatusBadge} from '../../ui';
import {MomoCell, MomoTable} from './MomoRecordViews';
import {Facts} from './OperationsRecords';
import {ReceiverSmsPanel} from './ReceiverSmsPanel';
import {useOperationRead} from './useOperationRead';
import './operations.css';
import './paymentsWorkspace.css';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/);
const count = z.number().int().nonnegative();
const version = count.min(1);
const direction = z.enum(['incoming', 'outgoing']);
const allocationState = z.enum(['allocated', 'unallocated']);
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)));
export const buriMunsiPayment = z.object({
  id, version, direction, amountRwf: count.nullable(), atRaw: z.string().nullable(),
  ftId: z.string().nullable(), payerNameRaw: z.string().nullable(), memberId: id.nullable(),
  memberName: z.string().nullable(), state: allocationState, sourceId: id.nullish(), canAllocate: z.boolean().optional(),
}).refine(row => (row.state === 'allocated') === (row.memberId !== null) &&
  (row.memberId !== null || row.memberName === null));
export type BuriMunsiPayment = z.infer<typeof buriMunsiPayment>;
const paymentPage = z.object({items: z.array(buriMunsiPayment).max(25), totalCount: count,
  offset: count, limit: z.literal(25), nextOffset: count.nullable(), asOf: timestamp});
const membersPage = z.object({items: z.array(z.object({id, name: z.string().min(1)})).max(25)});
const allocated = z.object({paymentId: id, memberId: id, state: z.literal('allocated'), version});
const maxSearchLength = 80;
const maxOffset = 100_000;
const amountFormat = new Intl.NumberFormat('en-RW');
const amount = (value: number | null) => value === null ? '—' : `RWF ${amountFormat.format(value)}`;
const allocationLabel = (state: BuriMunsiPayment['state']) => state === 'allocated' ? 'Allocated' : 'Unallocated';
const directionLabel = (value: BuriMunsiPayment['direction']) => value === 'incoming' ? 'Incoming' : 'Outgoing';
export const buriMunsiPaymentsPath = '/admin/payments';
export const buriMunsiSmsPath = buriMunsiPaymentsPath + '?view=sms';
export const buriMunsiPaymentPath = (paymentId: string) => buriMunsiPaymentsPath + '?' + new URLSearchParams({payment: paymentId});

function verifiedPage(payload: unknown, offset: number) {
  const page = paymentPage.parse(payload);
  if (page.offset !== offset || new Set(page.items.map(row => row.id)).size !== page.items.length ||
      page.items.length !== Math.max(0, Math.min(page.limit, page.totalCount - offset)) ||
      page.nextOffset !== (offset + page.items.length < page.totalCount ? offset + page.items.length : null)) {
    throw new Error('The payments page changed.');
  }
  return page;
}

export function BuriMunsiPaymentRows({rows, onSelect}: {rows: BuriMunsiPayment[]; onSelect?: (paymentId: string) => void}) {
  return <MomoTable name="Payments" headings={['Reference', 'Direction', 'Amount', 'Member', 'Status', 'Payment time']} compact>
    {rows.map(row => <tr key={row.id}><MomoCell label="Reference">{onSelect
      ? <button type="button" className="operations-link" onClick={() => onSelect(row.id)}>{row.ftId ?? 'View payment'}</button>
      : <Link className="operations-link" to={buriMunsiPaymentPath(row.id)}>{row.ftId ?? 'View payment'}</Link>}</MomoCell>
      <MomoCell label="Direction">{directionLabel(row.direction)}</MomoCell>
      <MomoCell label="Amount">{amount(row.amountRwf)}</MomoCell>
      <MomoCell label="Member">{row.memberName ?? '—'}</MomoCell>
      <MomoCell label="Status"><StatusBadge>{allocationLabel(row.state)}</StatusBadge></MomoCell>
      <MomoCell label="Payment time">{row.atRaw ?? '—'}</MomoCell>
    </tr>)}
  </MomoTable>;
}

export function BuriMunsiPayments() {
  const session = useSession(), [params] = useSearchParams();
  const permitted = canDisplaySessionRecords(session) && !!session.user?.permissions.includes('payments.read');
  const canReadSms = canDisplaySessionRecords(session) && canReadSmsEvidence(session.user);
  const view = params.get('view');
  const legacySource = params.getAll('source');
  const invalidView = params.getAll('view').length > 1 ||
    legacySource.length > 0 && (view !== 'sms' || legacySource.length !== 1 || legacySource[0] !== 'android') ||
    params.has('account') || params.has('group');
  return <section className="payments-workspace"><PageHeader title="Payments" />
    {canReadSms && <nav className="payments-nav" aria-label="Payment views">
      {permitted && <Link to={buriMunsiPaymentsPath} aria-current={view === null ? 'page' : undefined}>Records</Link>}
      <Link to={buriMunsiSmsPath} aria-current={view === 'sms' ? 'page' : undefined}>M-Money SMS</Link>
    </nav>}
    {invalidView ? <ErrorState title="Payment view unavailable" message="Open Payments to choose a view." /> :
      view === 'sms' && canReadSms ? <ReceiverSmsPanel simplePayments /> :
      view === null && permitted ? <PaymentRecords /> : <ErrorState title="Access unavailable" message="Your account cannot open this payment view." />}
  </section>;
}

function PaymentRecords() {
  const {epoch, request} = useSession(), [params, setParams] = useSearchParams();
  const status = allocationState.safeParse(params.get('status')).data ?? '';
  const flow = direction.safeParse(params.get('direction')).data ?? '';
  const query = (params.get('q') ?? '').slice(0, maxSearchLength);
  const selected = id.safeParse(params.get('payment')).data;
  const rawOffset = params.get('offset') ?? '';
  const offset = /^\d{1,6}$/.test(rawOffset) && Number(rawOffset) <= maxOffset && Number(rawOffset) % 25 === 0 ? Number(rawOffset) : 0;
  const requestQuery = new URLSearchParams({limit: '25', offset: String(offset)});
  if (status) requestQuery.set('status', status);
  if (flow) requestQuery.set('direction', flow);
  if (query) requestQuery.set('q', query);
  const queryString = requestQuery.toString();
  const load = useCallback(async (signal: AbortSignal) => verifiedPage(await request(`burimunsi/payments?${queryString}`, {signal}), offset),
    [offset, queryString, request]);
  const {result, retry} = useOperationRead(`${epoch}:payments:${queryString}`, true, load);
  const page = result?.status === 'success' ? result.value : undefined;
  const nextOffset = page?.nextOffset !== undefined && page.nextOffset !== null && page.nextOffset <= maxOffset ? page.nextOffset : null;
  function change(changes: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value); else next.delete(key);
    }
    setParams(next);
  }
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = String(new FormData(event.currentTarget).get('q') ?? '').trim().slice(0, maxSearchLength);
    change({q: next, offset: '', payment: ''});
  }
  return <><Card className="operations-records"><div className="operations-toolbar">
    <form className="operations-search" key={query} onSubmit={search}><Field label="Search payments" htmlFor="buri-payment-search">
      <input id="buri-payment-search" name="q" className="admin-input" defaultValue={query} maxLength={maxSearchLength} />
    </Field><Button type="submit">Search</Button></form>
    <Field label="Status" htmlFor="buri-payment-status"><select id="buri-payment-status" className="admin-input" value={status}
      onChange={event => change({status: event.target.value, offset: '', payment: ''})}>
      <option value="">All statuses</option><option value="allocated">Allocated</option><option value="unallocated">Unallocated</option>
    </select></Field>
    <Field label="Direction" htmlFor="buri-payment-direction"><select id="buri-payment-direction" className="admin-input" value={flow}
      onChange={event => change({direction: event.target.value, offset: '', payment: ''})}>
      <option value="">Both directions</option><option value="incoming">Incoming</option><option value="outgoing">Outgoing</option>
    </select></Field>
    <Button icon="refresh" onClick={retry}>Refresh</Button></div>
    {!result ? <LoadingState label="Loading payments" /> : result.status === 'error' ? <ErrorState message={result.message} onRetry={retry} /> :
      <>{page?.items.length ? <BuriMunsiPaymentRows rows={page.items} onSelect={payment => change({payment})} /> : <EmptyState title="No payments found" />}
        {page && (offset > 0 || page.nextOffset !== null) && <div className="operations-pagination"><span>{page.totalCount} payments</span><div>
          <Button onClick={() => change({offset: String(Math.max(0, offset - 25)), payment: ''})} disabled={offset === 0}>Previous</Button>
          <Button onClick={() => nextOffset !== null && change({offset: String(nextOffset), payment: ''})} disabled={nextOffset === null}>Next</Button>
        </div></div>}
      </>}
  </Card>{selected && <PaymentDetail key={selected} id={selected} onClose={() => change({payment: ''})} onUpdated={retry} />}</>;
}

function PaymentDetail({id: paymentId, onClose, onUpdated}: {id: string; onClose: () => void; onUpdated: () => void}) {
  const session = useSession(), {epoch, request} = session;
  const load = useCallback(async (signal: AbortSignal) => {
    const payment = buriMunsiPayment.parse(await request(`burimunsi/payments/${paymentId}`, {signal}));
    if (payment.id !== paymentId) throw new Error('The payment changed.');
    return payment;
  }, [paymentId, request]);
  const {result, retry} = useOperationRead(`${epoch}:payment:${paymentId}`, true, load);
  const payment = result?.status === 'success' ? result.value : null;
  return <Dialog open title="Payment details" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
    {!result ? <LoadingState label="Loading payment" /> : result.status === 'error' ? <ErrorState message={result.message} onRetry={retry} /> :
      payment && <><Facts items={[[ 'Reference', payment.ftId ], ['Direction', directionLabel(payment.direction)],
        ['Amount', amount(payment.amountRwf)], ['Payment time', payment.atRaw], ['Counterparty', payment.payerNameRaw],
        ['Member', payment.memberName], ['Status', allocationLabel(payment.state)]]} />
        {payment.sourceId && canReadSmsEvidence(session.user) && <p><Link to={buriMunsiSmsPath}>Open M-Money SMS</Link></p>}
        {payment.state === 'unallocated' && payment.canAllocate === true &&
          <AllocatePayment key={payment.version} payment={payment} onUpdated={() => {retry(); onUpdated();}} />}
      </>}
  </Dialog>;
}

function AllocatePayment({payment, onUpdated}: {payment: BuriMunsiPayment; onUpdated: () => void}) {
  const session = useSession(), {epoch, request, user} = session;
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(''), [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{memberId: string; key: string} | null>(null);
  const sending = useRef(false);
  const load = useCallback(async (signal: AbortSignal) => membersPage.parse(await request(
    `burimunsi/payments/members?${new URLSearchParams({q: query, limit: '25'})}`, {signal})), [query, request]);
  const {result, retry} = useOperationRead(`${epoch}:allocate-member:${query}`, true, load);
  async function allocate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || !user || !selected || !session.isCurrentAuthority(epoch, user.id, user.sessionId)) return;
    const saved = pending;
    if (saved && saved.memberId !== selected) return;
    const intent = saved ?? {memberId: selected, key: crypto.randomUUID()};
    setPending(intent);
    const current = () => session.isCurrentAuthority(epoch, user.id, user.sessionId);
    sending.current = true;
    setBusy(true);
    setMessage('');
    try {
      const receipt = allocated.parse(await request(`burimunsi/payments/${payment.id}/allocate`, {
        method: 'POST', body: {memberId: intent.memberId, expectedVersion: payment.version}, idempotencyKey: intent.key,
      }));
      if (receipt.paymentId !== payment.id || receipt.memberId !== intent.memberId || receipt.version !== payment.version + 1) {
        throw new Error('The allocation response changed.');
      }
      if (current()) onUpdated();
    } catch (error) {
      if (current()) {
        if (error instanceof AdminRequestError && !error.outcomeUnknown) {
          setPending(null);
          if (error.statusCode === 409) onUpdated();
          setMessage(error.message);
        } else setMessage('Allocation was not confirmed. Retry this allocation or reopen the payment to check its status.');
      }
    } finally {
      sending.current = false;
      if (current()) setBusy(false);
    }
  }
  const members = result?.status === 'success' ? result.value.items : [];
  return <section className="momo-assignment" aria-label="Allocate to member"><h3>Allocate to member</h3>
    <form className="operations-search" onSubmit={event => {
      event.preventDefault();
      const next = String(new FormData(event.currentTarget).get('member') ?? '').trim().slice(0, maxSearchLength);
      setSelected(''); setQuery(next);
    }}><Field label="Search group members" htmlFor="buri-allocation-search">
      <input id="buri-allocation-search" name="member" className="admin-input" maxLength={maxSearchLength} disabled={busy || pending !== null} />
    </Field><Button type="submit" disabled={busy || pending !== null}>Search</Button></form>
    {!result ? <LoadingState label="Loading group members" /> : result.status === 'error' ? <ErrorState message={result.message} onRetry={retry} /> :
      members.length ? <form className="operations-action-form" onSubmit={allocate}><Field label="Member" htmlFor="buri-allocation-member">
        <select id="buri-allocation-member" className="admin-input" value={selected} onChange={event => setSelected(event.target.value)}
          required disabled={busy || pending !== null}><option value="">Choose a member</option>
          {members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select></Field><Button type="submit" variant="primary" disabled={!selected || busy}>{pending ? 'Retry allocation' : 'Allocate'}</Button></form> :
        <EmptyState title="No group members found" />}
    {message && <p role="status">{message}</p>}
  </section>;
}
