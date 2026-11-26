import type {ReactNode, RefObject} from 'react';
import {Icon} from '../ui/Icon';
import burimunsiWordmark from '../ui/assets/burimunsi-wordmark.png';
import {adminBrand} from '../branding';

export interface AdminNavItem {
  label: string;
  path: string;
  icon?: string;
  /** An old deep link can correspond to a primary area without granting access to it. */
  relatedPaths?: readonly string[];
}

export function findCurrentSection(navigation: readonly AdminNavItem[], pathname: string): AdminNavItem | undefined {
  let current: AdminNavItem | undefined;
  let matchedLength = 0;
  for (const item of navigation) {
    for (const path of [item.path, ...item.relatedPaths ?? []]) {
      if ((path === pathname || (path !== '/admin' && pathname.startsWith(path + '/'))) && path.length > matchedLength) {
        current = item;
        matchedLength = path.length;
      }
    }
  }
  return current;
}

interface AdminNavigationProps {
  sidebar: RefObject<HTMLElement | null>;
  navigation: readonly AdminNavItem[];
  pathname: string;
  selected?: AdminNavItem;
  status?: ReactNode;
  onClose: () => void;
}

export function AdminNavigation({sidebar, navigation, pathname, selected, status, onClose}: AdminNavigationProps) {
  return <aside ref={sidebar} className="admin-sidebar" id="admin-navigation" aria-label="Primary admin navigation" tabIndex={-1}>
    <div className="admin-brand">
      <img className="admin-brand-wordmark" src={burimunsiWordmark} alt={adminBrand.product} />
      <button type="button" className="admin-icon-button admin-sidebar-close" onClick={onClose} aria-label="Close navigation">
        <Icon name="close" />
      </button>
    </div>
    <nav className="admin-sidebar-scroll" aria-label="Admin sections">
      {navigation.map(item => {
        const active = selected?.path === item.path;
        return <a key={item.path} className={active ? 'admin-nav-link admin-nav-link--active' : 'admin-nav-link'}
          href={`#${item.path}`} aria-current={active ? (pathname === item.path ? 'page' : 'location') : undefined} onClick={onClose}>
          <Icon name={item.icon ?? 'file'} /><span className="admin-compact-text" title={item.label}>{item.label}</span>
        </a>;
      })}
      {navigation.length === 0 && <p className="admin-nav-empty">No daily sections available.</p>}
    </nav>
    {status && <div className="admin-sidebar-footer">{status}</div>}
  </aside>;
}
