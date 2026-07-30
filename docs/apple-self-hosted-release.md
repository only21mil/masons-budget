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

## Persistent-host safety

Each matrix leg creates separate signing and release directories containing its
run ID, attempt, and platform under `RUNNER_TEMP`. Before changing the user
keychain search list, it records the complete prior list. The final `always()`
cleanup restores that list, deletes the temporary keychain, removes only the
exact profile created by that leg, and deletes only those validated run-scoped
directories. If the UUID path already contains the identical profile, the run
reuses and preserves it. If that path contains different bytes, signing fails
closed rather than overwriting a persistent-host asset.

Never replace that cleanup with deletion of `~/private_keys` or the whole
Provisioning Profiles directory. Those locations may contain unrelated assets
on a persistent runner.

Triggering `Deploy to TestFlight` still requires Victor's explicit release
approval. Default to `apple_runner: mbp`; use `mini` only as a deliberate
fallback after confirming its signing/toolchain parity.
