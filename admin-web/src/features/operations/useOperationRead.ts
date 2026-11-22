import {useCallback, useContext, useEffect, useRef, useState} from 'react';
import {AdminRequestError} from '../../api/client';
import {InteractionSuspendedContext} from '../../ui/useFocusScope';
import {useVisibleOperationsRefresh} from './useVisibleOperationsRefresh';

export type OperationReadState<T> =
  | {key: string; status: 'success'; value: T; receivedAt: number}
  | {key: string; status: 'error'; message: string};

/** Coalesce a single in-flight read across React's development effect replay. */
export function useOperationRead<T>(
  key: string,
  enabled: boolean,
  load: () => Promise<T>,
  {pollMs, collectionId, live = false, invalidResponse = 'The workspace response could not be verified.'}: {pollMs?: number; collectionId?: string; live?: boolean; invalidResponse?: string} = {},
) {
  const suspended = useContext(InteractionSuspendedContext);
  const [result, setResult] = useState<(OperationReadState<T> & {scope: string}) | null>(null);
  const [attempt, setAttempt] = useState(0);
  const flight = useRef<{key: string; promise: Promise<T>} | null>(null);
  const pending = useRef<string | null>(null);
  const attemptKey = `${key}:${attempt}`;

  useEffect(() => {
    if (!enabled || suspended) {flight.current = null; pending.current = null; return;}
    let read = flight.current;
    if (!read || read.key !== attemptKey) {
      read = {key: attemptKey, promise: load()};
      flight.current = read;
    }
    const current = read;
    let active = true;
    current.promise.then(value => {
      if (active) setResult({key: attemptKey, scope: key, status: 'success', value, receivedAt: Date.now() / 1000});
    }, (error: unknown) => {
      if (active) {
        setResult({
          key: attemptKey, scope: key, status: 'error',
          message: error instanceof AdminRequestError ? error.message : invalidResponse,
        });
      }
    }).finally(() => {
      if (!active || flight.current !== current) return;
      flight.current = null;
      if (pending.current === attemptKey) {
        pending.current = null;
        if (document.visibilityState === 'visible' && navigator.onLine) setAttempt(value => value + 1);
      }
    });
    return () => {active = false;};
  }, [attemptKey, enabled, invalidResponse, key, load, suspended]);

  const retry = useCallback(() => {
    if (!pollMs || !flight.current) setAttempt(value => value + 1);
  }, [pollMs]);

  const refresh = useCallback((invalidated: boolean) => {
    if (flight.current) {
      if (invalidated) pending.current = flight.current.key;
      return;
    }
    setAttempt(value => value + 1);
  }, []);
  useVisibleOperationsRefresh(enabled && !suspended, pollMs, refresh, collectionId, live);

  const sameScope = (pollMs !== undefined || live) && result?.scope === key && result.status === 'success';
  return {result: enabled && (result?.key === attemptKey || sameScope) ? result : null, retry};
}
