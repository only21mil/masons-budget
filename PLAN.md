# Mason's Budget App — Plan

> **ARCHIVAL — historical snapshot, not current guidance (marked 2026-07-26).**
>
> This document records scoping decisions from around 2026-04-30. It is kept for
> the reasoning it captures, not as instructions.
>
> Do not act on anything below without checking it first. Specifically:
> - Every `~/.openclaw/...` path, inode number, symlink and cron reference
>   describes a machine setup that no longer exists. They are left unedited
>   because rewriting them would falsify the record.
> - Tracking has moved to GitHub; the Linear references here are dead.
> - Nothing is kept on a workstation now, and builds run in GitHub Actions.
>
> For current rules read `AGENTS.md`. For the Apple build boundary read
> `docs/linux-apple-build-boundary.md`.

## Lane status — 2026-04-30 (snapshot)

> Each lane should append/update its row when claiming or releasing an issue.
> Source of truth is still Linear; this section is just for fast at-a-glance coordination.

| Issue | Status | Notes |
| --- | --- | --- |
| SAT-301 Init SwiftUI app | Done | M1 scaffolding |
| SAT-304 SwiftData schema | Done | All `@Model` classes in `Models/` |
| SAT-308 Voice parser | Done | `Services/VoiceParser.swift` + 39 tests (terminal lane) |
| SAT-306 MC2 reader | In flight | Active edits to `MC2DTOs.swift`, `MC2Mapper.swift`, `MC2Reader.swift` (mid-refactor: DTOs renamed `MC2Strategy → MC2BudgetStrategy`, `MC2Retirement → MC2FinancesRetirement`, `MC2RetirementAccount → MC2FinanceAccount`) |
| SAT-305 Design system / screenshots | In flight | Active edits to all view files + pbxproj |
| SAT-309 MC2 writer | Backlog (contended) | Two lanes appear to be on this. Terminal lane wrote `Services/MC2Writer.swift` + tests as reference but unhooked from build — see SAT-309 comment thread |
| SAT-302 iCloud entitlement | Backlog (unblocked) | Touches pbxproj — currently colliding with active SAT-305 lane |
| SAT-303 Move MC2 to iCloud | **Done 2026-04-30** | Folder at `~/Library/Mobile Documents/com~apple~CloudDocs/MC2/mission-control/`, symlink back at the old path, MC2 server restarted and verified. Backup at `~/Workspace MC2/.backups/mission-control-20260430-114822` if rollback needed. |
| SAT-307 Voice capture FAB | Backlog | Depends on stable SAT-305 + SAT-308 |
| SAT-310 File change observer | Backlog | Depends on SAT-302 + SAT-303 |
| SAT-292 Household sharing | Done | Per-user iCloud + shared MC2 JSON store |
| SAT-290 PLAN.md scoping | Done | All open decisions resolved, PLAN.md updated |


## Goal

A modern, voice-first iOS budget app for the family (Victor, Rachel, Mason, Maddox), tightly integrated with the existing **MC2 Mission Control** financial data system. Tracks monthly budget, income, spending, and net worth — competing in spirit with Rocket Money but with a different, simpler model: no Plaid, no banks, voice + manual entry only, all data lives on Apple iCloud and in MC2's existing JSON store.

## Architecture (locked decisions)

| Layer | Choice |
| --- | --- |
| Platform | **iOS only** (SwiftUI native) |
| Language | **Swift / SwiftUI** |
| Data persistence | **iCloud Drive + SwiftData** (no Supabase, no backend server) |
| Source of truth for net worth | **MC2 mission-control JSON files** (read/write) |
| Account aggregation | **None — Plaid dropped.** Manual + voice entry only. |
| Primary input method | **Voice** via `SFSpeechRecognizer` (on-device, free, private) |
| Sync between MC2 and iOS app | **iCloud Drive shared folder** with append-only writes for new entries |
| Multi-user model | **Per-user iCloud accounts** (Victor on his Mac/phone, Mason on his phone, etc.) — no household sharing zones in v1 |

## What this app is NOT

- Not a Rocket Money clone
- Not a Plaid-powered bank aggregator
- Not multi-tenant SaaS
- Not cross-platform

## What this app IS

- A voice-first companion to the MC2 dashboard, on iPhone
- A magical "tap mic, say `45 bucks groceries Costco`, done" experience
- A read view onto net worth (Bitcoin stacks, 401k, WAP) sourced from MC2
- A monthly budget tracker mirroring MC2's `budget.json` schema

## MC2 schema findings (read 2026-04-30)

`~/Workspace MC2/mission-control/` contains:

| File | Shape | Purpose |
| --- | --- | --- |
| `balances.json` | Object: per-account BTC balances (Strike, River, CashApp, Multisig, Zeus) + total + sync metadata | Bitcoin balances |
| `btc-balance-snapshot.json` | Versioned schema: accounts {btc, fiat, label, custody}, totals, metadata | Authoritative BTC snapshot |
| `bitcoin-buys.json` | Array of buy records with id, date, source, amount_sats, amount_btc, price_usd, usd, status, archimedes_request_id | BTC purchase history (append-only) |
| `finances.json` | retirement.401k + WAP holdings with detailed contribution lots, cost basis, gain% | Retirement / brokerage |
| `budget.json` | aven_balance, month, categories[{name, icon emoji, budget, spent}], strategy, income (weekly_gross etc.) | Monthly budget + income |
| `transactions.json` | Array: id, date, merchant, amount, category, card, note | Spending transactions (append-only) |
| `son-balances.json` | strike + river + coldcard (Multisig) + total BTC, lastUpdated | **Mason's BTC stack** (~0.78 BTC across 3 accounts) |
| `bitcoin-bill-pays.json` | bill_pays[] with id, date, merchant, category, amount_usd, btc_spent, btc_price, platform, fee_usd, source, note, reference | Bills paid in BTC via Strike (mortgage, credit cards, insurance) |

**Key observations:**
- Categories with emoji icons already defined in `budget.json` (Bills & Utilities 🏠, Dining & Drinks 🍔, Auto & Transport 🚗, Shopping 🛍️, Groceries 🛒, Health & Wellness 🧘, Medical 🏥, Pets 🐕)
- `budget.json` includes income tracking (weekly_gross, weekly_strike, weekly_river, monthly_gross, pay_frequency)
- Strategy notes captured in budget (e.g., "Aven debt at 7.99% APR, BTC stacking bet")
- Cards used: Strike (BTC), Aven, etc.
- `archimedes_request_id` in BTC buys suggests an existing automated pipeline writes these — voice input becomes another input channel

## Sync strategy (locked)

**Bidirectional read/write between iOS app and MC2** via shared iCloud Drive folder.

**Writes use append-only strategy for new entries:**
- New transactions → `transactions/tx-YYYY-MM-DD-{user}-{nanoid}.json` (one file per transaction)
- New BTC buys → `bitcoin-buys/buy-YYYY-MM-DD-{nanoid}.json`
- Both MC2 and the iOS app aggregate these append-only files at read time
- **No conflicts possible** — both sides only ADD files

**In-place writes for snapshots:**
- `balances.json`, `btc-balance-snapshot.json`, `finances.json` — these are *current state*, edited not appended
- iCloud creates a "conflict copy" on simultaneous edit; rare in practice for a family of 4
- v2 could add a manual merge UI if conflicts become annoying

## Decisions captured (M0)

- Platform: **iOS only** (no Android, no web)
- Stack: **SwiftUI native** (Expo dropped)
- Backend: **iCloud Drive + SwiftData** (Supabase dropped)
- Account aggregation: **None** (Plaid dropped — voice + manual only)
- Multi-user: **Per-user iCloud, no shared household zones in v1**
- Net worth source: **MC2 read/write integration**
- Voice: **`SFSpeechRecognizer` on-device, rules-based parsing first, LLM fallback if accuracy frustrates**
- Tech constraints: **None imposed**
- Plaid Production: **N/A — dropped**

## Decisions resolved (M0)

1. **MC2 location:** Done (SAT-303). Folder moved to `~/Library/Mobile Documents/com~apple~CloudDocs/MC2/mission-control/`, symlink back at old path.
2. **MC2 code changes:** iOS app uses append-only writes for new entries; in-place updates for snapshots. MC2 desktop reads both. Rare iCloud conflict risk accepted for v1.
3. **Hosting cost ceiling:** ~$8/mo (Apple Developer Program only). Confirmed via SAT-295.
4. **Family size + minors:** 4 members (Victor, Rachel, Mason, Maddox). No special minor handling in v1 — all use the same `FamilyMember` enum with profile selection.
5. **Timeline:** No hard deadline. Ship when ready; family TestFlight first.

## Phased roadmap

### M0: Scoping & Planning *(complete)*
- All decisions locked (see above)
- PLAN.md synced into Linear

### M1: Foundation & Infrastructure
- Initialize SwiftUI iOS app at `~/projects/Mason's Budget App`
- Bundle ID: `com.sats21m.masonsbudget`
- Targets: iOS 17+ (for SwiftData), iPhone first
- iCloud entitlement + iCloud Drive container
- SwiftData schema mirroring MC2's data shapes (Transaction, Category, Budget, BalanceSnapshot, BTCBuy, Holding)
- Design system: dark-first theme inspired by MC2 mockup (Bitcoin orange, ivory text, deep black bg)
- Theme primitives: Card, Stat, Button, Sheet, Skeleton, ChartContainer
- App skeleton with tab navigation: Dashboard, Money, Spending, Settings

### M2: Voice Capture & MC2 Sync
- `SFSpeechRecognizer` integration with tap-and-hold mic UI
- Rules-based parser for "I spent $X at Y for Z" patterns
- Confirm sheet with edit affordances before save
- iCloud Drive sync layer: read MC2 JSON files, write append-only entries
- Schema versioning + migration plan
- Conflict detection for in-place files

### M3: Budgeting & Categorization *(detail later)*
- Render `budget.json` categories with progress bars
- Per-category spend vs budget
- Income tracking (weekly_gross from budget.json)
- Category management UI

### M4: Net Worth *(detail later)*
- Render BTC stacks (per-account from `balances.json`)
- Render 401k + WAP from `finances.json`
- Net worth headline + history chart
- Asset breakdown view

### M5: Charts & Insights *(detail later)*
- Spending by category (donut)
- Monthly trend
- Recurring detection
- Push notifications

### M6: Polish, TestFlight & App Store *(detail later)*
- App icon
- Onboarding (sign in with Apple, iCloud permission)
- Empty/error states
- Privacy policy
- TestFlight beta with the family
- (Optional) App Store submission — or stay TestFlight-only since this is family-only

## Cost estimate

| Item | Cost |
| --- | --- |
| Apple Developer Program | $99/year |
| iCloud Drive | $0 (uses existing iCloud accounts) |
| Plaid | $0 (dropped) |
| Supabase | $0 (dropped) |
| Total recurring | **~$8/month** |

## File / repo locations

| What | Where |
| --- | --- |
| App source | `~/projects/Mason's Budget App/` |
| MC2 financial data (canonical) | `~/.openclaw/workspace-mc2/mission-control/` (inode 33630082) |
| MC2 financial data (friendly alias) | `~/Workspace MC2/mission-control/` — symlink resolving to the canonical path above |
| MC2 financial data (target after SAT-303) | `~/Library/Mobile Documents/com~apple~CloudDocs/MC2/mission-control/` |
| Linear project | https://linear.app/sats21m/project/masons-budget-app-0c5a8656081e |
| MC2 dashboard mockup | `~/.openclaw/workspace-sats-minimax-personal/v6_mc2_money.png` |

## SAT-303 audit findings — 2026-04-30

> Pre-flight audit for the iCloud move. Result: SAT-303's symlink strategy keeps every existing consumer working, so the active migration is just the folder + symlink — not a sweep through every hardcoded path.

**Path resolution check:** `~/Workspace MC2 → ~/.openclaw/workspace-mc2` (symlink). Both names hit the same inode (33630082). iCloud target `~/Library/Mobile Documents/com~apple~CloudDocs/MC2/` does not yet exist — SAT-303 creates it.

**Hardcoded MC2-path consumers found (~12 files + ~15 mockup scripts):**
- LaunchAgents: `com.sats.missioncontrol.plist`, `com.sats.mc2.retirement-auto-contributions.plist`
- Cron jobs in `~/.openclaw/cron/jobs.json` — Intel cycles (3×/day), daily-notes sync, retirement contributions, BTC snapshot push
- `~/.openclaw/openclaw.json` — `scriptPath` + `statusFile` keys
- `gmail-receipt-scanner.js` in workspace-sats-gpt-personal-2 (cross-workspace require)
- Symlink cluster: `~/.openclaw/workspace-sats-daily-ops/mission-control/{,.env,gdrive-credentials.json,node_modules}` → into workspace-mc2
- The dashboard's own `server.js` + scripts/

**With the SAT-303 symlink in place at `~/.openclaw/workspace-mc2/mission-control/ → iCloud`, all of the above keep working transparently.** No code changes required for the move.

**Pre-existing rot (SAT-313 — fixed 2026-04-30):**
- `~/Library/LaunchAgents/com.victor.btcpricemonitor.plist` — updated to `workspace-mc2` path, LaunchAgent reloaded.
- Python files in `mc2-mockups/` — only in Trash and archive directories, no active code to fix.
- No `MC2_PATH` env-var indirection anywhere — every consumer is absolute. Worth introducing as a chore once the move is done.

**iOS app already expects iCloud:** `MC2Reader.swift` and `SettingsTab.swift` are designed for the iCloud target. No app-side changes needed for the move.
