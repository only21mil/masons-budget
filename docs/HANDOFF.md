# The Vogel Vault — build handoff

**Tree audit: 2026-07-29 at `62c41bb` (`main` after the Wave 1b merge).** This
is a source-tree handoff, not a fresh production
probe. Production observations below are explicitly dated. Inspect current
GitHub issues and pull requests before starting work; do not copy queue counts
from an old handoff.

The remaining integration and release work is tracked under
[umbrella issue #46](https://github.com/only21mil/masons-budget/issues/46).

## 1. What this system is

The Vogel Vault is a private family finance application for Victor and Rachel
(one adult household) and Mason and Maddox (isolated child profiles). It tracks
budgets, transactions, todos, Bitcoin, retirement, bills, income, and net
worth.

| Client | Tree | Stack |
| --- | --- | --- |
| iOS and macOS | `MasonsBudget/` | SwiftUI and SwiftData |
| Linux desktop | `linux/` | Electron, React, TypeScript, and Vite |
| Android | `android/` | Kotlin and Compose |
| Shared contract | `shared/domain/` | TypeScript plus language-neutral fixtures |
| Backend | `convex/` | Convex deployment `keen-elephant-452` |

Convex is the system of record. MC2 was a Python service on the wiped DGX Spark;
it was never pushed and is unrecoverable. Names such as `MC2DTOs`, `MC2Mapper`,
`MC2Reader`, and `MC2SyncService` remain only because shipped Swift clients
still need the legacy JSON decoding contract. There is no live MC2 service or
separate repository to recover.

## 2. Recorded production posture

The row schema and authenticated public `tables:*` API are deployed, and the
approved blob-to-row migration populated the typed row/document tables. The
five document sources that were once skipped—`budget`, `mason-budget`,
`btc-balance-snapshot`, `finances`, and `son-balances`—are part of that
projection.

The original 13 JSON documents remain in `dataFiles`. They are a retained
compatibility copy for shipped blob readers and fallback paths, not a separate
upstream. `syncVersions` and `todoTombstones` remain part of that legacy
contract. Do not alter or delete any of those three surfaces as a side effect of
row work.

Read authentication was recorded as `ENFORCED` on 2026-07-26, with
`ALLOW_TOKENLESS_READ` removed. This documentation refresh did not re-probe
production and makes no claim about current row counts, balances, token values,
or escape-hatch state. Use an approved, credential-safe operational check when
fresh evidence is required.

## 3. The canonical write path

New ledger integrations write the typed tables through the mutations in
`convex/tables.ts`. For a transaction, use **`tables:upsertTransaction`**.
Do not use `dataFiles:appendTransaction` or
`writeback:createTransaction` for new ingestion: those are legacy blob writers.

The current row mutation surface is:

| Data | Mutation |
| --- | --- |
| Create or replace a transaction | `tables:upsertTransaction` |
| Delete a transaction | `tables:deleteTransaction` |
| Create or replace a todo | `tables:upsertTodo` |
| Delete a todo | `tables:deleteTodo` |
| Create or replace a BTC buy | `tables:upsertBtcBuy` |
| Create or replace a BTC bill pay | `tables:upsertBtcBillPay` |
| Create or replace a BTC account | `tables:upsertBtcAccount` |
| Edit a budget category | `tables:upsertBudgetCategory` |

Every one of these mutations calls `validateSyncToken`. The caller must inject
the household sync token at runtime as the `token` argument, and the deployment
must have `CONVEX_SYNC_TOKEN` configured. Never hardcode, bundle, commit, log,
or document the token. `ALLOW_TOKENLESS_SYNC=true` deliberately outranks the
token and opens the mutation surface; it is an incident rollback hatch, not a
normal configuration.

Money crosses this API as integer minor units: cents for USD and satoshis for
BTC. With `format: "convex_encoded_json"`, each `v.int64()` is encoded as:

```json
{"$integer":"<base64>"}
```

The tag contains exactly eight little-endian two's-complement bytes. Clients
must encode and decode it exactly; JavaScript `number`, floating-point
conversion, and decimal-dollar wire values are not acceptable substitutes.

For transactions, purchases are **positive** and refunds/credits are
**negative for every owner**. The caller also supplies matching intent through
`kind`; Income is a positive ledger amount with `kind: "credit"` and contributes
zero to derived spend. `tables:upsertTransaction` rejects zero amounts,
contradictory signs, unknown owners, and an Income row sent as a spend. It never
silently flips a sign.

`sourceFile` is part of transaction identity and ownership. Adult household
transactions use `transactions`; child transaction files remain isolated.
Never rely on a default adult source when writing or deleting a child row.

### Why the legacy blob write code still exists

Shipped clients have not all retired the blob compatibility path. The Swift
`AppWriteSyncService` still contains approved app-originated blob write routes,
and `convex/writeback.ts` preserves validating/audited transaction and todo
operations for that compatibility period. Those functions do not make blobs
the canonical path for new integrations.

Removing blob writers or changing the JSON shapes now would break compatible
clients and could make a later blob fallback disagree with rows. Retirement
requires an explicit convergence design, including row-native tombstones and
proof that no shipped reader or writer depends on `dataFiles`.

### Monthly import operator

[`production-monthly-import.md`](production-monthly-import.md) defines the
reviewed route for routine admin ingestion.

The operator is admin-only and writes canonical typed rows from a private
fd-only manifest. It uses deterministic stable IDs, create-or-identical-no-op
semantics, canonical income rows, and an in-place budget-month advance that
carries categories/configuration without inventing missing monthly history.
Bill pays remain excluded from budget spending. Runtime source locks and
tombstones stay enforced.

Each manifest is capped at 100 ledger rows and commits with its optional month
advance as one atomic operation. The required sequence is dry run, exact-plan
apply, canonical readback using the same manifest, then a no-change replay
check. Evidence is structural and redacted. A lost or malformed completion
response is an unknown outcome that must be resolved by manifest-bound readback
before any retry. Neither recovery nor rollback may use table replacement,
legacy blob replay, or the completed migration.

## 4. Financial and visibility invariants

1. **Victor and Rachel are one adult household.** Canonical adult records may
   carry owner `victor`; Rachel still sees them through the visibility rule.
2. **Children are isolated.** Mason and Maddox must never see adult or sibling
   records.
3. **Visibility and net-worth scope differ.** Adults can see child records, but
   a child's balance must never enter adult net worth.
4. **Money is exact integer minor units.** TypeScript uses `bigint`, Kotlin uses
   `Long`, Swift uses exact integer/`Decimal` boundaries, and Convex uses
   `v.int64()`.
5. **Purchase and refund signs are owner-independent.** Purchases are positive;
   refunds are negative.
6. **Budget spend is derived from signed transactions for the selected month.**
   Refunds reduce spend. Income contributes zero.
7. **Unknown owners fail closed.** Never coerce an unrecognised owner to an
   adult.
8. **Missing financial data is unavailable, not zero.** A confident zero is
   valid only when the authoritative source is present and explicitly reports
   zero.

Swift's `FamilyMember.canSee(dataOwnedBy:)` is authoritative. The
`shared/domain/fixtures/visibility-cases.json` vectors keep TypeScript, Kotlin,
and Swift aligned. When the Swift rule changes, update the fixture and every
parity suite in the same commit.

## 5. Read path and client state

All three clients contain authenticated row transports and strict tagged-int64
decoders. Runtime configuration still matters: source code containing a row
reader does not prove a released build has it enabled.

Row queries live in `convex/tables.ts`. Callers name a viewer and, where
required, choose visibility or net-worth scope. The household read token
authenticates access to the private deployment; it is not per-person identity.
Server-side visibility filtering therefore remains load-bearing.

The legacy `dataFiles` readers stay available during the compatibility period.
A row API failure must not be disguised as authoritative zero or silently
replaced with sample figures. Each client has explicit unavailable/error states;
inspect the actual client path before changing fallback behavior.

## 6. Repository map

| Concern | Source |
| --- | --- |
| Row schema and indexes | `convex/schema.ts` |
| Row queries and canonical row mutations | `convex/tables.ts` |
| Internal blob-to-row migration | `convex/migrate.ts` |
| Legacy blob functions | `convex/dataFiles.ts` |
| Legacy audited blob writeback | `convex/writeback.ts` |
| Shared visibility, money, and wire contracts | `shared/domain/` |
| Swift visibility authority | `MasonsBudget/MasonsBudget/Models/SharedEnums.swift` |
| Swift Convex transport | `MasonsBudget/MasonsBudget/Services/ConvexClient.swift` |
| Swift blob compatibility | `MasonsBudget/MasonsBudget/Services/MC2*.swift` |
| Android row transport | `android/app/src/main/kotlin/com/sats21m/vogelvault/data/` |
| Linux main-process row transport | `linux/electron/convexRows.ts` |

## 7. How to work and verify

- Work on a branch and use a GitHub pull request. Never commit directly to
  `main`; do not use Linear for this repository.
- Check open issues and pull requests before starting so another lane is not
  changing the same boundary.
- Production Convex mutations, schema deployment, migrations, credential
  changes, packaging, and release operations require explicit approval.
- Do not start an Apple app-target build, test, archive, export, or upload
  without Victor's explicit approval. Releases are manually triggered through
  GitHub Actions and both Apple schemes ship together.
- Android can compile locally with the repository wrapper and the configured SDK
  and JDK. Run `./gradlew testDebugUnitTest` from `android/`.
- Both Convex TypeScript configurations must pass:
  `npx tsc --noEmit -p convex/tsconfig.json` and
  `npx tsc --noEmit -p convex/tsconfig.test.json`.
- A regression test must be shown to fail with the fix disabled before the fix
  is restored. A test that cannot go red is not evidence.

`MasonsBudget/project.yml` is the Apple project source of truth. Never hand-edit
the generated `.xcodeproj`. The Linux-safe Apple static preflight is
`scripts/vv-swift-check.sh`; it reports missing tools instead of silently
passing.

## 8. Current follow-up boundary

Use current GitHub state rather than the old PR queue that previously filled
this file. As of this audit, the durable tracked items include:

- [#46](https://github.com/only21mil/masons-budget/issues/46): production row
  cutover and release readiness.
- [#71](https://github.com/only21mil/masons-budget/issues/71): Swift voice/CSV
  transaction sign handling. (Note: the CSV import feature itself was removed
  from the build on 2026-08-21 per Victor's order; the CSV clause of this item
  concerns signed-transaction handling, not the import screen.)
- [#73](https://github.com/only21mil/masons-budget/issues/73): secondary
  consumers of signed transaction credits.
- [#75](https://github.com/only21mil/masons-budget/issues/75) and
  [#76](https://github.com/only21mil/masons-budget/issues/76): bounded row-feed
  ordering and exact scalable counts.
- [#108](https://github.com/only21mil/masons-budget/issues/108): record Swift
  sync success only after an error-free read.
- [#110](https://github.com/only21mil/masons-budget/issues/110): distinguish
  successful migration writes from partial-write failures.
- [#145](https://github.com/only21mil/masons-budget/issues/145): Apple
  integration-boundary spend-sign and wire-golden failures.
- [#165](https://github.com/only21mil/masons-budget/issues/165): prevent stale
  Android Gradle outputs from satisfying parity CI.
- [#189](https://github.com/only21mil/masons-budget/issues/189): represent
  unavailable BTC fiat valuation without inventing zero.

This list is intentionally issue-based and non-exhaustive. Query GitHub before
acting.

## 9. Operational traps

- A successful row query does not prove every required table is populated or
  every money value is correct. Verify counts, contents, ownership, and exact
  sums independently.
- The read and sync escape hatches outrank their tokens. A configured token does
  not prove enforcement while its hatch is present.
- Swift's custom HTTP client does not get Convex int64 decoding from
  `JSONDecoder`. Requests using `convex_encoded_json` require the repository's
  strict recursive decoder.
- Row deletes do not update legacy todo tombstones, and a later blob remigration
  can resurrect a row that remains in a blob. Do not rerun migration as a
  synchronization mechanism.
- Never add a child's visible balance to an adult net-worth aggregate.
- Never correct a transaction sign silently. Reject the write and fix the
  caller.
