import {requireThat} from './errors.js';
import {sha256} from './values.js';

const DIGEST = /^[a-f0-9]{64}$/;
const check = value => requireThat(value, 'observation_storage_changed', 409);

/** Read the original encrypted upload, including after an acknowledged retry. */
export async function committedRawSmsEnvelope(media, key, candidate, acknowledgement) {
  const expected = acknowledgement?.sha256;
  check(acknowledgement?.stored === true && acknowledgement?.metadataCommitted === true &&
    acknowledgement?.key === key && DIGEST.test(expected ?? ''));
  if (await sha256(candidate) === expected) return candidate;

  const original = await media.get(key);
  check(original?.key === key && original.sha256 === expected && typeof original.text === 'function');
  const envelope = await original.text();
  check(typeof envelope === 'string' && await sha256(envelope) === expected);
  return envelope;
}

/** Caller owns the authenticated capture transaction and its committed source metadata. */
export async function storeRawSmsEnvelope(tx, groupId, sourceId, objectSha256, envelope) {
  const written = await tx.unsafe(`INSERT INTO burimunsi.raw_sms(id, collection_id, object_sha256, ciphertext)
    VALUES($1,$2,$3,convert_to($4,'UTF8')) ON CONFLICT(id) DO NOTHING RETURNING id`,
    [sourceId, groupId, objectSha256, envelope]);
  if (written.length === 1 && written[0].id === sourceId) return;
  check(written.length === 0);
  const existing = await tx.unsafe(`SELECT id FROM burimunsi.raw_sms WHERE id=$1 AND collection_id=$2
    AND object_sha256=$3 AND ciphertext=convert_to($4,'UTF8')`, [sourceId, groupId, objectSha256, envelope]);
  check(existing.length === 1 && existing[0].id === sourceId);
}

/** The already-authorized source and storage journal bind the exact table envelope. */
export async function readRawSmsEnvelope(tx, groupId, record, journal) {
  const rows = await tx.unsafe(`SELECT object_sha256,convert_from(ciphertext,'UTF8') AS envelope
    FROM burimunsi.raw_sms WHERE id=$1 AND collection_id=$2`, [record.id, groupId]);
  if (rows.length === 0) return null;
  const {object_sha256: objectSha256, envelope} = rows[0];
  check(rows.length === 1 && objectSha256 === record.object_sha256 && typeof envelope === 'string' &&
    envelope.length > 0 && envelope.length <= 524288 && await sha256(envelope) === journal.put.sha256);
  return envelope;
}
