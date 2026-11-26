import {useRef, useState, type ClipboardEvent, type FormEvent} from 'react';
import {AdminRequestError} from '../api/client';
import {Button, Card, Field} from '../ui';
import {authFailureMessage} from './AuthFrame';
import {PASSCODE} from './phonePasscode';
import {useSession} from './SessionProvider';

const emptyPasscodes = {current: '', next: '', confirm: ''};
const fields = [['current', 'Current passcode'], ['next', 'New passcode'], ['confirm', 'Confirm new passcode']] as const;
const digitDraft = /^[0-9]{0,4}$/;
const formatHint = 'Use exactly four digits (0–9) for each passcode.';

export function ChangePasscodeForm({onSignIn}: {onSignIn: () => void}) {
  const session = useSession();
  const [passcodes, setPasscodes] = useState(emptyPasscodes);
  const [busy, setBusy] = useState(false), [unknown, setUnknown] = useState(false), [feedback, setFeedback] = useState('');
  const inFlight = useRef(false);
  const {current, next, confirm} = passcodes;
  const same = PASSCODE.test(next) && current === next;
  const mismatch = PASSCODE.test(next) && PASSCODE.test(confirm) && next !== confirm;
  const canSubmit = PASSCODE.test(current) && PASSCODE.test(next) && next === confirm && !same;

  function edit(name: keyof typeof emptyPasscodes, value: string) {
    if (!digitDraft.test(value)) {setFeedback(formatHint); return;}
    setPasscodes(previous => ({...previous, [name]: value}));
    setFeedback('');
  }

  function checkPaste(event: ClipboardEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
    const replacement = input.value.slice(0, start) + event.clipboardData.getData('text/plain') + input.value.slice(end);
    // maxlength would silently truncate an oversized paste to a different credential.
    if (!digitDraft.test(replacement)) {event.preventDefault(); setFeedback(formatHint);}
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session.changePasscode || unknown || inFlight.current || !canSubmit) return;
    inFlight.current = true; setBusy(true); setFeedback(''); setPasscodes(emptyPasscodes);
    try {await session.changePasscode(current, next, confirm); onSignIn();}
    catch (error) {
      setUnknown(error instanceof AdminRequestError && error.outcomeUnknown);
      setFeedback(authFailureMessage(error));
    } finally {inFlight.current = false; setBusy(false);}
  }
  async function signOut() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {await session.signOut(); onSignIn();}
    catch (error) {setFeedback(authFailureMessage(error));}
    finally {inFlight.current = false; setBusy(false);}
  }
  return <Card className="admin-security-card"><h2>Change passcode</h2>
    <p id="passcode-instructions">Use four digits (0–9) for each passcode. After changing it, sign in again with your new passcode.</p>
    <form className="admin-auth-form" onSubmit={submit}>
      {!unknown && fields.map(([name, label]) => {
        const error = name === 'next' && same ? 'Choose a different new passcode.' :
          name === 'confirm' && mismatch ? 'The new passcodes do not match.' : null;
        return <Field key={name} label={label} htmlFor={`passcode-${name}`}>
          <input className="admin-input" id={`passcode-${name}`} name={name} type="password" inputMode="numeric"
            autoComplete={name === 'current' ? 'current-password' : 'new-password'} pattern="[0-9]{4}"
            minLength={4} maxLength={4} required disabled={busy} value={passcodes[name]}
            aria-invalid={error ? true : undefined} aria-describedby={error ? `passcode-${name}-error` : 'passcode-instructions'}
            onPaste={checkPaste} onChange={event => edit(name, event.currentTarget.value)} />
          {error && <p className="admin-field-error" id={`passcode-${name}-error`} role="status">{error}</p>}
        </Field>;
      })}
      {feedback && <p role="status">{feedback}</p>}
      {unknown ? <Button onClick={() => void signOut()} loading={busy}>Sign out and sign in again</Button> :
        <Button type="submit" variant="primary" loading={busy} disabled={!canSubmit}>Change passcode</Button>}
    </form>
  </Card>;
}
