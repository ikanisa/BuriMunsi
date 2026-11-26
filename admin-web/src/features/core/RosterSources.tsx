import {flushSync} from 'react-dom';
import {useCallback, useEffect, useRef, useState, type FormEvent, type RefObject} from 'react';
import {AdminRequestError, type AdminRequest} from '../../api/contracts';
import {Button, ErrorState, Icon, LoadingState} from '../../ui';
import {useOperationRead} from '../operations/useOperationRead';
import {disclosureVersion, IMPORT_PATH, readRosterPreview, readSuggestions, SUGGESTIONS_PATH,
  type PreviewRow, type RosterCandidate, type SourceKind} from './memberRoster';
import {describeRosterFile, rosterFileBytes, workbookMime} from './rosterFile';

export type UploadMode = 'camera' | 'photo' | 'file';
export const methodLabels = {suggestions:'Suggested from MoMo', manual:'Add manually', camera:'Take a photo of the list',
  photo:'Choose a photo', file:'Import member list'} as const;
const icons = {suggestions:'users', manual:'edit', camera:'smartphone', photo:'layers', file:'file'} as const;
export type EnrollmentMode = keyof typeof methodLabels;
export function EnrollmentMethods({choose, fileInput, recovering = false}: {choose: (mode: EnrollmentMode) => void;
  fileInput: RefObject<HTMLInputElement | null>; recovering?: boolean}) {
  function open(mode: EnrollmentMode) {
    if (mode === 'manual' || mode === 'suggestions') {choose(mode); return;}
    // The system file or camera picker must open during the operator's original gesture.
    flushSync(()=>choose(mode));
    fileInput.current?.click();
  }
  return <div className="members-enrollment-options">
    {(Object.keys(methodLabels) as EnrollmentMode[]).filter(mode=>!recovering || mode !== 'manual').map(mode=>
      <button className="members-enrollment-option" key={mode} onClick={()=>open(mode)}>
        <span className="members-enrollment-icon"><Icon name={icons[mode]} /></span>
        <span>{methodLabels[mode]}</span><Icon name="chevron" /></button>)}
  </div>;
}

export function RosterSuggestions({request, group, onSelect, onBack}: {
  request: AdminRequest; group: string; onSelect: (row: RosterCandidate) => void; onBack: () => void;
}) {
  const [text, setText] = useState(''), [search, setSearch] = useState({q:'', cursor:'', revision:''});
  const load = useCallback(async (signal: AbortSignal) => {
    const params = new URLSearchParams({q: search.q, limit:'40'});
    if (search.cursor) params.set('cursor', search.cursor);
    const page = readSuggestions(await request(SUGGESTIONS_PATH + '?' + params, {signal}), group);
    if (search.revision && page.revision !== search.revision) throw new Error('Suggestions changed.');
    return page;
  }, [request, group, search]);
  const {result,retry} = useOperationRead(JSON.stringify([group,search]), true, load,
    {invalidResponse:'The suggestions could not be verified. Search again.'});
  function submit(event: FormEvent) {event.preventDefault(); setSearch({q:text.trim(), cursor:'', revision:''});}
  return <section className="members-journey"><h2>{methodLabels.suggestions}</h2>
    <form onSubmit={submit} className="members-suggestion-filter"><div className="admin-field">
      <label htmlFor="payer-query">Name or last three digits</label>
      <input className="admin-input" id="payer-query" type="search" value={text} maxLength={80} onChange={e=>setText(e.target.value)} />
    </div><Button type="submit">Search</Button></form>
    {!result ? <LoadingState label="Loading suggestions" /> : result.status === 'error'
      ? <ErrorState title="Suggestions unavailable" message={result.message} onRetry={search.cursor
        ? ()=>setSearch({q:search.q,cursor:'',revision:''}) : retry} />
      : <>{!result.value.items.length && <p role="status">No suggested payers found.</p>}
        <ul className="members-roster-list">{result.value.items.map(item=><li key={item.candidateId}>
          <button className="members-enrollment-option" onClick={()=>onSelect(item)}><span>{item.momoName}</span>
            <span>···{item.last3}</span><Icon name="chevron" /></button></li>)}</ul>
        {!!result.value.nextCursor && <Button onClick={()=>setSearch({q:search.q, cursor:result.value.nextCursor!, revision:result.value.revision})}>More suggestions</Button>}
      </>}
    <Button onClick={onBack}>Back</Button>
  </section>;
}

function previewFailure(error: unknown) {
  if (error instanceof AdminRequestError) {
    const code = error.code ?? '';
    if (/headers_invalid/.test(code)) return 'Use a Name column and a Phone column in the file.';
    if (/^(smart_import_(ocr|decoder)_unavailable|smart_import_decoder_invalid)$/.test(code))
      return 'This file format cannot be previewed right now. Try a CSV file or add the member manually.';
    if (/unconfirmed|pending|in_progress/.test(code) || error.outcomeUnknown)
      return 'The preview could not be confirmed. Retry this selected file to check its original request.';
    if (/consent_required|disclosure/.test(code)) return 'Permission for this file could not be confirmed. Choose the file again.';
    if (/admin_required|permission_required|access_denied/.test(code)) return 'Your account cannot preview rosters for this group.';
    if (/invalid|unsupported|size|too_many/.test(code)) return 'Check the file format and contents. A roster can contain up to 500 rows.';
    return 'The file could not be previewed. Try again or choose another file.';
  }
  return 'The file could not be prepared or verified. Try another file or add the member manually.';
}

interface Selection {file: File; source: SourceKind; mimeType: string; flow: string;}
export function RosterUpload({mode, fileInput, request, isCurrent, onPreview, onBack}: {mode: UploadMode;
  fileInput: RefObject<HTMLInputElement | null>; request: AdminRequest;
  isCurrent: () => boolean; onPreview: (rows: PreviewRow[]) => void; onBack: () => void}) {
  const [selection, setSelection] = useState<Selection | null>(null), [error, setError] = useState('');
  const [working,setWorking] = useState(false), flight = useRef<AbortController | null>(null);
  useEffect(()=>()=>{ flight.current?.abort(); }, []);
  function choose(file?: File) {
    flight.current?.abort(); flight.current = null; setWorking(false); setError(''); setSelection(null);
    if (!file) return;
    try {setSelection({file, ...describeRosterFile(file, mode !== 'file'), flow:crypto.randomUUID()});}
    catch (error) {setError(error instanceof Error ? error.message : 'Choose a supported roster file.');}
  }
  const needsOcr = selection?.source === 'image' || selection?.source === 'pdf';
  async function preview() {
    if (!selection || flight.current || !isCurrent()) return;
    const controller = new AbortController(); flight.current = controller; setWorking(true); setError('');
    try {
      const fileBytes = await rosterFileBytes(selection.file, selection.source, controller.signal);
      if (controller.signal.aborted || !isCurrent()) return;
      const data = await request(IMPORT_PATH + '/preview', {method:'POST', signal:controller.signal,
        body:{mimeType:selection.mimeType, fileBytes, externalOcrConsent:needsOcr,
          ...(needsOcr ? {importFlowId:selection.flow, ocrDisclosureVersion:disclosureVersion} : {})}});
      if (!controller.signal.aborted && isCurrent()) onPreview(readRosterPreview(data, selection.source));
    } catch (error) {
      if (!controller.signal.aborted && isCurrent()) setError(previewFailure(error));
    } finally {
      if (flight.current === controller) {flight.current = null; if (!controller.signal.aborted && isCurrent()) setWorking(false);}
    }
  }
  return <section className="members-journey"><h2>{methodLabels[mode]}</h2>
    <div className="admin-field"><label htmlFor="roster-file">{mode === 'file' ? 'Roster file' : 'Roster photo'}</label>
      <input className="admin-input members-roster-file" ref={fileInput} id="roster-file" type="file" capture={mode === 'camera' ? 'environment' : undefined}
        accept={mode === 'file' ? '.csv,.xlsx,.pdf,text/csv,application/pdf,' + workbookMime + ',image/jpeg,image/png,image/webp' : mode === 'camera' ? 'image/*' : 'image/jpeg,image/png,image/webp'}
        onChange={e=>choose(e.target.files?.[0])} aria-describedby="roster-file-hint" />
      <p id="roster-file-hint">{mode === 'file' ? 'CSV, Excel, PDF or photo. For a spreadsheet, include Name and Phone columns.' : 'Use a clear photo showing the names and full mobile numbers.'}</p></div>
    {selection && <div><strong>{selection.file.name}</strong>
      {needsOcr && <p id="roster-disclosure">Sending this file to OpenAI permits text extraction for this preview. You can review and edit every row before registering members.</p>}
    </div>}
    {error && <p role="alert">{error}</p>}
    <div className="members-enrollment-actions"><Button onClick={onBack}>Back</Button>
      <Button variant="primary" disabled={!selection || working} loading={working} aria-describedby={needsOcr ? 'roster-disclosure' : undefined}
        onClick={()=>void preview()}>{needsOcr ? 'Send to OpenAI for preview' : 'Preview file'}</Button></div>
  </section>;
}
