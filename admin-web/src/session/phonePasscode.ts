export const PASSCODE = /^[0-9]{4}$/;

export function normalizeLoginPhone(value: string): string {
  if (value.length > 40 || !/^[+0-9 ()-]+$/.test(value)) throw new Error('Enter a Rwanda login phone number.');
  let phone = value.trim().replace(/[ ()-]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (/^0\d{9}$/.test(phone)) phone = `+250${phone.slice(1)}`;
  else if (/^\d{9}$/.test(phone)) phone = `+250${phone}`;
  else if (/^250\d{9}$/.test(phone)) phone = `+${phone}`;
  if (!/^\+2507[2389]\d{7}$/.test(phone)) throw new Error('Enter a Rwanda login phone number.');
  return phone;
}
