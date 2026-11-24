import {webcrypto} from 'node:crypto';
import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {MemoryRouter, Route, Routes} from 'react-router';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {AdminRequestError, type AdminRequest, type JsonObject} from '../../src/api/contracts';
import {AddMemberPage} from '../../src/features/core/AddMemberPage';
import {canAddMember} from '../../src/features/core/addMemberAccess';
import {ENROLLMENT_PATH, validateMember} from '../../src/features/core/memberEnrollment';
import {PENDING_KEY} from '../../src/features/core/pendingAttempt';
import type {AdminUser} from '../../src/session/sessionResponses';

const session = vi.hoisted(() => ({read: vi.fn()}));
vi.mock('../../src/session/SessionProvider', () => ({useSession: session.read}));
const id = '10000000-0000-4000-8000-000000000001', accountId = '20000000-0000-4000-8000-000000000002';
const collectionId = 'group-fixture', name = 'Amina Mugisha', phone = '+250788000100';
const user: AdminUser = {id, accountId, authMethod: 'phone_passcode', email: '', role: 'admin',
  sessionId: 'operator-session', principalId: 'operator-principal', financialModel: 'canonical_evidence_ledger',
  emailVerifiedAt: null, assuranceLevel: 1, mfaAt: null, expiresAt: '2100-01-01T00:00:00.000Z',
  permissions: ['users.read', 'users.manage', 'collections.manage'],
  adminIdentity: {schemaVersion: 1, adminId: id, accountId, principalId: 'operator-principal', role: 'admin', collectionId}};
const scope = {canEnroll: true, collectionId, label: 'BuriMunsi savings'};
const receipt = (requestId: unknown, extra: JsonObject = {}) => ({requestId, outcome: 'applied',
  member: {id: 'member-fixture', groupId: collectionId, name, phone, active: true, version: 1, balanceRwf: 0, ...extra}});
const confirmations = {verifiedOwnership: true, acceptedTerms: true, consentRecorded: true};

function open(request: AdminRequest, actor = user) {
  session.read.mockReturnValue({user: actor, request, epoch: 4, isCurrentAuthority: () => true});
  return render(<MemoryRouter initialEntries={['/admin/members/new']}><Routes>
    <Route path="/admin/members/new" element={<AddMemberPage />} />
    <Route path="/admin/members" element={<h1>Members directory</h1>} /></Routes></MemoryRouter>);
}
async function fields(fullName = name, number = '0788 000 100') {
  fireEvent.change(await screen.findByLabelText('Registered MoMo name'), {target: {value: fullName}});
  fireEvent.change(screen.getByLabelText('MoMo phone number'), {target: {value: number}});
}
function confirm() {
  for (const checkbox of screen.getAllByRole('checkbox')) {
    if (!(checkbox as HTMLInputElement).checked) fireEvent.click(checkbox);
  }
}
async function enter() {await fields(); confirm(); fireEvent.click(screen.getByRole('button', {name: 'Save member'}));}

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', {value: webcrypto, configurable: true});
  sessionStorage.clear();
});

describe('Add member', () => {
  it('requires an internal phone identity and both actual shared write grants', () => {
    expect(canAddMember(user)).toBe(true);
    for (const actor of [{...user, permissions: ['users.read', 'users.manage']},
      {...user, permissions: ['users.read', 'collections.manage']}, {...user, authMethod: undefined},
      {...user, adminIdentity: {...user.adminIdentity!, accountId: id}}]) expect(canAddMember(actor)).toBe(false);
    const request = vi.fn<AdminRequest>();
    open(request, {...user, role: 'staff', adminIdentity: null});
    expect(screen.getByText('Your account cannot add members to this group.')).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses access when the live operator has no enrollment approval or the collection differs', async () => {
    const denied = open(async () => ({...scope, canEnroll: false}));
    expect(await screen.findByText('Your account cannot add members to this group.')).toBeInTheDocument();
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    denied.unmount();
    open(async () => ({...scope, collectionId: 'other-group'}));
    expect(await screen.findByText('Member form unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Save member'})).not.toBeInTheDocument();
  });

  it('validates the name, Rwanda MoMo formats and required member confirmations before writing', async () => {
    const request = vi.fn<AdminRequest>().mockResolvedValue(scope);
    open(request);
    await fields('X', 'abc0788000100');
    fireEvent.click(screen.getByRole('button', {name: 'Save member'}));
    expect(screen.getByLabelText('Registered MoMo name')).toHaveFocus();
    expect(screen.getByText(/Enter a valid Rwanda MoMo number/)).toBeInTheDocument();
    await fields();
    fireEvent.click(screen.getByRole('button', {name: 'Save member'}));
    expect(screen.getByRole('checkbox', {name: /confirmed who owns/})).toHaveFocus();
    expect(screen.getByText(/Confirm each statement/)).toBeInTheDocument();
    expect(request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    expect(validateMember({name: 'A\nB', phone}).errors.name).toBeTruthy();
    for (const number of ['788000100', '250788000100', '00 250 (788) 000-100', phone]) {
      expect(validateMember({name, phone: number})).toEqual({errors: {}, name, phone});
    }
  });

  it('submits one canonical request, shows the real member, and returns to Members', async () => {
    const request = vi.fn<AdminRequest>(async (_path, options) => options?.method === 'POST' ? receipt(options.idempotencyKey) : scope);
    open(request);
    await fields(' ' + name + ' '); confirm();
    const save = screen.getByRole('button', {name: 'Save member'}); fireEvent.click(save); fireEvent.click(save);
    expect(await screen.findByText('Member confirmed')).toBeInTheDocument();
    const writes = request.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(writes).toHaveLength(1);
    const [path, options] = writes[0];
    expect(path).toBe(ENROLLMENT_PATH); expect(options?.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
    expect(options?.body).toEqual({requestId: options?.idempotencyKey, name, phone, ...confirmations});
    expect(screen.getByText(name + ' · ' + phone)).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument(); expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    fireEvent.click(screen.getByRole('link', {name: 'Back to Members'}));
    expect(screen.getByRole('heading', {name: 'Members directory'})).toBeInTheDocument();
  });

  it('recovers an ambiguous save after reload without persisting the member details or sending another POST', async () => {
    let key: string | undefined;
    const request = vi.fn<AdminRequest>(async (path, options) => {
      if (options?.method === 'POST') {key = options.idempotencyKey; throw new AdminRequestError('Connection lost', {outcomeUnknown: true});}
      if (key && path === ENROLLMENT_PATH + '/requests/' + key) return receipt(key, {name: 'Existing member name', active: false, version: 3});
      return scope;
    });
    const first = open(request); await enter();
    expect(await screen.findByText(/The save could not be confirmed/)).toBeInTheDocument();
    const saved = sessionStorage.getItem(PENDING_KEY)!;
    expect(saved).toContain(key); expect(saved).not.toContain(name); expect(saved).not.toContain(phone);
    first.unmount(); open(request);
    fireEvent.click(await screen.findByRole('button', {name: 'Check request'}));
    expect(await screen.findByText('Member confirmed')).toBeInTheDocument();
    expect(screen.getByText('Existing member name · ' + phone)).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('retries only the original name and number after an explicit missing receipt', async () => {
    const writes: JsonObject[] = []; let key: string | undefined;
    const request: AdminRequest = async (path, options) => {
      if (options?.method === 'POST') {
        key = options.idempotencyKey; writes.push(options.body!);
        if (writes.length === 1) throw new Error('Connection lost');
        return receipt(key);
      }
      return path === ENROLLMENT_PATH ? scope : {requestId: key, outcome: 'not_found'};
    };
    const first = open(request); await enter();
    await screen.findByText(/The save could not be confirmed/); first.unmount(); open(request);
    fireEvent.click(await screen.findByRole('button', {name: 'Check request'}));
    await screen.findByText(/No completed request was found/);
    await fields('Another member'); confirm();
    fireEvent.click(screen.getByRole('button', {name: 'Retry original request'}));
    expect(await screen.findByText(/Use the same registered name/)).toBeInTheDocument(); expect(writes).toHaveLength(1);
    await fields(); confirm(); fireEvent.click(screen.getByRole('button', {name: 'Retry original request'}));
    await screen.findByText('Member confirmed'); expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  });

  it('retains the original request if a returned receipt has the wrong number or key', async () => {
    const request: AdminRequest = async (path, options) => {
      if (options?.method === 'POST') return receipt(options.idempotencyKey, {phone: '+250788000101'});
      return path === ENROLLMENT_PATH ? scope : {requestId: 'unrelated-key', outcome: 'not_found'};
    };
    open(request); await enter();
    await screen.findByText(/The save could not be confirmed/);
    fireEvent.click(screen.getByRole('button', {name: 'Check request'}));
    await screen.findByText(/The original request could not be checked/);
    expect(sessionStorage.getItem(PENDING_KEY)).not.toBeNull();
    expect(screen.queryByRole('button', {name: 'Retry original request'})).not.toBeInTheDocument();
  });

  it('keeps a correctable rejection editable and invalidates attestations when the member changes', async () => {
    const request: AdminRequest = async (_, options) => {
      if (options?.method === 'POST') throw new AdminRequestError('Conflicting number', {statusCode: 409, code: 'duplicate_phone'});
      return scope;
    };
    open(request); await enter();
    expect(await screen.findByText(/That number matches conflicting records/)).toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    fireEvent.change(screen.getByLabelText('MoMo phone number'), {target: {value: '0788000102'}});
    await waitFor(() => expect(screen.getAllByRole('checkbox', {checked: false})).toHaveLength(3));
  });
});
