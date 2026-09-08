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
Flutter 3.41.7 Hermit tool, and builds with Xcode 26.6 build 17F113. It uses the
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
public inventory receipt before rejecting an unavailable number. Uploads not yet visible in ASC remain subject to
Apple's own collision rejection. The signed IPA and source receipt are retained
before upload.
Upload uses the retained App Store Connect credential and a private run-scoped
key file through Apple's existing altool route.

The upload receipt records transport success. A separate read-only ASC step
polls for the exact version/build for up to 20 minutes, fails on FAILED or INVALID,
and retains `asc-processed.json` only after VALID. The final receipt artifact
runs after failures too, retaining any existing upload and ASC inventory receipts. Token signing uses the existing Node crypto client in memory and writes no
private key file. Processing success leaves group assignment and
installation unverified. Assign the valid build to the approved Buzz internal
group. Tester identity/access and any invitation are separately scoped; never broaden unrelated app access or
send emails without existing authorization. Rachel's TestFlight install/launch
needs device or user-confirmed evidence. No USB connection is required for
TestFlight delivery. Preserve prior artifacts; recovery is a corrected build
with an increased build number, never destructive app removal.

## Preserved artifact signing recovery

The manual `buzz-ios-signing-recovery.yml` signs the successful unsigned build
from run 34247966654, attempt 1, artifact 10065006053. Its trusted driver pins
the original controller, successful build job, provider artifact digest and both
contained file hashes. It never compiles or executes fetched app code. The
original receipt stays byte-identical; a separate provenance receipt identifies
the current recovery run and controller. Temporary signing paths use the current
execution identity.

The original signing attempt failed before upload with no usable error detail.
Recovery retains fixed native phase names, error classifications and assertion
hashes while applying the same profile, identity, entitlement and signature
checks. It never logs command arguments, raw native output, secrets or private
paths. Existing ASC inventory, IPA retention, upload and processing checks run
in the same recovery when signing succeeds. Public recovery receipts survive
failures and temporary signing material is always cleaned up.

## Invite one recipient to the preserved TestFlight build

`buzz-testflight-recipient.yml` operates only on Buzz 0.5.9 build 1, already
uploaded and VALID. It creates no build, signing artifact, App Store version,
team user, or account role. The operator must first run `inventory`, then
review the fresh group and build beta state before selecting `distribute`.
The selected group must have no public link or all-build access. A new build
assignment refuses to reach unrelated testers. `new-private` creates or reuses
only `Buzz private beta`; internal groups require existing recipient membership.

The approved recipient travels through the temporary Actions secret
`BUZZ_TESTFLIGHT_RECIPIENT_20260908`, never through workflow inputs or source.
Check that the name is absent before creation, supply its value through stdin,
and remove it after the terminal operation. Existing ASC secrets stay in their
current GitHub custody. Artifacts retain redacted provider state and mutation
receipts. A failed request is never retried automatically; inspect fresh
inventory before recovery to prevent duplicate invitations. Apple beta review
submission is limited to the fixed build and may leave a pending external
approval. Missing beta metadata requires a separately reviewed factual update.
A successful invitation does not prove a physical installation.

Recipient membership also refuses access to older builds in the selected group.
Group names never enter receipts. Apple Ready to Test is pending until a scoped
build notification and live IN_BETA_TESTING readback succeed. Notifications and
auto-notifying beta review submission refuse any unrelated build audience.
API failures retain only bounded error codes and attribute pointers.

Inventory reports presence-only beta review contact, description, feedback email
and test notes for the fixed app/build. It never requests or retains demo-account credential fields.
Submission refuses missing required metadata or unverified demo-account access.

The separate `metadata` action accepts only a reviewed JSON object in temporary
`BUZZ_TESTFLIGHT_REVIEW_20260908` Actions input. Allowed sections are
`review_detail`, `localizations`, and `test_notes`. It patches existing review
contact fields, creates or patches explicitly supplied locale descriptions and
feedback addresses, and creates or patches exact-build test notes. Values stay
out of dispatch inputs and receipts; every write receives an exact-value
readback. It cannot set demo-account credentials or submit review. Metadata
values must come from the operator and require a concrete reviewed plan. Remove
this temporary input after its terminal run and verify name absence.

Metadata IDs are opaque strings obtained from the fixed app/build. A PATCH
response must preserve its selected ID. If tester setup succeeds but review
metadata is missing, distribution retains verified membership and reports
BETA_REVIEW_METADATA_REQUIRED; it does not submit review or claim availability.
