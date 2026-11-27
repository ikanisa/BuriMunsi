import {Icon} from '../../ui';

const terms = {
  allocated: ['linked', 'Allocated'],
  unallocated: ['unlinked', 'Unallocated'],
  incoming: ['incoming', 'Incoming'],
  outgoing: ['outgoing', 'Outgoing'],
  net: ['swap', 'Net flow'],
} as const;

export function PaymentTermIcon({term}: {term: keyof typeof terms}) {
  const [icon, label] = terms[term];
  return <span className="payment-term-icon" title={label}>
    <Icon name={icon} />
    <span>{label}</span>
  </span>;
}
