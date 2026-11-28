import {useCallback, useEffect, useRef, useState} from 'react';
import type {DataRouter} from 'react-router';
import {readDesktopDestination, type DesktopDestination, type WorkspaceBookmark} from '../session/operatorBookmarks';
import {publicSessionPaths} from '../session/returnLocation';
import {Button} from '../ui';
import {hasActiveFocusScope} from '../ui/useFocusScope';
import {primaryAdminNavigation} from './navigation';
import './desktop-launch.css';

const destinations = primaryAdminNavigation.filter(item =>
  ['/admin', '/admin/members', '/admin/payments'].includes(item.path));

interface DesktopLaunchQueue {
  setConsumer(consume: (launch: {targetURL?: string | null}) => void): void;
}

export function DesktopLaunch({router}: {router: DataRouter}) {
  const [pending, setPending] = useState<DesktopDestination | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const opening = useRef<string | null>(null);
  const open = useCallback((destination: WorkspaceBookmark) => {
    setPending(null);
    if (opening.current === destination.path) return;
    opening.current = destination.path;
    const onLogin = router.state.location.pathname === publicSessionPaths.login;
    const target = onLogin
      ? {pathname: publicSessionPaths.login, search: '?' + new URLSearchParams({returnTo: destination.path})}
      : destination.path;
    void router.navigate(target, {replace: onLogin}).then(() => {
      if (!onLogin) requestAnimationFrame(() => {
        if (router.state.location.pathname === destination.path.split('?')[0] && document.activeElement === document.body) {
          document.getElementById('main-content')?.focus();
        }
      });
    }).finally(() => {
      if (opening.current === destination.path) opening.current = null;
    });
  }, [router]);

  useEffect(() => {
    const queue = (window as Window & {launchQueue?: DesktopLaunchQueue}).launchQueue;
    if (!queue) return;
    let location = router.state.location;
    let interacted = false;
    let active = true;
    // Primary lists can hold unapplied searches and filters outside the URL.
    // Remember interaction only. Field values stay with their owning screen.
    const markInteraction = (event: Event) => {
      const element = event.target;
      if (element instanceof Element && element.closest('main, [role="dialog"]') &&
          element.closest('input, select, textarea, button, [role="button"], [role="tab"], [contenteditable]')) interacted = true;
    };
    const events = ['input', 'change', 'click'] as const;
    for (const event of events) document.addEventListener(event, markInteraction, true);
    const unsubscribe = router.subscribe(state => {
      if (state.location.key === location.key) return;
      if (state.location.pathname !== location.pathname) interacted = false;
      location = state.location;
      setPending(null);
      previousFocus.current = null;
    });
    queue.setConsumer(({targetURL}) => {
      if (!active) return;
      const destination = readDesktopDestination(targetURL, window.location.origin);
      if (!destination) return;
      const {pathname, search, hash} = router.state.location;
      const onLogin = pathname === publicSessionPaths.login;
      const loginTarget = onLogin && (new URLSearchParams(search).get('returnTo') ?? '/admin');
      // A bare section shortcut keeps the current view. An explicit filtered
      // bookmark on that same section can request a different record or criteria.
      const current = loginTarget || (pathname + search + hash);
      if (destination.kind === 'workspace' && (current === destination.path ||
          destinations.some(item => item.path === destination.path) && current.split('?')[0] === destination.path)) {
        setPending(null);
        previousFocus.current = null;
        return;
      }
      // Updating the existing sign-in destination preserves the form itself.
      // A detailed task, a dialog or work on a list can only be left explicitly.
      if (destination.kind === 'document' || hasActiveFocusScope() || document.querySelector('dialog[open]') ||
          !onLogin && (interacted || search || hash ||
          (pathname !== '/' && !destinations.some(item => item.path === pathname)))) {
        if (!previousFocus.current && document.activeElement instanceof HTMLElement) previousFocus.current = document.activeElement;
        setPending(destination);
        return;
      }
      open(destination);
    });
    return () => {
      active = false;
      unsubscribe();
      for (const event of events) document.removeEventListener(event, markInteraction, true);
    };
  }, [router, open]);

  function dismiss() {
    setPending(null);
    if (previousFocus.current?.isConnected) previousFocus.current.focus({preventScroll: true});
    previousFocus.current = null;
  }

  return <div className={pending ? 'admin-shortcut-notice' : undefined}
    role={pending ? 'region' : undefined} aria-label={pending ? 'Desktop shortcut' : undefined}>
    <span aria-live="polite" aria-atomic="true">{pending && (pending.kind === 'document'
      ? `${pending.label} opens in a new tab.` : `Opening ${pending.label} will leave this page.`)}</span>
    {pending && <>{pending.kind === 'document'
      ? <a className="admin-btn admin-btn--secondary" href={pending.path} target="_blank" rel="noopener noreferrer"
          aria-label={`Open ${pending.label} (opens in a new tab)`} onClick={dismiss}>Open {pending.label}</a>
      : <Button onClick={() => open(pending)}>Open {pending.label}</Button>}
      <Button onClick={dismiss}>Dismiss</Button></>}
  </div>;
}
