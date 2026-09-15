# AGENTS · The Vogel Vault

**If you're an AI agent about to modify this app — read this first.**

MC2 mission-control is gone. It lived only on the wiped DGX Spark, was never
pushed, and is unrecoverable. **Convex (`keen-elephant-452`) is the system of
record.** Canonical typed rows are the current ledger authority. The surviving
`dataFiles` JSON blobs are a load-bearing compatibility copy for shipped readers.
Never describe MC2 as a live upstream or direct work toward a separate MC2 repo.

## Tracking — GitHub primary (2026-09-15)

**Do not use Linear for this repo.** GitHub is authoritative for branches,
issues, pull requests, review, and history. The Buzz relay is a read mirror.
This section is the normative delivery rule until the rewritten
`only21mil/buzz:docs/delivery-lifecycle.md` lands; the retired 2026-09-05
Buzz-first block is kept below as history, not guidance.

- Seed every feature branch on GitHub. Open and update its pull request on
  GitHub. Never commit to `main`, and never treat a relay-only branch as
  landed.
- Landing is the GitHub merge: GitHub PR readback (number, state, head, base
  and merge commits, ordered parents, tree) plus required checks green, with
  GitHub `main` at the merge commit. Buzz-mirror convergence is informational
  lag, not a landing gate.
- Preserve every other branch and its owner when reconciling refs. Never delete,
  overwrite, or adopt another lane's branch.
- File a GitHub issue for a bug or follow-up rather than batching it silently into
  the current change. Check open GitHub issues and pull requests before starting so
  lanes do not duplicate work.
- Routine verification runs in GitHub Actions. Linux/Android work uses hosted
  Ubuntu; Apple work uses the registered MacBook Pro, with the Mac mini only as
  an explicitly selected fallback. The Framework laptop remains the primary
  development and Linux-preflight machine.

Superseded: this file previously mandated mirroring every change into Linear. That rule no longer applies.

Superseded (2026-09-15): the 2026-09-05 "Buzz relay first" block is retired.
The Buzz relay was authoritative for branches, issues, pull requests, review,
and history with GitHub as the CI mirror; lanes seeded branches on the Budget
relay via the Buzz CLI and gated landing on dual-endpoint comparison plus a
later complete no-op mirror cycle. That direction no longer applies — GitHub
is primary and the relay is the mirror.

This is **The Vogel Vault** (internal repo name still "Mason's Budget App"). SwiftUI iOS + macOS app, multi-profile family Bitcoin + budget dashboard. Convex (`keen-elephant-452.convex.cloud`) is the backend and system of record. Shipped clients still read the legacy JSON blobs through `dataFiles`; the reviewed row-table cutover is tracked in [umbrella issue #46](https://github.com/only21mil/masons-budget/issues/46).

- **Repo location: GitHub, `only21mil/masons-budget`.** There is no canonical
  local checkout and nothing is kept on a workstation — clone it where you need
  it and delete it when you are done. Any path in this file that looked like a
  home directory was stale; do not reintroduce one.
- **iOS + macOS targets share the same Swift source code.**
- Bundle id: `com.sats21m.masonsbudget` · Team `384ZGKG4GB`
- Releases go to TestFlight through GitHub Actions. See "Build, archive,
  TestFlight" below. Both schemes ship together.
- `Services/LegacyBlobDTOs.swift` defines the surviving blob schema; `Services/MC2DTOs.swift` retains historical Swift type aliases. `LedgerMapper.swift`, `ConvexDataReader.swift`, and `ConvexSyncService.swift` map and sync the current data. These paths are relative to `MasonsBudget/MasonsBudget/`. Preserve the legacy decoding contract while shipped clients still consume `dataFiles`.
- Native app writeback exists through `AppWriteSyncService` for approved app-originated transactions/todos when `ConvexConfig.isConfigured` is true. Do **not** put shared Convex write tokens in Swift source, UserDefaults, or bundled config; app writeback must use the approved configured path only. Any production write or migration remains approval-gated.
- The reviewed monthly-import route lives in
  `docs/production-monthly-import.md`. It is the only admin ingestion path:
  private fd-only manifests, deterministic typed-row writes, one atomic batch
  of at most 100 ledger records, and redacted structural evidence. Never
  substitute table replacement, a legacy blob writer, or a rerun of the
  completed migration.

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

**Use `canSee(dataOwnedBy:)` everywhere — view filters AND sync mappers. NEVER strict equality.** Strict `==` breaks Rachel's profile because canonical adult records use `owner: "victor"`; an `accountOwner == .rachel` check filters them all out and leaves her tabs empty. We hit this exact bug in v0.3 (the current mapping is `LedgerMapper.mapFinances`).

Records persisted to SwiftData are tagged with the **canonical** owner from the JSON (adults → `.victor`, mason_401k → `.mason`). Visibility is then resolved at query time via `canSee`. Don't tag records with the active member just because that member triggered the sync.

Profile switching is in `Views/Screens/ProfileSwitcherView.swift`. Kids cannot switch into adult profiles; the picker uses `FamilyMember.allowedSwitchTargets` (returns `[self]` for kids). Adults switching profiles must pass Face ID via `LocalAuthentication` — see `requiresAuthToSwitch`.

---

## Code surface map

Paths below are relative to `MasonsBudget/MasonsBudget/`.

| Area | File |
|---|---|
| Family enum + visibility | `Models/SharedEnums.swift` |
| Legacy blob DTOs | `Services/LegacyBlobDTOs.swift` |
| Historical `MC2` type aliases | `Services/MC2DTOs.swift` |
| Map blob DTO → SwiftData model | `Services/LedgerMapper.swift` |
| Convex sync orchestration | `Services/ConvexSyncService.swift` |
| Convex HTTP client | `Services/ConvexClient.swift` |
| Convex row reader with legacy `dataFiles` fallbacks | `Services/ConvexDataReader.swift` |
| App entry | `App/MasonsBudgetApp.swift` |
| Screens / tabs | `Views/Screens/*.swift` |
| Charts | `Views/Components/*.swift` |

`ConvexSyncService.syncAll()` syncs todos for every member. Adults also sync
transactions, budget, BTC accounts, child balances, BTC buys, bill pays, and
finances. Mason's dedicated path syncs child balances, his budget, transactions,
BTC buys, and finances. Maddox currently receives only shared todos through his
visibility scope. Replacement helpers reconcile by record type, owner scope, and snapshot source.
They protect active optimistic writes and can remove failed pending rows after
authoritative reads. Preserve these reconciliation rules when changing sync
behavior.

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

The unsigned Apple verification automatically routed by `.github/workflows/swift.yml`
to the registered MacBook Pro is pre-authorized for affected PRs and main pushes.
It creates no distributable artifact. The Mac mini route requires an explicit
manual fallback dispatch.

Stop and ask Victor before:
- bumping `CURRENT_PROJECT_VERSION` for distribution
- any direct or ad hoc `xcodebuild build` / `xcodebuild test` / simulator
  build-run command outside that ordinary CI route
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

**Releases run in GitHub Actions on self-hosted Apple hardware.**
`.github/workflows/deploy.yml` is `workflow_dispatch` only and defaults to the
registered MacBook Pro (`mason-mbp`). The registered Mac mini (`mason-mini`) is
available only through the explicit fallback input. The workflow uses reviewed
manual-signing assets in a run-scoped keychain, restores the persistent host's
original keychain search list, preserves the signed `.ipa` or `.pkg`, then
uploads with the App Store Connect API key. `APPLE_MANUAL_SIGNING_READY` must be
exactly `true`, and the inventory in `.github/workflows/secrets-inventory.json`
lists the required certificate, profile, and ASC secrets. Triggering the
workflow remains the approval gate; it is never automatic.
Setup and persistent-host cleanup rules are in
`docs/apple-self-hosted-release.md`.

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

**Build hosts.** The Framework laptop is the primary development/Linux preflight
machine. `xcodebuild` needs macOS, so ordinary affected-tree Apple CI runs on
the MacBook Pro; the Mac mini is a manually selected fallback only.
`scripts/vv-swift-check.sh` is the Linux-safe static preflight —
XcodeGen generation into a temp dir, SwiftLint, SwiftFormat, a stdin typecheck,
SwiftPM core tests, and a secret scan — with no app target build, simulator,
archive, signing, or upload. It reports every tool it cannot find rather than
passing silently, so a bare checkout will show failures for absent tooling; that
is the script working, not the repo being broken.

SourceKit/LSP "Cannot find type" diagnostics have historically included stale
index references to the former `MC2Mapper` and `MC2SyncService` names. The current
files are `LedgerMapper.swift` and `ConvexSyncService.swift`. Verify against the
approved unsigned Apple CI checks; an editor diagnostic alone is not a build result.

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
`MC2DTOs.swift` retains source-compatibility aliases, and legacy UserDefaults
keys remain. Historical references to `MC2Mapper`, `MC2Reader`, and
`MC2SyncService` refer to code now named `LedgerMapper`, `ConvexDataReader`, and
`ConvexSyncService`. These names do not imply a live upstream, companion service,
or companion repository. Treat Convex and this
repository as the current data boundary, and preserve the old JSON decoding
contract while shipped clients still consume `dataFiles`.

---

*Last updated 2026-07-26 · Victor Vogel*
