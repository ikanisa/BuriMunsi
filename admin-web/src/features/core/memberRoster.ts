import {z} from 'zod';
import {ENROLLMENT_PATH, type MemberDraft} from './memberEnrollment';
import {sha256Text, type PendingAttempt} from './pendingAttempt';

export const ROSTER_FAMILY = 'burimunsi.member-import';
export const SUGGESTIONS_PATH = ENROLLMENT_PATH + '/suggestions';
export const IMPORT_PATH = ENROLLMENT_PATH + '/import';
export const disclosureVersion = 'burimunsi-ocr-disclosure-v1';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const rowNumber = z.number().int().min(1).max(500);
const candidate = z.object({id, groupId:id, candidateId:id, momoName:z.string().min(2).max(100), last3:z.string().regex(/^\d{3}$/),
  latestSeenAt:z.string().nullable(), sourceCount:z.number().int().positive()});
export type RosterCandidate = z.infer<typeof candidate>;
const suggestionPage = z.object({items:z.array(candidate).max(100), nextCursor:z.string().min(1).max(8192).nullable(),
  revision:z.string().min(1).max(256), totalCount:z.number().int().nonnegative(), asOf:z.string().min(1)});
export function readSuggestions(data: unknown, group: string) {
  const page = suggestionPage.parse(data);
  if (page.items.length > page.totalCount || page.items.some(item => item.groupId !== group || item.id !== item.candidateId) || new Set(page.items.map(item => item.candidateId)).size !== page.items.length) {
    throw new Error('The suggestions could not be verified.');
  }
  return page;
}
const previewRow = z.object({row:rowNumber, momoName:z.string().max(1024), momoNumber:z.string().max(1024),
  status:z.enum(['ready','invalid','duplicate_in_file']), selected:z.boolean(), issue:z.string().max(100).nullable()});
const preview = z.object({sourceKind:z.enum(['csv','pdf','xlsx','image']), rows:z.array(previewRow).max(500)});
export type SourceKind = z.infer<typeof preview>['sourceKind'];
export type PreviewRow = z.infer<typeof previewRow>;
export function readRosterPreview(data: unknown, source: SourceKind) {
  const value = preview.parse(data);
  if (value.sourceKind !== source || new Set(value.rows.map(item => item.row)).size !== value.rows.length) {
    throw new Error('The roster preview could not be verified.');
  }
  return value.rows;
}
export type ReviewedMember = MemberDraft & {verifiedOwnership: true; acceptedTerms: true; consentRecorded: true};
export type ImportRow = ReviewedMember & {row: number; candidateId?: string};
export const resultLabels = {invalid:'Invalid row', needs_verification:'Needs review', duplicate_in_batch:'Duplicate in this list',
  candidate_changed:'Suggestion changed', already_registered:'Already registered', created:'Registered'} as const;
const resultRow = z.object({row:rowNumber, status:z.enum(Object.keys(resultLabels) as [keyof typeof resultLabels, ...(keyof typeof resultLabels)[]]), memberId:id.nullable()});
const receipt = z.object({requestId:z.uuid(), results:z.array(resultRow).min(1).max(500), created:z.number().int().min(0).max(500)});
export type ImportReceipt = z.infer<typeof receipt>;
export async function importIntent(requestId: string, rows: readonly ImportRow[]) {
  const members = rows.map(r => [r.row, r.name, r.phone, r.candidateId ?? null]);
  return {batchHash:await sha256Text(JSON.stringify([requestId, members])), rowNumbers:rows.map(r => r.row).join(',')};
}
export function validImportAttempt(attempt: PendingAttempt, group: string) {
  if (attempt.family !== ROSTER_FAMILY || attempt.resource_id !== group || attempt.permission !== 'users.manage' ||
      !z.uuid().safeParse(attempt.request_key).success || !/^[a-f0-9]{64}$/.test(String(attempt.intent.batchHash)) ||
      typeof attempt.intent.rowNumbers !== 'string' || Object.keys(attempt.intent).length !== 2) return false;
  const numbers = attempt.intent.rowNumbers.split(',');
  return numbers.length <= 500 && new Set(numbers).size === numbers.length &&
    numbers.every(value => /^(?:[1-9]\d{0,2})$/.test(value) && Number(value) <= 500);
}
export function readImportReceipt(data: unknown, attempt: PendingAttempt) {
  const value = receipt.parse(data), expected = String(attempt.intent.rowNumbers).split(',').map(Number);
  const received = new Set(value.results.map(r=>r.row));
  if (value.requestId !== attempt.request_key || received.size !== value.results.length || received.size !== expected.length ||
      expected.some(n=>!received.has(n)) || value.created !== value.results.filter(r=>r.status==='created').length ||
      value.results.some(r=>['created','already_registered'].includes(r.status) !== (r.memberId!==null))) throw new Error('The import result could not be verified.');
  return value;
}
