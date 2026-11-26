import {paymentTime} from '../operations/canonicalPaymentAnalysis';
import {memberStatementPageSize, readMemberStatementPage, type ProfileMembership} from './memberStatement';
import type {AdminRequest} from './types';

export type StatementPage = Awaited<ReturnType<typeof readMemberStatementPage>>;

// Quoting alone does not stop a spreadsheet from interpreting source text as a formula.
function csvText(value: string) {
  const literal = /^(?:\s*[=+@\-＝＋＠－]|[\t\r\n])/u.test(value) ? "'" + value : value;
  return '"' + literal.replaceAll('"', '""') + '"';
}

export async function memberStatementCsv(current: StatementPage, membership: ProfileMembership, request: AdminRequest, signal: AbortSignal) {
  const lines = ['Entry,Date (Kigali),Reference,Debit (RWF),Credit (RWF),Balance (RWF)', 'Opening balance,,,,,0'];
  const ids = new Set<string>();
  let running = 0n;
  for (let offset = 0; offset < current.totalCount; offset += memberStatementPageSize) {
    signal.throwIfAborted();
    const page = offset === current.offset ? current : await readMemberStatementPage(request, signal, current.memberId, membership,
      {offset, revision: current.revision});
    if (page.totalCount !== current.totalCount || page.closingRwf !== current.closingRwf) throw new Error('The statement changed.');
    for (const payment of page.items) {
      const credit = payment.direction === 'incoming';
      running += BigInt(payment.amountRwf) * (credit ? 1n : -1n);
      if (ids.has(payment.id) || running !== payment.balanceRwf) throw new Error('The transaction history could not be verified.');
      ids.add(payment.id);
      lines.push(['Transaction', csvText(payment.atRaw.trim() ? paymentTime(payment.atRaw) : ''), csvText(payment.ftId ?? ''),
        credit ? '' : String(payment.amountRwf), credit ? String(payment.amountRwf) : '', running.toString()].join(','));
    }
  }
  signal.throwIfAborted();
  if (ids.size !== current.totalCount || running !== current.closingRwf) throw new Error('The closing balance could not be verified.');
  lines.push('Closing balance,,,,,' + current.closingRwf);
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
