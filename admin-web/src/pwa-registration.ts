/** Register the same-origin Admin worker without taking over unfinished tabs. */
export async function registerAdminWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  if (document.readyState !== 'complete') {
    await new Promise<void>(ready => window.addEventListener('load', () => ready(), {once: true}));
  }
  if ('requestIdleCallback' in window) {
    await new Promise<void>(ready => window.requestIdleCallback(() => ready(), {timeout: 3000}));
  }
  try {
    return await navigator.serviceWorker.register('/custom-sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });
  } catch {
    // The application remains available in a regular browser tab. The caller
    // must not claim that installation or offline access is available.
    return null;
  }
}

/** Observe the browser's waiting phase after the worker has verified its static cache. */
export function observeAdminWorkerUpdate(report: (waiting: boolean) => void): () => void {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return () => {};
  const serviceWorker = navigator.serviceWorker;
  const scope = new URL('/', window.location.origin).href;
  const script = new URL('/custom-sw.js', scope).href;
  const watched = new Set<ServiceWorker>();
  let registration: ServiceWorkerRegistration | undefined;
  let disposed = false;
  const refresh = () => {
    if (disposed || !registration) return;
    const {installing, waiting, active} = registration;
    for (const worker of watched) {
      if (worker === installing || worker === waiting) continue;
      worker.removeEventListener('statechange', refresh);
      watched.delete(worker);
    }
    for (const worker of [installing, waiting]) {
      if (!worker || watched.has(worker)) continue;
      worker.addEventListener('statechange', refresh);
      watched.add(worker);
    }
    report(active !== null && active === serviceWorker.controller && active.scriptURL === script &&
      waiting !== null && waiting !== active && waiting.scriptURL === script && waiting.state === 'installed');
  };
  serviceWorker.addEventListener('controllerchange', refresh);
  void serviceWorker.ready.then(current => {
    if (disposed || current.scope !== scope) return;
    registration = current;
    registration.addEventListener('updatefound', refresh);
    refresh();
  }).catch(() => undefined);
  return () => {
    disposed = true;
    serviceWorker.removeEventListener('controllerchange', refresh);
    registration?.removeEventListener('updatefound', refresh);
    for (const worker of watched) worker.removeEventListener('statechange', refresh);
    watched.clear();
  };
}
