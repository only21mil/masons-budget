# The Vogel Vault

A voice-first, Bitcoin-native budget tracker for the family, fed by the MC2
Mission Control financial data system. Internal repo name is still
"Mason's Budget App".

## Clients

| Client | Path | Stack |
|---|---|---|
| iOS / macOS | `MasonsBudget/` | SwiftUI, SwiftData, SFSpeechRecognizer on-device voice |
| Linux desktop | `linux/` | Electron + React + TypeScript + Vite |
| Android (Pixel Fold) | `android/` | Kotlin |
| Backend | `convex/` | Convex — MC2 pushes JSON via `dataFiles:sync`, clients read it |

The family/visibility contract lives in `shared/domain` and mirrors
`MasonsBudget/MasonsBudget/Models/SharedEnums.swift`, which is authoritative.
`shared/domain/fixtures/visibility-cases.json` pins TypeScript and Kotlin to the
same vectors as the Swift tests — change the Swift rules and the fixture changes
in the same commit.

No Plaid, no third-party financial aggregator, no data broker.

## Working on this

Tracking, review and builds are on GitHub. Nothing is kept on a workstation:
clone where you need it, push a branch, delete the checkout. See `AGENTS.md`.

```bash
git clone https://github.com/only21mil/masons-budget.git
cd masons-budget
npm ci        # workspaces: convex backend, shared/domain, linux client
```

Linux client and shared contract:

```bash
npm run test --workspace @vogel-vault/domain   # visibility + money parity
cd linux && npm run typecheck && npm run lint && npm run test && npm run dev
```

Android domain module — plain Kotlin/JVM, needs no Android SDK:

```bash
cd android && gradle :domain:test
```

Apple targets need macOS and Xcode:

```bash
cd MasonsBudget && xcodegen generate --spec project.yml
xcodebuild -project MasonsBudget.xcodeproj -scheme MasonsBudget \
  -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

`MasonsBudget/project.yml` is the source of truth; the `.xcodeproj` is generated.
Never hand-edit the pbxproj. Releases run through
`.github/workflows/deploy.yml` and need Victor's approval.

## Linux preflight

On a Linux machine, run the safe static preflight before asking a Mac build host to
compile:

```bash
scripts/vv-swift-check.sh
```

This does not run `xcodebuild`, simulator actions, signing, archives, uploads,
or TestFlight. It checks the Swift toolchain, temp XcodeGen generation,
SourceKit-backed SwiftLint, SwiftFormat, `git diff --check`, a Swift typecheck
smoke, serialized SwiftPM core tests, a `Package.resolved` mutation guard, and
a redacted gitleaks scan over tracked/unignored working-tree files.

For Apple SDK builds, use the approval-gated Mac bridge documented in
`docs/linux-apple-build-boundary.md`.

If SourceKit-LSP feels stale, use:

```bash
scripts/vv-swift-lsp-reset.sh status
scripts/vv-swift-lsp-reset.sh prime
```

## Project Structure

```
MasonsBudget/
├── MasonsBudget.xcodeproj/       # Generated — don't edit manually
├── project.yml                   # XcodeGen spec
├── MasonsBudget/
│   ├── App/                       # Entry point
│   │   └── MasonsBudgetApp.swift  # @main, ModelContainer, sync orchestration
│   ├── Models/                    # SwiftData @Model classes
│   │   ├── Transaction.swift      # Spending entries
│   │   ├── BTCAccount.swift        # BTC balances per account
│   │   ├── BTCBuy.swift           # BTC purchase records
│   │   ├── BTCBillPay.swift       # Bills paid in BTC
│   │   ├── BudgetCategory.swift    # Budget categories with icons
│   │   ├── MonthlyBudgetSnapshot.swift  # Monthly income/surplus
│   │   ├── HoldingAccount.swift    # 401k / WAP accounts + holdings + lots
│   │   ├── SyncEvent.swift        # Audit trail
│   │   ├── FamilyProfile.swift     # Per-user iCloud identity
│   │   └── SharedEnums.swift      # FamilyMember, BTCCustody
│   ├── Services/
│   │   ├── MC2Reader.swift        # Read MC2 JSON files from iCloud
│   │   ├── MC2Writer.swift        # Write append-only files + atomic snapshots
│   │   ├── MC2DTOs.swift         # Decodable DTOs matching MC2 JSON shapes
│   │   ├── MC2Mapper.swift        # DTO → SwiftData model conversion
│   │   ├── MC2SyncService.swift   # Full sync pipeline
│   │   ├── MC2FileObserver.swift  # iCloud file change watching
│   │   ├── MC2FolderManager.swift # Security-scoped folder bookmarks
│   │   ├── VoiceParser.swift      # Rules-based speech → ParsedTransaction
│   │   ├── RecurringDetector.swift # Transaction pattern detection
│   │   └── BudgetNotificationManager.swift  # Budget threshold alerts
│   ├── Theme/
│   │   └── AppTheme.swift         # Colors, typography, shared formatters
│   ├── Views/
│   │   ├── ContentView.swift      # Tab navigation (Dashboard/Money/Spending/Settings)
│   │   ├── DashboardTab.swift     # Net Worth, budget, quick actions, voice FAB
│   │   ├── MoneyTab.swift         # BTC, 401k, income, charts
│   │   ├── SpendingTab.swift      # Categories, transactions, month nav
│   │   ├── SettingsTab.swift      # Profile, MC2 folder, sync, categories
│   │   ├── VoiceCaptureView.swift # Full-screen voice input
│   │   ├── AddTransactionView.swift  # Manual transaction entry
│   │   ├── OnboardingView.swift   # First-launch walkthrough
│   │   ├── CategoryManagementView.swift  # Add/edit/delete categories
│   │   └── Components/
│   │       ├── StatCard.swift, QuickActionButton.swift, SectionHeader.swift
│   │       ├── CategoryRow.swift, TransactionRow.swift
│   │       ├── SpendingDonutChart.swift, MonthlyTrendChart.swift
│   │       ├── NetWorthHistoryChart.swift, AssetBreakdownChart.swift
│   │       ├── SyncBadge.swift, MicFAB.swift, RangePicker.swift
│   └── Resources/
│       └── Assets.xcassets/        # App icon, accent color
└── MasonsBudgetTests/              # 65 unit tests
```

## Data Flow

```
MC2 JSON files (iCloud Drive or local)
    ↕  MC2Reader / MC2Writer
MC2 DTOs (Decodable structs)
    ↕  MC2Mapper
SwiftData Models (@Model)
    ↕  @Query / ModelContext
SwiftUI Views (Dashboard, Money, Spending, Settings)
```

## Voice Input

The voice flow works in three stages:

1. **Capture** — `VoiceCaptureView` uses `SFSpeechRecognizer` (on-device, en-US) with `AVAudioEngine`. Tap-and-hold mic FAB on Dashboard.
2. **Parse** — `VoiceParser` extracts amount ($45, "five dollars"), merchant (at/from/to prepositions), category (merchant mapping + keywords), date (today/yesterday/weekdays/ISO), card (on/with), and note (note: prefix).
3. **Confirm** — Review parsed result with Edit/Save buttons. Saves directly to SwiftData.

## MC2 Integration

The app syncs bidirectionally with the MC2 Mission Control dashboard:

- **Reads**: `budget.json`, `transactions.json`, `bitcoin-buys.json`, `bitcoin-bill-pays.json`, `balances.json`, `btc-balance-snapshot.json`, `finances.json`, `son-balances.json`
- **Writes**: Append-only files in `transactions/`, `bitcoin-buys/`, `bitcoin-bill-pays/` subdirectories + atomic snapshot writes
- **Watches**: `NSMetadataQuery` on iCloud folder triggers sync on desktop changes

## Configuration

| Key | Value |
|---|---|
| Bundle ID | `com.sats21m.masonsbudget` |
| Team | `8KN6X3FLPZ` |
| iOS Target | 17.0+ |
| Swift | 5.9 |
| Code Sign | Automatic |

## Privacy

- No Plaid, no bank linking, no third-party data aggregation
- Voice processed on-device via Apple's SFSpeechRecognizer
- All data stored in user's iCloud Drive
- No backend servers, no analytics, no tracking
- Full privacy policy: `PRIVACY.md`

## License

Private — family use only.
