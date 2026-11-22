import {useEffect, useState, type FormEvent} from 'react';
import {AdminRequestError} from '../api/client';
import {adminBrand} from '../branding';
import {Button, Field} from '../ui';
import {AuthFrame, authFailureMessage} from './AuthFrame';
import {PASSCODE} from './phonePasscode';
import {useSession} from './SessionProvider';

export function LoginPage({onSignedIn}: {onSignedIn: () => void}) {
  const session = useSession();
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [unknown, setUnknown] = useState(false);
  const needsSessionCheck = unknown || session.status === 'error';
  useEffect(() => {if (session.status === 'authenticated') onSignedIn();}, [session.status, onSignedIn]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || needsSessionCheck || !session.signInWithPhonePasscode) return;
    setBusy(true);
    setFeedback('');
    setPin('');
    try {await session.signInWithPhonePasscode(phone, pin);}
    catch (failure) {
      if (failure instanceof AdminRequestError && failure.outcomeUnknown) setUnknown(true);
      setFeedback(authFailureMessage(failure));
    } finally {setBusy(false);}
  }

  async function checkSession() {
    setBusy(true);
    setFeedback('');
    try {
      await session.refresh();
      setUnknown(false);
    } catch (failure) {setFeedback(authFailureMessage(failure));}
    finally {setBusy(false);}
  }

  return <AuthFrame title={`Welcome to ${adminBrand.product}`} subtitle="Use your BuriMunsi mobile number and passcode.">
    <form className="admin-auth-form" onSubmit={submit}>
      <Field label="Mobile number" htmlFor="admin-phone"><input className="admin-input" id="admin-phone" type="tel"
        maxLength={40} autoComplete="username" required value={phone} onChange={event => setPhone(event.target.value)}
        disabled={busy || needsSessionCheck} /></Field>
      <Field label="Four-digit passcode" htmlFor="admin-pin"><input className="admin-input" id="admin-pin" type="password"
        inputMode="numeric" autoComplete="current-password" pattern="[0-9]{4}" maxLength={4} required
        value={pin} onChange={event => setPin(event.target.value.replace(/[^0-9]/g, ''))} disabled={busy || needsSessionCheck} /></Field>
      {(feedback || (session.status === 'error' && session.error)) && <p className="admin-auth-feedback" role="status">{feedback || session.error}</p>}
      {needsSessionCheck ? <Button variant="primary" loading={busy} onClick={() => void checkSession()}>Check session</Button> :
        <Button type="submit" variant="primary" loading={busy} disabled={!phone.trim() || !PASSCODE.test(pin)}>Sign in</Button>}
    </form>
  </AuthFrame>;
}
