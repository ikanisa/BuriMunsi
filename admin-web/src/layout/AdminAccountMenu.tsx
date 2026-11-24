import {useEffect, useRef, useState} from 'react';
import {Icon} from '../ui/Icon';
import {SupportLink} from '../ui/SupportLink';
import {hasActiveFocusScope} from '../ui/useFocusScope';

export interface AdminShellIdentity {
  name: string;
  role?: string;
}

export interface AdminAccountDestination {
  label: string;
  path: string;
  icon?: string;
  group?: 'help' | 'advanced';
}

export function AdminAccountMenu({identity, destinations = [], pathname, onSignOut}: {
  identity: AdminShellIdentity;
  destinations?: readonly AdminAccountDestination[];
  pathname?: string;
  onSignOut?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || hasActiveFocusScope()) return;
      const restoreFocus = container.current?.contains(document.activeElement);
      setOpen(false);
      if (restoreFocus) trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const links = (group: AdminAccountDestination['group']) => destinations.filter(item => item.group === group).map(item =>
    <a className="admin-profile-destination" key={item.path} href={`#${item.path}`}
      aria-current={item.path === pathname ? 'page' : undefined} onClick={() => setOpen(false)}>
      {item.icon && <Icon name={item.icon} />}{item.label}
    </a>);

  const advanced = links('advanced');
  return <div className="admin-profile" ref={container}>
    <button className="admin-profile-button" type="button" ref={trigger} aria-controls={open ? 'admin-account-options' : undefined} aria-label={'Account: ' + identity.name}
      aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="admin-operator-role">{identity.role}</span>
      <span className="admin-avatar" aria-hidden="true">{identity.name.slice(0, 1).toLocaleUpperCase()}</span>
    </button>
    {open && <div className="admin-profile-menu" id="admin-account-options">
      <strong>{identity.name}</strong>
      {identity.role && <span>{identity.role}</span>}
      {links(undefined)}
      <details className="admin-profile-more"><summary>Help</summary><SupportLink />{links('help')}</details>
      {advanced.length > 0 && <details className="admin-profile-more"><summary>Advanced</summary>{advanced}</details>}
      {onSignOut && <button type="button" onClick={() => {setOpen(false); onSignOut();}}>
        <Icon name="logout" />Sign out
      </button>}
    </div>}
  </div>;
}
