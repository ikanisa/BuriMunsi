// Evidence is intake eligibility only, never a payment.
// Unfamiliar text is unconfirmed, rather than assumed nonfinancial.
import { escape } from './native-auto-source.js';

const transactionStart = [
 'you have sent', 'you have paid', 'withdrawal', 'withdrawn',
 'reversal', 'reversed', 'extournée', 'yarasubijwe', 'transfer fee',
];
const atoms = values => Array.isArray(values) && values.length >= 1 && values.length <= 30 &&
 values.every(v=>typeof v==='string' && v.trim()===v && v.length>=1 && v.length<=80 && !/[^\p{L}\p{N} .:_-]/u.test(v));
const boundary = '(?![\\p{L}\\p{N}_])';
export function hasPositiveReceiptEvidence(body, profile) {
 if (typeof body!=='string'||body.length<1||body.length>3000||
     !atoms(profile?.incomingPrefixes)||!atoms(profile?.currencyAliases)||!atoms(profile?.transactionIdPrefixes))
  return false;
 const labels = xs => xs.map(escape).join('|');
 const start = new RegExp('^\\s*(?:'+labels([...profile.incomingPrefixes,...transactionStart])+')'+boundary,'iu');
 const amount = new RegExp('(?<![\\p{L}\\p{N}.,_])(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)[ \\t]+(?:'+labels(profile.currencyAliases)+')'+boundary,'iu');
 const reference = new RegExp('(?<![\\p{L}\\p{N}_])(?:'+labels(profile.transactionIdPrefixes)+')[ \\t:#-]*[A-Z0-9][A-Z0-9_-]{3,63}'+boundary,'iu');
 const id = reference.exec(body);
 if (!id) return false;
 // Both established amounts are supported; keep pending notices unconfirmed.
 const units = '(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)';
 const currency = '(?:'+labels(profile.currencyAliases)+')';
 const amountAndCurrency = '(?:'+currency+'[ \\t]+'+units+'|'+units+'[ \\t]+'+currency+')';
 const outgoing = new RegExp('^\\s*your payment of[ \\t]+'+amountAndCurrency+'[ \\t]+to[ \\t]+'+
   '[^.!?\\r\\n]{1,120}[ \\t]+has been completed(?=[.!? \\t])','iu').exec(body);
 if (outgoing && outgoing[0].length <= id.index) return true;
 // Recognize currency-first reversal evidence without classifying it as a payment.
 const reversal = new RegExp('^\\s*transaction reversed for[ \\t]+(?:'+labels(profile.currencyAliases)+')[ \\t]+'+
   '(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?=[.!?](?:[ \t\r\n]|$))','iu').exec(body);
 if (reversal && reversal[0].length <= id.index) return true;
 const first = start.exec(body), money = amount.exec(body);
 if (!first || !money || first[0].length > money.index || money.index+money[0].length > id.index)
  return false;
 // A prefix followed by prose is not sufficient (e.g. "Received your offer").
 return /^\s*(?:(?:accepted|processed)\b[ \t.:;-]*)?[ \t.:;-]*$/iu.test(body.slice(first[0].length,money.index));
}
