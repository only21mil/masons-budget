# The Vogel Vault

A voice-first, Bitcoin-native budget tracker for the family. Internal repo name is
still "Mason's Budget App".

> **Start here: [`docs/HANDOFF.md`](docs/HANDOFF.md)** — the goal, current state,
> what is done, and what is left. Read it before acting on anything else in this
> repo, including the rest of this README.

## Clients

| Client | Path | Stack |
|---|---|---|
| iOS / macOS | `MasonsBudget/` | SwiftUI, SwiftData, SFSpeechRecognizer on-device voice |
| Linux desktop | `linux/` | Electron + React + TypeScript + Vite |
| Android (Pixel Fold) | `android/` | Kotlin |
| Backend | `convex/` | Convex — system of record; shipped clients currently read legacy `dataFiles` blobs |

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
Never hand-edit the pbxproj. Releases run through the manually triggered
`.github/workflows/deploy.yml`, sign as team `384ZGKG4GB`, and use the App Store
Connect API-key secrets `ASC_API_KEY_P8`, `ASC_KEY_ID`, and `ASC_ISSUER_ID`.
The old Apple-ID password and `.p12` routes are retired. Every release needs
Victor's approval.

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

## Project structure

- `convex/` — schema, legacy blob functions, row queries, writeback, migration, tests
- `shared/domain/` — cross-client visibility, money, and wire-format contracts
- `linux/` — Electron/React desktop client
- `android/` — Kotlin/Compose Fold client and plain-JVM domain module
- `MasonsBudget/project.yml` — XcodeGen source of truth; never hand-edit the generated project
- `MasonsBudget/MasonsBudget/Models/` — SwiftData models and family visibility rules
- `MasonsBudget/MasonsBudget/Services/` — Convex transport, legacy blob compatibility,
  writeback, import, prices, voice, and sync orchestration
- `MasonsBudget/MasonsBudget/Views/` — shared iOS/macOS screens and components
- `MasonsBudget/MasonsBudgetTests/` — Swift tests

## Data flow

Convex is authoritative; there is no service upstream of it. MC2 disappeared
when its DGX Spark host was wiped, and its source was never pushed anywhere, so
it cannot be restored. The approved row migration has since populated Convex's
typed tables from the retained blobs.

The production row schema and public row API are deployed, and the row migration
has been applied. That includes the five formerly skipped document sources:
`budget`, `mason-budget`, `btc-balance-snapshot`, `finances`, and
`son-balances`. The original JSON documents remain in `dataFiles`;
`syncVersions` and `todoTombstones` still support compatible blob readers and
must not be altered by row work.

```
Convex system of record
    ├── unchanged `dataFiles` blobs (compatibility/fallback)
    └── migrated typed rows/documents ──authenticated row API──> clients
```

Verify this state rather than inferring it from a successful request: make an
authenticated `tables:rowCounts` request, inspect the typed document queries,
and compare their values with the source blobs. The HTTP request must explicitly
set `format: "convex_encoded_json"`. Under that format, every `v.int64()` is
`{"$integer":"<base64>"}` containing exactly eight little-endian two's-complement
bytes. Plain `format: "json"` returns decimal strings and is not a compatible
substitute for the clients' strict row decoders.

The migration leaves `dataFiles`, `syncVersions`, and `todoTombstones`
byte-identical. Deployment and client cutover remain coordinated under
[umbrella issue #46](https://github.com/only21mil/masons-budget/issues/46).

### Measured financial contract

- Purchases are positive for every owner, refunds are negative, and
  `category == "Income"` contributes zero to `spendAmount`. Verify a real
  `tables:listTransactions` response: every non-Income row must have
  `spendAmount == amountCents`; every Income row must have `spendAmount == 0`.
- Adult BTC net worth uses exactly one adult `btcBalanceDocuments` total. The
  authoritative production snapshot is **5.41782856 BTC as of 2026-07-16**.
  Do not sum it with overlapping `btcAccounts` or the older
  `balanceDocuments` observation of 4.87970749 BTC.
- Income uses the dedicated `income` table only: **16 rows, $34,893.47** in the
  measured production snapshot. Transaction rows categorized as Income are
  mirrors and contribute zero.
- `btcBillPays` is its own ledger section: **31 rows, $25,634.05**. It is not an
  input to an existing balance or net-worth total because those balances already
  reflect the spend.
- An empty required financial source is **unavailable**, not zero. A zero is
  authoritative only when the required source exists and explicitly reports
  zero. This rule does not apply to non-financial collections such as open todos.

**Release order is load-bearing:** deploy and verify the corrected Convex
transaction projection before building any client that enforces the corrected
sign contract. Such a client rejects a row when `spendAmount != amountCents`
(except Income), and one rejected row discards the entire response. Shipping the
client first recreates a total read outage.

## Voice Input

The voice flow works in three stages:

1. **Capture** — `VoiceCaptureView` uses `SFSpeechRecognizer` (on-device, en-US) with `AVAudioEngine`. Tap-and-hold mic FAB on Dashboard.
2. **Parse** — `VoiceParser` extracts amount ($45, "five dollars"), merchant (at/from/to prepositions), category (merchant mapping + keywords), date (today/yesterday/weekdays/ISO), card (on/with), and note (note: prefix).
3. **Confirm** — Review parsed result with Edit/Save buttons. Saves directly to SwiftData.

## MC2 history and blob compatibility

MC2 (mission-control) was the Python service that originally owned the family
finance JSON and pushed projections into Convex. It is gone, but its file names,
field names, record shapes, and adult-versus-child conventions survive in the
only remaining copy of the data and therefore throughout the code.

The Swift client reads Convex `dataFiles` documents including `budget`,
`transactions`, `bitcoin-buys`, `bitcoin-bill-pays`, `btc-balance-snapshot`,
`finances`, `son-balances`, and the Mason-specific files. `MC2DTOs`, `MC2Mapper`,
`MC2Reader`, and `MC2SyncService` are historical compatibility names: these
types now read from Convex, not from an MC2 process. Keeping the names and shapes
stable protects existing JSON decoding and SwiftData mapping during cutover.

Do not delete the blob path, alter `syncVersions`/`todoTombstones`, or break old
JSON decoding when adding row reads. Production migration and client cutover are
approval-gated and coordinated under [issue #46](https://github.com/only21mil/masons-budget/issues/46).

## Configuration

| Key | Value |
|---|---|
| Bundle ID | `com.sats21m.masonsbudget` |
| Team | `384ZGKG4GB` |
| iOS Target | 17.0+ |
| Swift | 5.9 |
| Code Sign | Automatic |

## Privacy

- No Plaid, no bank linking, no third-party data aggregation
- Voice processed on-device via Apple's SFSpeechRecognizer
- Convex is the private backend and system of record; clients cache mapped data locally
- No Plaid-style aggregator, analytics, or tracking
- Full privacy policy: `PRIVACY.md`

## License

Private — family use only.
