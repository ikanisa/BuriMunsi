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

## Compare the two private readbacks

From the repository root, set `PRIVATE` to a new private directory and make a fresh key for **one** pair. Set `ADB_SERIAL`, `ANDROID_PROFILE` and `TARGET_VERSION` for the approved test profile. Keep the key and both files private; run the first command before the normal Play update and the second afterwards. Do not change Android OS or Android profile during the exercise.

```sh
umask 077
python3 -c 'import secrets,sys; sys.stdout.buffer.write(secrets.token_bytes(32))' > "$PRIVATE/pair.key"
python3 scripts/qa/managed_play_device_readback.py --serial "$ADB_SERIAL" \
  --profile "$ANDROID_PROFILE" --expected-version "$TARGET_VERSION" \
  --pair-key-file "$PRIVATE/pair.key" --phase before > "$PRIVATE/before.json"
# Perform and independently witness the normal managed Play update here.
python3 scripts/qa/managed_play_device_readback.py --serial "$ADB_SERIAL" \
  --profile "$ANDROID_PROFILE" --expected-version "$TARGET_VERSION" \
  --pair-key-file "$PRIVATE/pair.key" --phase after > "$PRIVATE/after.json"
python3 scripts/qa/managed_play_device_compare.py "$PRIVATE/before.json" "$PRIVATE/after.json"
```

Stop if either readback exits nonzero. The comparator checks that both reads are tied to the same selected device/profile and release target using a private, per-pair pseudonym; it does not print this pseudonym or the serial. Exit 0 means both apps show a lower Play-installed version before and the target Play-installed version after. Exit 3 is a valid non-upgrade result, such as a first install, sideload baseline, or no version change. Exit 2 means an incomplete or mismatched pair. This check does not attest to the installed signature, management enrollment, Play action, continuity or the operator's acceptance. Preserve those separately before marking this gate complete.
