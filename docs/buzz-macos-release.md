# Manual Buzz Mac release through the protected Apple route

`buzz-macos-release.yml` builds one immutable public `only21mil/buzz` commit
for Apple Silicon and Intel. It imports the dedicated Developer ID Application
p12 on the approved Mac, signs nested code and the app, notarizes and staples
both the app and DMG, and returns final artifacts. It never publishes a release.

This reuses the Apple team and protected ASC credentials proven by Bitcoin
Budget run `33999621459`, at Budget commit
`c0b9db0f8959b14df4a8cf870820cb5b85e6207b`. That iOS run proves the existing
credential route, temporary keychain pattern, and cleanup approach. It does
not prove Developer ID signing or notarization. The first successful Mac run
must establish those facts with real Apple responses.

The source currently selected by the release controller is Buzz
`9daaf702afa3ed1146bd3cdd96af1f023f28f9fb`, desktop version `0.5.8`. The
workflow checks the committed version and does not patch source versions or
lockfiles. Later releases must supply another fully reviewed immutable commit
and its committed desktop version.

## Credential boundary

Buzz and dependency build scripts run on ephemeral GitHub-hosted `macos-15`
runners, with read-only repository access and only the public updater key and
fixed fork endpoint. Source builds cannot reach any Apple or updater private
credential. Apple Silicon keeps the maintained `mesh-llm` native library build;
Intel follows the maintained Intel release feature selection. Both retain the
platform sidecar configuration and build all six native sidecars.

The signing job runs on `macbook-pro-m5`. The dispatch input must explicitly
select `mac-mini-m4` to use the fallback. It checks out only the trusted Budget
workflow scripts, installs the integrity-locked Tauri CLI with lifecycle scripts
disabled, and validates the same-run unsigned archive before secrets are bound.
It never checks out Buzz or executes an app binary, source script, or artifact
script. Its copy of `desktop/scripts/verify-macos-entitlements.sh` is reviewed
in Budget and hash-compared with the immutable Buzz source during packaging.

The signer rejects archive traversal, links escaping the app, writes through
links, special files, duplicate names, privileged modes, and other app roots.
It checks the bundle identifier, version, and architecture of every Mach-O
file. It signs nested Mach-O code and bundles before signing the outer app.

The credential step reads these protected Budget secrets:

- `BUZZ_DEVELOPER_ID_P12_B64`, with the matching Apple intermediate chain.
- `BUZZ_DEVELOPER_ID_P12_PASSWORD`, the bootstrap's URL-safe ASCII password.
- `BUZZ_TAURI_SIGNING_PRIVATE_KEY`, with an empty updater password.
- Existing `ASC_API_KEY_P8`, `ASC_KEY_ID`, and `ASC_ISSUER_ID`.

The repository variable `BUZZ_TAURI_SIGNING_PUBLIC_KEY` contains base64-encoded
minisign public-key text. Builds embed that public key and
`https://github.com/only21mil/buzz/releases/download/buzz-desktop-latest/latest.json`.

Private material uses mode-0600 files inside the mode-0700 run-scoped protected
signing directory on the Mac, matching the existing temporary Apple route.
The p12 and keychain passwords reach `security -i` through stdin, with captured
output. They never enter process arguments or retained logs. Each Apple signing
command selects the temporary keychain explicitly. The job never replaces the
runner's keychain search list or default keychain; deleting the temporary
keychain removes its registration. Cleanup runs in the Python `finally`
block and the workflow's `always()` step. A cleanup failure prevents successful
artifact upload and must be resolved before another attempt. Force termination
or a lost host can prevent any in-process cleanup, so inspect the recorded
run-scoped directory before recovery on that host.

## Output contract

Each architecture produces Actions artifact
`buzz-macos-signed-<arch>-<40-character-source-SHA>`, containing:

- `Buzz_<version>_<arch>.dmg`.
- `Buzz_<version>_<arch>.app.tar.gz`, rebuilt from the final stapled app.
- The archive's `.sig`, created with the retained updater private key.
- `mac-release-<arch>.json` and `build-<arch>.json`.
- Architecture-prefixed notarization submission JSON, logs, and successful
  `codesign`, `spctl`, entitlements, and stapler validation receipts.

All asset and receipt names are unique across architectures. The release
manifest schema is `buzz-macos-release-v1`. It contains `source.repository`
and `source.sha`; `version`, `arch`, and `target`; updater endpoint, public key,
and fingerprint; Developer ID identity, team, and certificate fingerprint;
Budget run ID, attempt, URL, and exact workflow commit; asset file records;
`Accepted` app and DMG notarization IDs and file records; successful verification
file records; and the build receipt plus unsigned archive hash.

Every file record has exactly `name`, `sha256`, and `size`. Public-key identity
is SHA-256 of the decoded minisign text bytes, including its retained newline.
Certificate identity is SHA-256 of the DER leaf certificate. Verification
receipts are only referenced after their commands exit successfully. The
publisher verifies updater signatures independently and must authenticate the
successful exact workflow run; a JSON claim alone grants no release authority.
Failed notary submissions retain diagnostic JSON under a separate diagnostics
artifact, with no successful signed-candidate claim.

## Activation and release sequence

The root controller owns promotion and signing authorization. Preparation and
portable tests perform no signing, app build, credential mutation, or publishing.

1. Integrate this candidate and the separate bootstrap candidate onto a fresh
   branch from current Budget `main`, preserving the active Budget lane. Run
   workflow lint and focused helper tests on the combined exact candidate, then
   complete the required independent review. The root binds the complete changed
   path manifest, exact commit, diff hash, approval, and rollback commit.
2. Land the reviewed workflow through the Budget pull-request route. A new
   `workflow_dispatch` file must exist on default `main` before GitHub registers
   it. Fetch current main immediately before integration and landing; do not
   reset or overwrite another lane. Record the resulting exact main commit and
   its required CI. This is a workflow-only change, not a Budget app release.
3. Complete the separately reviewed minimum bootstrap under the approved Apple
   team. Read back presence and public identities without retrieving secrets.
4. Verify Buzz's exact committed source CI, independent review, source version,
   current channel version, and release approval. Then dispatch the workflow
   from the exact reviewed Budget commit, with that immutable Buzz source,
   matching version, and `runner=macbook-pro-m5`. Do not use a floating branch
   as evidence. A run retry must rebuild both architectures because build
   receipts bind the run attempt.
5. Require both signing jobs and cleanup to pass. Download both signed artifacts,
   verify every file hash and updater signature, require both app and DMG
   notarizations to be `Accepted`, and inspect the retained Apple logs. Verify
   the exact Budget run and workflow commit. A test suite is not live proof.
6. Hand the artifact pair to Buzz's fork-owned publisher. The Buzz controller
   must complete relay-first immutable tag readback, publication review and
   gates, versioned assets, rolling updater JSON last, anonymous download checks,
   and a real Mac Gatekeeper and updater check before claiming delivery.

Rollback before dispatch is the previous Budget workflow commit, preserving
all unrelated changes. After signing, deleting a candidate artifact does not
revoke a certificate or undo an Apple notarization. Channel rollback must use
the retained previous manifest and assets through the Buzz publisher's governed
route. Certificate revocation and credential rotation require separate approval.

## Focused verification

Run from Budget's checkout:

```bash
python3 .github/workflows/scripts/tests/test_mac_release_workflow.py
python3 .github/workflows/scripts/check_action_pins.py
python3 .github/workflows/scripts/check_secret_inventory.py
actionlint
shellcheck .github/workflows/scripts/buzz_macos_build.sh
```

These tests cover input binding, archive attacks, app identity, credential
isolation, confidential stdin, receipt creation, and failed cleanup. The real
Apple code signing, nested-code compatibility, notarization access, stapling,
Gatekeeper assessment, and updater acceptance require the authorized Mac run.

References: [Apple notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
and [Tauri signer CLI](https://v2.tauri.app/reference/cli/#signer-sign).
