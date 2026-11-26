import {useCallback, useContext, useEffect, useRef, useState} from 'react';
import {AdminRequestError} from '../../api/client';
import {useVisibleOperationsRefresh} from './useVisibleOperationsRefresh';
import {InteractionSuspendedContext} from '../../ui/useFocusScope';

export type OperationReadState<T> =
  | {key: string; status: 'success'; value: T; receivedAt: number}
  | {key: string; status: 'error'; message: string};

/** Coalesce a single in-flight read across React's development effect replay. */
export function useOperationRead<T>(
  key: string,
  enabled: boolean,
  load: (signal: AbortSignal) => Promise<T>,
  {pollMs, collectionId, live = false, retainDuringRefresh = false, invalidResponse = 'The workspace response could not be verified.'}:
    {pollMs?: number; collectionId?: string; live?: boolean; retainDuringRefresh?: boolean; invalidResponse?: string} = {},
) {
  const suspended = useContext(InteractionSuspendedContext);
  const [read, setRead] = useState<{scope: string; result: OperationReadState<T>} | null>(null);
  const [attempt, setAttempt] = useState(0);
  const flight = useRef<{key: string; promise: Promise<T>; controller: AbortController; readers: number} | null>(null);
  const lastStarted = useRef(0);
  const queuedChange = useRef<string | null>(null);
  const attemptKey = `${key}:${attempt}`;

  useEffect(() => {
    if (suspended) {
      flight.current?.controller.abort();
      flight.current = null;
      queuedChange.current = null;
      return;
    }
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
      if (!active || flight.current !== current) return;
      flight.current = null;
      if (queuedChange.current === attemptKey) {
        queuedChange.current = null;
        if (document.visibilityState === 'visible' && navigator.onLine) setAttempt(value => value + 1);
      }
    });
    return () => {
      active = false;
      current.readers--;
      // React's development replay attaches again before this microtask.
      queueMicrotask(() => {if (!current.readers) current.controller.abort();});
    };
  }, [attemptKey, enabled, invalidResponse, key, load, suspended]);

  const retry = useCallback(() => {
    if (!suspended && (!pollMs || !flight.current)) setAttempt(value => value + 1);
  }, [pollMs, suspended]);

  const refresh = useCallback((changed: boolean, minimumAge: number) => {
    if (flight.current) {
      if (changed) queuedChange.current = flight.current.key;
      return;
    }
    if (changed || Date.now() - lastStarted.current >= minimumAge) setAttempt(value => value + 1);
  }, []);
  useVisibleOperationsRefresh(enabled && !suspended, pollMs, refresh, collectionId, live);

  const result = enabled && (read?.result.key === attemptKey ||
    (pollMs !== undefined || live || retainDuringRefresh) && read?.scope === key && read.result.status === 'success') ? read?.result ?? null : null;
  return {result, retry};
}
