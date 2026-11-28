import {useEffect, useRef, useState, type ReactNode} from 'react';
import {adminBrand} from '../branding';
import {Icon} from '../ui/Icon';
import {useFocusScope} from '../ui/useFocusScope';
import {AdminAccountMenu, type AdminAccountDestination, type AdminShellIdentity} from './AdminAccountMenu';
import {AdminNavigation, findCurrentSection, type AdminNavItem} from './AdminNavigation';

export type {AdminAccountDestination, AdminShellIdentity} from './AdminAccountMenu';
export type {AdminNavItem} from './AdminNavigation';

export interface AdminShellProps {
  navigation: readonly AdminNavItem[];
  accountNavigation?: readonly AdminAccountDestination[];
  showAccountHelp?: boolean;
  currentPath: string;
  identity?: AdminShellIdentity | null;
  onSignOut?: () => void;
  toolbar?: ReactNode;
  status?: ReactNode;
  children: ReactNode;
}

const compactNavigation = '(max-width: 720px)';

export function AdminShell({navigation, accountNavigation, showAccountHelp, currentPath, identity, onSignOut, toolbar, status, children}: AdminShellProps) {
  const [menuRequested, setMenuOpen] = useState(false);
  const menuTrigger = useRef<HTMLElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const closeMenu = () => setMenuOpen(false);
  function openMenu(trigger: HTMLElement) {
    menuTrigger.current = trigger;
    setMenuOpen(true);
  }
  const menuOpen = useFocusScope(menuRequested, sidebarRef, closeMenu, menuTrigger);
  const pathname = currentPath.split('?')[0];
  const selected = findCurrentSection(navigation, pathname);
  const sectionLabel = selected?.label ?? findCurrentSection(accountNavigation ?? [], pathname)?.label;

  useEffect(() => {
    document.title = sectionLabel ? `${sectionLabel} · ${adminBrand.name}` : adminBrand.name;
    return () => { document.title = adminBrand.name; };
  }, [sectionLabel]);

  useEffect(() => {
    if (!menuOpen) return;
    const media = window.matchMedia?.(compactNavigation);
    const resize = (event: MediaQueryListEvent) => {
      if (!event.matches) setMenuOpen(false);
    };
    media?.addEventListener?.('change', resize);
    return () => media?.removeEventListener?.('change', resize);
  }, [menuOpen]);

  return <div className={`admin-shell ${menuOpen ? 'admin-shell--menu-open' : ''}`}>
    <a className="admin-skip-link" href="#main-content" inert={menuOpen}
      onClick={(event) => {event.preventDefault(); contentRef.current?.focus();}}>Skip to main content</a>
    {menuOpen && <button className="admin-menu-scrim" aria-hidden="true" tabIndex={-1} type="button" onClick={closeMenu} />}
    <AdminNavigation sidebar={sidebarRef} navigation={navigation} pathname={pathname} selected={selected} status={status} onClose={closeMenu} />
    <div className="admin-main-column" inert={menuOpen}>
      <header className="admin-topbar">
        <button type="button" className="admin-icon-button admin-menu-button" aria-label="Open navigation" aria-controls="admin-navigation" aria-expanded={menuOpen} onClick={event => openMenu(event.currentTarget)}><Icon name="menu" /></button>
        <span className="admin-topbar-location">{sectionLabel ?? 'Workspace'}</span>
        <div className="admin-top-spacer" />
        {toolbar}
        {identity && <AdminAccountMenu key={JSON.stringify([identity.name, identity.role, currentPath])} identity={identity}
          destinations={accountNavigation} showHelp={showAccountHelp} pathname={pathname} onSignOut={onSignOut} />}
      </header>
      <main id="main-content" className="admin-content" ref={contentRef} tabIndex={-1}>{children}</main>
    </div>
  </div>;
}
