# The Vogel Vault — build handoff

**Updated 2026-07-27 against `build/finish-vogel-vault` at `e2d0781`.** Supersedes
`PLAN.md`, which is archival. If you are picking this up cold, read this file
first and trust it over anything in `PLAN.md` or older wiki entries. Remaining
integration work is tracked by [umbrella issue #46](https://github.com/only21mil/masons-budget/issues/46).

This handoff distinguishes the integration tree from its review queue. Sixteen
PRs merged after the previous `f037d19` handoff snapshot. The twelve-PR queue
recorded at the start of this refresh was #72, #74 and #77–#86; #87, #88 and #90
joined it during verification. The queue is live, so inspect GitHub rather than
copying this count. A queued implementation is described as queued until it
lands, even when its implementation code already exists.

---

## 1. The goal

A private family finance app for the Vogels — Victor and Rachel (adults), Mason and
Maddox (children). It tracks budgets, transactions, todos, bills, Bitcoin holdings
and net worth, with per-person visibility rules so the children see their own money
and the adults see the household.

Three clients, one shared contract:

| Client | Stack | Who uses it |
|---|---|---|
| iOS / macOS | SwiftUI | Rachel, Mason — the daily drivers |
| Linux desktop | Electron + React + TypeScript + Vite | Victor (Framework desktop, Yoga) |
| Android | Kotlin + Compose | Victor's Pixel 10 Pro Fold |

Backend is **Convex** (`keen-elephant-452`). It is the *system of record* as of
2026-07-26 — see §3.

**Not going on the App Store.** iOS distribution is TestFlight only, forever. See
the comment block in `ExportOptions.plist` before you touch signing.

---

## 2. How to work on this repo

These are Victor's standing rules, not suggestions:

- **GitHub only. Keep nothing local.** Branch, PR, merge. Clone into an ephemeral
  `/tmp` directory and delete it when you are done. No long-lived working copies.
- **No Linear.** Tracking is GitHub issues/PRs plus the session task board.
- **Builds run in CI, not on a workstation.** The Framework desktop has no Swift,
  no Android SDK, no Xcode. CI is the first compile for Swift and Kotlin, always.
- **Ask only for visual decisions.** Everything else, proceed.
- **Approval-gated:** app builds, anything touching production Convex data,
  credential changes, packaging/publishing.
- **The session task-board controls live outside this repository.** The current
  fleet installer defines four hooks in `~/.claude/settings.json`:
  `PostToolUse[Bash] --claude`, `PostToolUse[Workflow|Agent] --dispatch`,
  `UserPromptSubmit --preflight`, and `Stop --stop`. The recover/recreate issue
  [#47](https://github.com/only21mil/masons-budget/issues/47) still says three
  because it predates the `UserPromptSubmit` hook; do not use that stale count.
- **Worker timeout has two ceilings.** The fleet's maintained Codex worker
  wrapper defaults to and caps itself at 1200 seconds. A Claude Code caller that
  waits synchronously is still cut off by the harness at 600 seconds; invoke the
  wrapper detached to make the full 1200 seconds usable. After exit 124, check
  `gh pr list` before declaring failure because the branch or PR may already
  have been pushed.

The hook installer and worker wrapper are fleet-owned, not files in this tree.
Their names and limits above were verified against the installed 2026-07-27
fleet copies; this repository can link the tracking issue but cannot enforce
those controls.

---

## 3. Where things actually stand

### The single most important fact

**Nothing has been deployed to Convex.** The row schema, backfill migration,
public row API and writeback path are present on this integration branch and
tested, but
`keen-elephant-452` still has only the original blob tables. The new tables do not
exist there yet. Do not assume otherwise.

### What is live in production right now

- `dataFiles` — 13 JSON blob documents, the family's entire financial record
- `syncVersions`, `todoTombstones` — the blob path's bookkeeping
- `mobilePairings`, `mobileDevices` — device pairing, predates this work
- **Read authentication was recorded as ENFORCED on 2026-07-26.** That cutover
  verified no-token and wrong-token rejection, a correct-token list of 13 files,
  and rejection of tokenless `dataFiles:get`. Before that day the data was
  publicly readable.
- The same cutover recorded `ALLOW_TOKENLESS_READ` as removed. This documentation
  update did **not** re-probe production; do not present it as fresh runtime evidence.

### What MC2 was, and why it is gone

MC2 (mission-control) was a Python service on the DGX Spark that owned the data and
pushed it into Convex. **The Spark was wiped. MC2 was never pushed anywhere and is
unrecoverable.** Nothing has written to Convex since 2026-07-18. That is why Convex
became the system of record rather than a projection — there is no longer anything
upstream of it.

Consequence: **the Convex data is the only copy.** It has been backed up to two LUKS
volumes with independently re-verified sha256. Treat every migration and every write
path as operating on irreplaceable data.

### Data volumes (real production counts)

905 transactions · 31 BTC buys · 25 todos. The test fixtures use these exact counts
and the real MC2 field shapes, deliberately — a migration exercised over six rows
would not have caught the batching, the duplicate ids or the sums.

---

## 4. Domain invariants — break these and you corrupt the ledger

These are the cross-client contract, not style preferences. The integration tree
enforces the existing rules in `shared/domain` (TypeScript), `android/domain`
(Kotlin), language-neutral fixtures and Swift. The signed-spend refinement in
item 4 is implemented across those surfaces in queued PR
[#72](https://github.com/only21mil/masons-budget/pull/72); do not use the base
tree's older absolute-value helper as the intended contract.

1. **Money is integer minor units.** `bigint` in TS, `Long` in Kotlin, `v.int64()`
   in Convex. USD is cents, BTC is satoshis. Never a float, never `x * 100` — parse
   lexically. A `v.float64()` money column is a defect, full stop.

2. **`canSeeDataOwnedBy` is WIDER than `sharesNetWorthWith`.** Adults can see
   everyone's records; adult net worth only aggregates adults. A child's balance
   must never roll into an adult total. These two rules look similar and are not —
   `listBtcBuys`/`listBtcAccounts` take an explicit `scope` so the choice is named
   at the call site.

3. **Child files store spend as a POSITIVE magnitude; adult files sign it negative.**
   Do not normalise. The write path *rejects* a wrong sign rather than correcting it,
   because silently flipping a sign turns a child's spend into income.

4. **`spendAmount` is a signed budget contribution.** Positive means spent;
   negative means a credit or refund and reduces derived spend. Use
   `displaySpendAmount` only for the rendering magnitude.
   `hasOppositeSpendSign` flags the ambiguous legacy shape shared by a valid
   credit and a corrupt wrong-sign row; do not hide it with `abs`.

5. **Budget spend is DERIVED from that month's transactions.** Never a reported
   total. July's budget shows July's transactions only.

6. **`owner` is a closed literal union.** This is load-bearing: `coerceOwner` maps
   any unrecognised owner string to `"victor"` — an **adult** — so a single typo
   would promote a child's row into the adult view and adult net worth. The schema
   refuses unknown owners rather than coercing them.

7. **The blob path must stay byte-identical during migration.** The production
   fallback still depends on it. A bumped `syncVersions` version makes every
   blob reader re-download everything; a touched `todoTombstones` row can
   resurrect a deleted todo. `snapshotBlobWorld` in `convex/migrate.test.ts`
   guards `dataFiles`, `syncVersions`, and `todoTombstones`.

---

## 5. What is done

### Backend (Convex)

- `convex/schema.ts` — row tables: `transactions`, `todos`, `btcBuys`,
  `btcAccounts`, `btcBillPays`, plus the closed owner union and indexes
- `convex/tables.ts` — bounded, authenticated public row/document projections
  plus runtime queries and upsert mutations. Query callers name visibility
  versus net-worth scope explicitly; runtime validators reject unknown owners
  and malformed arguments.
- `convex/migrate.ts` — the **sole** blob→row migration. `internalMutation`, so it
  is unreachable over HTTP. `apply` defaults to `false`, and writes are idempotent
  via a deterministic `sourceKey`. Post-write verification checks row count, exact
  summed money per column, and canonical-JSON round-trip.
- `convex/writeback.ts` — validating write path (`createTransaction`,
  `editTransaction`, `createTodo`, `editTodo`). Rejects, never coerces. Keeps an
  append-only audit of what an edit replaced.
- `convex/dataFiles.ts` — the blob path, now behind fail-closed read/sync auth
- `scripts/convex-migrate.mjs` — migration driver, dry run by default, with
  versioned/redacted JSON evidence. The CLI can carry a backend
  `frozenPlanFingerprint`, but the current backend `migrate:status` does not
  produce one. A production deploy/backfill therefore remains blocked until a
  reviewed dry run emits a frozen-plan fingerprint and apply is demonstrably
  bound to that exact fingerprint.
- `scripts/verify-read-auth.sh` — reports `OPEN`, `ENFORCED`,
  `TOKEN-UNCONFIGURED`, `WRONG-KNOWN-GOOD`, `OUTAGE`, `CLOSED-UNCONFIRMED`, or
  `UNKNOWN`. `ENFORCED` requires anonymous and wrong-token rejection plus a
  successful supplied known-good token, so "shut" is distinguishable from
  "working"
- The verifier has **seven states**, not five. The list above is copied from the
  script's `usage()` contract; do not collapse an outage, missing deployment
  token, wrong known-good token, or unconfirmed closure into "closed".
- At this snapshot, the integration tree's local deterministic suites report
  **429 Convex tests and 84 shared-domain tests passing**. Client PR check state
  is separate and can change; inspect GitHub before merging queued work.

### Clients

- **Integration tree at `e2d0781`:** Linux and Android have strict authenticated
  row transports and tagged-int64 decoders, but their screen-level cutovers have
  not landed here. Swift has authenticated blob reads and its own strict
  `ConvexTaggedInt64Decoder`.
- **Queued Linux cutover
  [#82](https://github.com/only21mil/masons-budget/pull/82):** loads the bounded
  row/document API through the hardened Electron bridge when
  `VOGEL_VAULT_REMOTE_READ` is enabled. With the flag off it opens no socket;
  absent/empty row tables do not touch the blob path and degrade to the client's
  sanitized fallback/empty presentation.
- **Queued Android cutover
  [#83](https://github.com/only21mil/masons-budget/pull/83):** replaces the
  production fixture ViewModel path with authenticated row snapshots when
  remote rows are enabled. Missing/unavailable tables become explicit
  `ERROR`/`EMPTY` state rather than fabricated live figures or a blob fallback.
  Its signed transaction projection dependency is queued separately in
  [#88](https://github.com/only21mil/masons-budget/pull/88).
- **Queued iOS/macOS cutover
  [#85](https://github.com/only21mil/masons-budget/pull/85):** a default-off
  `convex_row_reads_enabled` flag selects typed row queries for transactions,
  todos, budgets, BTC buys and bill pays. While the tables/functions are absent,
  only the specific row-API-unavailable error falls back to authenticated
  blobs; auth and malformed-money failures remain hard failures. BTC accounts
  and several document-shaped datasets intentionally remain on blobs pending
  owner-preserving models.
- **Swift does not natively decode Convex tagged integers.** This app uses a
  custom `URLSession` client, not the native Convex Swift SDK. PR
  [#53](https://github.com/only21mil/masons-budget/pull/53) added the app's own
  strict recursive decoder for `{"$integer":"<base64>"}` before the queued row
  cutover. This is the Rachel/Mason daily-driver path; never remove or bypass
  that decoder.

### Infrastructure

- CI (`clients.yml`) builds and tests domain, Linux and Android, and produces design
  packets for visual review
- `deploy.yml` signs as team `384ZGKG4GB` with App Store Connect API-key secrets
  `ASC_API_KEY_P8`, `ASC_KEY_ID`, and `ASC_ISSUER_ID`; the Apple-ID password and
  `.p12` paths are retired. It preserves the signed `.ipa`/`.pkg` before upload
  and now runs an App Store Connect visibility preflight before archive/upload.
- `linux-package.yml` is a manual, approval-gated `.deb`/AppImage packaging
  workflow with package verification and smoke checks. This is no longer an
  unimplemented packaging path, but no production package run was performed for
  this handoff.
- `workflow-lint.yml` runs actionlint plus a secret-inventory cross-check that fails
  the build if a declaration outlives its use
- Fleet sync is Syncthing (whole folder, no allowlist), replacing the Spark's Python
  sync

---

## 6. What is left

Ordered. Each item names its gate.

### A. Deploy Convex and run the backfill — **Victor's approval required**

The largest remaining piece and the riskiest, because it operates on the only copy
of the family's financial record.

1. Finish and review the pre-write proof/plan-binding work in
   [umbrella issue #46](https://github.com/only21mil/masons-budget/issues/46).
   **A frozen-plan fingerprint is a deploy/backfill precondition, not optional
   evidence.** The current backend does not emit one, so stop here today.
   The implementation is queued in
   [#90](https://github.com/only21mil/masons-budget/pull/90); its existence is
   not permission to deploy before review and merge.
2. Deploy the reviewed schema to `keen-elephant-452` (the row tables do not exist
   there yet).
3. Run `node scripts/convex-migrate.mjs --prod --json` for a production-targeted
   dry run. Without `--prod`, the command targets the configured development
   deployment.
4. Inspect the machine-readable pre-write evidence: projected row counts, exact
   summed money per column, canonical round trip, unique keys, legacy-world
   fingerprint and frozen-plan fingerprint must all agree. Freeze that exact
   evidence for review.
5. Apply only if the reviewed implementation requires and verifies the exact
   frozen-plan fingerprint. `--apply --prod --confirm-production` by itself is
   not sufficient plan binding in the current tree.
6. Run the read-only post-deploy verifier after its queued implementation
   [#84](https://github.com/only21mil/masons-budget/pull/84) lands.
7. Re-run
   `CONVEX_READ_TOKEN="$THE_TOKEN" scripts/verify-read-auth.sh --expect enforced`
   afterwards. The token and expectation must be on the same invocation.

The current branch's dry run projects inserts/updates and its ordinary
verification remains deferred because it writes nothing. The CLI evidence schema
can report a backend fingerprint, but that is not the same as the backend
producing a frozen plan or apply requiring it. Do not perform or approve the
production backfill until both halves are present and reviewed.

### B. Land and enable the client row cutovers

The three screen-level cutovers are implemented in queued PRs
[#82](https://github.com/only21mil/masons-budget/pull/82),
[#83](https://github.com/only21mil/masons-budget/pull/83), and
[#85](https://github.com/only21mil/masons-budget/pull/85). Review and land them
against integration; do not enable their runtime flags in production until the
row schema/API and backfill exist and verification passes.

All three HTTP paths require an explicit strict decoder for Convex
`{"$integer":"<base64>"}` values. Linux and Android have theirs in the
integration tree. Swift has its own decoder from PR #53; it does **not** get
this behavior natively from `JSONDecoder` or from a Convex SDK.

Android's Room DAO/schema landed in PR #58. The ViewModel/cache wiring remains
queued in [#74](https://github.com/only21mil/masons-budget/pull/74).

### C. TestFlight — **Victor's approval required**

Archive and export already succeed. Upload fails:

```
APP STORE CONNECT API list-apps: status code 500  (x5)
Cannot determine the Apple ID from Bundle ID 'com.sats21m.masonsbudget'
```

Before retrying, use the landed preflight to confirm an app record for
`com.sats21m.masonsbudget` **exists in App Store Connect** and the API key's role
can see it. TestFlight lives inside App Store Connect, so even a testers-only
build needs that record — it is a container, not a store listing. The workflow
signs as team `384ZGKG4GB` and requires exactly `ASC_API_KEY_P8`, `ASC_KEY_ID`,
and `ASC_ISSUER_ID`. Do not restore the retired
`APPSTORE_USERNAME`/`APPSTORE_PASSWORD` or `.p12` route.

Five consecutive 500s over hours is long for a transient outage, so rule out app
record/key visibility before assuming Apple is simply down. App Store visibility
preflight and remaining deploy hardening are tracked in [issue #46](https://github.com/only21mil/masons-budget/issues/46).
A retry preserves the signed `.ipa`/`.pkg` as an artifact before upload, so a
failed upload does not discard the archive/export result.

### D. Linux packaging — **approval-gated**

The manual `linux-package.yml` path now builds and verifies `.deb` and AppImage
artifacts. Triggering a package run remains approval-gated. This documentation
update did not run it and therefore does not claim a produced installer.

### E. Backfill the missing transactions

Victor is reconstructing transaction history by hand and will hand it over. Once the
row tables exist and the writeback path is deployed, that data goes in through
`convex/writeback.ts`, which validates rather than trusts.

### F. Smaller, tracked

- [Issue #20](https://github.com/only21mil/masons-budget/issues/20) is narrowly the
  Linux CSV export row-builder unit suite: adult parity, child isolation/signs,
  net-worth flags, validator acceptance, and exact money strings. It is not the
  client row-cutover tracker. The suite exists in
  `linux/test/csv-export-rows.test.ts`; the issue is still open and should be
  reconciled rather than treated as evidence that the tests are absent.
- All production row cutover, client transport, migration proof, release, signing,
  and packaging work belongs under [umbrella issue #46](https://github.com/only21mil/masons-budget/issues/46).
- Task-board installer recovery and canonical ownership remain tracked in
  [issue #47](https://github.com/only21mil/masons-budget/issues/47). The installed
  fleet copy now defines four hooks; the issue's three-hook acceptance text is
  stale.
- Convex query scalability/index changes are queued in
  [#77](https://github.com/only21mil/masons-budget/pull/77); review that PR before
  repeating the old blanket claim that every row query still relies on
  unbounded `.collect()`.
- Production escape-hatch state is still unverified. The read-only attempt
  recorded in [#87](https://github.com/only21mil/masons-budget/pull/87) stopped
  before production because the checkout had no deployment binding. Fresh
  authorized evidence that `ALLOW_TOKENLESS_SYNC` is absent is a deploy
  precondition.

---

## 7. Things that will bite you

- **Nothing is deployed to Convex.** Said twice on purpose.
- **CI is the first compile for Swift and Kotlin.** No workstation in the fleet can
  build them. A green local run proves nothing about those two clients.
- **The escape hatch outranks the token.** `ALLOW_TOKENLESS_READ=true` admits a call
  even when `CONVEX_READ_TOKEN` is set. That is deliberate and documented, and it is
  why `verify-read-auth.sh` sends a deliberately-wrong control credential: it is the
  only automated way to catch a set token silently doing nothing.
- **The client cutovers do not imply a backend deploy.** PRs #82/#83/#85 are
  queued, their live modes are gated, and the row tables still do not exist on
  `keen-elephant-452`. Their absent-table paths fail, render empty/fallback state,
  or use authenticated blobs as documented above. Do not mutate `dataFiles`,
  `syncVersions` or `todoTombstones` from the migration.
- **`spendAmount` is not a display absolute value.** A refund must remain
  negative so it reduces the month's derived spend. Use
  `displaySpendAmount` to render a magnitude and preserve
  `hasOppositeSpendSign` for corrupt/ambiguous legacy rows.
- **Swift needs the repository's tagged-int64 decoder.** It uses a custom HTTP
  client; `JSONDecoder` does not natively turn Convex
  `{"$integer":"<base64>"}` into `Int64`.
- **Salvage from before the Spark wipe lives in tags, not branches.**
  `archive/ios-redesign-20260509` holds four Swift Charts components and Siri
  Shortcuts that never reached `main` — `main` has no charts and no App Intents at
  all. Do not merge that tag; it is 149 commits behind. Cherry-pick.
- **`method: app-store` in `ExportOptions.plist` is correct for TestFlight.**
  Changing it to `development` or `ad-hoc` produces a build TestFlight refuses.

---

## 8. Convex read auth, in one paragraph

Reads and syncs are fail-closed: no token means rejected, and an unset
`CONVEX_READ_TOKEN` on the deployment also means rejected rather than open. The
token is sent as a query argument, never in argv. `scripts/verify-read-auth.sh`
probes `dataFiles:list` (metadata only, hardcoded, never `dataFiles:get`) with no
credential, a wrong credential, and if available the real one, then classifies
the deployment. `--expect enforced` deliberately fails on OUTAGE, because
"nobody can read, including me" is a rollback trigger, not a successful cutover.
The `STATE: OPEN` transcript in `docs/convex-read-auth-cutover.md` records the
pre-cutover state; it is historical, while its hatch-based rollback mechanics
remain current. No production probe was run for this documentation update.
