import {AdminRequestError, isJsonObject, isVerificationUuid, type JsonObject} from '../../api/contracts';
import {normalizeLoginPhone} from '../../session/phonePasscode';
import {containsControl} from './contracts';
import {sha256Text, type PendingAttempt} from './pendingAttempt';

export const ENROLLMENT_PATH = 'burimunsi/members/enrollment';
export const ENROLLMENT_FAMILY = 'burimunsi.member-enrollment';
export const ENROLLMENT_PERMISSION = 'users.manage';
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const digest = /^[a-f0-9]{64}$/;

export interface MemberDraft {name: string; phone: string;}
export interface EnrollmentScope {collectionId: string; label: string; canEnroll: boolean;}
export interface EnrolledMember {id: string; name: string; phone: string; active: boolean;}

export function validateMember(draft: MemberDraft) {
  const name = draft.name.trim();
  const errors: {name?: string; phone?: string} = {};
  if (name.length < 2 || name.length > 100 || containsControl(draft.name)) {
    errors.name = 'Enter the registered MoMo name, between 2 and 100 characters.';
  }
  let phone = '';
  try {phone = normalizeLoginPhone(draft.phone);} catch {errors.phone = 'Enter a valid Rwanda mobile number.';}
  return {errors, name, phone};
}

function invalid(): never {throw new Error('The member response could not be confirmed.');}

export function readEnrollmentScope(data: JsonObject, expectedGroup?: string): EnrollmentScope {
  const {collectionId, label, canEnroll} = data;
  if (typeof collectionId !== 'string' || !identifier.test(collectionId) ||
      (expectedGroup !== undefined && collectionId !== expectedGroup) ||
      typeof label !== 'string' || !label.trim() || label.length > 200 || containsControl(label) ||
      typeof canEnroll !== 'boolean') return invalid();
  return {collectionId, label, canEnroll};
}

/** A reload can recover the original reference without storing anyone's name or mobile number. */
export async function enrollmentIntent(requestId: string, member: MemberDraft) {
  const [memberHash, phoneHash] = await Promise.all([
    sha256Text(JSON.stringify([requestId, member.name, member.phone])),
    sha256Text(JSON.stringify([requestId, member.phone])),
  ]);
  return {memberHash, phoneHash};
}

export function validEnrollmentAttempt(attempt: PendingAttempt, collectionId: string) {
  return attempt.family === ENROLLMENT_FAMILY && attempt.resource_id === collectionId &&
    attempt.permission === ENROLLMENT_PERMISSION && isVerificationUuid(attempt.request_key) &&
    Object.keys(attempt.intent).length === 2 && typeof attempt.intent.memberHash === 'string' &&
    digest.test(attempt.intent.memberHash) && typeof attempt.intent.phoneHash === 'string' && digest.test(attempt.intent.phoneHash);
}

export async function readEnrollmentOutcome(data: JsonObject, attempt: PendingAttempt, lookup = false): Promise<EnrolledMember | null> {
  if (data.requestId !== attempt.request_key) return invalid();
  if (lookup && data.outcome === 'not_found' && !Object.hasOwn(data, 'member')) return null;
  const member = data.member;
  if (data.outcome !== 'applied' || !isJsonObject(member) || typeof member.id !== 'string' || !identifier.test(member.id) ||
      member.groupId !== attempt.resource_id || typeof member.name !== 'string' || !member.name.trim() ||
      member.name.length > 100 || containsControl(member.name) || typeof member.phone !== 'string' ||
      !/^\+2507[2389]\d{7}$/.test(member.phone) || typeof member.active !== 'boolean' ||
      !Number.isSafeInteger(member.version) || Number(member.version) < 1 || !Number.isSafeInteger(member.balanceRwf)) return invalid();
  if (await sha256Text(JSON.stringify([attempt.request_key, member.phone])) !== attempt.intent.phoneHash) return invalid();
  return {id: member.id, name: member.name, phone: member.phone, active: member.active};
}

/** These rejections happen before a member or receipt can be committed. Other outcomes require a lookup. */
export function rejectedEnrollment(error: unknown): string | null {
  if (!(error instanceof AdminRequestError) || error.outcomeUnknown) return null;
  if (error.statusCode === 400 && error.code === 'invalid_name') return 'Check the registered MoMo name and try again.';
  if (error.statusCode === 400 && error.code === 'invalid_phone') return 'Check the Rwanda mobile number and try again.';
  if (error.statusCode === 409 && error.code === 'duplicate_phone') return 'That number matches conflicting records. Check the number in Members before continuing.';
  if (error.statusCode === 403 && ['access_denied', 'admin_required', 'permission_required'].includes(error.code ?? '')) return 'Your account cannot add members to this group.';
  if (error.statusCode === 403 && error.code === 'csrf_rejected') return 'Refresh your session before saving the member.';
  return null;
}
