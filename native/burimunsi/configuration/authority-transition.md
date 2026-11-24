# Supabase Cloud authority transition

The target is the existing Collect Supabase Cloud project
`rrlduytparvsjfmegalh`. Configured BuriMunsi builds accept only that project;
qualification and native-test builds have blank endpoints. Cloud Staff and
Admin use the new Android application IDs `rw.ikanisa.burimunsi.staff.cloud`
and `rw.ikanisa.burimunsi.gateway.cloud`. Android's separate app sandboxes and
Keystore UIDs prevent those apps from loading the previous apps' local sessions,
device credentials or queued work. This is a fresh installation and does not
move or resolve those records. A matching URL does not establish a working backend.

The designated human Admin signs in with their registered mobile number and
passcode and grants Android SMS access on the supported phone in use. There is
no manual phone or SIM enrollment for capture. Staff accounts cannot receive
or view SMS in BuriMunsi. The first consented scan records eligible inbox
identities. Later scans compare eligible messages against server custody and
parsing, using receipt time and inbox row ID for order. Confirmed gaps reuse
the original source identity. Older or uncertain observations retain their
held status; a new phone does not inherit the old app's pending command.
References to a paired gateway apply only to legacy receipt lineage or
separately managed outbound OpenSMS delivery. See the
[observation contract](../../../contracts/burimunsi-api/OBSERVATIONS.md).

Before live use, complete and verify the following for each installation:

1. Reconcile the cloud database, authentication, functions, Admin access and
   existing group and financial history. Preserve every uncertain outcome; do
   not replay an unknown effect against the cloud project.
2. Reconcile outstanding commands from earlier app packages under their original receipt identities. A previously paired gateway retains its own queue and recovery credentials.
3. Sign in to Admin Sync on each supported Android phone using the registered Admin mobile number and passcode. The app and server establish the new authenticated installation context automatically; this is not hardware approval. Grant the normal Android SMS permissions. Subsequent eligible receipts and backlog reconciliation run automatically. A second signed-in Admin handset can receive at the same time. Each handset verifies its own inbox, while payment references and credits remain scoped to the collection. Staff accounts have no access to the receiver.
4. Preserve unresolved obligations and original source identities. Verify that
   a crash, retry, reinstall or account change cannot create duplicate credits.
5. Qualify the hosted routes, Admin and Staff access, SMS permission separation,
   offline capture, upgrade, re-enrollment and duplicate-safe recovery on the
   intended device before releasing the apps for live use.

These steps do not assert that the Cloud service or commissioning path is deployed.
Do not put passwords, device tokens, collection IDs or service-role credentials
in public build properties.

`scripts/verify_authority_build_guard.py` exercises the cloud-only build guard
with the pinned Gradle distribution, dependency cache, Android SDK and JDK.
It builds no APK and makes no hosted request.
