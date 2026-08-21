# Self-hosted Apple release setup

`.github/workflows/deploy.yml` is intentionally inert until its manual-signing
assets have been reviewed. Preparing those assets does not authorize a build or
release.

## Runner contract

- MacBook Pro primary: `self-hosted`, `macOS`, `ARM64`, `xcode`, `mason-mbp`
- Mac mini fallback: `self-hosted`, `macOS`, `ARM64`, `xcode`, `mason-mini`
- Both hosts must expose Xcode `26.6` through `/Applications/Xcode.app`.
- The mini is selected only with the manual `apple_runner: mini` input.

Do not put both custom machine labels on one runner. Automatic Swift events
select `mason-mbp` and cannot fall through to the mini.

## Fail-closed configuration

Keep repository variable `APPLE_MANUAL_SIGNING_READY` absent or set to `false`
until all assets below have been created together and validated. The release
gate accepts only the exact value `true`.

Required repository secrets:

- `APPLE_DISTRIBUTION_CERTIFICATE_P12`
- `APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD`
- `APPLE_IOS_APP_STORE_PROFILE`
- `APPLE_MAC_APP_STORE_PROFILE`
- `APPLE_MAC_INSTALLER_CERTIFICATE_P12`
- `APPLE_MAC_INSTALLER_CERTIFICATE_PASSWORD`
- `ASC_API_KEY_P8`
- `ASC_KEY_ID`
- `ASC_ISSUER_ID`

The three old generic `APPLE_CERTIFICATE_*` / `APPLE_PROVISIONING_PROFILE`
values are retired and are never fallbacks.

Create a fresh Apple Distribution certificate with its private key, a Mac
Installer Distribution certificate with its private key, and non-debug App
Store profiles for both iOS and macOS. Both profiles must identify team
`384ZGKG4GB` and bundle `com.sats21m.masonsbudget`. Export each certificate and
private key together as a password-protected p12; base64-encode each binary p12
and profile before setting its matching secret.

Run the read-only `Release and App Store Connect preflight` workflow. Require
all release secrets to report present and the exact bundle probe to pass. Then,
and only then, set `APPLE_MANUAL_SIGNING_READY=true`.

## Required exact-SHA Apple verification

Every release SHA must have successful `Verify committed Xcode project` and
`Build and test the Apple client` checks, including a commit whose diff contains
no Apple-owned files. A normal Swift CI run may legitimately skip both checks
for such a commit, but the release gate does not accept those skips.

When either Apple check is skipped or missing, manually run Swift CI on the
current `main` with the MacBook Pro, wait for it to pass, and confirm `main` has
not advanced before starting the deploy. The commands below contain no secrets:

```bash
release_repo=only21mil/masons-budget
release_sha="$(gh api "repos/$release_repo/git/ref/heads/main" --jq .object.sha)"

gh workflow run swift.yml \
  --repo "$release_repo" \
  --ref main \
  -f apple_runner=mbp

# Wait for the new workflow_dispatch run to appear, then select its databaseId.
gh run list \
  --repo "$release_repo" \
  --workflow swift.yml \
  --event workflow_dispatch \
  --commit "$release_sha" \
  --limit 5 \
  --json databaseId,createdAt,headSha,status,url

swift_run_id=REPLACE_WITH_THE_NEW_RUN_DATABASE_ID
gh run watch "$swift_run_id" --repo "$release_repo" --exit-status
test "$(gh run view "$swift_run_id" --repo "$release_repo" \
  --json headSha --jq .headSha)" = "$release_sha"

current_main="$(gh api "repos/$release_repo/git/ref/heads/main" --jq .object.sha)"
test "$current_main" = "$release_sha"

gh workflow run deploy.yml \
  --repo "$release_repo" \
  --ref main \
  -f platform=both \
  -f apple_runner=mbp
```

If the final SHA comparison fails, `main` moved after Swift CI was dispatched.
Do not deploy; repeat the sequence for the new current SHA. The deploy workflow
also re-evaluates all required checks against its own exact `github.sha` and
fails closed if the successful Swift checks belong to an older commit.

## Persistent-host safety

Each matrix leg creates separate signing and release directories containing its
run ID, attempt, and platform under `RUNNER_TEMP`. Before changing the user
keychain search list, it records the complete prior list. The final `always()`
cleanup restores that list, deletes the temporary keychain, removes only the
exact profile created by that leg, and deletes only those validated run-scoped
directories. If the UUID path already contains the identical profile, the run
reuses and preserves it. If that path contains different bytes, signing fails
closed rather than overwriting a persistent-host asset.

At the start of the next release leg, the workflow also scans for interrupted
prior runs. It recognizes an artifact only when its strict run/attempt/platform
name and workflow ownership marker both match. A stale keychain is removed from
the current search list without replacing or reordering unrelated entries. A
profile is removed only when its recorded digest and either its creation marker
or its still-linked staging inode prove that the interrupted run created it.
Unmarked lookalikes and ownership mismatches are preserved for manual review.
The same marker guard applies to stale release output directories.

Never replace that cleanup with deletion of `~/private_keys` or the whole
Provisioning Profiles directory. Those locations may contain unrelated assets
on a persistent runner.

Triggering `Deploy to TestFlight` still requires Victor's explicit release
approval. Default to `apple_runner: mbp`; use `mini` only as a deliberate
fallback after confirming its signing/toolchain parity.
