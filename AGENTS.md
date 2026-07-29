# AGENTS · The Vogel Vault

**If you're an AI agent about to modify this app — read this first.**

MC2 mission-control is gone. It lived only on the wiped DGX Spark, was never
pushed, and is unrecoverable. **Convex (`keen-elephant-452`) is the system of
record.** The surviving `dataFiles` JSON blobs are the only authoritative copy
of the family ledger until the reviewed row migration is approved and applied.
Never describe MC2 as a live upstream or direct work toward a separate MC2 repo.

## Tracking — GitHub only (2026-07-26)

**Do not use Linear for this repo.** Tracking, review, and history live on GitHub.

- Work happens on a branch, reviewed via a pull request. Never commit to `main`.
- File a GitHub issue for a bug or follow-up rather than batching it silently into the current change.
- Check open issues and PRs at the start of a task so lanes do not duplicate work.
- Builds run on GitHub Actions (`.github/workflows/clients.yml`), not on an installed local toolchain.

Superseded: this file previously mandated mirroring every change into Linear. That rule no longer applies.

This is **The Vogel Vault** (internal repo name still "Mason's Budget App"). SwiftUI iOS + macOS app, multi-profile family Bitcoin + budget dashboard. Convex (`keen-elephant-452.convex.cloud`) is the backend and system of record. Shipped clients still read the legacy JSON blobs through `dataFiles`; the reviewed row-table cutover is tracked in [umbrella issue #46](https://github.com/only21mil/masons-budget/issues/46).

- **Repo location: GitHub, `only21mil/masons-budget`.** There is no canonical
  local checkout and nothing is kept on a workstation — clone it where you need
  it and delete it when you are done. Any path in this file that looked like a
  home directory was stale; do not reintroduce one.
- **iOS + macOS targets share the same Swift source code.**
- Bundle id: `com.sats21m.masonsbudget` · Team `384ZGKG4GB`
- Releases go to TestFlight through GitHub Actions. See "Build, archive,
  TestFlight" below. Both schemes ship together.
- Swift types retain `MC2` names for compatibility with the surviving blob schema. `MasonsBudget/MasonsBudget/Services/MC2DTOs.swift`, `MC2Mapper.swift`, `MC2Reader.swift`, and `MC2SyncService.swift` remain load-bearing until every shipped client has moved off `dataFiles`; do not rename, remove, or change their decoding contract casually.
- Native app writeback exists through `AppWriteSyncService` for approved app-originated transactions/todos when `ConvexConfig.isConfigured` is true. Do **not** put shared Convex write tokens in Swift source, UserDefaults, or bundled config; app writeback must use the approved configured path only. Any production write or migration remains approval-gated.

---

## Family / household model — HARD RULE

**Victor and Rachel are ONE shared household.** Dual-income, dual-finance. They see identical data — same paychecks, same transactions, same retirement, same BTC. The surviving blob schema and the row model use one adult household dataset; never propose splitting it into per-adult files (`rachel-budget.json`, etc.).

**Mason and Maddox are isolated.** Their data lives in parallel files (`mason-budget.json`, `mason-transactions.json`, `mason-bitcoin-buys.json`, `son-balances.json`, plus `mason_401k` as a sibling key inside the shared `finances.json`). Mason's profile in the app sees only Mason's data. Adults can see everyone's; kids see only their own.

The visibility primitive lives in `Models/SharedEnums.swift`:

```swift
extension FamilyMember {
    /// Adults can see the household AND the kids. Kids see only their own data.
    func canSee(dataOwnedBy owner: FamilyMember) -> Bool {
        if self == owner { return true }
        if isAdult { return true }
        return false
    }

    /// Narrower than `canSee`: an adult can see Mason's balance, but it must not
    /// roll into adult net-worth totals.
    func sharesNetWorth(with owner: FamilyMember) -> Bool {
        if self == owner { return true }
        return isAdult && owner.isAdult
    }
}
```

**Use `canSee(dataOwnedBy:)` everywhere — view filters AND sync mappers. NEVER strict equality.** Strict `==` breaks Rachel's profile because canonical adult records use `owner: "victor"`; an `accountOwner == .rachel` check filters them all out and leaves her tabs empty. We hit this exact bug in v0.3 (see `MC2Mapper.mapFinances`).

Records persisted to SwiftData are tagged with the **canonical** owner from the JSON (adults → `.victor`, mason_401k → `.mason`). Visibility is then resolved at query time via `canSee`. Don't tag records with the active member just because that member triggered the sync.

Profile switching is in `Views/Screens/ProfileSwitcherView.swift`. Kids cannot switch into adult profiles; the picker uses `FamilyMember.allowedSwitchTargets` (returns `[self]` for kids). Adults switching profiles must pass Face ID via `LocalAuthentication` — see `requiresAuthToSwitch`.

---

## Code surface map

| Area | File |
|---|---|
| Family enum + visibility | `Models/SharedEnums.swift` |
| Legacy blob DTOs (the `MC2` name is compatibility, not a live service) | `Services/MC2DTOs.swift` |
| Map blob DTO → SwiftData model | `Services/MC2Mapper.swift` |
| Convex blob sync orchestration | `Services/MC2SyncService.swift` |
| Convex HTTP client | `Services/ConvexClient.swift` |
| Convex `dataFiles` reader | `Services/MC2Reader.swift` |
| App entry | `App/MasonsBudgetApp.swift` |
| Screens / tabs | `Views/Screens/*.swift` |
| Charts | `Views/Components/*.swift` |

Sync entry points in `MC2SyncService.syncAll()` are split by member. Mason path: `syncSonBalances`, `syncMasonBudget`, `syncMasonTransactions`, `syncMasonBTCBuys`, `syncFinances`. Adult path: `syncTransactions`, `syncBudget`, `syncBTCAccounts`, `syncBTCBuys`, `syncBTCBillPays`, `syncFinances`. The wipe-and-replace pattern (`replaceAll(...)`) is intentional — profile switches re-sync from scratch.

---

## DTO ↔ JSON conventions

- JSON uses `snake_case` (`weekly_gross`, `monthly_gross`, `mtd_income`). DTOs use Swift `camelCase` with explicit `CodingKeys`. Always set the `CodingKeys` enum when adding new fields.
- Money is `Decimal`, never `Double`.
- Optional in the DTO == may be missing in JSON. Default sensibly in the mapper, not in the DTO.
- Changes to a surviving `dataFiles` JSON shape → update the DTO + mapper here AND verify the Swift app still decodes the previous blob shape. Preserve backward compatibility until the blob readers are retired.

---

## App Build Approval Gate — HARD RULE

**Do not start a new distributable build without Victor's explicit approval.**

This app is often worked by Codex, OpenCode, Claude, and Sats lanes. All of them may keep fixing bugs, filing GitHub issues, moving to the next item, editing code, and running static/non-app-artifact checks automatically.

Stop and ask Victor before:
- bumping `CURRENT_PROJECT_VERSION` for distribution
- any `xcodebuild build` / `xcodebuild test` / simulator build-run command that builds app targets
- creating an archive for TestFlight/App Store/tester distribution
- exporting an `.ipa`, `.app`, `.pkg`, `.dmg`, or other release artifact
- uploading to TestFlight/App Store Connect or any distribution channel

## Convex authentication — READ THIS BEFORE DEPLOYING

Reads and writes are fail-closed. The read-auth cutover completed on 2026-07-26:
the gated code is deployed, production was recorded as `ENFORCED`, and
`ALLOW_TOKENLESS_READ` was removed. The old `STATE: OPEN` command output in
`docs/convex-read-auth-cutover.md` is retained only as a historical transcript;
it is not the current posture and must not be copied into a new status report.
This documentation update did not re-probe production.

`validateReadToken` in `convex/dataFiles.ts` gates `get`, `getVersions`, `list`
and `listTodoTombstones`. Clients send a runtime-injected read token; never
bundle, hardcode, commit, print, or document its value.

**Rollback mechanics remain deliberate:** setting `ALLOW_TOKENLESS_READ=true`
reopens reads immediately because the hatch outranks the token. Use that only
for an approved incident rollback, verify `STATE: OPEN`, fix the reader, then
remove the hatch and verify `STATE: ENFORCED`. A set `CONVEX_READ_TOKEN` does
not prove enforcement while the hatch exists.

`CONVEX_SYNC_TOKEN` / `ALLOW_TOKENLESS_SYNC` gate mutations under the identical
pattern and precedence. Neither token belongs in the repo, source, docs, or a
build artifact.

Current status, historical cutover transcript, blast radius and rollback:
`docs/convex-read-auth-cutover.md`. Remaining auth hardening is tracked under
[umbrella issue #46](https://github.com/only21mil/masons-budget/issues/46).

## Build, archive, TestFlight

**Releases run in GitHub Actions, not on a workstation.**
`.github/workflows/deploy.yml` is `workflow_dispatch` only on `macos-latest`.
Release archives use manual signing with human-created Apple Distribution and
Mac Installer Distribution identities plus platform-specific App Store
provisioning profiles. The archive and export commands contain no
`-allowProvisioningUpdates`, so a release cannot create a certificate. The
workflow preserves the signed `.ipa` or `.pkg`, then uploads with
`xcrun altool --apiKey/--apiIssuer`.

The required repository secrets are `ASC_API_KEY_P8`, `ASC_KEY_ID`,
`ASC_ISSUER_ID`, `APPLE_DISTRIBUTION_CERTIFICATE_P12`,
`APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD`, `APPLE_IOS_APP_STORE_PROFILE`,
`APPLE_MAC_APP_STORE_PROFILE`, `APPLE_MAC_INSTALLER_CERTIFICATE_P12`, and
`APPLE_MAC_INSTALLER_CERTIFICATE_PASSWORD`. The older
`APPLE_CERTIFICATE_P12`/password/profile names are known stale and retired; the
workflow deliberately never reads them. Signing uses team `384ZGKG4GB`.
`APPLE_MANUAL_SIGNING_READY` must remain absent/false until
`docs/apple-manual-signing-runbook.md` is completed. Triggering the workflow is
the approval gate above — it is never automatic.

Never put signing material, App Store Connect keys, `.p12` files, provisioning
profiles, key IDs, or issuer IDs in the repo, in docs, or in a commit. Secrets
live in GitHub Actions secrets. Report only present/missing, never a value.

**Before triggering a release build:**
1. Confirm Victor explicitly approved this build/release sequence.
2. Bump `CURRENT_PROJECT_VERSION` in `MasonsBudget/project.yml` — App Store
   Connect requires a monotonic increase across all builds for a given app.
   `project.yml` is the source of truth; `MasonsBudget.xcodeproj` is generated by
   XcodeGen. Never hand-edit the pbxproj.
3. Both schemes ship together: `MasonsBudget` (iOS) and `MasonsBudgetMac` (macOS).
   Use the `both` platform input.

**Local Apple work.** `xcodebuild` needs macOS, so it cannot run on a Linux
machine at all. `scripts/vv-swift-check.sh` is the Linux-safe static preflight —
XcodeGen generation into a temp dir, SwiftLint, SwiftFormat, a stdin typecheck,
SwiftPM core tests, and a secret scan — with no app target build, simulator,
archive, signing, or upload. It reports every tool it cannot find rather than
passing silently, so a bare checkout will show failures for absent tooling; that
is the script working, not the repo being broken.

SourceKit/LSP "Cannot find type" diagnostics on `MC2DTOs` / `MC2Mapper` /
`MC2SyncService` are **persistent index noise**, not real errors. Trust
`xcodebuild`.

---

## Clients

Three clients share one family/visibility contract and one Convex read model:

| Client | Path | Notes |
|---|---|---|
| iOS / macOS | `MasonsBudget/` | SwiftUI. Source of truth for the visibility rules. |
| Linux | `linux/` | Electron + React + TypeScript. Graphite Ledger Cockpit. |
| Android (Fold) | `android/` | Kotlin. `domain` is plain JVM and needs no Android SDK. |

The contract lives in `shared/domain` (`@vogel-vault/domain`) and mirrors
`MasonsBudget/MasonsBudget/Models/SharedEnums.swift`, which stays authoritative.
`shared/domain/fixtures/visibility-cases.json` is language-neutral and is loaded
by both the TypeScript and Kotlin parity suites — **when the Swift rules change,
update the fixture in the same commit** so all three clients move together.

---

## Multi-agent coordination

Multiple agents work this project (Claude Code, OpenCode, Codex, Sats workers). Before risky operations (archive + upload, force-push, schema changes), check open GitHub issues and PRs and confirm with Victor whether another lane is mid-flight. Pausing costs nothing; racing a TestFlight upload while another agent is mid-edit costs a broken build.

---

## Historical MC2 references

MC2 was the Python service that originally owned the family-finance JSON and
pushed projections into Convex. Its file names, field names, record shapes, and
adult-versus-child conventions survive in the only remaining copy of the data
and therefore shape DTOs, mappers, fixtures, and tests throughout this codebase.
Names such as `MC2DTOs`, `MC2Mapper`, `MC2Reader`, `MC2SyncService`, and legacy
UserDefaults keys preserve that blob compatibility; they do not imply a live
upstream, companion service, or companion repository. Treat Convex and this
repository as the current data boundary, and preserve the old JSON decoding
contract while shipped clients still consume `dataFiles`.

---

*Last updated 2026-07-28 · Victor Vogel*
