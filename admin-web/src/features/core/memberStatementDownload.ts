import {paymentEventTime} from '../operations/canonicalPaymentAnalysis';
import type {CompleteMemberStatement} from './memberStatement';

// Quoting alone does not stop a spreadsheet from interpreting source text as a formula.
function csvText(value: string) {
  const literal = /^(?:\s*[=+@\-＝＋＠－]|[\t\r\n])/u.test(value) ? "'" + value : value;
  return '"' + literal.replaceAll('"', '""') + '"';
}

export function statementFilename({publicId, recordNumber, revision}: CompleteMemberStatement) {
  if (!recordNumber && !publicId) throw new Error('A public member identifier is unavailable.');
  return 'burimunsi-member-' + (recordNumber ?? publicId) + '-' + revision.slice(0,12) + '.csv';
}

export function memberStatementCsv({publicId, recordNumber, revision, asOf, transactions, closingRwf}: CompleteMemberStatement) {
  const lines = [
    ...(publicId ? ['Collect ID,' + csvText(publicId)] : []),
    ...(recordNumber ? ['Membership record number,' + csvText(recordNumber)] : []),
    'Statement revision,' + csvText(revision), ...(asOf ? ['Statement read as of (UTC),' + csvText(asOf)] : []), '',
    'Entry,Date (Kigali),Reference,Debit (RWF),Credit (RWF),Balance (RWF)', 'Opening balance,,,,,0'];
  for (const payment of transactions) {
    const credit = payment.direction === 'incoming';
    lines.push(['Transaction', csvText(payment.occurredAt!==undefined || payment.atRaw.trim() ? paymentEventTime(payment) : ''), csvText(payment.ftId ?? ''),
      credit ? '' : String(payment.amountRwf), credit ? String(payment.amountRwf) : '', payment.balanceRwf.toString()].join(','));
  }
  lines.push('Closing balance,,,,,' + closingRwf);
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
