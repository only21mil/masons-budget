# The Vogel Vault

A private, Bitcoin-native budget and family-finance application. The internal
repository name remains “Mason's Budget App.”

> Start with [`docs/HANDOFF.md`](docs/HANDOFF.md). It records the current
> architecture, write contract, safety invariants, and evidence boundary.

## Clients

| Client | Path | Stack |
| --- | --- | --- |
| iOS and macOS | `MasonsBudget/` | SwiftUI and SwiftData |
| Linux desktop | `linux/` | Electron, React, TypeScript, and Vite |
| Android | `android/` | Kotlin and Compose |
| Backend | `convex/` | Convex system of record |

The family/visibility contract lives in `shared/domain` and mirrors
`MasonsBudget/MasonsBudget/Models/SharedEnums.swift`, which is authoritative.
Adults can see household and child records, but adult net worth includes adult
owners only. Children see only their own records.

There is no Plaid integration, bank linking, or third-party financial
aggregator.

## Working on the repository

Tracking, review, and builds are on GitHub. Work on a branch and open a pull
request; never commit to `main`. The Buzz relay is a read mirror, not an
authority. See `AGENTS.md` for the approval gates around
Apple builds, releases, production Convex operations, and credentials.

```bash
git clone https://github.com/only21mil/masons-budget.git
cd masons-budget
npm ci
```

Shared contract and Linux client:

```bash
npm run typecheck --workspace @vogel-vault/domain
npm run test --workspace @vogel-vault/domain
cd linux
npm run typecheck
npm run lint
npm run test
```

Convex:

```bash
cd /path/to/masons-budget
npx tsc --noEmit -p convex/tsconfig.json
npx tsc --noEmit -p convex/tsconfig.test.json
npm run convex:test
```

Android unit tests can run locally with the repository wrapper:

```bash
export ANDROID_HOME=/path/to/android-sdk
export JAVA_HOME=/path/to/jdk21
cd android
./gradlew testDebugUnitTest
```

Apple app-target builds and tests require Victor's explicit approval and run on
the approved macOS/GitHub Actions path. On Linux, the non-building static
preflight is:

```bash
scripts/vv-swift-check.sh
```

`MasonsBudget/project.yml` is the XcodeGen source of truth. Never hand-edit the
generated `.xcodeproj`.

## Project structure

- `convex/` — schema, authenticated row queries and mutations, legacy blob
  compatibility, migration, and tests
- `shared/domain/` — cross-client visibility, money, todo, and wire contracts
- `linux/` — Electron/React desktop client
- `android/` — Kotlin/Compose client and plain-JVM domain module
- `MasonsBudget/MasonsBudget/Models/` — SwiftData models and authoritative
  family visibility rules
- `MasonsBudget/MasonsBudget/Services/` — Convex transport, blob compatibility,
  approved writeback, prices, voice parsing, and sync orchestration
- `MasonsBudget/MasonsBudget/Views/` — shared iOS/macOS screens and components

## Data flow

Convex is authoritative; there is no service upstream of it. MC2 disappeared
when its DGX Spark host was wiped, and its source was never pushed. Its name
survives only in compatibility types for the retained JSON schema.

The production row schema and authenticated `tables:*` API are deployed, and
the approved migration populated typed rows/documents from the retained blobs.
The original `dataFiles` documents remain for shipped compatibility readers and
fallbacks.

```text
Convex system of record
    ├── typed rows/documents ──authenticated tables:* API──> current row paths
    └── unchanged dataFiles blobs ──compatibility API─────> legacy readers
```

New ledger integrations write rows. A new or reconstructed transaction uses
`tables:upsertTransaction`, not `dataFiles:appendTransaction` or
`writeback:createTransaction`. Other row mutations are documented in
[`docs/HANDOFF.md`](docs/HANDOFF.md#3-the-canonical-write-path).

Routine statement ingestion, canonical income writes, and budget-month advance
use the admin-only atomic operator described in
[`docs/production-monthly-import.md`](docs/production-monthly-import.md). The
operator writes typed rows only; it never uses table replacement, legacy blob
writeback, or the completed migration as a monthly synchronization path.

Public row mutations require the runtime-injected sync token; the monthly
operator is an internal function reachable only with deployment-scoped admin
auth. Money is integer
minor units, and HTTP calls use `format: "convex_encoded_json"` so each int64 is
tagged as `{"$integer":"<base64>"}`. Purchases are positive and refunds are
negative for every owner; the server rejects a contradictory sign instead of
correcting it.

Do not delete or casually change `dataFiles`, `syncVersions`,
`todoTombstones`, the Swift `MC2*` compatibility types, or legacy JSON decoding.
They remain load-bearing until every shipped blob reader/writer has retired and
a reviewed convergence plan has landed.

## Voice entry

The iOS voice-entry screen uses `SFSpeechRecognizer` and `AVAudioEngine`.
Tapping the microphone starts or stops recognition; the transcript is parsed
locally into amount, merchant, category, date, payment method, and note fields
for review before saving. The current code does not require Apple's on-device
recognition mode, and microphone capture is unavailable in the macOS target.

## Configuration

| Key | Value |
| --- | --- |
| Bundle ID | `com.sats21m.masonsbudget` |
| Apple team | `384ZGKG4GB` |
| iOS deployment target | 17.0 |
| macOS deployment target | 14.0 |
| Swift language version | 5.9 |

Release workflows are manually triggered and approval-gated. Signing material
and App Store Connect credentials belong in GitHub Actions secrets, never in
source or documentation.

The Framework laptop is the primary development and Linux-preflight host.
Automatic Apple CI and the default manual release route use the self-hosted
MacBook Pro label `mason-mbp`; the self-hosted Mac mini label `mason-mini` is
available only through an explicit manual fallback selection. No workflow uses
GitHub-hosted macOS/Xcode runners.

## Privacy

- No Plaid, bank linking, third-party aggregation, analytics, or tracking
- Convex is the private household backend
- Voice audio is submitted to Apple's speech-recognition framework and is not
  retained by the app after recognition
- Full policy: [`PRIVACY.md`](PRIVACY.md)

## Documentation

- [HANDOFF.md](docs/HANDOFF.md): Architecture, canonical writes, safety invariants, and current handoff.
- [apple-self-hosted-release.md](docs/apple-self-hosted-release.md): Apple runner setup and manual release signing requirements.
- [bitcoin-ledger-cutover.md](docs/bitcoin-ledger-cutover.md): Bitcoin ledger activation gates and reconciliation plan.
- [btc-fiat-availability-investigation.md](docs/btc-fiat-availability-investigation.md): BTC fiat availability investigation and proposed fix.
- [buzz-ios-release.md](docs/buzz-ios-release.md): Manual Buzz iOS TestFlight release procedure.
- [buzz-macos-build-supervisor.md](docs/buzz-macos-build-supervisor.md): Unsigned Buzz macOS build isolation and supervisor boundaries.
- [buzz-macos-release.md](docs/buzz-macos-release.md): Manual Buzz macOS signing, notarization, and artifact procedure.
- [ci-result-reuse.md](docs/ci-result-reuse.md): Premerge qualification, protected check reuse, and landing evidence.
- [convex-codegen-safety.md](docs/convex-codegen-safety.md): Offline generated-code checks and approval-gated remote generation.
- [convex-deploy-hatch-state.md](docs/convex-deploy-hatch-state.md): Recorded production authentication hatch state and evidence limits.
- [convex-deploy-preflight.md](docs/convex-deploy-preflight.md): Historical production deployment preflight evidence.
- [convex-migration-runbook.md](docs/convex-migration-runbook.md): Completed row migration record, retained for audit provenance.
- [convex-query-scalability-audit.md](docs/convex-query-scalability-audit.md): Historical row-query scalability analysis and scan limits.
- [convex-read-auth-cutover.md](docs/convex-read-auth-cutover.md): Read authentication cutover history and rollback procedure.
- [dependency-security-audit-2026-07-27.md](docs/dependency-security-audit-2026-07-27.md): Historical dependency security findings as of July 27, 2026.
- [design/recent-unlock-profile-switch.md](docs/design/recent-unlock-profile-switch.md): Recent-unlock authentication rules for adult profile switching.
- [finance-share-repair-runbook.md](docs/finance-share-repair-runbook.md): One-time finance share-quantity repair procedure.
- [linux-apple-build-boundary.md](docs/linux-apple-build-boundary.md): Linux static checks and the boundary around native Apple builds.
- [linux-device-writeback.md](docs/linux-device-writeback.md): Linux device credentials and approved writeback behavior.
- [market-quote-boundary.md](docs/market-quote-boundary.md): Market quote storage and its separation from retirement records.
- [net-worth-snapshot-repair.md](docs/net-worth-snapshot-repair.md): Net-worth snapshot contamination assessment and repair decisions.
- [production-monthly-import.md](docs/production-monthly-import.md): Admin-only atomic monthly import procedure and approval gates.
- [transaction-owner-enforcement.md](docs/transaction-owner-enforcement.md): Canonical household and child ownership rules for transactions.
- [vogel-vault-transaction-contract.md](docs/vogel-vault-transaction-contract.md): Cross-client payment sources, transaction writes, and conformance rules.

## License

Private — family use only.
