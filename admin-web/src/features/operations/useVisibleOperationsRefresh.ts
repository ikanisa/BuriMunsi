import {useEffect} from 'react';
import {useOperationsLive} from './operationsLiveContext';

/** Refetch the current authorized route. Notifications contain no record data. */
export function useVisibleOperationsRefresh(enabled: boolean, pollMs: number | undefined,
  refresh: (invalidated: boolean, minimumAge: number) => void, collectionId?: string, liveReads = false) {
  const stream = useOperationsLive(enabled && (!!pollMs || liveReads), collectionId);
  const interval = stream.configured ? (stream.connected ? 60000 : Math.min(pollMs ?? 5000, 5000)) : pollMs;
  useEffect(() => {
    if (!enabled || !interval) return;
    let timer: number | undefined;
    const visible = () => document.visibilityState === 'visible' && navigator.onLine;
    const stop = () => {if (timer !== undefined) window.clearInterval(timer); timer = undefined;};
    const tick = () => {if (visible()) refresh(false, interval); else stop();};
    const schedule = () => {stop(); if (visible()) timer = window.setInterval(tick, interval);};
    const resume = () => {schedule(); if (visible()) refresh(false, interval);};
    const changed = (event: Event) => {
      const scope: unknown = (event as CustomEvent<{collectionId?: string}>).detail?.collectionId;
      if (visible() && (!scope || !collectionId || scope === collectionId)) refresh(true, 0);
    };
    schedule();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    window.addEventListener('offline', stop);
    window.addEventListener('burimunsi-operations-changed', changed);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', stop);
      window.removeEventListener('burimunsi-operations-changed', changed);
    };
  }, [enabled, interval, refresh, collectionId]);
}
