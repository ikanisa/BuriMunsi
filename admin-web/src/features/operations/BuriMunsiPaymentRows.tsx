import {Link} from 'react-router';
import {CompactText, StatusBadge} from '../../ui';
import {MomoCell, MomoTable} from './MomoRecordViews';
import {PaymentTermIcon} from './PaymentTermIcon';
import {paymentMemberName, paymentEventTime, type BuriMunsiPayment} from './canonicalPaymentAnalysis';
import {paymentsPath as buriMunsiPaymentsPath} from './paymentLocations';
import './operations.css';
import './paymentsWorkspace.css';

export {buriMunsiPaymentsPath};
export const buriMunsiSmsPath = buriMunsiPaymentsPath + '?view=sms';
const buriMunsiPaymentPath = (id: string) => buriMunsiPaymentsPath + '?' + new URLSearchParams({payment: id});

const amountFormat = new Intl.NumberFormat('en-RW');
export const paymentAmount = (value: number | null) => value === null ? '—' : 'RWF ' + amountFormat.format(value);
export const recordedText = (value: string | null | undefined) => value?.trim() ? value : null;

export function PaymentDirection({direction}: {direction: BuriMunsiPayment['direction']}) {
  return <span className="payment-direction" data-payment-flow={direction}>
    <PaymentTermIcon term={direction} />
  </span>;
}

export function AllocationStatus({row, search, text = false}: {row: BuriMunsiPayment; search?: URLSearchParams; text?: boolean}) {
  const allocated = row.state === 'allocated';
  const badge = <StatusBadge tone={allocated ? 'success' : 'warning'}>
    <PaymentTermIcon term={row.state} />
  </StatusBadge>;
  if (row.state !== 'unallocated' || row.canAllocate !== true) return badge;
  const next = new URLSearchParams(search);
  next.set('allocate', row.id); next.delete('view'); next.delete('source');
  return <Link className="payment-allocation-link" to={buriMunsiPaymentsPath + '?' + next}
    state={{allocationReturn: row.id}} preventScrollReset aria-haspopup="dialog"
    aria-label={text ? 'Allocate to member' : 'Unallocated – allocate payment ' + (recordedText(row.ftId) ?? row.id)}>{badge}</Link>;
}

export function BuriMunsiPaymentRows({rows}: {rows: BuriMunsiPayment[]}) {
  return <MomoTable name="Payments" headings={['Reference', 'IN/OUT', 'Amount', 'Member', 'Status', 'Payment time']} compact>
    {rows.map(row => <tr key={row.id}><MomoCell label="Reference"><Link className="operations-link" to={buriMunsiPaymentPath(row.id)}>
      <CompactText cell>{row.ftId ?? 'View payment'}</CompactText></Link></MomoCell>
      <MomoCell label="IN/OUT"><PaymentDirection direction={row.direction} /></MomoCell><MomoCell label="Amount"><span className="payment-exact-value">{paymentAmount(row.amountRwf)}</span></MomoCell>
      <MomoCell label="Member"><CompactText cell>{paymentMemberName(row) ?? '—'}</CompactText></MomoCell><MomoCell label="Status"><AllocationStatus row={row} /></MomoCell>
      <MomoCell label="Payment time"><span className="payment-exact-value">{paymentEventTime(row)}</span></MomoCell></tr>)}
  </MomoTable>;
}
