# The Vogel Vault

A voice-first, Bitcoin-native budget tracker for the family. Internal repo name is
still "Mason's Budget App".

> **Start here: [`docs/HANDOFF.md`](docs/HANDOFF.md)** — the goal, current state,
> what is done, and what is left. Read it before acting on anything else in this
> repo, including the rest of this README.
>
> **MC2 is gone.** It was a Python service on the DGX Spark, the Spark was wiped,
> and it was never pushed anywhere. Convex is now the system of record, not a
> projection. `MC2`-named Swift types remain only to preserve compatibility with
> the surviving JSON blob schema while clients move to row queries.

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

Convex is authoritative. The production deployment still stores the original
JSON documents in `dataFiles`, and every shipped client must keep that blob path
working during the row-table migration.

```
Convex system of record
    ↓  dataFiles legacy JSON blobs (current shipped-client contract)
ConvexClient → MC2Reader → compatibility DTOs → MC2Mapper
    ↓
SwiftData models → SwiftUI views
```

The `MC2` names are historical compatibility names, not evidence of a running
MC2 service. Row tables, public projections, client cutover, and the production
backfill are tracked in [umbrella issue #46](https://github.com/only21mil/masons-budget/issues/46).

## Voice Input

The voice flow works in three stages:

1. **Capture** — `VoiceCaptureView` uses `SFSpeechRecognizer` (on-device, en-US) with `AVAudioEngine`. Tap-and-hold mic FAB on Dashboard.
2. **Parse** — `VoiceParser` extracts amount ($45, "five dollars"), merchant (at/from/to prepositions), category (merchant mapping + keywords), date (today/yesterday/weekdays/ISO), card (on/with), and note (note: prefix).
3. **Confirm** — Review parsed result with Edit/Save buttons. Saves directly to SwiftData.

## Legacy blob compatibility

The Swift client reads Convex `dataFiles` documents including `budget`,
`transactions`, `bitcoin-buys`, `bitcoin-bill-pays`, `btc-balance-snapshot`,
`finances`, `son-balances`, and the Mason-specific files. `MC2DTOs`, `MC2Mapper`,
`MC2Reader`, and `MC2SyncService` intentionally retain their old names so the
existing JSON decoding and SwiftData mapping remain stable during cutover.

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
