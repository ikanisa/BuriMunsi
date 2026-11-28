// Loopback browser fixture. Account changes use in-memory records only in explicit sign-in mode.
import {createServer} from 'node:http';
import {analyzeCanonicalPaymentRows,parsePaymentAnalysisQuery}
  from '../../../supabase/functions/_shared/domain/burimunsi/payment-analysis-shared.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {versionedStatic} from '../../../deploy/platform-admin/src/static-recovery.js';
import {standalonePrivacySupport} from '../../../supabase/functions/_shared/burimunsi-privacy-support.js';
import {createPaymentCommitFixture} from './payment-commit-fixture.mjs';
import {createPhoneAccountFixture, fixtureAdminId} from './phone-account-fixture.mjs';
import {fixtureMembers, fixtureMembership, fixtureMomoDetail, fixtureMomoRecord, fixtureOutgoingPayment, fixturePayment, fixtureSmsEvidenceId, fixtureOriginalSms, fixtureOriginalDigest,
  readBuriMunsiPayments, readMemberList, readMemberStatementFixture, readMomoList} from './operator-read-fixture.mjs';

const baseline = path.resolve(process.argv[2] ?? '');
let root = baseline;
if (!process.argv[2] || !(await fs.stat(root)).isDirectory()) throw new Error('Provide a candidate directory.');
if (process.argv[3]) {
  if (!process.send) throw new Error('Two-version fixture requires a private IPC channel.');
  const candidate = path.resolve(process.argv[3]);
  for (const artifact of [baseline, candidate]) {
    const meta = JSON.parse(await fs.readFile(path.join(artifact, 'version.json')));
    if (meta.backend !== 'unconfigured') throw new Error('Expected synthetic Admin artifacts.');
  }
  process.on('message', label => {
    if (label !== 'baseline' && label !== 'candidate') return;
    root = label === 'baseline' ? baseline : candidate;
    process.send(label);
  });
}
const port = Number(process.env.COLLECT_FIXTURE_PORT ?? 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid fixture port.');
const origin = `http://127.0.0.1:${port}`;
const counts = {users: 4, groups: 2, active_members: 4, payees: 2, transactions: 1, app_users: 3,
  direct_users: 1, admin_users: 1, staff_users: 1, active_payees: 2, unallocated_transactions: 1,
  ledger_entries: 0, reversed_entries: 0, payment_evidence: 1};
const amounts = {total_recorded_rwf: '5000', total_reconciled_rwf: '0', total_unallocated_rwf: '5000', total_net_contributions_rwf: '0'};
const labels = {users: 'Users', groups: 'Groups', active_members: 'Active members', payees: 'Payees',
  transactions: 'Transactions', app_users: 'App users', direct_users: 'Direct users', admin_users: 'Admin users',
  staff_users: 'Staff users', active_payees: 'Active payees', unallocated_transactions: 'Unallocated transactions',
  ledger_entries: 'Ledger entries', reversed_entries: 'Reversal entries', payment_evidence: 'Retained payment evidence',
  total_recorded_rwf: 'Recorded evidence amount', total_reconciled_rwf: 'Reconciled evidence amount',
  total_unallocated_rwf: 'Unallocated evidence amount', total_net_contributions_rwf: 'Net recorded contributions'};
const overview = {contract_version: 2, model: 'canonical_evidence_ledger', country_code: 'RW',
  measured_at: '2026-11-16T12:00:00.000Z', counts, amounts, contribution_basis: 'reconciled_evidence_entries',
  collected_basis: 'retained_received_evidence', reconciliations_available: true,
  metrics: Object.entries(labels).map(([key, label]) => ({key, label, status: 'measured', value: String(counts[key] ?? amounts[key])}))};
// Synthetic captures for reviewing the SMS layout; these never represent real
// messages, extracted facts, confirmed payments or provider settlement.
const smsCaptures = [
  ['11111111-1111-4111-8111-111111111111', '123456', 'Demo member A', 'received', '2026-11-16T10:00:00+02:00'],
  ['22222222-2222-4222-8222-222222222222', '234567', 'Demo member B', 'under_review', '2026-11-16T09:20:00+02:00'],
  ['33333333-3333-4333-8333-333333333333', '345678', 'Demo member C', 'received', '2026-11-15T17:45:00+02:00'],
].map(([id, public_id, display_name, status, received_at_device]) => {
  const received_at = Date.parse(received_at_device) / 1000;
  return {source_kind: 'capture', id, user_id: fixtureAdminId, payee_id: null, source_sha256: 'a'.repeat(64), status, version: 1,
    received_at, created_at: received_at, public_id, display_name, transaction_id: null, evidence_level: 'client_received',
    source_fact_id: null, parser_version: null, extraction_status: 'not_extracted', source_body_sha256: null, source_payload_sha256: null,
    parsed_at: null, payer_name: null, payer_phone: null, payer_masked_phone: null, payer_last3: null, payee_momo_number: null,
    payee_momo_code: null, momo_transaction_reference: null, momo_timestamp_local: null, momo_timezone_offset: null, amount_rwf: null,
    wallet_balance_rwf: null, network: null, direction: null, is_payment: null, transaction_reference: null,
    duplicate_reference_count: 0, conflicting_reference_count: 0, provider_confirmation: false, settlement_status: 'not_asserted',
    timezone_known: false, payer_last3_known: false, source_content_reveal_required: true, received_at_device};
});
const mime = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'};
function json(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders});
  response.end(JSON.stringify(body));
}

async function readFixtureBody(request) {
  const chunks = [];
  for await (const part of request) chunks.push(part);
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {return null;}
}

const phoneAccounts = createPhoneAccountFixture({cookieSignIn: process.env.COLLECT_FIXTURE_SIGN_IN === '1',
  legacySessionResponses: process.env.COLLECT_FIXTURE_LEGACY_SESSIONS === '1',
  lifetime: process.env.COLLECT_FIXTURE_LONG_EXPIRY === '1' ? 40 * 24 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000,
  json, readBody: readFixtureBody, startupHome: process.env.COLLECT_FIXTURE_SESSION_HOME === '1' ? homeFor : undefined});

// Only the pinned two-version browser rehearsal can enable this scoped
// in-memory side effect. The generic fixture API remains read-only.
const commitRehearsal = process.argv[4] === '--allocation-recovery';
if (process.argv[4] && (!commitRehearsal || !process.argv[3] || !process.send || process.env.COLLECT_FIXTURE_SIGN_IN !== '1')) {
  throw new Error('Allocation recovery requires the synthetic two-version sign-in fixture.');
}
const commitFixture = commitRehearsal ? createPaymentCommitFixture({
  payment:fixturePayment, member:fixtureMembers.rows[0], json, readBody:readFixtureBody
}) : null;

function homeFor(session) {
  const payments = phoneAccounts.hasPermission(session,'payments.read'), sms = phoneAccounts.hasPermission(session,'sms.read');
  return {paymentCount:payments ? 2 : 0, memberCount:1, unallocatedCount:payments ? 2 : 0,
    recentPayments:payments ? [fixturePayment,fixtureOutgoingPayment].map(item=>visiblePaymentFor(item,sms)) : [], asOf:fixturePayment.atRaw,
    ...(payments && {paymentTotals:{incomingRwf:'5000',outgoingRwf:'5000',...(sms && {latestSmsBalanceRwf:0})}})};
}

function visiblePaymentFor(item,sms) {
  return {...(commitFixture && item.id === fixturePayment.id ? commitFixture.readPayment() : item),sourceId:sms ? item.sourceId : null};
}
if (commitFixture) process.on('message', command => {
  if (command === 'allocation-evidence') process.send(commitFixture.evidence());
});

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', origin);
  if (url.origin !== origin) return json(response, 403, {error: {code: 'fixture_origin_denied'}});
  if (url.pathname === '/privacy' || url.pathname.startsWith('/privacy/')) {
    const privacy = standalonePrivacySupport(new Request(url, {method: request.method}));
    if (!privacy) return json(response, 404, {error: {code: 'not_found'}});
    response.writeHead(privacy.status, Object.fromEntries(privacy.headers));
    return response.end(await privacy.text());
  }
  if (process.env.COLLECT_FIXTURE_MISSING_ENTRY === '1' && /^\/_build\/[a-f0-9]{64}\/assets\/admin-entry\.js$/.test(url.pathname)) {
    const recovery = await versionedStatic(new Request(url, {method: request.method}), {fetch: async () =>
      new Response('<html>synthetic SPA fallback</html>', {headers: {'Content-Type': 'text/html'}})});
    response.writeHead(recovery.status, Object.fromEntries(recovery.headers));
    return response.end(await recovery.text());
  }
  if (url.pathname.startsWith('/api/')) {
    const session = phoneAccounts.current(request);
    if (url.pathname.startsWith('/api/admin/auth/') || /^\/api\/admin\/team(?:\/|$)/.test(url.pathname)) {
      return phoneAccounts.handle(request, response, url.pathname.slice('/api/admin/'.length), session);
    }
    if (commitFixture && await commitFixture.handle(request,response,url,session,phoneAccounts.hasPermission(session,'payments.read'))) return;
    const paymentAnalysis = request.method === 'POST' && url.pathname === '/api/admin/burimunsi/payments/analysis';
    if (!paymentAnalysis && request.method !== 'GET') return json(response, 405, {error: {code: 'fixture_read_only'}});
    if (!session) return json(response, 401, {error: {code: 'fixture_unauthorized'}});
    const payments = phoneAccounts.hasPermission(session, 'payments.read'), sms = phoneAccounts.hasPermission(session, 'sms.read');
    const visiblePayment = item => visiblePaymentFor(item,sms);
    if (url.pathname === '/api/admin/burimunsi/home') return json(response, 200, homeFor(session));
    if (url.pathname === '/api/admin/burimunsi/members/enrollment') {
      const canEnroll = ['users.manage','collections.manage'].every(permission => phoneAccounts.hasPermission(session,permission));
      return json(response, 200, {collectionId:'fixture-group', label:'Synthetic group', canEnroll});
    }
    if (paymentAnalysis) {
      if (!payments) return json(response,403,{error:{code:'forbidden'}});
      let query;
      try {if (url.search) throw new Error(); query=parsePaymentAnalysisQuery(await readFixtureBody(request),sms);}
      catch {return json(response,400,{error:{code:'invalid_fixture'}});}
      const q=query.q.toLowerCase();
      const base=[fixtureOutgoingPayment,fixturePayment].map(visiblePayment)
        .filter(item=>!q || `${item.ftId} ${item.payerNameRaw}`.toLowerCase().includes(q));
      const matches=analyzeCanonicalPaymentRows(base,query.filters,query.sort,sms);
      const sums={incoming:0n,outgoing:0n};
      for(const item of matches)sums[item.direction]+=BigInt(item.amountRwf);
      return json(response,200,{items:matches.slice(query.offset,query.offset+query.limit),totalCount:base.length,
        matchingCount:matches.length,offset:query.offset,limit:query.limit,missing:0,asOf:fixturePayment.atRaw,
        directionTotalsRwf:{incoming:String(sums.incoming),outgoing:String(sums.outgoing)}});
    }
    if (url.pathname === '/api/admin/burimunsi/payments') {
      if (!payments) return json(response, 403, {error:{code:'forbidden'}});
      if (url.searchParams.has('statement')) {
        if (!['users.read','collections.read'].every(permission => phoneAccounts.hasPermission(session,permission))) {
          return json(response,403,{error:{code:'forbidden'}});
        }
        const {status, body} = readMemberStatementFixture(url.searchParams);
        return json(response,status,body);
      }
      const result = readBuriMunsiPayments(url.searchParams, sms);
      return result ? json(response, 200, result) : json(response, 400, {error:{code:'invalid_fixture'}});
    }
    const evidencePayment = /^\/api\/admin\/burimunsi\/payments\/([A-Za-z0-9_-]+)\/sms-evidence$/.exec(url.pathname);
    if (evidencePayment) {
      if (!payments || !sms) return json(response,403,{error:{code:'forbidden'}});
      if (url.search) return json(response,400,{error:{code:'invalid_fixture'}});
      const paymentId=evidencePayment[1];
      return json(response,200,{paymentId,groupId:'fixture-group',evidence:paymentId===fixturePayment.id ?
        {requestId:fixturePayment.id,sourceId:fixtureSmsEvidenceId,admittedAt:fixturePayment.atRaw,retentionState:'retained',
          bodySha256:fixtureOriginalDigest,processing:'parsed',paymentReference:null,payerStatus:null,payerReason:null}:null});
    }
    if (url.pathname === `/api/admin/momo/observations/${fixtureSmsEvidenceId}/content`) {
      if (!sms || !phoneAccounts.hasPermission(session,'sms.reveal')) return json(response,403,{error:{code:'forbidden'}});
      const reason=request.headers['x-collect-review-reason'];
      if (url.searchParams.size !== 1 || url.searchParams.get('collectionId') !== fixturePayment.groupId ||
          typeof reason !== 'string' || reason.trim().length < 8 || reason.length > 500) return json(response,400,{error:{code:'invalid_fixture'}});
      return json(response,200,{contractVersion:1,collectionId:fixturePayment.groupId,sourceId:fixtureSmsEvidenceId,sourceKind:'observation',
        retentionState:'retained',rawSender:'Fixture M-Money',rawBody:fixtureOriginalSms,bodySha256:fixtureOriginalDigest});
    }
    const payment = [fixturePayment, fixtureOutgoingPayment].find(item => url.pathname === '/api/admin/burimunsi/payments/' + item.id);
    if (payment) return payments ? json(response, 200, visiblePayment(payment)) : json(response, 403, {error:{code:'forbidden'}});
    if (url.pathname === '/api/admin/momo/observations/collections') return sms ? json(response, 200, {
      contractVersion:1,asOf:fixturePayment.atRaw,items:[{collectionId:'fixture-group',label:'Synthetic group'}],
    }) : json(response, 403, {error:{code:'forbidden'}});
    if (url.pathname === '/api/admin/momo/observations') return sms ? json(response, 200, {
      contractVersion:1,collectionId:'fixture-group',nextCursor:null,asOf:fixturePayment.atRaw,
      inboxCheck:{state:'unknown',checkedAt:null,candidateCount:null,missingCount:null,pendingCount:null,headsMatch:null},
      items:[{requestId:fixturePayment.id,sourceId:fixtureSmsEvidenceId,admittedAt:fixturePayment.atRaw,retentionState:'retained',
        bodySha256:fixtureOriginalDigest,processing:'parsed',paymentReference:null,payerStatus:null,payerReason:null}],
    }) : json(response, 403, {error:{code:'forbidden'}});
    if (url.pathname === '/api/admin/core/overview') return json(response, 200, overview);
    if (['/api/admin/core/members', '/api/admin/core/users'].includes(url.pathname) || /^\/api\/admin\/operations\/(members|users)\//.test(url.pathname)) {
      if (!phoneAccounts.hasPermission(session, 'users.read')) return json(response, 403, {error: {code: 'forbidden'}});
      // This fixture grants the two collection-scoped roster reads. A generic person read cannot satisfy the walkthrough.
      if (url.pathname === '/api/admin/core/members' && url.searchParams.get('directory') === 'roster') {
        return json(response, 200, readMemberList(url.searchParams));
      }
      const member = fixtureMembers.rows.find(row => url.pathname === '/api/admin/operations/members/' + row.id);
      if (!member) return json(response, 403, {error: {code: 'expected_group_roster'}});
      let projection = {};
      const include = url.searchParams.get('include');
      if (include !== null) {
        if (url.searchParams.size !== 1 || !['balance','statement'].includes(include)) return json(response,400,{error:{code:'invalid_filter'}});
        if (!payments || !phoneAccounts.hasPermission(session,'collections.read')) return json(response,403,{error:{code:'forbidden'}});
        const {status,body} = readMemberStatementFixture(new URLSearchParams({statement:'1',memberId:member.id,offset:'0'}));
        if (status !== 200) return json(response,status,body);
        const {groupId,memberId,membershipId,closingRwf} = body;
        projection = include === 'statement' ? {member_statement:body} : {member_balance:{groupId,memberId,membershipId,closingRwf}};
      }
      return json(response, 200, {contract_version: 2, model: 'canonical_evidence_ledger', resource_type: 'members',
        current_actor_id: fixtureAdminId, can_manage: false, resource: member, related_truncated: false,
        related: {memberships: [fixtureMembership(member)]}, ...projection});
    }
    if (url.pathname === '/api/admin/momo/transactions' ||
        url.pathname === `/api/admin/momo/transactions/${fixtureMomoRecord.id}`) {
      if (!phoneAccounts.hasPermission(session, 'payments.read')) return json(response, 403, {error: {code: 'forbidden'}});
      const result = url.pathname === '/api/admin/momo/transactions' ? readMomoList(url.searchParams) : fixtureMomoDetail;
      return result ? json(response, 200, result) : json(response, 400, {error: {code: 'invalid_fixture'}});
    }
    if (url.pathname === '/api/admin/sms/receipts') {
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 25);
      if (!Number.isSafeInteger(offset) || offset < 0 || limit !== 25) return json(response, 400, {error: {code: 'invalid_fixture'}});
      const search = (url.searchParams.get('search') ?? '').toLowerCase(), status = url.searchParams.get('status') ?? '', kind = url.searchParams.get('source_kind') ?? '';
      const all = smsCaptures.filter(row => (!kind || row.source_kind === kind) && (!status || row.status === status) &&
        (!search || `${row.id} ${row.public_id} ${row.display_name}`.toLowerCase().includes(search)));
      const rows = all.slice(offset, offset + limit);
      return json(response, 200, {rows, total: all.length, limit, offset, next_offset: offset + rows.length < all.length ? offset + rows.length : null});
    }
    const smsDetail = url.pathname.match(/^\/api\/admin\/sms\/receipts\/capture\/([a-f0-9-]+)$/);
    if (smsDetail) {
      const row = smsCaptures.find(item => item.id === smsDetail[1]);
      if (!row) return json(response, 404, {error: {code: 'fixture_not_found'}});
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) return json(response, 400, {error: {code: 'invalid_fixture'}});
      return json(response, 200, {resource_type: 'sms_receipts', resource: row, current_actor_id: fixtureAdminId, can_extract: false,
        related: {duplicate_references: {rows: [], total: 0, limit: 25, offset, next_offset: null}}});
    }
    if (/^\/api\/admin\/core\/(?:groups|users|members|payees|transactions|ledgers)$/.test(url.pathname) || url.pathname === '/api/admin/operations/requests') {
      return json(response, 200, {contract_version: 2, model: 'canonical_evidence_ledger', rows: [], total: 0});
    }
    return json(response, 404, {error: {code: 'fixture_not_found'}});
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {response.writeHead(405); return response.end();}
  let relative;
  try {relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');} catch {response.writeHead(400); return response.end();}
  if (!relative || relative === 'index.html' || /^admin(?:\/[^.]*)?$/.test(relative)) relative = 'index.html';
  const selected = root;
  const target = path.resolve(selected, relative);
  if (!target.startsWith(`${selected}${path.sep}`)) {response.writeHead(403); return response.end();}
  try {
    const data = await fs.readFile(target);
    response.writeHead(200, {'Content-Type': mime[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store'});
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch {response.writeHead(404, {'Content-Type': 'text/plain', 'Cache-Control': 'no-store'}); response.end('Not found');}
}).listen(port, '127.0.0.1', () => console.log(`Synthetic Admin fixture listening on ${origin}`));
