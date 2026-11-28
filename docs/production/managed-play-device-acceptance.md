# BuriMunsi managed Play device acceptance

Use a separate, approved physical Android 11+ device/profile enrolled in the intended managed Play organization. Do not uninstall, re-enroll or change the receiver on the field Pixel for this exercise. Never sideload a version merely to make this gate pass.

1. Record the intended organization, approved country and exact release/version in the private release record. Confirm that the profile can see both correct package listings and that the intended track and signing identity are documented.
2. Record the prior installed version/source in this same profile. If there is no earlier Play installation, record this as a **new-install** test, not an upgrade. Preserve a permitted operator-owned continuity marker without putting personal, account or payment data in Git.
3. In the device's managed Play profile use Play's normal Install or Update action. Record what was actually observed. Do not change the installer or repair signing mismatches by uninstalling the field app.
4. Run the read-only check before and after, using the exact device serial and profile user number. Store output privately:

   ```sh
   python3 scripts/qa/managed_play_device_readback.py \
     --serial '<exact ADB serial>' --profile '<Android user ID>' --expected-version '<release version code>'
   ```

   This reads only exact package/installer status. An expected version and a Play installer of record corroborate but do not certify a managed Play update. A different or absent installer is not evidence the Play path succeeded. A script exit of zero means the read succeeded, not that acceptance passed. Support a release claim with observed Play action, current artifact signing evidence and separate proof of enrollment and listing visibility.
5. Recheck launch and continuity for both apps. Verify role enforcement and SMS consent without moving the production receiver or altering any real payment data. Record operator, versions, observed channel and result in the private acceptance record. Live receipt-to-ledger verification and designated operator sign-off are separate gates.

[Android Developers: installer of record and initiating package](https://developer.android.com/reference/android/content/pm/InstallSourceInfo).
