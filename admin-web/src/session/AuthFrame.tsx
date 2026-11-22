import type {ReactNode} from 'react';
import {Card} from '../ui';
import burimunsiWordmark from '../ui/assets/burimunsi-wordmark.png';
import {adminBrand} from '../branding';
import './auth.css';

export function AuthFrame({title, subtitle, children}: {title: string; subtitle: string; children: ReactNode}) {
  return <main className="admin-auth"><div className="admin-auth-inner">
    <div className="admin-auth-brand">
      <img className="admin-auth-wordmark" src={burimunsiWordmark} alt={adminBrand.product} />
      <span><small>Admin workspace</small></span>
    </div>
    <Card className="admin-auth-card"><h1>{title}</h1><p className="admin-auth-subtitle">{subtitle}</p>{children}</Card>
  </div></main>;
}

export function authFailureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : 'The request could not be confirmed. Try again.';
}
