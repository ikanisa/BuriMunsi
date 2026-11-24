import {Link, useSearchParams} from 'react-router';
import {ErrorState, PageHeader} from '../../ui';
import {useSession} from '../../session/SessionProvider';
import {canDisplaySessionRecords} from '../../session/sessionContext';
import {CoreListPage} from '../core/CoreListPage';
import type {FeatureAccess} from '../core/types';
import {ReconciliationQueuePage} from '../reconciliation/ReconciliationQueuePage';
import {MemberReceiptsPage} from './MemberReceiptPages';
import {UploadedSms} from './MomoIncomingSms';
import {WorkspaceMomoTransactionList} from './MomoTransactionList';
import {ReceiverSmsPanel} from './ReceiverSmsPanel';
import {canOpenPaymentView, canOpenReceiptSource, paymentViewLocation, paymentViews, receiptSources} from './paymentLocations';
import './operations.css';
import './paymentsWorkspace.css';

const denied = <ErrorState title="Access unavailable" message="Your current account cannot open this view." />;

export function PaymentsWorkArea(access: FeatureAccess) {
  const session = useSession(), [params] = useSearchParams();
  // Reuse the session presentation fence and keep each child under its own read permission.
  const permissions = canDisplaySessionRecords(session) ? access.permissions : [];
  const views = paymentViews.filter(({id}) => canOpenPaymentView(id, permissions));
  const requested = params.get('view');
  const view = views.find(({id}) => id === requested) ?? (requested === null ? views[0] : undefined);
  const sources = receiptSources.filter(({id}) => canOpenReceiptSource(id, permissions));
  const sourceParam = params.get('source');
  const source = sources.find(({id}) => id === sourceParam) ?? (sourceParam === null
    ? sources.find(({id}) => id === (session.user?.authMethod === 'phone_passcode' ? 'android' : 'app')) ?? sources[0]
    : undefined);
  const momo = params.get('dataset') === 'momo';
  const invalidDataset = params.has('dataset') && !['collect', 'momo'].includes(params.get('dataset') ?? '');
  const invalidSelector = params.getAll('view').length > 1 || params.getAll('source').length > 1 || params.getAll('dataset').length > 1;

  return <section className="payments-workspace" key={access.authorityKey}>
    <PageHeader title="Payments" />
    {views.length > 1 && <nav className="payments-nav" aria-label="Payment views">
      {views.map(({id, label}) => <Link key={id} to={paymentViewLocation(id)} aria-current={view?.id === id ? 'page' : undefined}>{label}</Link>)}
    </nav>}
    {!view || invalidSelector ? denied : view.id === 'recorded' ? <>
      <nav className="payments-nav payments-sources" aria-label="Recorded payment sources">
        <Link to={paymentViewLocation('recorded')} aria-current={!momo && !invalidDataset ? 'page' : undefined}>Payment records</Link>
        <Link to={paymentViewLocation('recorded', {momo: true})} aria-current={momo ? 'page' : undefined}>MoMo transactions</Link>
      </nav>
      {invalidDataset ? denied : momo ? <WorkspaceMomoTransactionList /> :
        <CoreListPage {...access} area="transactions" locationSearch={params.toString()} paymentsWorkspace />}
      {permissions.includes('ledger.read') && <p className="operations-note"><Link to="/admin/ledgers">Ledger and reversals history</Link></p>}
    </> : view.id === 'sms' ? <>
      <nav className="payments-nav payments-sources" aria-label="Receipt sources">
        {sources.map(({id, label}) => <Link key={id} to={paymentViewLocation('sms', {source: id})}
          aria-current={source?.id === id ? 'page' : undefined}>{label}</Link>)}
      </nav>
      <p className="operations-note">SMS and receipts are evidence. Capture, parsing, crediting and settlement are separate outcomes.</p>
      {!source ? denied : source.id === 'android' ? <ReceiverSmsPanel /> : source.id === 'app' ?
        <UploadedSms paymentsWorkspace /> : <MemberReceiptsPage paymentsWorkspace />}
      {permissions.includes('sms.read') && <p className="operations-note"><Link to="/admin/sms-receipts">Full SMS records and source filters</Link></p>}
    </> : <ReconciliationQueuePage {...access} locationSearch={params.toString()} paymentsWorkspace />}
  </section>;
}
