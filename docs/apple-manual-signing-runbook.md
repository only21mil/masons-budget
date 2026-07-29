# Apple manual-signing asset runbook

This runbook prepares the human-created assets required by
`.github/workflows/deploy.yml`. It does not archive, export, upload, revoke a
certificate, or start an app build.

The release path is inert unless the repository variable
`APPLE_MANUAL_SIGNING_READY` is exactly `true`. Keep it absent or `false` until
every verification below passes. The known-stale `APPLE_CERTIFICATE_P12`,
`APPLE_CERTIFICATE_PASSWORD`, and `APPLE_PROVISIONING_PROFILE` secrets are
deliberately not read by the new path.

Apple's current names are important:

- Create one **Apple Distribution** certificate. Xcode 11 and later can use this
  unified distribution certificate for both iOS and macOS app signing.
- Create one **Mac Installer Distribution** certificate for the macOS package.
  This is not a Developer ID Installer certificate.
- Create an **App Store Connect** provisioning profile for iOS.
- Create a **Mac App Store Connect** provisioning profile for macOS.

Apple documents those certificate purposes in
[Certificates overview](https://developer.apple.com/help/account/certificates/certificates-overview)
and the two profile types in
[Create an App Store Connect provisioning profile](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile).
Both profiles must use the explicit App ID `com.sats21m.masonsbudget`, team
`384ZGKG4GB`, and the new Apple Distribution certificate.

## 1. Keep the release path disabled

From a Mac with `gh` authenticated for `only21mil/masons-budget`:

```bash
gh variable set APPLE_MANUAL_SIGNING_READY \
  --repo only21mil/masons-budget \
  --body false
```

Verification command:

```bash
test "$(gh variable get APPLE_MANUAL_SIGNING_READY \
  --repo only21mil/masons-budget)" = "false"
```

Do not proceed if that command exits nonzero.

## 2. Inspect the certificate cap before creating anything

After the separately owned Apple-certificate containment workflow is merged,
run its read-only mode:

```bash
gh workflow run apple-certificates.yml \
  --repo only21mil/masons-budget \
  --ref main \
  --field command=list
gh run list \
  --repo only21mil/masons-budget \
  --workflow apple-certificates.yml \
  --limit 1
```

Verification command: open the run URL printed by the second command and require
the `Inspect or clear Apple signing certificates` job to be green. The list must
show enough capacity for the two certificate types above.

If capacity is exhausted by the development certificates created by the failed
automatic-signing runs, revoke only certificate IDs that the containment
workflow classifies as development certificates. Never revoke a distribution
certificate based only on age or name. Re-run the read-only `list` command after
any approved containment action. Certificate cleanup is one-time containment;
the durable prevention is that the release workflow contains neither automatic
Release signing nor `-allowProvisioningUpdates`.

## 3. Create two CSRs and certificates on the Mac

In Keychain Access:

1. Choose **Keychain Access → Certificate Assistant → Request a Certificate
   From a Certificate Authority**.
2. Enter the Apple Developer account email and a distinct common name such as
   `Vogel Vault Apple Distribution 2026`.
3. Leave the CA email blank, choose **Saved to disk**, and save the CSR.
4. Repeat with a distinct common name such as
   `Vogel Vault Mac Installer Distribution 2026`.

Apple's exact CSR steps are in
[Create a certificate signing request](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request).

Verification commands:

```bash
openssl req \
  -in "/absolute/path/VogelVaultAppleDistribution.certSigningRequest" \
  -noout -verify -subject
openssl req \
  -in "/absolute/path/VogelVaultMacInstaller.certSigningRequest" \
  -noout -verify -subject
```

Both commands must report that the certificate request self-signature verifies.

In Apple Developer **Certificates, Identifiers & Profiles → Certificates**:

1. Create **Apple Distribution** with the first CSR.
2. Create **Mac Installer Distribution** with the second CSR.
3. Download both `.cer` files and double-click each to import it into the same
   login keychain that holds its CSR-created private key.
4. In Keychain Access → My Certificates, expand each certificate and confirm a
   private key appears directly under it.

Verification commands:

```bash
security find-identity -v -p codesigning |
  grep '"Apple Distribution:.*(384ZGKG4GB)"'
security find-identity -v -p basic |
  grep '"Mac Installer Distribution:.*(384ZGKG4GB)"'
```

Each command must print exactly the intended current identity. Stop if either
identity is missing, expired, belongs to another team, or lacks its private key.
Do not create an Apple Development certificate.

## 4. Export and verify fresh p12 files

In Keychain Access → My Certificates:

1. Expand the new Apple Distribution certificate.
2. Select the certificate and its private key together.
3. Choose **File → Export Items**, select Personal Information Exchange
   (`.p12`), and set a new strong export password.
4. Repeat for Mac Installer Distribution with a different `.p12` file and
   password.

Use new filenames, for example `VogelVaultAppleDistribution-2026.p12` and
`VogelVaultMacInstaller-2026.p12`. Do not reuse or overwrite the old p12 and
password pair; it is known not to match.

Verify the exact files and passwords in an isolated temporary keychain:

```bash
VV_SIGNING_DIR="/absolute/path/to/the/new/signing-assets"
VV_DIST_P12="$VV_SIGNING_DIR/VogelVaultAppleDistribution-2026.p12"
VV_INSTALLER_P12="$VV_SIGNING_DIR/VogelVaultMacInstaller-2026.p12"
read -r -s -p "Apple Distribution p12 password: " VV_DIST_P12_PASSWORD
printf '\n'
read -r -s -p "Mac Installer p12 password: " VV_INSTALLER_P12_PASSWORD
printf '\n'

VV_VERIFY_DIR=$(mktemp -d "${TMPDIR%/}/vv-signing-verify.XXXXXX")
VV_VERIFY_KEYCHAIN="$VV_VERIFY_DIR/verify.keychain-db"
VV_VERIFY_KEYCHAIN_PASSWORD=$(uuidgen)
security create-keychain \
  -p "$VV_VERIFY_KEYCHAIN_PASSWORD" \
  "$VV_VERIFY_KEYCHAIN"
security unlock-keychain \
  -p "$VV_VERIFY_KEYCHAIN_PASSWORD" \
  "$VV_VERIFY_KEYCHAIN"
security import "$VV_DIST_P12" \
  -k "$VV_VERIFY_KEYCHAIN" \
  -P "$VV_DIST_P12_PASSWORD" \
  -T /usr/bin/codesign \
  -T /usr/bin/security
security import "$VV_INSTALLER_P12" \
  -k "$VV_VERIFY_KEYCHAIN" \
  -P "$VV_INSTALLER_P12_PASSWORD" \
  -T /usr/bin/productbuild \
  -T /usr/bin/security
security find-identity -v -p codesigning "$VV_VERIFY_KEYCHAIN" |
  grep '"Apple Distribution:.*(384ZGKG4GB)"'
security find-identity -v -p basic "$VV_VERIFY_KEYCHAIN" |
  grep '"Mac Installer Distribution:.*(384ZGKG4GB)"'
security delete-keychain "$VV_VERIFY_KEYCHAIN"
rmdir "$VV_VERIFY_DIR"
```

Verification result: both imports and both `grep` commands exit `0`. An import
failure proves that the p12/password pair does not match; do not set repository
secrets in that state.

Keep the two p12 files, their passwords, the downloaded certificates, and the
profiles in durable encrypted storage controlled by the family. Retaining a
recoverable original is part of this fix—the former pair could not be repaired
after its only source machine was lost.

## 5. Create and verify the two App Store profiles

In Apple Developer **Certificates, Identifiers & Profiles → Profiles**:

1. Under Distribution, create **App Store Connect** for iOS.
2. Choose the explicit App ID for `com.sats21m.masonsbudget`.
3. Choose the new Apple Distribution certificate.
4. Name it `Vogel Vault iOS App Store Manual`, generate it, and download the
   `.mobileprovision` file.
5. Under Distribution, create **Mac App Store Connect** for macOS.
6. Choose the same explicit App ID and Apple Distribution certificate.
7. Name it `Vogel Vault macOS App Store Manual`, generate it, and download the
   `.provisionprofile` file.

Set local paths, derive the Apple Distribution certificate fingerprint, and
decode the profiles:

```bash
VV_IOS_PROFILE="$VV_SIGNING_DIR/Vogel_Vault_iOS_App_Store_Manual.mobileprovision"
VV_MAC_PROFILE="$VV_SIGNING_DIR/Vogel_Vault_macOS_App_Store_Manual.provisionprofile"
VV_DIST_CERT_SHA256=$(
  openssl pkcs12 \
    -in "$VV_DIST_P12" \
    -clcerts -nokeys \
    -passin env:VV_DIST_P12_PASSWORD |
    openssl x509 -outform DER |
    shasum -a 256 |
    awk '{print $1}'
)
VV_IOS_PROFILE_PLIST="$VV_VERIFY_DIR-ios.plist"
VV_MAC_PROFILE_PLIST="$VV_VERIFY_DIR-macos.plist"
security cms -D -i "$VV_IOS_PROFILE" > "$VV_IOS_PROFILE_PLIST"
security cms -D -i "$VV_MAC_PROFILE" > "$VV_MAC_PROFILE_PLIST"
```

Verification command for the iOS profile:

```bash
VV_PROFILE_PLIST="$VV_IOS_PROFILE_PLIST" \
VV_EXPECTED_PLATFORM="iOS" \
VV_EXPECTED_CERT_SHA256="$VV_DIST_CERT_SHA256" \
python3 - <<'PY'
import datetime
import hashlib
import os
import plistlib

with open(os.environ["VV_PROFILE_PLIST"], "rb") as handle:
    profile = plistlib.load(handle)

entitlements = profile["Entitlements"]
certificate_hashes = {
    hashlib.sha256(certificate).hexdigest()
    for certificate in profile["DeveloperCertificates"]
}
assert profile["TeamIdentifier"] == ["384ZGKG4GB"]
assert profile["Platform"] == [os.environ["VV_EXPECTED_PLATFORM"]]
assert entitlements["application-identifier"] == (
    "384ZGKG4GB.com.sats21m.masonsbudget"
)
assert entitlements["get-task-allow"] is False
assert profile["ExpirationDate"] > datetime.datetime.now()
assert os.environ["VV_EXPECTED_CERT_SHA256"] in certificate_hashes
print("PASS: profile team, platform, bundle, distribution mode, expiry, and certificate")
PY
```

Verification command for the macOS profile:

```bash
VV_PROFILE_PLIST="$VV_MAC_PROFILE_PLIST" \
VV_EXPECTED_PLATFORM="OSX" \
VV_EXPECTED_CERT_SHA256="$VV_DIST_CERT_SHA256" \
python3 - <<'PY'
import datetime
import hashlib
import os
import plistlib

with open(os.environ["VV_PROFILE_PLIST"], "rb") as handle:
    profile = plistlib.load(handle)

entitlements = profile["Entitlements"]
certificate_hashes = {
    hashlib.sha256(certificate).hexdigest()
    for certificate in profile["DeveloperCertificates"]
}
assert profile["TeamIdentifier"] == ["384ZGKG4GB"]
assert profile["Platform"] == [os.environ["VV_EXPECTED_PLATFORM"]]
assert entitlements["application-identifier"] == (
    "384ZGKG4GB.com.sats21m.masonsbudget"
)
assert entitlements["get-task-allow"] is False
assert profile["ExpirationDate"] > datetime.datetime.now()
assert os.environ["VV_EXPECTED_CERT_SHA256"] in certificate_hashes
print("PASS: profile team, platform, bundle, distribution mode, expiry, and certificate")
PY
rm -f "$VV_IOS_PROFILE_PLIST" "$VV_MAC_PROFILE_PLIST"
```

Both Python commands must exit `0`. These checks prove each profile is
non-debug, unexpired, for the exact team/bundle/platform, and contains the same
Apple Distribution certificate exported to the p12.

## 6. Set the new repository secrets

The workflow requires six new signing secrets. The old three `APPLE_*` names
remain retired and must not be repurposed.

```bash
base64 < "$VV_DIST_P12" |
  gh secret set APPLE_DISTRIBUTION_CERTIFICATE_P12 \
    --repo only21mil/masons-budget
printf '%s' "$VV_DIST_P12_PASSWORD" |
  gh secret set APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD \
    --repo only21mil/masons-budget
base64 < "$VV_IOS_PROFILE" |
  gh secret set APPLE_IOS_APP_STORE_PROFILE \
    --repo only21mil/masons-budget
base64 < "$VV_MAC_PROFILE" |
  gh secret set APPLE_MAC_APP_STORE_PROFILE \
    --repo only21mil/masons-budget
base64 < "$VV_INSTALLER_P12" |
  gh secret set APPLE_MAC_INSTALLER_CERTIFICATE_P12 \
    --repo only21mil/masons-budget
printf '%s' "$VV_INSTALLER_P12_PASSWORD" |
  gh secret set APPLE_MAC_INSTALLER_CERTIFICATE_PASSWORD \
    --repo only21mil/masons-budget
unset VV_DIST_P12_PASSWORD VV_INSTALLER_P12_PASSWORD
```

Verification command:

```bash
gh secret list \
  --repo only21mil/masons-budget \
  --json name \
  --jq 'map(.name) | map(select(
    . == "APPLE_DISTRIBUTION_CERTIFICATE_P12" or
    . == "APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD" or
    . == "APPLE_IOS_APP_STORE_PROFILE" or
    . == "APPLE_MAC_APP_STORE_PROFILE" or
    . == "APPLE_MAC_INSTALLER_CERTIFICATE_P12" or
    . == "APPLE_MAC_INSTALLER_CERTIFICATE_PASSWORD"
  )) | sort | length'
```

The command must print `6`. This proves only that all six names exist; the local
keychain/profile checks above prove the corresponding bytes and passwords.

## 7. Run the non-build release preflight

After this change is merged to `main`, run:

```bash
gh workflow run release-preflight.yml \
  --repo only21mil/masons-budget \
  --ref main
gh run list \
  --repo only21mil/masons-budget \
  --workflow release-preflight.yml \
  --limit 1
```

Verification command: open the listed run and require both `Report release
secret presence` and `Verify App Store Connect bundle visibility` to be green.
The report checks that every required secret is present and that encoded values
are base64-shaped. It intentionally does not claim that Linux can open a p12 or
validate an Apple CMS profile; the Mac checks in steps 4 and 5 do that.

## 8. Enable the guarded path

Only after steps 1–7 pass:

```bash
gh variable set APPLE_MANUAL_SIGNING_READY \
  --repo only21mil/masons-budget \
  --body true
```

Verification command:

```bash
test "$(gh variable get APPLE_MANUAL_SIGNING_READY \
  --repo only21mil/masons-budget)" = "true"
```

Setting the variable does not authorize a build. Before the first TestFlight
run, Victor must separately approve the build/release sequence, the build number
must be bumped in `MasonsBudget/project.yml`, both platforms must be selected,
required checks on the exact `main` SHA must be green, and other active lanes
must be checked. Those are the existing release gates.

## What this runbook does not prove

These commands prove that the new local p12/password pairs import, the expected
private-key identities exist, the profiles match their certificate and exact
team/bundle/platform, the repository secret names exist, and the read-only
preflight sees App Store Connect.

They do not prove that Xcode 26.6 can produce a signed iOS archive, signed macOS
archive, `.ipa`, or `.pkg` from these assets; that proof requires the first
approval-gated GitHub release run. They also do not prove App Store Connect will
accept the uploaded artifacts. No signed archive or upload was run while
preparing this change.
