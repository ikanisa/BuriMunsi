import {useEffect, useState} from 'react';
import {Link} from 'react-router';
import type {AdminUser} from '../../session/sessionResponses';
import {withPendingFence} from '../operations/pendingFence';
import {canAddMember} from './addMemberAccess';
import {readPending, type PendingIdentity} from './pendingAttempt';
import {usePendingIdentity} from './usePendingIdentity';

export function MemberDirectoryViews({area}: {area: 'members' | 'users'}) {
  return <nav className="member-directory-views" aria-label="Member directory views">
    {([['members', 'Group members'], ['users', 'All people']] as const).map(([value, label]) =>
      <a key={value} href={`#/admin/${value}`} aria-current={value === area ? 'page' : undefined}
        className={`admin-btn admin-btn--${value === area ? 'primary' : 'secondary'}`}>{label}</a>)}
  </nav>;
}

export function MemberDirectoryActions({user, identity}: {user: AdminUser; identity: PendingIdentity}) {
  const stableIdentity = usePendingIdentity(identity);
  const [pendingFor, setPendingFor] = useState<PendingIdentity | null>(null);
  const mayRecover = user.role !== 'staff' && user.permissions.includes('users.manage');
  useEffect(() => {
    if (!mayRecover) return;
    let current = true;
    const family = 'operating-createuser', resourceId = 'new';
    const ownedAttempt = readPending(stableIdentity, family, resourceId).then(Boolean).catch(() => false);
    const sharedAttempt = user.financialModel === 'transaction_journals'
      ? withPendingFence({identity: stableIdentity, family, resourceId, isCurrent: () => current},
          async access => access.read().kind === 'owned').catch(() => false)
      : false;
    void Promise.all([ownedAttempt, sharedAttempt]).then(([local, shared]) => {
      if (current) setPendingFor(local || shared ? stableIdentity : null);
    });
    return () => {current = false;};
  }, [stableIdentity, mayRecover, user.financialModel]);

  return <>
    {mayRecover && pendingFor === stableIdentity && <Link className="admin-btn admin-btn--secondary" to="/admin/users/new">Review pending person request</Link>}
    {canAddMember(user) && <Link className="admin-btn admin-btn--primary" to="/admin/members/new">Add member</Link>}
  </>;
}
