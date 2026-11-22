import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyNativeSourceHistory} from './requalify-burimunsi-scheduler.mjs';

test('unchanged provider approval can continue across a contiguous sequence of witnessed source upgrades',()=>{
  const original='a'.repeat(64), middle='b'.repeat(64), current='c'.repeat(64);
  const step=(previous,source,epoch)=>({
    previous,source,epoch,next_epoch:epoch+1,qualification:'d'.repeat(64),deployment:'e'.repeat(64),signed_dispatch:true,
  });
  const first=step(original,middle,62), last=step(middle,current,64);
  assert.deepEqual(verifyNativeSourceHistory(original,current,[first,last]),[first,last]);
  assert.deepEqual(verifyNativeSourceHistory(original,original,[]),[]);
  for(const broken of [[first], [last], [first,{...last,signed_dispatch:false}], [first,{...last,previous:original}],
    [first,{...last,next_epoch:66}], [first,{...last,source:original}], [first,{...last,qualification:null}]]){
    assert.throws(()=>verifyNativeSourceHistory(original,current,broken),/native_source_history/);
  }
});
