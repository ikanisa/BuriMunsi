type InstallState = 'help' | 'available' | 'prompting' | 'installed';
type InstallChoice = {outcome: 'accepted' | 'dismissed'};
interface InstallPrompt extends Event {
  prompt(): Promise<InstallChoice | void>;
  userChoice: Promise<InstallChoice>;
}
interface InstallNavigator extends Navigator {
  install?: () => Promise<unknown>;
  standalone?: boolean;
  userAgentData?: {brands: readonly {brand: string}[]};
}

function observeInstallation(target: Window) {
  const nav: InstallNavigator = target.navigator;
  const display = target.matchMedia?.('(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)');
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  let deferred: InstallPrompt | undefined;
  let nativeInstall = nav.install?.bind(nav);
  let prompting = false;
  let installed = false;

  function getSnapshot(): InstallState {
    if (installed || display?.matches || nav.standalone) return 'installed';
    if (prompting) return 'prompting';
    return nativeInstall || deferred ? 'available' : 'help';
  }

  target.addEventListener('beforeinstallprompt', event => {
    const offer = event as InstallPrompt;
    if (typeof offer.prompt !== 'function' || getSnapshot() === 'installed') return;
    event.preventDefault();
    deferred = offer;
    notify();
  });
  target.addEventListener('appinstalled', () => {
    installed = true;
    deferred = undefined;
    notify();
  });
  display?.addEventListener?.('change', notify);

  async function request(): Promise<'done' | 'help'> {
    if (getSnapshot() !== 'available') return 'done';
    const offer = deferred;
    // Keep the original click's activation and consume this offer before any await.
    deferred = undefined;
    prompting = true;
    notify();
    try {
      if (nativeInstall) {
        await nativeInstall();
        installed = true;
      } else if (offer) {
        const choice = await offer.prompt() ?? await offer.userChoice;
        if (choice.outcome === 'accepted') installed = true;
      }
      return 'done';
    } catch (failure) {
      nativeInstall = undefined;
      // A private window or policy can report the same abort as a dismissal.
      // Leave guidance available on the next click without opening it automatically.
      if (failure && typeof failure === 'object' && 'name' in failure && failure.name === 'AbortError') return 'done';
      return 'help';
    } finally {
      prompting = false;
      notify();
    }
  }
  return {getSnapshot, request, subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {listeners.delete(listener);};
  }};
}

const controllers = new WeakMap<Window, ReturnType<typeof observeInstallation>>();
export function getAppInstallation(target: Window = window) {
  let controller = controllers.get(target);
  if (!controller) {
    controller = observeInstallation(target);
    controllers.set(target, controller);
  }
  return controller;
}
// A browser can offer installation before React has mounted the sign-in form or account menu.
if (typeof window !== 'undefined') getAppInstallation(window);

export function installInstructions(nav: Pick<InstallNavigator, 'userAgent' | 'maxTouchPoints' | 'userAgentData'>) {
  const ua = nav.userAgent;
  const mac = /Macintosh/.test(ua);
  const ios = /iPhone|iPod|iPad/.test(ua) || (mac && nav.maxTouchPoints > 1);
  const safari = /Version\/\S+.*Safari\//.test(ua) && !/Chrome\/|CriOS\/|Edg|FxiOS\/|OPR\//.test(ua);
  if (safari && ios) return 'In Safari, open Share and choose Add to Home Screen. Turn on Open as Web App if shown, then tap Add.';
  if (safari && mac) return 'In Safari on macOS Sonoma 14 or later, choose Add to Dock from the File menu, then Add. On earlier versions, bookmark this page.';
  const brands = nav.userAgentData?.brands.map(item => item.brand) ?? [];
  if (!ios && !/Android/.test(ua) && (brands.includes('Microsoft Edge') || /Edg\//.test(ua))) {
    return 'In Edge, open Settings and more, then More tools and Apps. Choose Install this site as an app.';
  }
  if (brands.includes('Google Chrome')) {
    if (/Android/.test(ua)) return 'In Chrome, open the menu, choose Install and create shortcut, then tap Install.';
    return 'In Chrome, open the menu, choose Cast, save, and share, then Install page as app.';
  }
  return 'Look for an install option in your browser’s menu or address bar. If none is available, bookmark this page for quick access.';
}
