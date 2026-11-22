import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {captureRuntimeSnapshot,captureSmsGatewaySnapshot,checkSnapshot,desiredPublicConfig,prepareSecretProposal} from './runtime-plan.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex');
const slugs=['collect-api','admin-api','collect-jobs'];
const mkfixture=()=>{
 const root=mkdtempSync(join(tmpdir(),'collect-runtime-plan-test-'));
 mkdirSync(join(root,'functions','_shared'),{recursive:true});
 writeFileSync(join(root,'functions','_shared','common.js'),'export const result=1;\n');
 writeFileSync(join(root,'retention-inventory.json'),'{}\n');
 writeFileSync(join(root,'functions','deno.json'),'{}\n');
 writeFileSync(join(root,'functions','deno.lock'),JSON.stringify({npm:{'postgres@3.4.7':{integrity:'sha512-fixture'}}}));
 for(const slug of slugs){mkdirSync(join(root,'functions',slug));writeFileSync(join(root,'functions',slug,'index.ts'),"import '../_shared/common.js';\n");}
 function graph(_bin,args,{cwd}){
  const file=join(cwd,args.at(-1)),common=join(cwd,'_shared/common.js'),inventory=join(root,'retention-inventory.json');
  return JSON.stringify({roots:[pathToFileURL(file).href],modules:[file,common,inventory].map(f=>({specifier:pathToFileURL(f).href})).concat([{specifier:'npm:/postgres@3.4.7'}])});
 }
 return {root,graph,close:()=>rmSync(root,{recursive:true,force:true})};
};

test('captures one stable union and prepares exact per-function payloads without deployment',async()=>{
 const f=mkfixture();try{
  const a=captureRuntimeSnapshot({root:f.root,run:f.graph}),b=captureRuntimeSnapshot({root:f.root,run:f.graph});
  assert.equal(a.sourceSha,b.sourceSha);assert.equal(a.summary().manifest.files.length,7);
  assert(a.summary().manifest.files.some(x=>x.path==='retention-inventory.json'));
  const saved=a.copyFile('functions/_shared/common.js');writeFileSync(join(f.root,'functions/_shared/common.js'),'export const result=2;\n');
  assert.deepEqual(a.copyFile('functions/_shared/common.js'),saved);
  assert.notEqual(captureRuntimeSnapshot({root:f.root,run:f.graph}).sourceSha,a.sourceSha);
  for(const slug of slugs){
   const form=a.makeForm(slug),metadata=JSON.parse(form.get('metadata')),files=form.getAll('file');
   assert.equal(metadata.entrypoint_path,`functions/${slug}/index.ts`);assert.equal(metadata.verify_jwt,false);
   assert(files.some(x=>x.name==='retention-inventory.json'));
   const item=files.find(x=>x.name==='functions/_shared/common.js');assert.equal(await item.text(),saved.toString());
  }
  let checkedDir;
  assert.equal(checkSnapshot(a,{run:(_bin,_args,{cwd})=>{checkedDir=cwd;assert.equal(readFileSync(join(cwd,'_shared/common.js'),'utf8'),saved.toString());}}).status,'passed');
  assert.equal(existsSync(checkedDir),false);
  assert.throws(()=>a.makeForm('send-sms-hook'),/unknown_function/);
 }finally{f.close();}
});

test('rejects source graph escape, symlinks and unapproved network dependencies',()=>{
 const f=mkfixture(),outside=mkdtempSync(join(tmpdir(),'collect-runtime-plan-outside-'));
 try{
  const target=join(outside,'bad.js');writeFileSync(target,'outside');symlinkSync(target,join(f.root,'functions','_shared','link.js'));
  const modify=specifier=>(bin,args,options)=>{const x=JSON.parse(f.graph(bin,args,options));x.modules.push({specifier});return JSON.stringify(x);};
  assert.throws(()=>captureRuntimeSnapshot({root:f.root,run:modify(pathToFileURL(join(f.root,'functions/_shared/link.js')).href)}),/unsafe_source_file/);
  assert.throws(()=>captureRuntimeSnapshot({root:f.root,run:modify('https://example.invalid/unpinned.js')}),/unapproved_external_dependency/);
 }finally{f.close();rmSync(outside,{recursive:true,force:true});}
});

test('captures and checks the SMS gateway with its repository-relative imports',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'collect-sms-plan-test-')));
 try{
  const source='deploy/collect-sms/src/edge.ts',entry='supabase/functions/collect-sms/index.ts';
  const adapter='export const reply = "first";\n';
  mkdirSync(join(root,'deploy/collect-sms/src'),{recursive:true});
  mkdirSync(join(root,'supabase/functions/collect-sms'),{recursive:true});
  writeFileSync(join(root,source),adapter);
  writeFileSync(join(root,entry),"import '../../../deploy/collect-sms/src/edge.ts';\n");
  writeFileSync(join(root,'supabase/functions/deno.json'),'{}\n');
  const lockPath=join(root,'supabase/functions/deno.lock');
  writeFileSync(lockPath,JSON.stringify({npm:{'hono@4.13.16':{integrity:'sha512-fixture'}}}));
  const graph=(_bin,args,{cwd})=>{
   assert.equal(cwd,join(root,'supabase/functions'));
   assert.equal(args.at(-1),'collect-sms/index.ts');
   return JSON.stringify({roots:[pathToFileURL(join(root,entry)).href],
    modules:[entry,source].map(path=>({specifier:pathToFileURL(join(root,path)).href}))
     .concat({specifier:'npm:/hono@4.13.16'})});
  };
  const snapshot=captureSmsGatewaySnapshot({root,run:graph});
  assert.equal(snapshot.summary().manifest.format,'collect.cloud-sms-runtime-source.v1');
  assert.deepEqual(snapshot.summary().manifest.functions.map(item=>item.entrypoint),[entry]);
  writeFileSync(join(root,source),'export const reply = "changed";\n');
  assert.notEqual(captureSmsGatewaySnapshot({root,run:graph}).sourceSha,snapshot.sourceSha);
  const form=snapshot.makeForm('collect-sms');
  assert.deepEqual(JSON.parse(form.get('metadata')),{name:'collect-sms',entrypoint_path:entry,verify_jwt:false});
  assert.equal(await form.getAll('file').find(file=>file.name===source).text(),adapter);
  assert.throws(()=>snapshot.makeForm('send-sms-hook'),/unknown_function/);
  assert.throws(()=>snapshot.makeForm('admin-api'),/unknown_function/);
  let checked;
  checkSnapshot(snapshot,{run:(bin,args,{cwd})=>{
   checked=cwd;
   assert.equal(bin,'deno');assert.deepEqual(args,['check','--frozen','--cached-only','collect-sms/index.ts']);
   assert.equal(readFileSync(join(cwd,'../../'+source),'utf8'),adapter);
  }});
  assert.equal(existsSync(checked),false);

  writeFileSync(join(root,'unexpected.js'),'export const unexpected = true;');
  assert.throws(()=>captureSmsGatewaySnapshot({root,run:(...args)=>{
   const output=JSON.parse(graph(...args));output.modules.push({specifier:pathToFileURL(join(root,'unexpected.js')).href});
   return JSON.stringify(output);
  }}),/unexpected_source_graph_file/);
  writeFileSync(lockPath,'{}');
  assert.throws(()=>captureSmsGatewaySnapshot({root,run:graph}),/unlocked_npm_dependency/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('secret proposals preserve existing keys, expose names only, and hold automatic work',()=>{
 const source='a'.repeat(64),local={OPENAI_API_KEY:'local-test-secret-should-never-appear',DATA_ENCRYPTION_KEY:'old-data-key',
  SESSION_ENCRYPTION_KEY:'old-session-key',BURIMUNSI_PIN_PEPPER_BASE64:'pepper',MOMO_AI_MODEL:'fixture-model'};
 const required=['DATA_ENCRYPTION_KEY','DATA_KEY_ID','SESSION_ENCRYPTION_KEY','SESSION_KEY_ID','COLLECT_JOB_SIGNING_KEY',
  'BURIMUNSI_PIN_PEPPER_BASE64','BURIMUNSI_PIN_PEPPER_ID','BURIMUNSI_CURSOR_KEY_BASE64'];
 const cloudRows=required.map(name=>({name,value:hash('cloud-'+name)}));
 const p=prepareSecretProposal({cloudRows,localEnv:local,sourceSha:source}),view=p.publicView(),body=p.mutationBody();
 assert.deepEqual(view.requiredCloudSecretsMissing,[]);
 assert.equal(view.openAiKey,'proposed_from_source');assert.equal(view.nativeAutomationTransition.readyToApply,false);
 assert.equal(view.nativeAutomationTransition.proposedConfig.MOMO_AI_MODEL,'fixture-model');
 assert.equal(body.find(x=>x.name==='OPENAI_API_KEY').value,local.OPENAI_API_KEY);
 for(const name of required)assert(!body.some(x=>x.name===name));
 for(const secret of ['local-test-secret-should-never-appear','old-data-key','old-session-key','pepper'])assert(!JSON.stringify(p).includes(secret));
 assert.equal(desiredPublicConfig(source).COLLECT_NATIVE_INGRESS_MODE,'supabase_direct_v1');
 assert.equal(desiredPublicConfig(source).BURIMUNSI_NATIVE_AUTO_TRANSACTIONS_ENABLED,'false');
 assert.throws(()=>desiredPublicConfig('bad'),/invalid_source_sha/);
 assert.throws(()=>prepareSecretProposal({cloudRows:[...cloudRows,cloudRows[0]],localEnv:local,sourceSha:source}),/metadata_invalid/);
 const missing=prepareSecretProposal({cloudRows:[],localEnv:{},sourceSha:source}).publicView();
 assert.equal(missing.requiredCloudSecretsMissing.length,required.length);assert.equal(missing.openAiKey,'missing');
});
