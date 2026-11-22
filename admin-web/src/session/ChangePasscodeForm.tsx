import {useRef, useState, type FormEvent} from 'react';
import {AdminRequestError} from '../api/client';
import {Button, Card, Field} from '../ui';
import {authFailureMessage} from './AuthFrame';
import {PASSCODE} from './phonePasscode';
import {useSession} from './SessionProvider';

export function ChangePasscodeForm({onSignIn}: {onSignIn: () => void}) {
  const session = useSession();
  const [busy, setBusy] = useState(false), [unknown, setUnknown] = useState(false), [feedback, setFeedback] = useState('');
  const inFlight = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session.changePasscode || unknown || inFlight.current) return;
    const form = event.currentTarget, data = new FormData(form);
    const current = String(data.get('current') ?? ''), next = String(data.get('next') ?? ''), confirm = String(data.get('confirm') ?? '');
    if (!PASSCODE.test(current) || !PASSCODE.test(next) || next !== confirm || current === next) {
      setFeedback('Enter your current passcode and confirm a different four-digit passcode.');
      return;
    }
    inFlight.current = true; setBusy(true); setFeedback(''); form.reset();
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
    <p>You can keep your current passcode. If you change it, sign in again with the new one.</p>
    <form className="admin-auth-form" onSubmit={submit}>
      {!unknown && <>{([['current', 'Current passcode'], ['next', 'New passcode'], ['confirm', 'Confirm new passcode']] as const).map(([name, label]) =>
        <Field key={name} label={label} htmlFor={`passcode-${name}`}><input className="admin-input" id={`passcode-${name}`} name={name}
          type="password" inputMode="numeric" autoComplete={name === 'current' ? 'current-password' : 'new-password'}
          pattern="[0-9]{4}" maxLength={4} disabled={busy} required /></Field>)}</>}
      {feedback && <p role="status">{feedback}</p>}
      {unknown ? <Button onClick={() => void signOut()} loading={busy}>Sign out and sign in again</Button> :
        <Button type="submit" variant="primary" loading={busy}>Change passcode</Button>}
    </form>
  </Card>;
}
