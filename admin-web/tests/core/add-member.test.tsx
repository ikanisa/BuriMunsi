import {webcrypto} from 'node:crypto';
import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {MemoryRouter, Route, Routes} from 'react-router';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {AdminRequestError, type AdminRequest, type JsonObject} from '../../src/api/contracts';
import {AddMemberPage} from '../../src/features/core/AddMemberPage';
import {canAddMember} from '../../src/features/core/addMemberAccess';
import {ENROLLMENT_PATH, validateMember} from '../../src/features/core/memberEnrollment';
import {disclosureVersion, IMPORT_PATH, SUGGESTIONS_PATH} from '../../src/features/core/memberRoster';
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
  fireEvent.change(screen.getByRole('textbox', {name: 'Mobile number'}), {target: {value: number}});
}
async function manual() {fireEvent.click(await screen.findByRole('button', {name:'Add manually'}));}
function review() {fireEvent.click(screen.getByRole('button', {name:'Review member'}));}
async function enter() {
  await manual(); await fields(); review(); fireEvent.click(screen.getByRole('button', {name:'Confirm and save'}));
}

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

  it('collects one mobile number and validates its Rwanda format and all confirmations before writing', async () => {
    const request = vi.fn<AdminRequest>().mockResolvedValue(scope);
    open(request);
    await manual(); await fields('X', 'abc0788000100');
    expect(screen.getAllByRole('textbox').filter(field => field.getAttribute('type') === 'tel')).toHaveLength(1);
    expect(screen.queryByRole('textbox', {name: /MoMo.*number/i})).not.toBeInTheDocument();
    review();
    expect(screen.getByLabelText('Registered MoMo name')).toHaveFocus();
    expect(screen.getByText(/Enter a valid Rwanda mobile number/)).toBeInTheDocument();
    await fields();
    review();
    expect(screen.getByRole('button', {name:'Confirm and save'})).toHaveAccessibleDescription(/verified ownership.*accepted.*terms.*recorded.*privacy consent/);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    expect(validateMember({name: 'A\nB', phone}).errors.name).toBeTruthy();
    for (const number of ['788000100', '250788000100', '00 250 (788) 000-100', phone]) {
      expect(validateMember({name, phone: number})).toEqual({errors: {}, name, phone});
    }
  });

  it('submits one canonical request, shows the real member, and returns to Members', async () => {
    const request = vi.fn<AdminRequest>(async (_path, options) => options?.method === 'POST' ? receipt(options.idempotencyKey) : scope);
    open(request);
    await manual(); await fields(' ' + name + ' '); review();
    const save = screen.getByRole('button', {name: 'Confirm and save'}); fireEvent.click(save); fireEvent.click(save);
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
    await fields('Another member'); review();
    fireEvent.click(screen.getByRole('button', {name: 'Retry original request'}));
    expect(await screen.findByText(/Use the same registered name/)).toBeInTheDocument(); expect(writes).toHaveLength(1);
    await fields(); review(); fireEvent.click(screen.getByRole('button', {name: 'Retry original request'}));
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
    fireEvent.change(screen.getByRole('textbox', {name: 'Mobile number'}), {target: {value: '0788000102'}});
    expect(screen.queryByRole('button', {name:'Confirm and save'})).not.toBeInTheDocument();
    review();
    expect(screen.getByText('+250788000102')).toBeInTheDocument();
  });
});

const previewRow = (row: number, momoName = name, momoNumber = phone) => ({
  row, momoName, momoNumber, selected:true, status:'ready', issue:null,
});
async function selectFile(file: File, openPicker = true) {
  if (openPicker) fireEvent.click(await screen.findByRole('button', {name:'Import member list'}));
  fireEvent.change(screen.getByLabelText('Roster file'), {target:{files:[file]}});
}
const csv = () => new File(['Name,Phone\n' + name + ',' + phone], 'members.csv', {type:'text/csv'});
async function previewCsv() {
  await selectFile(csv()); fireEvent.click(screen.getByRole('button', {name:'Preview file'}));
  await screen.findByRole('heading', {name:'Review extracted members'});
}
async function approveRow(n: number) {
  fireEvent.click(await screen.findByRole('button', {name:'Review row ' + n})); review();
  fireEvent.click(screen.getByRole('button', {name:'Confirm reviewed row'}));
}
const appliedImport = (requestId: unknown) => ({requestId,created:1,results:[{row:1,status:'created',memberId:'member-one'}]});
const candidate = {id:'candidate-one',candidateId:'candidate-one',groupId:collectionId,momoName:name,last3:'100',
  latestSeenAt:'2026-11-26T05:00:00Z',sourceCount:2};
const candidates = {items:[candidate],nextCursor:null,revision:'r1',totalCount:1,asOf:'2026-11-26T05:00:00Z'};

describe('Android member entry paths on the web', () => {
  it('offers five native methods, and camera and photo pickers never upload on selection', async () => {
    const request = vi.fn<AdminRequest>().mockResolvedValue(scope); open(request);
    for (const method of ['Suggested from MoMo','Add manually','Take a photo of the list','Choose a photo','Import member list']) {
      expect(await screen.findByRole('button', {name:method})).toBeInTheDocument();
    }
    const picker = vi.spyOn(HTMLInputElement.prototype, 'click');
    fireEvent.click(screen.getByRole('button', {name:'Take a photo of the list'}));
    expect(picker.mock.instances).toContain(screen.getByLabelText('Roster photo'));
    picker.mockRestore();
    expect(screen.getByLabelText('Roster photo')).toHaveAttribute('capture','environment');
    const image = new File(['synthetic PNG'], 'list.png', {type:'image/png'});
    fireEvent.change(screen.getByLabelText('Roster photo'), {target:{files:[image]}});
    expect(screen.getByRole('button', {name:'Send to OpenAI for preview'})).toHaveAccessibleDescription(/Sending this file to OpenAI/);
    fireEvent.click(screen.getByRole('button', {name:'Back'}));
    fireEvent.click(screen.getByRole('button', {name:'Choose a photo'}));
    expect(screen.getByLabelText('Roster photo')).not.toHaveAttribute('capture');
    expect(screen.queryByRole('button', {name:'Send to OpenAI for preview'})).not.toBeInTheDocument();
    expect(request.mock.calls.some(([,options])=>options?.method === 'POST')).toBe(false);
  });

  it('previews CSV, edits and excludes rows, and imports only explicitly reviewed identities', async () => {
    const request = vi.fn<AdminRequest>(async (path,options) => {
      if (path === IMPORT_PATH + '/preview') return {sourceKind:'csv',rows:[previewRow(1),previewRow(2,'Other Member','+250788000200')]};
      if (path === IMPORT_PATH) return appliedImport(options?.idempotencyKey);
      return scope;
    });
    open(request); await previewCsv();
    expect(request.mock.calls.find(([path])=>path === IMPORT_PATH + '/preview')?.[1]?.body).toEqual({
      mimeType:'text/csv',fileBytes:btoa('Name,Phone\n' + name + ',' + phone),externalOcrConsent:false,
    });
    expect(screen.getByRole('button', {name:'Register verified members (0)'})).toBeDisabled();
    await approveRow(1); await approveRow(2);
    fireEvent.click(screen.getByRole('button',{name:'Exclude row 2'}));
    fireEvent.click(screen.getByRole('button',{name:'Edit row 1'}));
    fireEvent.change(screen.getByLabelText('Registered MoMo name'),{target:{value:'Corrected Name'}});
    review(); fireEvent.click(screen.getByRole('button',{name:'Edit details'}));
    expect(screen.queryByRole('button',{name:'Confirm reviewed row'})).not.toBeInTheDocument();
    review(); fireEvent.click(screen.getByRole('button',{name:'Confirm reviewed row'}));
    const submit = screen.getByRole('button',{name:'Register verified members (1)'}); fireEvent.click(submit); fireEvent.click(submit);
    expect(await screen.findByRole('heading',{name:'Import results'})).toBeInTheDocument();
    const writes = request.mock.calls.filter(([path])=>path === IMPORT_PATH); expect(writes).toHaveLength(1);
    const options = writes[0][1];
    expect(options?.body).toEqual({requestId:options?.idempotencyKey,rows:[{row:1,name:'Corrected Name',phone,...confirmations}]});
    expect(screen.getByText('1 registered · 1 reviewed')).toBeInTheDocument(); expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('requests fresh per-file OCR approval, reuses an uncertain flow only for the same file, and explains provider unavailability', async () => {
    const request = vi.fn<AdminRequest>(async path => {
      if (path === IMPORT_PATH + '/preview') throw new AdminRequestError('Unavailable', {code:'smart_import_ocr_unavailable',statusCode:503,outcomeUnknown:true});
      return scope;
    });
    open(request);
    const pdf = new File(['%PDF-1.4 fixture'], 'roster.pdf', {type:'application/pdf'});
    await selectFile(pdf);
    expect(request.mock.calls.some(([path])=>path === IMPORT_PATH + '/preview')).toBe(false);
    const send = () => fireEvent.click(screen.getByRole('button', {name:'Send to OpenAI for preview'}));
    send(); await screen.findByText(/Try a CSV file or add the member manually/);
    const before = request.mock.calls.find(([path])=>path === IMPORT_PATH + '/preview')?.[1]?.body;
    expect(before).toMatchObject({mimeType:'application/pdf',fileBytes:btoa('%PDF-1.4 fixture'),
      externalOcrConsent:true, ocrDisclosureVersion:disclosureVersion, importFlowId:expect.stringMatching(/^[\da-f-]{36}$/)});
    send(); await screen.findByText(/Try a CSV file or add the member manually/);
    await selectFile(new File(['%PDF-1.4 other'], 'new.pdf', {type:'application/pdf'}), false);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(request.mock.calls.filter(([path])=>path === IMPORT_PATH + '/preview')).toHaveLength(2);
    send(); await screen.findByText(/Try a CSV file or add the member manually/);
    const calls = request.mock.calls.filter(([path])=>path === IMPORT_PATH + '/preview');
    expect(calls[1][1]?.body).toEqual(before); expect(calls[2][1]?.body?.importFlowId).not.toBe(before?.importFlowId);
    expect(request.mock.calls.some(([path])=>path === IMPORT_PATH)).toBe(false); expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('uses group-bound suggestions, requires the entire matching number and submits the recorded candidate', async () => {
    const request = vi.fn<AdminRequest>(async (path,options) => {
      if (path.startsWith(SUGGESTIONS_PATH + '?')) return candidates;
      if (path === IMPORT_PATH) return appliedImport(options?.idempotencyKey);
      return scope;
    });
    open(request); fireEvent.click(await screen.findByRole('button', {name:'Suggested from MoMo'}));
    await screen.findByRole('button', {name:/Amina Mugisha/});
    fireEvent.change(screen.getByLabelText('Name or last three digits'), {target:{value:'100'}});
    fireEvent.click(screen.getByRole('button',{name:'Search'}));
    fireEvent.click(await screen.findByRole('button', {name:/Amina Mugisha/}));
    expect(screen.getByRole('textbox',{name:'Mobile number'})).toHaveValue('');
    await fields(name,'+250788000101'); review(); expect(screen.getByText('The full number must end in 100.')).toBeInTheDocument();
    await fields(); review(); fireEvent.click(screen.getByRole('button',{name:'Confirm reviewed row'}));
    fireEvent.click(screen.getByRole('button',{name:'Register verified members (1)'}));
    await screen.findByRole('heading',{name:'Import results'});
    const rows = request.mock.calls.find(([path])=>path===IMPORT_PATH)?.[1]?.body?.rows;
    expect(rows).toEqual([{row:1,name,phone,...confirmations,candidateId:'candidate-one'}]);
    expect(request.mock.calls.some(([path])=>path===SUGGESTIONS_PATH+'?q=100&limit=40')).toBe(true);
  });

  it('rejects foreign-group suggestions and any preview that does not describe the chosen source', async () => {
    const request = vi.fn<AdminRequest>(async path => {
      if (path.startsWith(SUGGESTIONS_PATH)) return {...candidates,items:[{...candidate,groupId:'other'}]};
      if (path === IMPORT_PATH + '/preview') return {sourceKind:'pdf',rows:[previewRow(1)]};
      return scope;
    });
    open(request); fireEvent.click(await screen.findByRole('button',{name:'Suggested from MoMo'}));
    await screen.findByText('Suggestions unavailable'); expect(screen.queryByText(name)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Back'})); await selectFile(csv()); fireEvent.click(screen.getByRole('button',{name:'Preview file'}));
    await screen.findByRole('alert'); expect(screen.queryByRole('list',{name:'Roster rows'})).not.toBeInTheDocument();
    expect(request.mock.calls.some(([path])=>path===IMPORT_PATH)).toBe(false);
  });

  it('recovers an uncertain batch after reload by original reference without storing roster data or resending it', async () => {
    let key: string | undefined;
    const request = vi.fn<AdminRequest>(async (path,options) => {
      if (path === IMPORT_PATH + '/preview') return {sourceKind:'csv',rows:[previewRow(1)]};
      if (path === IMPORT_PATH) {key=options?.idempotencyKey; throw new Error('Connection ended');}
      if (path === IMPORT_PATH + '/requests/' + key) return appliedImport(key);
      return scope;
    });
    const first = open(request); await previewCsv(); await approveRow(1);
    fireEvent.click(screen.getByRole('button',{name:'Register verified members (1)'}));
    await screen.findByText(/The import could not be confirmed/);
    const saved = sessionStorage.getItem(PENDING_KEY)!;
    expect(saved).toContain(key); for (const privateText of [name, phone, 'members.csv']) expect(saved).not.toContain(privateText);
    first.unmount(); open(request); fireEvent.click(await screen.findByRole('button',{name:'Check import request'}));
    await screen.findByRole('heading',{name:'Import results'}); expect(request.mock.calls.filter(([path])=>path===IMPORT_PATH)).toHaveLength(1);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });
});

describe('roster import outcomes', () => {
  it('retains the individual results and correct created count for partially applicable verified rows', async () => {
    const request = vi.fn<AdminRequest>(async (path, options)=>{
      if (path === IMPORT_PATH + '/preview') return {sourceKind:'csv',rows:[previewRow(1),previewRow(2,'Second member','+250788000102')]};
      if (path === IMPORT_PATH) return {requestId:options?.idempotencyKey, created:1,
        results:[{row:1,status:'already_registered',memberId:'existing'},{row:2,status:'created',memberId:'new'}]};
      return scope;
    });
    open(request); await previewCsv(); await approveRow(2); await approveRow(1);
    fireEvent.click(screen.getByRole('button',{name:'Register verified members (2)'}));
    await screen.findByText('1 registered · 2 reviewed'); expect(screen.getByText('Already registered')).toBeInTheDocument();
    expect(screen.getByText('Registered')).toBeInTheDocument();
    expect((request.mock.calls.find(([path])=>path===IMPORT_PATH)?.[1]?.body?.rows as {row:number}[]).map(r=>r.row)).toEqual([1,2]);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('rebuilds an explicitly missing import only with the original reviewed values and idempotency key', async () => {
    const writes: JsonObject[] = []; let returnedRows = [previewRow(1)], key: string | undefined;
    const request = vi.fn<AdminRequest>(async (path,options)=>{
      if (path === IMPORT_PATH + '/preview') return {sourceKind:'csv', rows:returnedRows};
      if (path === IMPORT_PATH) {
        writes.push(options!.body!); key = options?.idempotencyKey;
        if (writes.length===1) return {requestId:key,created:1,results:[{row:2,status:'created',memberId:'wrong-row'}]};
        return appliedImport(key);
      }
      if (path === IMPORT_PATH + '/requests/' + key) return {requestId:key,outcome:'not_found'};
      return scope;
    });
    const first = open(request); await previewCsv(); await approveRow(1);
    fireEvent.click(screen.getByRole('button',{name:'Register verified members (1)'})); await screen.findByText(/The import could not be confirmed/);
    first.unmount(); open(request);
    fireEvent.click(await screen.findByRole('button',{name:'Check import request'})); await screen.findByText(/No completed import was found/);
    returnedRows = [previewRow(1, 'Unrelated name')]; await previewCsv(); await approveRow(1);
    fireEvent.click(screen.getByRole('button',{name:'Retry original import'})); await screen.findByText(/Use the same rows/);
    expect(writes).toHaveLength(1);
    fireEvent.click(screen.getByRole('button',{name:'Edit row 1'})); await fields(); review();
    fireEvent.click(screen.getByRole('button',{name:'Confirm reviewed row'}));
    fireEvent.click(screen.getByRole('button',{name:'Retry original import'}));
    await screen.findByText('Import results'); expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  });

  it('ignores a late OCR preview after the operator picks a different file, and reports a legitimate empty result', async () => {
    let finish: ((data: JsonObject)=>void) | undefined, signal: AbortSignal | undefined;
    const request = vi.fn<AdminRequest>(async (path,options)=>{
      if (path === IMPORT_PATH + '/preview' && options?.body?.mimeType === 'application/pdf') {
        signal = options.signal; return new Promise<JsonObject>(resolve=>{finish=resolve;});
      }
      if (path === IMPORT_PATH + '/preview') return {sourceKind:'csv',rows:[]};
      return scope;
    });
    open(request); await selectFile(new File(['%PDF-1.4 example'], 'example.pdf', {type:'application/pdf'}));
    fireEvent.click(screen.getByRole('button',{name:'Send to OpenAI for preview'}));
    await waitFor(()=>expect(finish).toBeDefined());
    await selectFile(csv(),false); expect(signal?.aborted).toBe(true);
    finish!({sourceKind:'pdf',rows:[previewRow(1)]});
    fireEvent.click(screen.getByRole('button',{name:'Preview file'})); await screen.findByText('No member rows were found in this file.');
    expect(screen.queryByText(name)).not.toBeInTheDocument(); expect(screen.getByRole('button',{name:'Register verified members (0)'})).toBeDisabled();
  });
});
