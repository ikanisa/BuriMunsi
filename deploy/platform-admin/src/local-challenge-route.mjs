export const LOCAL_CHALLENGE_PATH = '/admin/auth/local-challenge';

export function isLocalChallengePath(path) {
  // Decode only to identify aliases of the retired route.
  let candidate = path;
  for (let pass = 0; pass < 2; pass++) {
    if (candidate.toLowerCase().replace(/\\/g, '/').replace(/\/{2,}/g, '/').startsWith(LOCAL_CHALLENGE_PATH)) return true;
    try { const decoded = decodeURIComponent(candidate); if (decoded === candidate) break; candidate = decoded; }
    catch { return candidate.toLowerCase().startsWith(LOCAL_CHALLENGE_PATH); }
  }
  return candidate.toLowerCase().replace(/\\/g, '/').replace(/\/{2,}/g, '/').startsWith(LOCAL_CHALLENGE_PATH);
}
