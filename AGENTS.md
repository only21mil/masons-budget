# AGENTS · The Vogel Vault (iOS)

**If you're an AI agent about to modify this iOS app — read this first.** Companion to `~/.openclaw/workspace-mc2/mission-control/AGENTS.md` (the MC2 data backend). Read both if you're touching the data flow.

## Linear — HARD RULE (non-negotiable)

**Every meaningful change must be reflected in Linear in real time.** This is not optional and Victor should never have to remind you.

- Before starting work, ensure a Linear issue exists for it. If not, create one.
- Move the issue to In Progress immediately when you start.
- Add comments as you make progress, hit decisions, or uncover findings.
- When done, add a closing comment with what was done and how it was verified, then move to Done.
- If you find a bug or a new item that needs work, create a new issue — don't batch it silently into the current task. Other lanes may pick it up.
- Check the project's issue list at the START of every task to avoid duplicating work another lane already started.
- Projects: "Vogel Vault v0.3 — Mason's Money Setup" (id `35b49d8a-...`) and "Vogel Vault v0.2 Bug Fixes" (id `4ad37721-...`).
- Use the configured Linear MCP server (`mcp__linear__`) first for listing, searching, commenting, status updates, and issue/project writes. If MCP tools are not initially visible, use `tool_search` to expose them, especially `save_issue` for create/update/state changes and `save_comment` for progress notes. Use `linear.sh` from `~/.openclaw/workspace-sats-daily-ops/tools/` only as a fallback/support path when MCP listing/search is blocked.

This is **The Vogel Vault** (internal repo name still "Mason's Budget App"). SwiftUI iOS + macOS app, multi-profile family Bitcoin + budget dashboard. Backend is Convex (`keen-elephant-452.convex.cloud`); MC2 pushes JSON files there via `dataFiles:sync`, the app reads them.

- App repo: this directory (`~/projects/Mason's Budget App`) — **iOS + macOS targets share the same Swift source code**
- Bundle id: `com.sats21m.masonsbudget` · Team `384ZGKG4GB`
- Live to TestFlight via temp keychain + API key auth. Build BOTH `MasonsBudget` (iOS) AND `MasonsBudgetMac` (macOS) schemes on every release.
- iOS DTOs in `MasonsBudget/MasonsBudget/Services/MC2DTOs.swift` mirror MC2's JSON schemas. If a JSON shape changes in MC2, the DTO + mapper change here.

---

## Family / household model — HARD RULE

**Victor and Rachel are ONE shared household.** Dual-income, dual-finance. They see identical data — same paychecks, same transactions, same retirement, same BTC. There is exactly one adult dataset in MC2; never propose splitting it into per-adult files (`rachel-budget.json`, etc.). Mirrors MC2's stance.

**Mason and Maddox are isolated.** Their data lives in parallel files (`mason-budget.json`, `mason-transactions.json`, `mason-bitcoin-buys.json`, `son-balances.json`, plus `mason_401k` as a sibling key inside the shared `finances.json`). Mason's profile in the app sees only Mason's data. Adults can see everyone's; kids see only their own.

The visibility primitive lives in `Models/SharedEnums.swift`:

```swift
extension FamilyMember {
    func canSee(dataOwnedBy owner: FamilyMember) -> Bool {
        if self == owner { return true }
        if isAdult && owner.isAdult { return true }   // household sharing
        return false
    }
}
```

**Use `canSee(dataOwnedBy:)` everywhere — view filters AND sync mappers. NEVER strict equality.** Strict `==` breaks Rachel's profile because adult records in MC2 default to `owner: "victor"`; an `accountOwner == .rachel` check filters them all out and leaves her tabs empty. We hit this exact bug in v0.3 (see `MC2Mapper.mapFinances`).

Records persisted to SwiftData are tagged with the **canonical** owner from the JSON (adults → `.victor`, mason_401k → `.mason`). Visibility is then resolved at query time via `canSee`. Don't tag records with the active member just because that member triggered the sync.

Profile switching is in `Views/SettingsTab.swift`. Kids cannot switch into adult profiles; the picker uses `FamilyMember.allowedSwitchTargets` (returns `[self]` for kids). Adults switching profiles must pass Face ID via `LocalAuthentication` — see `requiresAuthToSwitch`.

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
| Tabs | `Views/{Dashboard,Money,Spending,Settings}Tab.swift` |
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

This app is often worked by Codex, OpenCode, Claude, and Sats lanes. All of them may keep fixing bugs, creating/updating Linear issues, moving to the next issue, editing code, and running local tests/simulator checks automatically.

Stop and ask Victor before:
- bumping `CURRENT_PROJECT_VERSION` for distribution
- creating an archive for TestFlight/App Store/tester distribution
- exporting an `.ipa`, `.app`, `.pkg`, `.dmg`, or other release artifact
- uploading to TestFlight/App Store Connect or any distribution channel

Read `/Users/node2m1pro/Obsidian/Victor/Agent-Shared/rules/app-build-deploy-workflow.md` before any approved build/release sequence.

## Build, archive, TestFlight

This app runs in macOS Background sessions (Claude Code, Codex), which **don't share keychain unlock state** with the GUI Terminal session. Use the temp-keychain workaround:

- Combined Dev + Distribution p12: `~/.openclaw/private/signing-transfer/air-xcode-identities.p12`
- Password file: `~/.openclaw/private/signing-transfer/rlh-p12-pass.txt` (yes, the rlh-named file is the one with the air-xcode-identities password — confusing but durable)
- ASC API key (Admin tier): `~/.appstoreconnect/private_keys/AuthKey_59588HYRQK.p8` · ID `59588HYRQK` · Issuer `ded50b50-7670-456c-b221-10f1d038c7ea`

Build pipeline reference: `/tmp/vogel-vault-build.sh` (1) creates a temp keychain, (2) imports the combined p12 with `set-key-partition-list`, (3) replaces the search list, (4) `xcodebuild ... archive` with `-allowProvisioningUpdates` + the API key flags, (5) `-exportArchive` with the same flags, (6) `xcrun altool --upload-app`, (7) cleanup.

**Pre-archive checklist after Victor approves the distributable build:**
1. Confirm Victor explicitly approved starting this build/release sequence.
2. `xcodegen generate` — `project.yml` is source of truth; `MasonsBudget.xcodeproj` is generated. Don't edit pbxproj by hand.
3. Bump `CURRENT_PROJECT_VERSION` in `project.yml` (App Store Connect requires monotonic increase across all builds for a given app).
3. `xcodebuild test -destination 'platform=iOS Simulator,name=iPhone 17'` → must be green.
4. `xcodebuild build -destination 'platform=iOS Simulator,name=iPhone 17'` → must be clean.
5. SourceKit/LSP "Cannot find type" diagnostics on the MC2DTOs / MC2Mapper / MC2SyncService files are **persistent index noise**, not real errors. Trust `xcodebuild`.

---

## Linear

Team: **Sats21m** (key `SAT`). Active project for this app:

- "Vogel Vault v0.3 — Mason's Money Setup" (id `35b49d8a-3703-4fbf-b853-3fb07b8d9422`) — Mason's income/spending/retirement, profile lockdown, V+R household share.
- v0.2 sprint (`Vogel Vault v0.2 Bug Fixes`, id `4ad37721...`) — fully Done.

Comment on issues as slices land. Don't let Linear go stale.

---

## Multi-agent coordination

Multiple agents work this project (Claude Code, OpenCode, Codex, Sats workers). Before risky operations (archive + upload, force-push, schema changes), check Linear and confirm with Victor whether another lane is mid-flight. Pausing costs nothing; racing a TestFlight upload while another agent is mid-edit costs a broken build.

---

## Companion repos

- **MC2 mission-control** (`~/.openclaw/workspace-mc2/mission-control/`) — data backend, helper scripts, JSON source of truth. **Read its `AGENTS.md`** for the helper-script lane (`add-paycheck.py`, `add-mason-paycheck.py`, `add-transaction.py`, etc.) and file conventions.

---

*Last updated 2026-05-01 · v0.3.0 in progress · Victor Vogel*
