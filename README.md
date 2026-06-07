# Mason's Budget App

A voice-first, Bitcoin-native budget tracker for the family. iOS native (SwiftUI), integrated with the MC2 Mission Control financial data system.

## Architecture

| Layer | Choice |
|---|---|
| Platform | iOS 17+ (SwiftUI) |
| Language | Swift 5.9 |
| Data | SwiftData (local) + iCloud Drive (MC2 sync) |
| Voice | SFSpeechRecognizer (on-device) |
| Sync | iCloud Drive append-only files + NSMetadataQuery watching |
| Backend | None — no servers, no databases, no Plaid |

## Quick Start

```bash
# Clone
git clone <repo-url>
cd "Mason's Budget App/MasonsBudget"

# Install xcodegen if needed
brew install xcodegen

# Generate Xcode project
xcodegen generate

# Build
xcodebuild -project MasonsBudget.xcodeproj -scheme MasonsBudget \
  -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build

# Test
xcodebuild -project MasonsBudget.xcodeproj -scheme MasonsBudget \
  -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

## DGX Preflight

On DGX Spark, run the safe static preflight before asking the Mac build host to
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
`docs/dgx-apple-build-boundary.md`.

If SourceKit-LSP feels stale on DGX, use:

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
