import {useEffect, useState} from 'react';
import {observeAdminWorkerUpdate} from '../pwa-registration';
import {Card} from '../ui';

export function AdminUpdateNotice() {
  const [waiting, setWaiting] = useState(false);
  useEffect(() => observeAdminWorkerUpdate(setWaiting), []);
  if (!waiting) return null;
  return <Card role="status" className="admin-previous-service">
    <strong>Admin update ready.</strong>{' '}
    Finish open work. Open <code>about:blank</code> in every Admin tab and close any installed Admin windows.
    Reopen Admin in the same browser tabs.
  </Card>;
}
