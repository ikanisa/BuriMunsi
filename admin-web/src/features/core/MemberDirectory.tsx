type DirectoryArea = 'members' | 'users';
const views = [
  {area: 'members', label: 'Group members'},
  {area: 'users', label: 'All people'},
] as const;

export function MemberDirectoryViews({area}: {area: DirectoryArea}) {
  return <nav className="member-directory-views" aria-label="Member directory views">
    {views.map(view => <a key={view.area} href={`#/admin/${view.area}`}
      className={`admin-btn admin-btn--${view.area === area ? 'primary' : 'secondary'}`}
      aria-current={view.area === area ? 'page' : undefined}>{view.label}</a>)}
  </nav>;
}
