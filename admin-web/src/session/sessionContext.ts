import type {AdminRequest} from '../api/client';
import type {VerificationMode} from './returnLocation';
import type {SensitiveEmailRecovery} from './sensitiveEmailVerification';
import type {AdminUser, OtpReceipt} from './sessionResponses';

export interface SessionSnapshot {
  status: 'loading' | 'anonymous' | 'authenticated' | 'rechecking' | 'error';
  user: AdminUser | null;
  error?: string;
  logoutUnconfirmed: boolean;
  mfaRecoveryPending: boolean;
  epoch: number;
}

/** Previously verified records can stay visible in the suspended workspace. */
export function canDisplaySessionRecords(session: Pick<SessionSnapshot, 'status' | 'user'>): boolean {
  return !!session.user && (session.status === 'authenticated' || session.status === 'rechecking');
}

export function canReadSmsEvidence(user: Pick<AdminUser, 'role' | 'permissions'> | null | undefined): boolean {
  return !!user && user.role !== 'staff' && user.permissions.includes('sms.read');
}

export type PasswordChangeOutcome = 'session-retained' | 'signed-out';

export interface SessionContextValue extends SessionSnapshot {
  request: AdminRequest;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithPhonePasscode?: (phone: string, pin: string) => Promise<void>;
  signOut: () => Promise<void>;
  googleSignInAvailable: boolean;
  signInWithGoogle: () => Promise<void>;
  cancelGoogleSignIn: () => void;
  requestEmailOtp: (email: string) => Promise<OtpReceipt>;
  verifyEmailOtp: (email: string, challengeId: string, code: string) => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  completePasswordSetup: (token: string, password: string, invite: boolean) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<PasswordChangeOutcome>;
  clearLocalSession: () => void;
  isCurrentAuthority: (epoch: number, actorId: string, sessionId: string) => boolean;
  isRecentSensitiveVerification: (epoch: number, actorId: string, sessionId: string) => boolean;
  recheckSensitivePasscode?: () => Promise<boolean>;
  verifySensitivePasscode?: (pin: string) => Promise<void>;
  changePasscode?: (current: string, next: string, confirmation: string) => Promise<void>;
  verificationMode: VerificationMode;
  requestSensitiveEmailVerification: () => Promise<OtpReceipt>;
  verifySensitiveEmailVerification: (challengeId: string, code: string) => Promise<void>;
  /** Checks only the email step; it does not grant combined sensitive access. */
  recheckEmailVerification: () => Promise<boolean>;
  recheckSensitiveEmailVerification: () => Promise<boolean>;
  sensitiveEmailRecovery: () => SensitiveEmailRecovery | null;
  releaseExpiredSensitiveRequest: () => void;
  cancelSensitiveEmailVerification: () => void;
  verifyAuthenticator: (factorId: string, challengeId: string, code: string) => Promise<void>;
}
