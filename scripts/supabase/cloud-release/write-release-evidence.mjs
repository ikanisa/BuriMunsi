import {open} from 'node:fs/promises';
import {join} from 'node:path';

export async function writeReleaseEvidence(directory, name, receipt) {
  const file = await open(join(directory, name), 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(receipt) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  const parent = await open(directory, 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
