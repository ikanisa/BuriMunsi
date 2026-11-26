import type {SourceKind} from './memberRoster';

export const workbookMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const photoTypes = ['image/jpeg', 'image/png', 'image/webp'];
const mb = 1024 * 1024;

export function describeRosterFile(file: File, photoOnly: boolean): {source: SourceKind; mimeType: string} {
  const extension = file.name.split('.').pop()?.toLowerCase();
  const extensions: Record<string, string> = {csv:'text/csv', xlsx:workbookMime, pdf:'application/pdf',
    jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp'};
  const reported = file.type.toLowerCase().split(';')[0];
  const type = !reported || reported === 'application/octet-stream' || (reported === 'application/vnd.ms-excel' && extension === 'csv')
    ? extensions[extension ?? ''] : reported;
  let source: SourceKind;
  if (photoTypes.includes(type)) source = 'image';
  else if (photoOnly) throw new Error('Choose a JPEG, PNG or WebP photo.');
  else if (type === 'application/pdf') source = 'pdf';
  else if (type === workbookMime) source = 'xlsx';
  else if (['text/csv','text/comma-separated-values','application/csv','text/plain'].includes(type)) source = 'csv';
  else throw new Error('Choose a CSV, Excel workbook (.xlsx), PDF, JPEG, PNG or WebP file.');
  const maxMb = source === 'image' ? 20 : source === 'csv' ? 2 : 5;
  if (!file.size || file.size > maxMb * mb) throw new Error(`Choose a nonempty file up to ${maxMb} MB.`);
  return {source, mimeType:source === 'csv' ? 'text/csv' : source === 'image' ? 'image/jpeg' : type};
}

async function preparePhoto(file: File, signal: AbortSignal) {
  const url = URL.createObjectURL(file), image = new Image();
  try {
    image.src = url;
    await image.decode(); signal.throwIfAborted();
    const {naturalWidth: width, naturalHeight: height} = image;
    if (!width || !height || width * height > 100_000_000) throw new Error('Choose a smaller photo.');
    const scale = Math.min(1, 2560 / Math.max(width, height)), canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This photo could not be prepared. Choose another photo or a CSV file.');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.9, 0.8, 0.7]) {
      const jpeg = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      signal.throwIfAborted();
      if (jpeg?.type === 'image/jpeg' && jpeg.size > 0 && jpeg.size <= 5 * mb) return jpeg;
    }
    throw new Error('Choose a smaller photo.');
  } finally { URL.revokeObjectURL(url); }
}

export async function rosterFileBytes(file: File, source: SourceKind, signal: AbortSignal): Promise<string> {
  const blob = source === 'image' ? await preparePhoto(file, signal) : file;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    signal.addEventListener('abort', abort, {once: true});
    reader.onloadend = () => {
      signal.removeEventListener('abort', abort);
      const value = reader.result;
      if (reader.error || signal.aborted || typeof value !== 'string' || !value.includes(';base64,')) {
        reject(new Error('The file could not be read. Choose it again.')); return;
      }
      resolve(value.slice(value.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}
