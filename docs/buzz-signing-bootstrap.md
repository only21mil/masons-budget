# Buzz Mac signing bootstrap

This is one-time credential infrastructure for `only21mil/buzz`, Apple team
`384ZGKG4GB`. It reuses the live ASC credential inside this repository. It does
not extract that credential, run Buzz code, build an app, revoke certificates,
or publish releases. The existing App Store workflow inputs and defaults remain
unchanged. All new operations require an explicit `purpose`.

Victor's 2026-09-05 instruction authorizes the minimum Buzz setup and future
routine releases through this account and route. The root controller binds
the reviewed candidate and exact phase inputs before execution. No additional
user permission question is needed for a covered update. Review still applies.

## Current evidence and decision

The reference iOS upload is run `33999621459`, Budget main
`c0b9db0f8959b14df4a8cf870820cb5b85e6207b`. The separately approved read-only
certificate run `34001629050` succeeded at that same commit, including key
cleanup. It found existing Developer ID Application certificate `XC7USYDS9Z`,
named `Developer ID Application: Victor Vogel`, expiring 2027-02-01.

An existing public certificate does not prove possession of its private key.
The targeted provenance lookup found no usable retained key route. Its receipt
is `DEVELOPER-ID-PROVENANCE.md` in the controller evidence directory, SHA-256
`5c183463e1af13861f5d42028333e3aa32aef0ac1cf72f36899e85c09918d5fb`.
The controller can bind a dedicated Buzz certificate. Nothing revokes or replaces the
existing certificate. Apple lists `DEVELOPER_ID_APPLICATION` in its API, but
requires Account Holder authority to create Developer ID certificates.
Successful inventory access does not prove creation authority.

## Phase actions

All commands run from the reviewed candidate. Store helper commands are dry
runs unless `--execute` is present. The private store is only
`~/.config/sats/secrets.env`, owned by the current user, mode `0600`, in a
mode-`0700` directory. The helper rejects symlinks, hard links and overwrites.
It appends only `BUZZ_*` entries under an exclusive file lock, preserves other
entries, and never sources the file into a shell.

1. **Public certificate capability probe, if needed.** Promote the reviewed
   workflow source and dispatch registered `apple-signing-assets.yml` with
   `purpose=buzz-developer-id-probe`, all CSR inputs empty, and no revocation.
   Record exact run `headSha`. One bounded GET, no pagination or redirect, emits
   public Developer ID certificates and `receipt.json`. No private key file is
   written. A matching retained p12 may be evaluated by its public certificate
   identity through a separately bound action. This candidate never retrieves
   another credential.

2. **Dedicated Developer ID key and public CSR, only if needed.**

   ```sh
   python3 .github/workflows/scripts/buzz_signing_store.py developer-id-key \
     --out /home/victor/work/buzz-t3-takeover-20260905/mac-signing-bootstrap-evidence/buzz-developer-id.csr
   ```

   After root phase GO, add `--execute`. The helper generates RSA-2048 in memory,
   appends `BUZZ_DEVELOPER_ID_PRIVATE_KEY_PEM_B64`, and writes only a public CSR.
   If the private entry already exists, it recovers the same public CSR without
   generating another key. A new output path is required. Record CSR SHA-256.

3. **One certificate issuance attempt.** Dispatch `apple-signing-assets.yml`
   against the exact promoted reviewed branch/SHA with
   `purpose=buzz-developer-id-create` and `developer_id_csr_b64` containing the
   base64 public PEM CSR. Use structured JSON input or a public input file.
   Other CSR inputs are empty; `revoke_oldest_if_capped=false`.

   The helper verifies CSR signature, Buzz CN and approved team; checks the
   existing inventory; reuses a valid same-public-key certificate; otherwise
   sends one POST for `DEVELOPER_ID_APPLICATION`. It never retries a POST,
   follows a redirect, revokes anything, or generates provisioning profiles.
   It records POST intent before the request and issued ID before validation.
   Download the public certificate and receipt from the run artifact.

   On HTTP 401/403, API denial, certificate cap or ambiguous transport failure,
   stop. The public receipt retains HTTP status and safe Apple error codes.
   Do not change roles or revoke another certificate. The supported alternative
   is the Account Holder's Developer portal using this same public CSR, which
   requires a separate controller-bound procedure. After an ambiguous response,
   use a read-only inventory to reconcile the same public key before any new
   issuance attempt.

4. **Assemble and retain the p12.** Download the applicable public Developer ID
   intermediate from Apple's PKI page and Apple Root CA from
   `https://www.apple.com/appleca/AppleIncRootCertificate.cer`. The script pins
   that root's SHA-256, verifies issuer signatures, validity, the Developer ID
   extension, team and retained private-key match. Pass those public paths:

   ```sh
   python3 .github/workflows/scripts/buzz_signing_store.py assemble-p12 \
     --certificate PUBLIC_CERTIFICATE_PATH --intermediate PUBLIC_INTERMEDIATE_PATH \
     --apple-root PUBLIC_ROOT_PATH
   ```

   Add `--execute` only after root GO. It stores `BUZZ_DEVELOPER_ID_P12_B64` and
   `BUZZ_DEVELOPER_ID_P12_PASSWORD`, with a 48-character URL-safe password,
   compatible PKCS#12 algorithms, and the intermediate chain. A local p12
   round-trip checks key, certificate and chain. The later Mac signing job must
   still prove the imported identity with `security find-identity`.

5. **Retained updater key.** Use the reviewed Tauri CLI 2.11.4 binary, matching
   Buzz's pinned version, and a new public output path:

   ```sh
   python3 .github/workflows/scripts/buzz_signing_store.py updater-key \
     --tauri-cli ABSOLUTE_REVIEWED_TAURI_CLI_PATH \
     --out /home/victor/work/buzz-t3-takeover-20260905/mac-signing-bootstrap-evidence/buzz-updater.pub
   ```

   Add `--execute` after root GO. The subprocess output is captured in memory.
   Its private value is never printed or written to a temporary key file.
   The retained names are `BUZZ_TAURI_SIGNING_PRIVATE_KEY` and
   `BUZZ_TAURI_SIGNING_PUBLIC_KEY`. The optional updater password is empty.
   Existing entries are reused, never rotated. Losing this key breaks future
   updates to installed apps.

6. **Protected GitHub installation.** After all public identities are bound:

   ```sh
   python3 .github/workflows/scripts/buzz_signing_store.py install-github
   ```

   With root GO and `--execute`, the helper uses stdin to set exactly these
   three secrets in `only21mil/masons-budget`: `BUZZ_DEVELOPER_ID_P12_B64`,
   `BUZZ_DEVELOPER_ID_P12_PASSWORD`, `BUZZ_TAURI_SIGNING_PRIVATE_KEY`. It sets
   repository variable `BUZZ_TAURI_SIGNING_PUBLIC_KEY` through stdin. Existing
   names cause HOLD before any write. A partial installation is reported and
   requires metadata reconciliation; the helper does not overwrite it blindly.
   Verify all three secret names and the exact public variable through readback.

## Build and publisher contract

Only the public updater key and endpoint reach the credential-free Buzz build.
The manual signing job receives the protected names above and the existing ASC
secrets in a separate trusted execution stage. Its updater password is empty.
The source is an immutable reviewed `only21mil/buzz` commit, initially
`9daaf702afa3ed1146bd3cdd96af1f023f28f9fb`. The endpoint is
`https://github.com/only21mil/buzz/releases/download/buzz-desktop-latest/latest.json`.

The public key is Tauri's base64 of the minisign text key file. Its fingerprint
is SHA-256 of the decoded text bytes, including their actual newlines. The
certificate fingerprint is SHA-256 of leaf DER bytes. Retain these identities
with source SHA, both architecture artifacts, notarization receipts, final
signatures and hashes. No publisher receives a private key or password.

## Verification and residual state

Focused checks are the new `test_buzz_signing_bootstrap.py`, existing
`test_apple_signing_assets.py`, actionlint, immutable action pins, secret
inventory, and unchanged-App-Store-job comparison. Run the existing authoritative
workflow suite once on the combined candidate through the controller.

Before phase GO, no keys or certificates have been created, no secrets installed,
and no candidate source promoted. The sole remote action so far is the separately
approved read-only run `34001629050`. Every phase records exact source and inputs.

After issuance, a certificate may remain valid even if assembly or a later step
fails. Keep its public ID and the retained private key; do not auto-revoke it.
The public artifact upload runs even on failure and retains results for 7 days.
After local key generation, the private entry persists in the protected store.
After partial GitHub installation, installed secrets also persist. Rollback is
to stop before signing or publication and leave those protected records intact
for recovery. Deletion, rotation or revocation is outside this action plan.
The later signer owns run-scoped keychain and key-file cleanup on every exit.

## Primary sources

- [Apple Developer ID requirements](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [Apple certificate type API](https://developer.apple.com/documentation/appstoreconnectapi/certificatetype)
- [Apple certificate create attributes](https://developer.apple.com/documentation/appstoreconnectapi/certificatecreaterequest/data-data.dictionary/attributes-data.dictionary)
- [Apple PKI certificates](https://www.apple.com/certificateauthority/)
- [Tauri CLI 2.11.4 generator source](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-cli/src/signer/generate.rs)
- [Tauri updater signing](https://v2.tauri.app/plugin/updater/)
