// Release evidence binds the existing Cloud handler and its exact modules.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const shared=new URL('../../../supabase/functions/_shared/',import.meta.url);
export const managedJobsHandlerFiles=Object.freeze({
 serve:'serve.js',
 handler:'edge-jobs-handler.js',
 cycle:'edge-job-cycle.js',
 runtime:'edge-runtime.js',
 processing:'scheduled-processing.js',
 auth:'managed-jobs-dispatch-auth.mjs',
 budget:'native-provider-budget.mjs',
});
const hashes=Object.freeze({
 serve:'96e1a7c3a8ffdd07c637537f9351175c282ed636af844ea631ac0f2a1aa87549',
 handler:'3b121754a24e70befc5c7b681c9a0330dd563751158cf47d10b95d06a7f0cfdb',
 cycle:'2581cc4f91b5f0fcfdb8e61f52fd30f9e4d65c3a2dc561fcd624915369c45c46',
 runtime:'77898be72c9dac093ae08fa554cffe4e185dff014886e702f5dcffa17567594a',
 processing:'64a161f7aef2d4e113d3a88c0f2063cbaf70219416ed6d031b873c8aec4f8d2b',
 auth:'5cac35234d8fce99056705a7e002c078970366a007e4a572b00485a9502ad463',
 budget:'8c212ad319d820374a33abcaeb405ee643010cc86b0e107790d39b7020fe9962',
});

async function readPinnedModule(key) {
 const source = await readFile(new URL(managedJobsHandlerFiles[key], shared), 'utf8');
 if (createHash('sha256').update(source).digest('hex') !== hashes[key]) {
  throw Error('cloud_jobs_handler_source_changed');
 }
 return source;
}

export function renderManagedJobsDispatchAuth() {
 return readPinnedModule('auth');
}

export async function renderManagedJobsHandler(){
 const entries=await Promise.all(Object.keys(managedJobsHandlerFiles).map(async key=>[key,await readPinnedModule(key)]));
 return {...Object.fromEntries(entries),hashes};
}
