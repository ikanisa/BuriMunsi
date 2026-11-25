import assert from 'node:assert/strict';
import fs from 'node:fs';
import {hasSmsCredential} from '../../../supabase/functions/_shared/domain/burimunsi/native-auto-source.js';
import {hasPositiveReceiptEvidence} from '../../../supabase/functions/_shared/domain/burimunsi/observation-positive-evidence.js';
import {isObservationCandidate} from '../../../supabase/functions/_shared/domain/burimunsi/observation-evidence.js';
const profile={version:'synthetic',senders:['Example Money'],incomingPrefixes:['Received'],currencyAliases:['RWF'],transactionIdPrefixes:['Reference:']};
const table=path=>fs.readFileSync(path,'utf8').trim().split('\n').map(s=>s.split('\t'));
const cases=table(new URL('./synthetic-receipts.tsv',import.meta.url));
const actual=new Map(table(process.argv[2]));
assert.equal(actual.size,cases.length,'one Android result per synthetic fixture');
let admitted=0, withheld=0;
for(const [name, expected, sender, rawBody] of cases){
 const edge=String(isObservationCandidate({rawSender:sender,rawBody},profile) && !hasSmsCredential(rawBody,sender) && hasPositiveReceiptEvidence(rawBody,profile));
 assert.equal(edge,expected,'Edge '+name);assert.equal(actual.get(name),expected,'Android '+name);
 if(expected==='true')admitted++;else withheld++;
}
console.log(JSON.stringify({matched:actual.size,admitted,withheld}));
