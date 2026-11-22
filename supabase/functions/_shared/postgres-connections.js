import postgres from 'npm:postgres@3.4.7';
import {CONTROL_ROLLBACK_ACK, FENCE_IO_TIMEOUT_MS} from './application-fence.js';

// Only Edge holds this database credential. SQL strings come from reviewed
// server modules. Pool ownership is local to this Edge isolate.
const pools = new Map();
export function connection(url,env={}) { return configuredConnection(url,false,env); }
export function fenceConnection(url,env={}) { return configuredConnection(url,true,env); }
function configuredConnection(url,control,env) {
  if (!url) throw new Error('COLLECT_DATABASE_URL is required.');
  const target=new URL(url);const local=['127.0.0.1','localhost','::1','[::1]'].includes(target.hostname);if(!['postgres:','postgresql:'].includes(target.protocol))throw new Error('Invalid database URL.');
  const ca=env.COLLECT_DB_CA_PEM;
  if(ca!==undefined&&(typeof ca!=='string'||!ca.startsWith('-----BEGIN CERTIFICATE-----\n')||ca.length>32768))throw new Error('Invalid database CA.');
  const poolKey=(control?'control:':'business:')+url+'\n'+(ca??'');
  if (!pools.has(poolKey)) {const options={max: control ? 1 : 4, prepare: false,
    idle_timeout: 20, connect_timeout: 10, ssl: local ? false : {rejectUnauthorized: true,...(ca?{ca}:{}),servername:target.hostname},
    types: {numeric: {to:1700,from:[1700],serialize:String,parse:value=>{const n=Number(value);if(!/^-?\d+(?:\.0+)?$/.test(value)||!Number.isSafeInteger(n))throw new Error('integer_out_of_range');return n;}},bigint: {to: 20, from: [20], serialize: String, parse: value => {
      const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error('integer_out_of_range'); return n;
    }}}, onnotice: () => {}};
    pools.set(poolKey,control?leaseOwnedControlPool(()=>postgres(url,options)):postgres(url,options));
  }
  return pools.get(poolKey);
}

// Eight local slots include idle connections, setup, WORK, cleanup and
// quarantined pools. Only a confirmed rollback returns a lease to warm idle.
export function leaseOwnedControlPool(createPool) {
  const capacity=8,waiting=[],idle=[],owned=new Set();let ending=false;
  const unavailable=()=>new Error('collect_fence_unavailable');
  const hasCapacity=()=>idle.length>0 || owned.size<capacity;
  function pump(){
    while(!ending&&hasCapacity()&&waiting.length){
      const waiter=waiting.shift();clearTimeout(waiter.timer);
      if(performance.now()>=waiter.deadline){waiter.reject(unavailable());continue;}
      void acquire().then(waiter.resolve,waiter.reject);
    }
  }
  function retire(entry){
    if(!entry.retirement)entry.retirement=Promise.resolve().then(()=>entry.pool.end()).then(()=>{
      owned.delete(entry);pump();
    });
    // Keep the original end promise/options. Lost or rejected ACK quarantines
    // the slot; neither normal release nor shutdown may dispatch another end.
    void entry.retirement.catch(()=>{});return entry.retirement;
  }
  async function acquire(){
    let entry=idle.pop();
    try{
      if(!entry){entry={pool:createPool(),retirement:null};owned.add(entry);}
      const tx=await entry.pool.reserve();
      let returned=false;
      const assertOwned=()=>{if(returned)throw unavailable();};
      const release=ack=>{
        if(returned)return;
        returned=true;
        try{tx.release();}catch(error){void retire(entry);throw error;}
        if(ack===CONTROL_ROLLBACK_ACK&&!ending){idle.push(entry);pump();}
        else void retire(entry);
      };
      return new Proxy(tx,{
        apply(target,receiver,args){assertOwned();return Reflect.apply(target,receiver,args);},
        get(target,key){
          if(key==='release')return release;
          assertOwned();
          const value=Reflect.get(target,key,target);
          return typeof value==='function'?(...args)=>{assertOwned();return Reflect.apply(value,target,args);}:value;
        },
      });
    }catch(error){if(entry)void retire(entry);else queueMicrotask(pump);throw error;}
  }
  return Object.freeze({capacity,queueCapacity:capacity,get pendingReservations(){return waiting.length;},
    reserve(){
      if(ending)return Promise.reject(unavailable());
      return new Promise((resolve,reject)=>{
        if(hasCapacity()){void acquire().then(resolve,reject);return;}
        if(waiting.length>=capacity){reject(unavailable());return;}
        const waiter={resolve,reject,timer:null,deadline:performance.now()+FENCE_IO_TIMEOUT_MS};
        waiter.timer=setTimeout(()=>{const i=waiting.indexOf(waiter);if(i>=0){waiting.splice(i,1);reject(unavailable());}},FENCE_IO_TIMEOUT_MS);
        waiting.push(waiter);
      });
    },
    async end(options){
      ending=true;for(const waiter of waiting.splice(0)){clearTimeout(waiter.timer);waiter.reject(unavailable());}
      // Shutdown may retire idle slots. It cannot touch a reservation that
      // still owns setup, WORK, or unacknowledged rollback.
      for(const entry of idle.splice(0))void retire(entry);
      const entries=[...owned];if(entries.some(entry=>!entry.retirement))throw unavailable();
      const completion=Promise.all(entries.map(entry=>entry.retirement));let timer;
      try{await Promise.race([completion,new Promise((_,reject)=>{timer=setTimeout(()=>reject(unavailable()),FENCE_IO_TIMEOUT_MS);})]);}finally{clearTimeout(timer);}
      if(owned.size)throw unavailable();
    }
  });
}
