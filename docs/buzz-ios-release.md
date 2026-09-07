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

The reviewed MBP supervisor accepts an explicit `arch=ios` request with a build
number and no updater parameters. The unchanged dedicated user, kernel group
checks, Seatbelt policy, root-owned installed payload hashes, UID-wide descendant
drain, supervisor lock and bounded file export also apply to iOS. The only iOS
outputs are `unsigned-ios.app.tar.gz` and `build-ios.json`. No arbitrary command,
bundle, profile, output name, keychain or repository comes from the request.

Both carriers use the `buzz-apple-release` concurrency group. Do not change the
installed supervisor while either carrier or its build user is active. The
operator must retain the prior installed receipt, remove only that exact idle
installation through its reviewed removal procedure, and install the new frozen
payload through the existing reviewed prepare/install procedure. This is an
operator action; the workflow never installs or upgrades its own root boundary.

The signing job validates and extracts the inert archive before credentials
exist. It never checks out or executes Buzz scripts. It reuses the retained
Distribution identity in a temporary keychain and two new Buzz-specific App
Store profiles. Exact profile team, app, certificate, expiry and entitlements
are checked. All Mach-O files must be arm64. The parent and NSE receive only
their expected entitlements; nested code is signed separately. Both bundles
must pass strict signature and entitlement readback before IPA retention.

The already-configured Distribution certificate/password and ASC secrets remain
in their existing Actions custody. Add only `BUZZ_IOS_APP_STORE_PROFILE` and
`BUZZ_IOS_NSE_APP_STORE_PROFILE` as base64 public profiles after account setup
review and verification. No API key export, new signing key or credential
rotation is part of this release path. Run-scoped keychain and raw material are
removed on success or failure. Existing persistent keychain search lists and
installed provisioning profiles are unchanged.

## Release and verification

Dispatch only reviewed, landed source after its applicable CI passes. Choose a
marketing version and unused, increasing build number after reading the exact
Buzz ASC app. The signed IPA and source receipt are retained before upload.
Upload uses the retained App Store Connect credential and a private run-scoped
key file through Apple's existing altool route.

A successful upload receipt explicitly leaves processing and installation
unverified. Use ASC build readback to prove the exact version/build is valid,
then assign it to the approved Buzz internal group. Tester identity/access and
any invitation are separately scoped; never broaden unrelated app access or
send emails without existing authorization. Rachel's TestFlight install/launch
needs device or user-confirmed evidence. No USB connection is required for
TestFlight delivery. Preserve prior artifacts; recovery is a corrected build
with an increased build number, never destructive app removal.
