# AGENTS · The Vogel Vault (iOS)

**If you're an AI agent about to modify this iOS app — read this first.** Companion to `~/.openclaw/workspace-mc2/mission-control/AGENTS.md` (the MC2 data backend). Read both if you're touching the data flow.

## Tracking — GitHub only (2026-07-26)

**Do not use Linear for this repo.** Tracking, review, and history live on GitHub.

- Work happens on a branch, reviewed via a pull request. Never commit to `main`.
- File a GitHub issue for a bug or follow-up rather than batching it silently into the current change.
- Check open issues and PRs at the start of a task so lanes do not duplicate work.
- Builds run on GitHub Actions (`.github/workflows/clients.yml`), not on an installed local toolchain.

Superseded: this file previously mandated mirroring every change into Linear. That rule no longer applies.

This is **The Vogel Vault** (internal repo name still "Mason's Budget App"). SwiftUI iOS + macOS app, multi-profile family Bitcoin + budget dashboard. Backend is Convex (`keen-elephant-452.convex.cloud`); MC2 pushes JSON files there via `dataFiles:sync`, the app reads them.

- App repo: this directory (`/home/victor/dgxprojects/Mason's Budget App` on DGX) — **iOS + macOS targets share the same Swift source code**
- Bundle id: `com.sats21m.masonsbudget` · Team `384ZGKG4GB`
- Live to TestFlight via temp keychain + API key auth. Build BOTH `MasonsBudget` (iOS) AND `MasonsBudgetMac` (macOS) schemes on every release.
- iOS DTOs in `MasonsBudget/MasonsBudget/Services/MC2DTOs.swift` mirror MC2's JSON schemas. If a JSON shape changes in MC2, the DTO + mapper change here.
- Native app writeback exists through `AppWriteSyncService` for approved app-originated transactions/todos when `ConvexConfig.isConfigured` is true. Do **not** put shared Convex write tokens in Swift source, UserDefaults, or bundled config; app writeback must use the approved configured path only, and MC2/private sync remains the owner of private bulk sync.

---

## Family / household model — HARD RULE

**Victor and Rachel are ONE shared household.** Dual-income, dual-finance. They see identical data — same paychecks, same transactions, same retirement, same BTC. There is exactly one adult dataset in MC2; never propose splitting it into per-adult files (`rachel-budget.json`, etc.). Mirrors MC2's stance.

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

**Use `canSee(dataOwnedBy:)` everywhere — view filters AND sync mappers. NEVER strict equality.** Strict `==` breaks Rachel's profile because adult records in MC2 default to `owner: "victor"`; an `accountOwner == .rachel` check filters them all out and leaves her tabs empty. We hit this exact bug in v0.3 (see `MC2Mapper.mapFinances`).

Records persisted to SwiftData are tagged with the **canonical** owner from the JSON (adults → `.victor`, mason_401k → `.mason`). Visibility is then resolved at query time via `canSee`. Don't tag records with the active member just because that member triggered the sync.

Profile switching is in `Views/Screens/ProfileSwitcherView.swift`. Kids cannot switch into adult profiles; the picker uses `FamilyMember.allowedSwitchTargets` (returns `[self]` for kids). Adults switching profiles must pass Face ID via `LocalAuthentication` — see `requiresAuthToSwitch`.

---

## Code surface map

| Area | File |
|---|---|
| Family enum + visibility | `Models/SharedEnums.swift` |
| MC2 DTOs (Codable mirrors of MC2 JSON) | `Services/MC2DTOs.swift` |
| Map DTO → SwiftData model | `Services/MC2Mapper.swift` |
| Sync orchestration | `Services/MC2SyncService.swift` |
| Convex client | `Services/ConvexClient.swift` |
| Convex reader | `Services/MC2Reader.swift` |
| App entry | `App/MasonsBudgetApp.swift` |
| Screens / tabs | `Views/Screens/*.swift` |
| Charts | `Views/Components/*.swift` |

Sync entry points in `MC2SyncService.syncAll()` are split by member. Mason path: `syncSonBalances`, `syncMasonBudget`, `syncMasonTransactions`, `syncMasonBTCBuys`, `syncFinances`. Adult path: `syncTransactions`, `syncBudget`, `syncBTCAccounts`, `syncBTCBuys`, `syncBTCBillPays`, `syncFinances`. The wipe-and-replace pattern (`replaceAll(...)`) is intentional — profile switches re-sync from scratch.

---

## DTO ↔ JSON conventions

- JSON uses `snake_case` (`weekly_gross`, `monthly_gross`, `mtd_income`). DTOs use Swift `camelCase` with explicit `CodingKeys`. Always set the `CodingKeys` enum when adding new fields.
- Money is `Decimal`, never `Double`.
- Optional in the DTO == may be missing in JSON. Default sensibly in the mapper, not in the DTO.
- New JSON fields in MC2 → bump the DTO + mapper here AND verify the iOS app still decodes existing data without the field.

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

Read `/home/victor/Obsidian/Victor/Agent-Shared/rules/app-build-deploy-workflow.md` before any approved build/release sequence on DGX.

## Build, archive, TestFlight

This app runs in macOS Background sessions (Claude Code, Codex), which **don't share keychain unlock state** with the GUI Terminal session. Use the temp-keychain workaround:

- Combined Dev + Distribution p12: `~/.openclaw/private/signing-transfer/air-xcode-identities.p12`
- Password file: `~/.openclaw/private/signing-transfer/rlh-p12-pass.txt` (yes, the rlh-named file is the one with the air-xcode-identities password — confusing but durable)
- ASC API key: use the approved App Store Connect private key from the local secret store; do not copy key filenames, key IDs, issuer IDs, or private key material into repo docs.

Build pipeline reference: `/tmp/vogel-vault-build.sh` (1) creates a temp keychain, (2) imports the combined p12 with `set-key-partition-list`, (3) replaces the search list, (4) `xcodebuild ... archive` with `-allowProvisioningUpdates` + the API key flags, (5) `-exportArchive` with the same flags, (6) `xcrun altool --upload-app`, (7) cleanup.

**Pre-archive checklist after Victor approves the distributable build:**
1. Confirm Victor explicitly approved starting this build/release sequence.
2. `cd MasonsBudget && xcodegen generate --spec project.yml` — `MasonsBudget/project.yml` is source of truth; `MasonsBudget.xcodeproj` is generated. Don't edit pbxproj by hand.
3. Bump `CURRENT_PROJECT_VERSION` in `MasonsBudget/project.yml` (App Store Connect requires monotonic increase across all builds for a given app).
3. `xcodebuild test -destination 'platform=iOS Simulator,name=iPhone 17'` → must be green.
4. `xcodebuild build -destination 'platform=iOS Simulator,name=iPhone 17'` → must be clean.
5. SourceKit/LSP "Cannot find type" diagnostics on the MC2DTOs / MC2Mapper / MC2SyncService files are **persistent index noise**, not real errors. Trust `xcodebuild`.

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

## Companion repos

- **MC2 mission-control** (`~/.openclaw/workspace-mc2/mission-control/`) — data backend, helper scripts, JSON source of truth. **Read its `AGENTS.md`** for the helper-script lane (`add-paycheck.py`, `add-mason-paycheck.py`, `add-transaction.py`, etc.) and file conventions.

---

*Last updated 2026-06-06 · v0.5.0 / build 32 source line · Victor Vogel*
