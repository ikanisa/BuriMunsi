import {useEffect, useRef, useState, type RefObject} from 'react';
import type {AdminRequest} from '../../api/contracts';
import {Button, StatusBadge} from '../../ui';
import {clearOriginalAttempt} from './canonicalMutation';
import {EnrollmentReview} from './EnrollmentReview';
import {ENROLLMENT_PERMISSION, type MemberDraft} from './memberEnrollment';
import {IMPORT_PATH, importIntent, readImportReceipt, resultLabels, ROSTER_FAMILY,
  type ImportReceipt, type ImportRow, type PreviewRow, type ReviewedMember, type RosterCandidate} from './memberRoster';
import {retainPending, type PendingAttempt, type PendingIdentity} from './pendingAttempt';
import {EnrollmentMethods, RosterSuggestions, RosterUpload, type EnrollmentMode} from './RosterSources';

type RosterMode = Exclude<EnrollmentMode, 'manual'>;
interface DraftRow extends MemberDraft {
  row: number; status: PreviewRow['status']; issue: string | null; candidate?: RosterCandidate; verified?: ImportRow;
}
const rowStatus = {ready:'Ready to review', invalid:'Needs correction', duplicate_in_file:'Duplicate in file'};
const issueLabels: Record<string, string> = {invalid_name:'Check the registered name.', invalid_phone:'Check the full mobile number.',
  duplicate_phone:'The number appears more than once.'};

export function MemberRosterImport({initialMode, fileInput, group, request, identity, isCurrent, original, onBack}: {
  initialMode: RosterMode | null; fileInput: RefObject<HTMLInputElement | null>; group: string; request: AdminRequest; identity: PendingIdentity;
  isCurrent: () => boolean; original: PendingAttempt | null; onBack: () => void;
}) {
  const [mode,setMode] = useState(initialMode);
  const [drafts,setDrafts] = useState<DraftRow[] | null>(null), [editing,setEditing] = useState<number | null>(null);
  const [pending,setPending] = useState(original), [missing,setMissing] = useState(false);
  const [receipt,setReceipt] = useState<ImportReceipt | null>(null), [message,setMessage] = useState('');
  const [working,setWorking] = useState<'checking' | 'saving' | null>(null);
  const busy = useRef(false), mounted = useRef(true);
  useEffect(()=>{mounted.current = true; return ()=>{mounted.current = false;};}, []);
  const current = () => mounted.current && isCurrent();
  const verified = (drafts ?? []).flatMap(row=>row.verified ? [row.verified] : []);
  const editRow = drafts?.find(row=>row.row === editing);

  function chooseCandidate(candidate: RosterCandidate) {
    setDrafts([{row:1, name:candidate.momoName, phone:'', status:'ready', issue:null, candidate}]); setEditing(1);
  }
  function preview(rows: PreviewRow[]) {
    setDrafts(rows.map(r=>({row:r.row, name:r.momoName, phone:r.momoNumber, status:r.status, issue:r.issue})));
  }
  function edit(row: DraftRow) {
    setDrafts(rows=>rows?.map(r=>r.row === row.row ? {...r, verified:undefined} : r) ?? null); setEditing(row.row);
  }
  function verify(member: ReviewedMember) {
    if (!editRow) return;
    const entry: ImportRow = {row:editRow.row, ...member, ...(editRow.candidate ? {candidateId:editRow.candidate.candidateId} : {})};
    setDrafts(rows=>rows?.map(r=>r.row === editRow.row ? {...r, name:entry.name, phone:entry.phone, verified:entry} : r) ?? null);
    setEditing(null); setMessage('');
  }
  function chooseAgain() {
    setDrafts(null); setEditing(null); setMessage('');
    if (pending) setMode(null);
    else onBack();
  }
  async function finish(data: unknown, attempt: PendingAttempt) {
    const receipt = readImportReceipt(data, attempt);
    if (!current()) return;
    await clearOriginalAttempt(identity, attempt, current);
    if (current()) {setReceipt(receipt); setPending(null); setDrafts(null); setMessage('');}
  }
  async function check() {
    if (!pending || busy.current || !current()) return;
    busy.current = true; setWorking('checking'); setMissing(false); setMessage('');
    try {
      const data = await request(IMPORT_PATH + '/requests/' + pending.request_key);
      if (!current()) return;
      if (data.requestId === pending.request_key && data.outcome === 'not_found' && Object.keys(data).length === 2) {
        setMissing(true);
        setMessage('No completed import was found. Review the same rows to retry the original request.');
      } else await finish(data, pending);
    } catch {if (current()) setMessage('The original import could not be checked. Keep the reference and check again.');}
    finally {busy.current = false; if (current()) setWorking(null);}
  }
  async function register() {
    if (!verified.length || editing !== null || busy.current || !current() || (pending && !missing)) return;
    busy.current = true; setWorking('saving'); setMessage('');
    let submitted = false;
    try {
      const requestId = pending?.request_key ?? crypto.randomUUID();
      const rows = [...verified].sort((a,b)=>a.row-b.row);
      const intent = await importIntent(requestId, rows);
      if (!current()) return;
      if (pending && (pending.intent.batchHash !== intent.batchHash || pending.intent.rowNumbers !== intent.rowNumbers)) {
        setMessage('Use the same rows, registered names, numbers and suggestions as the original import.'); return;
      }
      const attempt = await retainPending(identity, ROSTER_FAMILY, group, requestId, ENROLLMENT_PERMISSION, intent, undefined, undefined, current);
      if (!current()) return;
      setPending(attempt); setMissing(false); submitted = true;
      const response = await request(IMPORT_PATH, {method:'POST', idempotencyKey:requestId, body:{requestId, rows}});
      await finish(response, attempt);
    } catch {
      if (current()) setMessage(submitted ? 'The import could not be confirmed. Check the original request before trying again.'
        : 'The original import reference could not be saved. Reopen Add member before continuing.');
    } finally {busy.current = false; if (current()) setWorking(null);}
  }
  if (receipt) return <section className="members-journey"><h2>Import results</h2>
    <p role="status">{receipt.created} registered · {receipt.results.length} reviewed</p>
    <ul className="members-roster-list">{receipt.results.map(r=><li key={r.row}><span>Row {r.row}</span>
      <StatusBadge tone={r.status === 'created' ? 'success' : 'neutral'}>{resultLabels[r.status]}</StatusBadge></li>)}</ul>
  </section>;
  const showDraft = !pending || missing;
  return <div className="members-journey">
    {pending && <div><h2>Original import request</h2><p>Request <code>{pending.request_key}</code></p>
      <Button onClick={()=>void check()} disabled={!!working} loading={working === 'checking'}>Check import request</Button></div>}
    {message && <p role="alert">{message}</p>}
    {showDraft && (editRow ? <EnrollmentReview key={editRow.row} initial={{name:editRow.name,phone:editRow.phone}}
      last3={editRow.candidate?.last3} confirmLabel="Confirm reviewed row" onConfirm={verify}
      onBack={()=>setEditing(null)} busy={!!working} /> : drafts ? <>
      <h2>Review extracted members</h2>
      {!drafts.length ? <p role="status">No member rows were found in this file.</p>
        : <ul aria-label="Roster rows" className="members-roster-list">{drafts.map(row=><li key={row.row}>
          <div><strong className="admin-compact-text" title={row.name || undefined}>{row.name || 'Name missing'}</strong><span>{row.phone || 'Number missing'} · Row {row.row}</span>
            <span>{row.verified ? 'Verified' : rowStatus[row.status]}</span>
            {row.issue && !row.verified && issueLabels[row.issue] && <small>{issueLabels[row.issue]}</small>}
          </div><div className="members-roster-row-actions"><Button disabled={!!working} onClick={()=>edit(row)}
            aria-label={(row.verified ? 'Edit row ' : 'Review row ') + row.row}>{row.verified ? 'Edit' : 'Review'}</Button>
            {row.verified && <Button disabled={!!working} onClick={()=>setDrafts(rows=>rows?.map(r=>
              r.row === row.row ? {...r,verified:undefined} : r) ?? null)} aria-label={'Exclude row ' + row.row}>Exclude</Button>}</div>
        </li>)}</ul>}
      <div className="members-enrollment-actions"><Button onClick={chooseAgain} disabled={!!working}>Choose another source</Button>
        <Button variant="primary" onClick={()=>void register()} disabled={!verified.length || !!working} loading={working === 'saving'}>
          {pending ? 'Retry original import' : `Register verified members (${verified.length})`}</Button></div>
    </> : mode === 'suggestions' ? <RosterSuggestions {...{request,group}} onSelect={chooseCandidate} onBack={chooseAgain} />
      : mode ? <RosterUpload key={mode} {...{mode,request,isCurrent,fileInput}} onPreview={preview} onBack={chooseAgain} />
      : <EnrollmentMethods recovering fileInput={fileInput} choose={value=>{if (value !== 'manual') setMode(value);}} />)}
  </div>;
}
