# Buzz iOS TestFlight releases

The manual `buzz-ios-release.yml` carrier uses the existing Apple account and
protected Distribution/ASC credentials. It creates a separate Buzz iOS product;
it never changes Vogel Vault app identities, profiles, builds or testers.

The source's existing AppOverrides mechanism supplies the fixed fork parent,
NotificationService, App Group and production APNs/App Attest configuration.
The trusted build recipe and unsigned receipt bind the exact override bytes,
source commit, marketing version and build number. Account-side identifiers and
capabilities must already match those fixed values before signing.

## Build and signing boundary

The iOS carrier uses two separate GitHub-hosted `macos-26` VMs. Its unsigned
job fetches the explicit immutable Buzz commit, activates that source's pinned
Flutter 3.41.7 Hermit tool, and builds with Xcode 26.3 build 17C529. It uses the
normal iOS resource compiler and never receives Distribution or ASC credentials.
The existing installed MBP sandbox remains unchanged. Its deferred native
resource work does not gate this hosted delivery path.

The unsigned job retains `unsigned-ios.app.tar.gz` and `build-ios.json`. The
receipt binds source, overrides, marketing version, build number, workflow SHA,
run ID, run attempt and archive hash. Download stays within the same workflow
run, and the separate signer checks every binding before extraction. The build
job has no checkout credentials persisted, signing secrets or shared caches.
The `buzz-ios-testflight-release` concurrency group serializes iOS numbering and
uploads independently of the Mac carrier's host lease.

The signing job validates and extracts the inert archive before credentials
exist. It never checks out or executes Buzz scripts. It reuses the retained
Distribution identity in a temporary keychain and the two existing Buzz-specific App
Store profiles. Exact profile team, app, certificate, expiry and entitlements
are checked. All Mach-O files must be arm64. The parent and NSE receive only
their expected entitlements; nested code is signed separately. Both bundles
must pass strict signature and entitlement readback before IPA retention.

The already-configured Distribution certificate/password and ASC secrets remain
in their existing Actions custody. Add only `BUZZ_IOS_APP_STORE_PROFILE` and
`BUZZ_IOS_NSE_APP_STORE_PROFILE` as base64 public profiles after account setup
review and verification. No API key export, new signing key or credential
rotation is part of this release path. Run-scoped keychain and raw material are removed on success or failure.
The signer temporarily adds its keychain to its disposable VM's search list
while codesign runs, verifies visibility, and restores that list on exit.
Signing rejects persistent hosts. No installed provisioning profile is changed.

## Release and verification

Dispatch only reviewed, landed source after its applicable CI passes. Choose a
marketing version and increasing build number. After inert preparation, the
trusted signer reads ASC app 6809565361, requires bundle com.sats21m.buzz, and
rejects any requested number already used or superseded in that iOS marketing
version. This check uses the existing ASC environment credentials and retains a
public inventory receipt. Uploads not yet visible in ASC remain subject to
Apple's own collision rejection. The signed IPA and source receipt are retained
before upload.
Upload uses the retained App Store Connect credential and a private run-scoped
key file through Apple's existing altool route.

The upload receipt records transport success. A separate read-only ASC step
polls for the exact version/build for up to 20 minutes, fails on FAILED or INVALID,
and retains `asc-processed.json` only after VALID. Token signing uses the existing Node crypto client in memory and writes no
private key file. Processing success leaves group assignment and
installation unverified. Assign the valid build to the approved Buzz internal
group. Tester identity/access and any invitation are separately scoped; never broaden unrelated app access or
send emails without existing authorization. Rachel's TestFlight install/launch
needs device or user-confirmed evidence. No USB connection is required for
TestFlight delivery. Preserve prior artifacts; recovery is a corrected build
with an increased build number, never destructive app removal.
