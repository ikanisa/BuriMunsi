import {useEffect, useState, type ComponentType} from 'react';
import {LoadingState} from '../../ui';

// Keep the module split without delaying its first render after the import resolves.
// The authorized outlet owns the loader; the only shared state is the page module.
export function loadWorkspacePage<Props extends object>(load: () => Promise<ComponentType<Props>>) {
  type Page = {Component: ComponentType<Props>} | {error: unknown};
  let pending: Promise<Page> | undefined;
  let loaded: Page | null = null;

  return function WorkspacePage(props: Props) {
    const [page, setPage] = useState(() => loaded);
    useEffect(() => {
      if (page !== null) return;
      let active = true;
      pending ??= load().then(Component => loaded = {Component}, error => loaded = {error});
      void pending.then(result => {if (active) setPage(result);});
      return () => {active = false;};
    }, [page]);

    if (page === null) return <LoadingState label="Opening workspace" />;
    if ('error' in page) throw page.error;
    return <page.Component {...props} />;
  };
}
