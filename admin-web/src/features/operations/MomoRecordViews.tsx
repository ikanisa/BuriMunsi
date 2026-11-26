import type {ReactNode} from 'react';
import {Button, CompactText, EmptyState, ErrorState, LoadingState} from '../../ui';
import type {Page} from './contracts';
import type {OperationReadState} from './useOperationRead';

export const momoReadOptions = {live: true, invalidResponse: 'The MoMo records could not be verified.'};

const momoAmount = new Intl.NumberFormat('en-RW', {maximumFractionDigits: 0});

export function formatMomoAmount(value: number | null, currency: 'RWF' | null = 'RWF') {
  if (value === null) return 'Not recorded';
  return currency === null ? `${momoAmount.format(value)} minor units · currency not recorded` : `RWF ${momoAmount.format(value)}`;
}

export function MomoPager<T>({page, change}: {page: Page<T>; change: (offset: number) => void}) {
  return <div className="operations-pagination"><span>{page.rows.length ? `Showing ${page.offset + 1}–${page.offset + page.rows.length} of ${page.total}` : `No records on this page · ${page.total} total`}</span><div><Button onClick={() => change(Math.max(0, page.offset - page.limit))} disabled={page.offset === 0}>Previous</Button><Button onClick={() => change(page.offset + page.limit)} disabled={page.offset + page.rows.length >= page.total}>Next</Button></div></div>;
}
export function MomoTable({name, headings, children, compact = false}: {name: string; headings: string[]; children: ReactNode; compact?: boolean}) {
  return <div className="admin-table-wrap" role="region" aria-label={name} tabIndex={0}>
    <table className={compact ? 'admin-table operations-receipt-table' : 'admin-table'} role="table">
      <thead role="rowgroup"><tr role="row">{headings.map((heading) => <th role="columnheader" scope="col" key={heading}><CompactText cell>{heading}</CompactText></th>)}</tr></thead>
      <tbody role="rowgroup">{children}</tbody>
    </table>
  </div>;
}
export function MomoCell({label, children}: {label: string; children: ReactNode}) {
  return <td role="cell"><span className="operations-receipt-field" aria-hidden="true">{label}</span>{children}</td>;
}
export function MomoResult<T>({result, retry, empty, children}: {result: OperationReadState<T> | null; retry: () => void; empty: (value: T) => boolean; children: (value: T) => ReactNode}) {
  if (!result) return <LoadingState label="Loading records" />;
  if (result.status === 'error') return <ErrorState message={result.message} onRetry={retry} />;
  if (empty(result.value)) return <EmptyState title="No matching records" description="Change your filters or check again later." />;
  return children(result.value);
}
