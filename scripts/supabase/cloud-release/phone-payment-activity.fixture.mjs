import assert from 'node:assert/strict';

// The caller owns the migrated socket-only PG17 fixture and signs in both
// operators through the normal phone/passcode and browser session handlers.
export async function verifyBrowserPaymentActivity({call,admin,staff}) {
 const path='core/payment-activity?limit=25&offset=0';
 const page=async (viewer,suffix='')=>{
  const result=await call(path+suffix,viewer);
  assert.equal(result.status,200,JSON.stringify({path:path+suffix,status:result.status,data:result.data,errors:result.errors}));
  const value=result.data;
  assert.equal(value.contractVersion,1);assert.equal(value.limit,25);assert.equal(value.offset,0);
  assert.equal(value.items.length,Math.min(25,value.total));
  assert.match(value.asOf,/Z$/);
  for(const row of value.items)for(const receipt of row.receipts)assert.deepEqual(Object.keys(receipt).sort(),[
    'bodySha256','collectionId','id','kind','payerReason','payerStatus','paymentReference','status']);
  return value;
 };
 const adminPage=await page(admin),staffPage=await page(staff);
 await page(admin,'&scope=android');
 assert.ok(staffPage.items.every(row=>['payment','momo'].includes(row.kind)&&row.receipts.length===0));
 assert.equal((await call(path+'&scope=sms',staff)).status,403);
 assert.equal((await call(path)).status,401);
 return {adminRows:adminPage.total,staffRows:staffPage.total,staffSms:403,guest:401};
}
