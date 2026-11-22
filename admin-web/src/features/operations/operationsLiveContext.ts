import {createContext, useCallback, useContext, useSyncExternalStore} from 'react';
import {watchOperations, type OperationsSubscription} from './operationsRealtime';

/** Multiple views of the same collection share one capability and private socket. */
export function operationsStreams(options: OperationsSubscription) {
  const groups = new Map<string, {connected: boolean; listeners: Set<() => void>; stop: () => void}>();
  return {
    connected: (group?: string) => !!groups.get(group ?? '')?.connected,
    subscribe(group: string | undefined, listener: () => void) {
      const key = group ?? '';
      let entry = groups.get(key);
      if (!entry) {
        const active = {connected:false, listeners:new Set<() => void>(), stop:() => {}};
        groups.set(key, active);
        active.stop = watchOperations(options, group, value => {
          if (active.connected === value) return;
          active.connected = value; for (const notify of active.listeners) notify();
        });
        entry = active;
      }
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
        if (!entry.listeners.size) {entry.stop(); groups.delete(key);}
      };
    },
  };
}
export const OperationsLiveContext = createContext<ReturnType<typeof operationsStreams> | null>(null);

export function useOperationsLive(enabled: boolean, group?: string) {
  const streams = useContext(OperationsLiveContext);
  const subscribe = useCallback((listener: () => void) => enabled && streams ? streams.subscribe(group, listener) : () => {}, [enabled, streams, group]);
  const snapshot = useCallback(() => enabled && !!streams?.connected(group), [enabled, streams, group]);
  const connected = useSyncExternalStore(subscribe, snapshot, () => false);
  return {configured: enabled && !!streams, connected};
}
