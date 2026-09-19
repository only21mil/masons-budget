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

## Premerge qualification at the actual release commit

Qualify the reviewed candidate before landing it. `deploy.yml` invokes the
trusted provider verifier at the current main SHA. It binds the original PR
workflow suites, job attempts, check identities, dependency/context artifacts,
tested tree and protected policy to the actual landed commit. It does not
schedule another Swift or Clients run after merge.

A failed, missing, stale or unexplained skipped source check blocks release.
The unchanged PR path rules may prove an unrelated job inapplicable; that skip
remains a skip and never becomes a passing build. Apple changes still require
successful project consistency and Apple execution in the source qualification.
The explicit release archive compiles and signs in its fresh release context.

Before dispatch, retain fresh GitHub `main` and GitHub PR
readback, the tested base and landing parents, and required-checks green. The hosted verifier checks GitHub
provider authority; Buzz-mirror convergence is informational and never replaces
that GitHub delivery evidence.

See [CI result reuse](ci-result-reuse.md) for bootstrap and refusal handling.
Do not use a manual all-platform main run to manufacture a second qualification.
If source qualification is missing or expired, qualify the reviewed candidate
before promotion. Release approval and signing-asset readiness remain required.

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
