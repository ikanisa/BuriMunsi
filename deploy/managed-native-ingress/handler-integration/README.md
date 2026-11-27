# Cloud native handler integration tests

Run `node --test deploy/managed-native-ingress/handler-integration/handler-integration.test.mjs` from the checkout.

The tests exercise the current Collect API handler and entrypoint, the Cloud
frontdoor, signature verification, application admission and committed nonce
claims. Synthetic adapters cover concurrent replay, lost acknowledgements,
cancellation, unavailable dependencies, a large approved preview, and ordinary
CORS and non-native routes. The scheduler tests exercise its receipt and
financial-work gates and check bounded output from the native SMS ledger lane.

The successor `qualification-inputs.json` binds the changed source and fixture bytes to the
preserved `current-inputs.json` by SHA-256. The shared handler exercises signed ingress and the
shipped standalone entrypoint exercises direct native admission. Inputs include the shared PostgreSQL write transaction scope and the
BuriMunsi origin and request-body boundary used by the phone/PIN gate. The
preserved predecessor digest identifies the earlier review. Deployment and
managed ingress approval continue to require separate evidence.
