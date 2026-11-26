import {render, screen, within} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {PaymentFlowTotals} from '../../src/features/operations/PaymentFlowTotals';

const total = (name: string) => within(screen.getByRole('region', {name: 'Totals for matching payments'}))
  .getByText(name).closest('dt')?.nextElementSibling?.textContent;

describe('filtered payment flow totals', () => {
  it('keeps exact whole RWF beyond the safe integer range and distinguishes outgoing from net', () => {
    render(<PaymentFlowTotals rows={[
      {direction: 'incoming', amountRwf: Number.MAX_SAFE_INTEGER}, {direction: 'incoming', amountRwf: 2},
      {direction: 'outgoing', amountRwf: 4},
    ]} />);
    expect(total('Incoming')).toBe('RWF 9,007,199,254,740,993');
    expect(total('Outgoing')).toBe('RWF 4');
    expect(total('Net flow')).toBe('RWF 9,007,199,254,740,989');
  });

  it('preserves zero, negative net and incomplete amounts on each new filtered set', () => {
    const {rerender} = render(<PaymentFlowTotals rows={[]} />);
    expect(total('Net flow')).toBe('RWF 0');
    rerender(<PaymentFlowTotals rows={[{direction: 'outgoing', amountRwf: 1500}, {direction: 'incoming', amountRwf: 0}]} />);
    expect(total('Incoming')).toBe('RWF 0');
    expect(total('Net flow')).toBe('RWF −1,500');
    rerender(<PaymentFlowTotals rows={[{direction: 'incoming', amountRwf: 3000}, {direction: 'outgoing', amountRwf: null}]} />);
    expect(total('Incoming')).toBe('RWF 3,000');
    expect(total('Outgoing')).toBe('—');
    expect(total('Net flow')).toBe('—');
    expect(screen.getByText('1 matching payment has no amount.')).toBeVisible();
  });
});
