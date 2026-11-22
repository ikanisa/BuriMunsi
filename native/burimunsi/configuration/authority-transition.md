# Supabase Cloud authority transition

The target is the existing Collect Supabase Cloud project
`rrlduytparvsjfmegalh`. Configured BuriMunsi builds accept only that project;
qualification and native-test builds have blank endpoints. Cloud Staff and
Admin use the new Android application IDs `rw.ikanisa.burimunsi.staff.cloud`
and `rw.ikanisa.burimunsi.gateway.cloud`. Android's separate app sandboxes and
Keystore UIDs prevent those apps from loading the previous apps' local sessions,
device credentials or queued work. This is a fresh installation and does not
move or resolve those records. A matching URL does not establish a working backend.

The first authorized scan records the existing inbox identities and the scoped consent under which they were observed. A receiver cycle compares each approved sender and receiving SIM row against server custody and parsing, including the newest phone receipt ordered by received time and inbox row ID. It requeues a confirmed gap with its original source identity. Paired receipts use the paired gateway and observation-only receipts use the consented observation transport. The historical recovery endpoint retains an eligible first-scan receipt under its recorded consent and holds it for review. For a key-only baseline, the receiver can open a new current-consent historical review. A previous in-flight command with uncertain original consent stays on hold. Admin receives the most recent online check, including missing or unparsed receipts.

Before live use, complete and verify the following for each installation:

1. Reconcile the cloud database, authentication, functions, Admin access and
   existing group and financial history. Preserve every uncertain outcome; do
   not replay an unknown effect against the cloud project.
2. Stop the former receiver and reconcile its outstanding commands and queues
   without replaying uncertain effects. Preserve the original evidence; the new
   apps cannot read it. Establish the single Cloud receiver and an accountable
   procedure for messages held at first scan.
3. Authenticate the existing approved operator and have the Cloud service issue
   a new installation-bound grant and session. Check role, collection and device
   scope; never copy a previous device credential into the new package.
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
