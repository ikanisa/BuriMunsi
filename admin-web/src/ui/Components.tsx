import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { Icon } from './Icon';
export {LoadingState, type LoadingLayout} from './LoadingState';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'soft' | 'danger';
  icon?: string;
  loading?: boolean;
}

export function CompactText({children, cell = false}: {children: string; cell?: boolean}) {
  return <span className={cell ? 'admin-compact-text admin-cell-text' : 'admin-compact-text'} title={children}>{children}</span>;
}

export function Button({ variant = 'secondary', icon, loading = false, children, className = '', type = 'button', disabled, ...props }: ButtonProps) {
  return <button {...props} type={type} className={`admin-btn admin-btn--${variant} ${className}`} disabled={disabled || loading} aria-busy={loading || undefined}>
    {loading ? <span className="admin-spinner" aria-hidden="true" /> : icon ? <Icon name={icon} /> : null}
    {typeof children === 'string' ? <CompactText>{children}</CompactText> : children}
  </button>;
}

export function Card({ className = '', children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`admin-card ${className}`} {...props}>{children}</div>;
}

export interface PageHeaderProps {
  title: string;
  eyebrow?: string;
  subtitle?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, eyebrow, subtitle, actions }: PageHeaderProps) {
  return <div className="admin-page-heading">
    <div>{eyebrow && <p className="admin-eyebrow">{eyebrow}</p>}<h1 className="admin-compact-text" title={title}>{title}</h1>{subtitle && <p className="admin-page-subtitle">{subtitle}</p>}</div>
    {actions && <div className="admin-heading-actions">{actions}</div>}
  </div>;
}

export interface StatusBadgeProps {
  children: ReactNode;
  tone?: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
}

export function StatusBadge({ children, tone = 'neutral' }: StatusBadgeProps) {
  return <span className={`admin-badge admin-badge--${tone}`}><span className="admin-badge-dot" aria-hidden="true" />{typeof children === 'string' ? <CompactText>{children}</CompactText> : children}</span>;
}

export function ErrorState({ title = 'Unable to load this page', headingLevel = 2, message, onRetry }: {
  title?: string; headingLevel?: 1 | 2; message: string; onRetry?: () => void;
}) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  return <div className="admin-state admin-state--error" role="alert"><Icon name="alert" /><Heading>{title}</Heading><p>{message}</p>{onRetry && <Button onClick={onRetry} icon="refresh">Try again</Button>}</div>;
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="admin-state"><span className="admin-state-icon"><Icon name="file" /></span><h2>{title}</h2>{description && <p>{description}</p>}{action}</div>;
}

export function Field({ label, htmlFor, hint, error, children }: { label: string; htmlFor: string; hint?: string; error?: string; children: ReactNode }) {
  return <div className="admin-field"><label htmlFor={htmlFor}>{label}</label>{children}{hint && <p className="admin-field-hint">{hint}</p>}{error && <p className="admin-field-error" role="alert">{error}</p>}</div>;
}
