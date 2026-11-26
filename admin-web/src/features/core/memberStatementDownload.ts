import {paymentTime} from '../operations/canonicalPaymentAnalysis';
import type {CompleteMemberStatement} from './memberStatement';

// Quoting alone does not stop a spreadsheet from interpreting source text as a formula.
function csvText(value: string) {
  const literal = /^(?:\s*[=+@\-＝＋＠－]|[\t\r\n])/u.test(value) ? "'" + value : value;
  return '"' + literal.replaceAll('"', '""') + '"';
}

export function memberStatementCsv({transactions, closingRwf}: CompleteMemberStatement) {
  const lines = ['Entry,Date (Kigali),Reference,Debit (RWF),Credit (RWF),Balance (RWF)', 'Opening balance,,,,,0'];
  for (const payment of transactions) {
    const credit = payment.direction === 'incoming';
    lines.push(['Transaction', csvText(payment.atRaw.trim() ? paymentTime(payment.atRaw) : ''), csvText(payment.ftId ?? ''),
      credit ? '' : String(payment.amountRwf), credit ? String(payment.amountRwf) : '', payment.balanceRwf.toString()].join(','));
  }
  lines.push('Closing balance,,,,,' + closingRwf);
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
