import {useEffect, useRef, useSyncExternalStore} from 'react';
import {useSession} from '../session/SessionProvider';
import {Icon} from '../ui/Icon';

function subscribeToNetworkChange(listener: () => void) {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}

const browserIsOnline = () => navigator.onLine;

export function useBrowserOnline() {
  return useSyncExternalStore(subscribeToNetworkChange, browserIsOnline);
}

export function WorkspaceConnectivity() {
  const online = useBrowserOnline();
  const {status, verificationMode, logoutUnconfirmed, mfaRecoveryPending, refresh} = useSession();
  const sawOffline = useRef(!online);

  useEffect(() => {
    if (!online) {
      sawOffline.current = true;
      return;
    }
    // The first session read may still be finishing when the network returns.
    if (!sawOffline.current || status === 'loading') return;
    sawOffline.current = false;
    if (status === 'error' && verificationMode === 'passcode' && !logoutUnconfirmed && !mfaRecoveryPending) {
      void refresh().catch(() => undefined);
    }
  }, [online, status, verificationMode, logoutUnconfirmed, mfaRecoveryPending, refresh]);

  if (online) return null;
  return <aside className="admin-offline-notice" role="status">
    <Icon name="unlinked" />
    <span><strong>You’re offline.</strong> Reconnect to load current records or submit changes.</span>
  </aside>;
}
