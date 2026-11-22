import {useCallback, useEffect, useRef, useState} from 'react';
import {AdminRequestError} from '../../api/client';

export type OperationReadState<T> =
  | {key: string; status: 'success'; value: T; receivedAt: number}
  | {key: string; status: 'error'; message: string};

/** Coalesce a single in-flight read across React's development effect replay. */
export function useOperationRead<T>(
  key: string,
  enabled: boolean,
  load: (signal: AbortSignal) => Promise<T>,
  {pollMs, invalidResponse = 'The workspace response could not be verified.'}: {pollMs?: number; invalidResponse?: string} = {},
) {
  const [read, setRead] = useState<{scope: string; result: OperationReadState<T>} | null>(null);
  const [attempt, setAttempt] = useState(0);
  const flight = useRef<{key: string; promise: Promise<T>; controller: AbortController; readers: number} | null>(null);
  const lastStarted = useRef(0);
  const attemptKey = `${key}:${attempt}`;

  useEffect(() => {
    if (!enabled) return;
    let pending = flight.current;
    if (!pending || pending.key !== attemptKey || pending.controller.signal.aborted) {
      pending?.controller.abort();
      const controller = new AbortController();
      lastStarted.current = Date.now();
      pending = {key: attemptKey, promise: load(controller.signal), controller, readers: 0};
      flight.current = pending;
    }
    const current = pending;
    current.readers++;
    let active = true;
    current.promise.then(value => {
      if (active) setRead({scope: key, result: {key: attemptKey, status: 'success', value, receivedAt: Date.now() / 1000}});
    }, (error: unknown) => {
      if (active) {
        setRead({scope: key, result: {
          key: attemptKey, status: 'error',
          message: error instanceof AdminRequestError ? error.message : invalidResponse,
        }});
      }
    }).finally(() => {
      if (flight.current === current) flight.current = null;
    });
    return () => {
      active = false;
      current.readers--;
      // React's development replay attaches again before this microtask.
      queueMicrotask(() => {if (!current.readers) current.controller.abort();});
    };
  }, [attemptKey, enabled, invalidResponse, key, load]);

  const retry = useCallback(() => {
    if (!pollMs || !flight.current) setAttempt(value => value + 1);
  }, [pollMs]);

  useEffect(() => {
    if (!enabled || !pollMs) return;
    const refreshVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine && Date.now() - lastStarted.current >= pollMs) retry();
    };
    const timer = window.setInterval(refreshVisible, pollMs);
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('focus', refreshVisible);
    window.addEventListener('online', refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.removeEventListener('focus', refreshVisible);
      window.removeEventListener('online', refreshVisible);
    };
  }, [enabled, pollMs, retry]);

  const result = enabled && (read?.result.key === attemptKey ||
    pollMs && read?.scope === key && read.result.status === 'success') ? read?.result ?? null : null;
  return {result, retry};
}
