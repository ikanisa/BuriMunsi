import {useCallback,useState,useSyncExternalStore} from 'react';
import type {ReceiverInboxCheck} from './receiverSmsContract';

const MAX_AGE_MS=5*60*1000;
type Clock={wall:number; elapsed:number};
export const inboxReadClock=():Clock=>({wall:Date.now(),elapsed:performance.now()});
export type InboxFreshnessSample={check:ReceiverInboxCheck;asOf:string;started:Clock};
type Proof={checkedAt:string; sourceTime:number; deadline:Clock|null};

function proofFor(sample:InboxFreshnessSample|null):Proof|null {
  if (!sample || sample.check.state!=='verified' || !sample.check.checkedAt) return null;
  const sourceTime=Date.parse(sample.check.checkedAt), age=Date.parse(sample.asOf)-sourceTime;
  if (!Number.isFinite(age) || age<0) return null;
  const budget=MAX_AGE_MS-age;
  // Counting the full local request duration is conservative: an older server
  // response cannot buy extra fresh time in transit. Clocks need not agree.
  const deadline=budget>0 ? {wall:sample.started.wall+budget,elapsed:sample.started.elapsed+budget} : null;
  return {checkedAt:sample.check.checkedAt,sourceTime,deadline};
}

function remaining(deadline:Clock|null) {
  if (!deadline) return 0;
  const now=inboxReadClock();
  return Math.min(deadline.wall-now.wall,deadline.elapsed-now.elapsed);
}

/** Keep the earliest deadline for a verification, including across failed
 * refreshes. Call from a component scoped to one collection and authority. */
export function useInboxFreshness(sample:InboxFreshnessSample|null) {
  const candidate=proofFor(sample);
  const [previous,setPrevious]=useState<Proof|null>(null);
  let proof=previous;
  if (candidate && (!previous || candidate.sourceTime>previous.sourceTime)) proof=candidate;
  else if (candidate && previous && candidate.sourceTime===previous.sourceTime && previous.deadline) {
    if (!candidate.deadline) proof={...previous,deadline:null};
    else {
      const wall=Math.min(previous.deadline.wall,candidate.deadline.wall);
      const elapsed=Math.min(previous.deadline.elapsed,candidate.deadline.elapsed);
      if (wall!==previous.deadline.wall || elapsed!==previous.deadline.elapsed) proof={...previous,deadline:{wall,elapsed}};
    }
  }
  const deadline=proof?.deadline ?? null;
  const subscribe=useCallback((changed:()=>void)=>{
    if (!deadline) return ()=>{};
    let timer=0;
    const sync=()=>{
      window.clearTimeout(timer);
      const ms=remaining(deadline);
      if (ms>0) timer=window.setTimeout(sync,Math.ceil(ms));
      changed();
    };
    sync();
    document.addEventListener('visibilitychange',sync);
    for (const event of ['focus','pageshow']) window.addEventListener(event,sync);
    return ()=>{
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange',sync);
      for (const event of ['focus','pageshow']) window.removeEventListener(event,sync);
    };
  },[deadline]);
  const active=useSyncExternalStore(subscribe,()=>remaining(deadline)>0);
  if (proof?.deadline && !active) proof={...proof,deadline:null};
  if (proof!==previous) setPrevious(proof);
  return {fresh:active && !!candidate && proof?.sourceTime===candidate.sourceTime,lastVerified:proof?.checkedAt ?? null};
}
