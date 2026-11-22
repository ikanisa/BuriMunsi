import {useState, type FormEvent} from 'react';
import {AdminRequestError} from '../api/client';
import {Button, Field} from '../ui';
import {authFailureMessage} from './AuthFrame';
import {PASSCODE} from './phonePasscode';
import {useSession} from './SessionProvider';

export function VerifyPasscodePage({onDone}: {onDone: () => void}) {
  const {verifySensitivePasscode, recheckSensitivePasscode} = useSession();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [feedback, setFeedback] = useState('');

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || unknown || !PASSCODE.test(pin) || !verifySensitivePasscode) return;
    setBusy(true);
    setFeedback('');
    setPin('');
    try {await verifySensitivePasscode(pin); onDone();}
    catch (failure) {
      if (failure instanceof AdminRequestError && failure.outcomeUnknown) setUnknown(true);
      setFeedback(authFailureMessage(failure));
    } finally {setBusy(false);}
  }

  async function check() {
    if (busy || !recheckSensitivePasscode) return;
    setBusy(true);
    setFeedback('');
    try {
      if (await recheckSensitivePasscode()) onDone();
      else {
        setUnknown(false);
        setFeedback('Verification is unconfirmed. Enter your passcode to continue.');
      }
    } catch (failure) {setFeedback(authFailureMessage(failure));}
    finally {setBusy(false);}
  }

  return <div className="admin-auth-task"><h1>Verify your passcode</h1><p>Confirm your current BuriMunsi passcode to continue.</p>
    <form className="admin-auth-form" onSubmit={verify}>
      {!unknown && <Field label="Four-digit passcode" htmlFor="verify-admin-pin"><input className="admin-input"
        id="verify-admin-pin" type="password" inputMode="numeric" autoComplete="current-password" pattern="[0-9]{4}"
        maxLength={4} required value={pin} onChange={event => setPin(event.target.value.replace(/[^0-9]/g, ''))} disabled={busy} /></Field>}
      {feedback && <p className="admin-auth-feedback" role="status">{feedback}</p>}
      {unknown ? <Button variant="primary" loading={busy} onClick={() => void check()}>Check session</Button> :
        <Button type="submit" variant="primary" loading={busy} disabled={!PASSCODE.test(pin)}>Verify passcode</Button>}
      <Button disabled={busy} onClick={onDone}>Back</Button>
    </form>
  </div>;
}
