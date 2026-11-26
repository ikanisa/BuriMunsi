import {Card, StatusBadge} from '../../ui';
import {directoryOperatorRows, type BuriDirectory, type BuriProvisioning} from './contracts';
import {BURI_CAPABILITIES} from './operatorPreparation';

const accountStatuses = {active: 'Account active', invited: 'Account invited', revoked: 'Account revoked'} as const;

export function BuriDirectoryView({directory, provisioning, provisioningError, phoneAccounts = false}: {
  directory: BuriDirectory;
  provisioning: BuriProvisioning | null;
  provisioningError: boolean;
  phoneAccounts?: boolean;
}) {
  const operators = directoryOperatorRows(directory);
  return <>
    <Card><div className="core-detail">
      <h2>{phoneAccounts ? 'BuriMunsi operators' : 'Collect operators'}</h2>
      {!directory.configured && <p>{phoneAccounts ? 'BuriMunsi group access needs to be configured.' :
        'The BuriMunsi group and receiving account need to be configured before approving access.'}</p>}
      {operators.length === 0 ? <p>{phoneAccounts ? 'No operators in this group.' : 'No Collect accounts or approvals are recorded for this group.'}</p> :
        <div className="admin-table-wrap" role="region" aria-label="BuriMunsi operator records" tabIndex={0}>
          <table className="admin-table">
            <thead><tr><th scope="col">Account</th><th scope="col">{phoneAccounts ? 'Role' : 'Collect role'}</th><th scope="col">BuriMunsi access</th><th scope="col">{phoneAccounts ? 'Allowed actions' : 'Capabilities'}</th></tr></thead>
            <tbody>{operators.map(({operator, approval}) => <tr key={operator.principalId}>
              <td>{phoneAccounts ? <>{operator.displayName || approval?.phone || operator.principalId}{operator.displayName && approval?.phone && <><br />{approval.phone}</>}</> :
                <>{operator.displayName || operator.email}<br />{operator.email}</>}</td>
              <td>{phoneAccounts ? (approval ? (approval.role === 'admin' ? 'Admin' : 'Staff') : 'Unassigned') : operator.role}</td>
              <td>{approval && phoneAccounts ? <><StatusBadge tone={approval.active ? 'success' : 'warning'}>{approval.active ? 'Enabled' : 'Disabled'}</StatusBadge>
                <br />{accountStatuses[approval.sharedStatus]}</> : approval ? <>
                <StatusBadge tone={approval.active ? 'success' : 'warning'}>{approval.active ? 'Recorded enabled' : 'Recorded disabled'}</StatusBadge>
                <br />{approval.role} · {approval.phone}<br />Collect status: {approval.sharedStatus}
              </> : 'No approval recorded'}</td>
              <td>{approval ? (phoneAccounts ? BURI_CAPABILITIES.filter(([key]) => approval.capabilities.includes(key)).map(([,label]) => label) : approval.capabilities).join(', ') : '—'}</td>
            </tr>)}</tbody>
          </table>
        </div>}
    </div></Card>
    <Card><div className="core-detail">
      <h2>{phoneAccounts ? 'Android app access' : 'Native app access'}</h2>
      {provisioningError ? <p role="alert">Native setup could not be verified. Refresh before continuing.</p> : provisioning && <>
        {phoneAccounts ? !provisioning.configured && <p>Android app setup is incomplete.</p> :
          <p>Recorded scope: {provisioning.scopeEnabled ? 'enabled' : 'not enabled'} · {provisioning.configured ? 'configured' : 'not configured'}.</p>}
        {provisioning.accounts.length === 0 ? <p>No approved native accounts are recorded.</p> : <>
          <h3>Accounts</h3>
          <ul>{provisioning.accounts.map(account => <li key={account.principalId}>{account.name || account.phone} · {account.role} · {account.approved ? 'approval current' : 'approval not current'} · {account.active && !account.removed ? 'recorded active' : 'not active'}</li>)}</ul>
        </>}
        {provisioning.grants.length === 0 ? <p>No installation grants are recorded.</p> : <>
          <h3>Installation grants</h3>
          <ul>{provisioning.grants.map(grant => <li key={grant.id}>{grant.installationId} · {phoneAccounts ? (grant.profile === 'internal_receiver' ? 'Receiving phone' : 'Staff') : grant.profile} · {grant.active ? 'recorded active' : 'recorded inactive'} · version {grant.version}</li>)}</ul>
        </>}
        {!phoneAccounts && <p>A recorded grant does not confirm physical device possession, carrier delivery or payment settlement.</p>}
      </>}
    </div></Card>
  </>;
}
