import {useRef, useState, type FormEvent} from 'react';
import {Button} from '../../ui';
import {validateMember, type MemberDraft} from './memberEnrollment';
import type {ReviewedMember} from './memberRoster';

interface Props {
  initial?: MemberDraft; last3?: string; confirmLabel: string; onConfirm: (value: ReviewedMember) => void;
  onBack: () => void; busy?: boolean;
}

export function EnrollmentReview({initial = {name:'', phone:''}, last3, confirmLabel, onConfirm, onBack, busy = false}: Props) {
  const [draft, setDraft] = useState(initial), [review, setReview] = useState<MemberDraft | null>(null);
  const [errors, setErrors] = useState<{name?: string; phone?: string}>({});
  const nextHeading = useRef<HTMLHeadingElement>(null);
  function update(field: keyof MemberDraft, value: string) {
    setDraft(previous=>({...previous, [field]:value})); setErrors({});
  }
  function showReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const {name, phone, errors} = validateMember(draft);
    if (last3 && phone && !phone.endsWith(last3)) errors.phone = 'The full number must end in ' + last3 + '.';
    setErrors(errors);
    if (errors.name || errors.phone) {
      event.currentTarget.querySelector<HTMLInputElement>(errors.name ? '[name=name]' : '[name=phone]')?.focus();
      return;
    }
    setReview({name, phone});
    requestAnimationFrame(()=>nextHeading.current?.focus());
  }
  if (review) return <section className="members-review" aria-label="Review member">
    <h2 ref={nextHeading} tabIndex={-1}>Review member</h2>
    <dl><div><dt>Registered MoMo name</dt><dd>{review.name}</dd></div><div><dt>Mobile number</dt><dd>{review.phone}</dd></div></dl>
    <p id="member-confirmation">By confirming, you attest that you verified ownership of this mobile number, the member accepted the savings terms, and you recorded their privacy consent.</p>
    <div className="members-enrollment-actions"><Button disabled={busy} onClick={()=>setReview(null)}>Edit details</Button>
      <Button variant="primary" disabled={busy} aria-describedby="member-confirmation" onClick={()=>onConfirm({...review,
        verifiedOwnership:true, acceptedTerms:true, consentRecorded:true})}>{confirmLabel}</Button></div>
  </section>;
  return <form className="admin-auth-form" aria-label="Member details" onSubmit={showReview} noValidate>
    {last3 && <p>Suggested from MoMo ···{last3}</p>}
    <div className="admin-field"><label htmlFor="member-name">Registered MoMo name</label>
      <input className="admin-input" id="member-name" name="name" autoComplete="off" required minLength={2} maxLength={100}
        value={draft.name} onChange={event=>update('name', event.target.value)} disabled={busy}
        aria-invalid={!!errors.name} aria-describedby={errors.name ? 'member-name-error' : undefined} />
      {errors.name && <p className="admin-field-error" id="member-name-error">{errors.name}</p>}
    </div>
    <div className="admin-field"><label htmlFor="member-phone">Mobile number</label>
      <input className="admin-input" id="member-phone" name="phone" type="tel" autoComplete="off" required maxLength={40}
        value={draft.phone} onChange={event=>update('phone', event.target.value)} disabled={busy}
        aria-invalid={!!errors.phone} aria-describedby={errors.phone ? 'member-phone-error' : undefined} />
      {errors.phone && <p className="admin-field-error" id="member-phone-error">{errors.phone}</p>}
    </div>
    <div className="members-enrollment-actions"><Button onClick={onBack} disabled={busy}>Back</Button>
      <Button variant="primary" type="submit" disabled={busy}>Review member</Button></div>
  </form>;
}
