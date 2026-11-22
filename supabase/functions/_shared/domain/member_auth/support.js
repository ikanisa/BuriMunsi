import { ApiError } from "../core.js";

export const unix = () => Math.floor(Date.now() / 1000);
export const mfaUnavailable = () =>
  new ApiError(
    410,
    "mfa_not_available",
    "Verify your email to confirm sensitive changes.",
  );

export function fail(code = "invalid_session", status = 401) {
  const message = code === "admin_access_not_approved"
    ? "This email does not have Admin access. Contact the super admin to be added."
    : "Sign in again or request a new code.";
  throw new ApiError(status, code, message);
}
