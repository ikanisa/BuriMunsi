import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyBrowserMemberEnrollment({call,group,admin,otherAdmin,staff,inspect,relogin,withoutGrant}) {
  const base='burimunsi/members/enrollment';
  const post=(view,body,key=body.requestId)=>call(base,{...view,body,key});
  const read=(view,id)=>call(base+'/requests/'+id,view);
  const verify=(response,status)=>assert.equal(response.status,status,JSON.stringify(response.data.error??{}));
  const command={requestId:randomUUID(),name:'Synthetic enrollment member',phone:'+250780000077',
    verifiedOwnership:true,acceptedTerms:true,consentRecorded:true};
  const before=await inspect();
  verify(await call(base),401);
  verify(await call(base,staff),403);
  verify(await post(staff,command),403);
  verify(await call(base+'?collectionId=other-group',admin),400);
  const context=await call(base,admin);
  verify(context,200);
  assert.deepEqual(context.data,{collectionId:group,label:'Synthetic browser group',canEnroll:true});
  verify(await post({...admin,csrf:undefined},command),403);
  verify(await post(admin,command,randomUUID()),400);
  verify(await post(admin,{...command,verifiedOwnership:false}),400);
  verify(await post(admin,{...command,collectionId:'foreign-group'}),400);
  verify(await post(admin,{...command,phone:'078'}),400);
  assert.deepEqual((await read(admin,command.requestId)).data,{requestId:command.requestId,outcome:'not_found'});
  assert.deepEqual(await inspect(),before);
  for(const permission of ['users.manage','collections.manage']){
    await withoutGrant(permission,async()=>{
      verify(await call(base,admin),403);
      verify(await post(admin,command),403);
    });
  }

  const [first,replay]=await Promise.all([post(admin,command),post(admin,command)]);
  verify(first,200);verify(replay,200);
  assert.deepEqual(replay.data,first.data);
  const {member}=first.data;
  assert.equal(first.data.requestId,command.requestId);
  assert.equal(first.data.outcome,'applied');
  assert.deepEqual(member,{id:member.id,groupId:group,name:command.name,phone:command.phone,active:true,version:1,balanceRwf:0});
  const roster=await call('core/members?directory=roster&status=active&search='+encodeURIComponent(command.name),admin);
  verify(roster,200);
  assert.equal(roster.data.total,1);
  assert.equal(roster.data.rows[0].id,member.id);
  assert.equal(roster.data.rows[0].membership_status,'active');
  const profile=await call('operations/members/'+member.id,admin);
  verify(profile,200);
  assert.equal(profile.data.resource.membership_status,'active');
  assert.equal(profile.data.resource.total_contributed_rwf,0);
  assert.deepEqual((await read(admin,command.requestId)).data,first.data);
  assert.deepEqual((await read(otherAdmin,command.requestId)).data,{requestId:command.requestId,outcome:'not_found'});
  const nextSession=await relogin();
  const wrongSession=await read(nextSession,command.requestId);
  verify(wrongSession,409);
  assert.equal(wrongSession.data.error.code,'idempotency_conflict');
  verify(await post(nextSession,command),409);
  const conflict=await post(admin,{...command,name:'Different member name'});
  verify(conflict,409);
  assert.equal(conflict.data.error.code,'idempotency_conflict');
  const samePhone={...command,requestId:randomUUID(),name:'Different supplied name'};
  const existing=await post(admin,samePhone);
  verify(existing,200);
  assert.deepEqual(existing.data.member,member);
  const after=await inspect();
  assert.deepEqual(after,{members:before.members+1,rematches:before.rematches+1,receipts:before.receipts+2,
    attestations:before.attestations+2,financial:before.financial});
}
