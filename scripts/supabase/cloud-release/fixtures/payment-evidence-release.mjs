// Receipts are exercised against the prior migration ledger on an owned Unix
// socket. Other feature fixtures in the same database have their own journals.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import pg from '../../node_modules/pg/lib/index.js';
import {readRecordedSql} from '../recorded-history.mjs';
import {loadPaymentEvidencePlan,runPaymentEvidenceRelease} from '../payment-evidence-release.mjs';

export async function exerciseEvidenceRelease(f){
  assert.match(f.cluster.root,/^\/(?:private\/)?tmp\/collect-pg-transfer-[A-Za-z0-9]+$/);
  const plan=await loadPaymentEvidencePlan();
  const connect=async()=>{
    const c=new pg.Client({host:f.cluster.socket,port:f.cluster.port,database:'postgres',user:f.cluster.initialUser});
    await c.connect();await c.query('SET SESSION AUTHORIZATION postgres');return c;
  };
  const run=args=>runPaymentEvidenceRelease(args,{open:connect}),dir=join(f.cluster.root,'payment-release');
  await mkdir(dir,{mode:0o700});
  const baseline=(await f.client.query('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version')).rows.map(row=>row.version);
  await f.client.query(`ALTER TABLE private.collect_fence_control
    ADD COLUMN project_ref text DEFAULT 'rrlduytparvsjfmegalh', ADD COLUMN epoch bigint DEFAULT 1, ADD COLUMN source_sha256 text DEFAULT repeat('a',64)`);
  await assert.rejects(run(['inspect']),/payment_release_history_changed/);
  try{
    for(const row of plan.before){
      if(!baseline.includes(row.version))await f.client.query('INSERT INTO supabase_migrations.schema_migrations VALUES($1,$2,$3)',
        [row.version,row.name,[await readRecordedSql(row)]]);
    }
    const pre=await run(['inspect']);assert.equal(pre.proof.ledger,plan.summary.baselineDigest);
    await assert.rejects(run(['apply','0'.repeat(64),dir]),/payment_release_preimage_changed/);
    const applied=await run(['apply',pre.fingerprint,dir]);
    assert.equal(applied.status,'recorded_and_verified');assert.equal(applied.proof.ledger,plan.summary.successorDigest);
    assert.equal(pre.proof.custody,applied.proof.custody);assert.equal(pre.proof.grants,applied.proof.grants);
    const reconcile=()=>run(['reconcile',pre.fingerprint,dir]);
    assert.deepEqual((await reconcile()).proof,applied.proof);
    assert.deepEqual((await reconcile()).proof,applied.proof);
    await f.client.query('UPDATE private.collect_fence_control SET epoch=epoch+1 WHERE singleton');
    try{await assert.rejects(reconcile(),/payment_release_fence_changed/);}
    finally{await f.client.query('UPDATE private.collect_fence_control SET epoch=epoch-1 WHERE singleton');}
    await assert.rejects(run(['apply',pre.fingerprint,dir]),/payment_release_preimage_changed/);
  }finally{
    await f.client.query('DELETE FROM supabase_migrations.schema_migrations WHERE NOT (version=ANY($1::text[]))',[baseline]);
  }
}
