# Single-admin preflight fixture (offline only)

`node --test scripts/supabase/single-admin-preflight/validate.test.mjs`

The fixture compares normalized synthetic intent/observations against the pinned
110→111 single-admin SQL and its transaction-stripped body. It requires the
same independently supplied epoch, fenced mode, idle ingress/effects and
settled scheduler admissions. It distinguishes exact before/absent and
after/present catalogue and history, and preserves an unknown acknowledgement
as a separate outcome. Apparent preimage after unknown ACK remains a hold,
never a retry recommendation. Mismatched or mixed evidence fails closed.

The history fingerprints are rehearsal pins, not a current hosted
attestation. The sample epoch has no operational meaning. Catalogue fields
including function ownership and original definition are **synthetic normalized
assertions**; this module does not collect or attest them. There is no CLI,
provider/client dependency, credential input, connection information,
fence action, SQL execution, or deploy/retry path. Existing release modes
are unchanged. The previous isolated PostgreSQL DDL/history rehearsal supplies
transactional evidence separately; these pure tests are not a replacement.
