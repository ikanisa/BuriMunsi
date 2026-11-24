import {revalidateCommandActor} from './command-authority.js';
import {requirePort,requireThat} from './errors.js';
import {canonicalJson,requireId,requireRequestId,sha256} from './values.js';

const operation='burimunsi.allocate';

export class PaymentAllocationService {
  constructor({store,groupId,clock=()=>Date.now()}) {
    requirePort(store,['inCanonicalTransaction']);
    this.store=store;this.groupId=requireId(groupId);this.clock=clock;
  }

  async allocate(actor,{paymentId,memberId,expectedVersion,requestId}) {
    requireId(paymentId);requireId(memberId);requireRequestId(requestId);
    requireThat(Number.isSafeInteger(expectedVersion)&&expectedVersion>=1,'invalid_version');
    const fingerprint=await sha256(canonicalJson({operation,paymentId,memberId,expectedVersion}));
    return this.store.inCanonicalTransaction(async tx=>{
      const fresh=await revalidateCommandActor(tx,{id:actor?.id,sessionId:actor?.sessionId},
        this.groupId,'payments.allocate',this.clock());
      const prior=await tx.retainedCommand(this.groupId,fresh.id,requestId);
      if(prior){
        requireThat(prior.operation===operation&&prior.sessionId===fresh.sessionId&&prior.fingerprint===fingerprint,
          'idempotency_conflict',409);
        return prior.response;
      }
      const response=await tx.assignPayment({groupId:this.groupId,paymentId,memberId,expectedVersion,actorId:fresh.id,sessionId:fresh.sessionId});
      await tx.retainCommand({operation,groupId:this.groupId,actorId:fresh.id,sessionId:fresh.sessionId,requestId,fingerprint,response});
      return response;
    });
  }
}
