import {useMemo} from 'react';
import './paymentFlowTotals.css';

type Payment = {direction: 'incoming' | 'outgoing'; amountRwf: number | null};
const number = new Intl.NumberFormat('en-RW', {maximumFractionDigits: 0});

function rwf(value: bigint | null) {
  if (value === null) return '—';
  return value < 0n ? `RWF −${number.format(-value)}` : `RWF ${number.format(value)}`;
}

export function PaymentFlowTotals({rows}: {rows: readonly Payment[]}) {
  const {incoming, outgoing, missing} = useMemo(() => {
    const sums = {incoming: 0n, outgoing: 0n};
    const absent = {incoming: 0, outgoing: 0};
    for (const {direction, amountRwf} of rows) {
      if (amountRwf === null) absent[direction]++;
      else sums[direction] += BigInt(amountRwf);
    }
    return {
      incoming: absent.incoming ? null : sums.incoming,
      outgoing: absent.outgoing ? null : sums.outgoing,
      missing: absent.incoming + absent.outgoing,
    };
  }, [rows]);
  const net = incoming !== null && outgoing !== null ? incoming - outgoing : null;

  return <section className="payment-flow-totals" aria-label="Totals for matching payments">
    <dl>
      <div><dt>Incoming</dt><dd>{rwf(incoming)}</dd></div>
      <div><dt>Outgoing</dt><dd>{rwf(outgoing)}</dd></div>
      <div><dt>Net flow</dt><dd>{rwf(net)}</dd></div>
    </dl>
    {missing > 0 && <p>{number.format(missing)} matching {missing === 1 ? 'payment has' : 'payments have'} no amount.</p>}
  </section>;
}
