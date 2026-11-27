import {adminBrand} from '../branding';
import type {ReactNode} from 'react';

export function SupportLink() {
  const {phone, url} = adminBrand.support;
  return <a className="admin-btn admin-btn--secondary" href={url} target="_blank" rel="noopener noreferrer">WhatsApp support · {phone}</a>;
}

export function PrivacyLink({className, children}: {className?: string; children?: ReactNode}) {
  return <a className={className} href="/privacy" target="_blank" rel="noopener noreferrer"
    aria-label="Privacy and data use (opens in a new tab)">{children}Privacy and data use</a>;
}
