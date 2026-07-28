# The Vogel Vault — build handoff

**Updated 2026-07-27 against `integration/lane-ba-be` at `3054fb9`.** Supersedes
`PLAN.md`, which is archival. If you are picking this up cold, read this file
first and trust it over anything in `PLAN.md` or older wiki entries. Remaining
integration work is tracked by [umbrella issue #46](https://github.com/only21mil/masons-budget/issues/46).

This is a measured integration-boundary snapshot, not a durable list of queued
PRs. Inspect GitHub issues and PRs before starting work; do not copy counts from
this handoff into a new status report.

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

**The row schema and public row API are deployed, and the row migration has been
applied.** The five formerly skipped document blobs (`budget`, `mason-budget`,
`btc-balance-snapshot`, `finances`, and `son-balances`) are migrated too.
`dataFiles` remains the retained compatibility copy and must stay byte-identical
until every shipped blob reader is retired.

### What is live in production right now

- `dataFiles` — 13 JSON blob documents, the family's entire financial record
- `syncVersions`, `todoTombstones` — the blob path's bookkeeping
- `mobilePairings`, `mobileDevices` — device pairing, predates this work
- Typed row/document tables and the authenticated `tables:*` query surface. Do
  not equate "the query returned" with "the required table is populated": verify
  `tables:rowCounts` and the corresponding typed query together.
- **Read authentication was recorded as ENFORCED on 2026-07-26.** That cutover
  verified no-token and wrong-token rejection, a correct-token list of 13 files,
  and rejection of tokenless `dataFiles:get`. Before that day the data was
  publicly readable.
- The same cutover recorded `ALLOW_TOKENLESS_READ` as removed. This documentation
  update did **not** re-probe production; do not present it as fresh runtime evidence.

### What MC2 was, and why it is gone

MC2 (mission-control) was a Python service on the DGX Spark that owned the data and
pushed it into Convex. **The Spark was wiped. MC2 was never pushed anywhere and is
unrecoverable.** Convex became the system of record because there is no longer
anything upstream of it. Approved migration writes have since populated the
typed tables from the retained blobs.

Consequence: **the Convex data is the only copy.** It has been backed up to two LUKS
volumes with independently re-verified sha256. Treat every migration and every write
path as operating on irreplaceable data.

### Data volumes (real production counts)

905 Victor transactions plus 6 Mason transactions · 31 BTC buys · 31 BTC bill
pays · 16 income rows · 25 todos. The five document sources named above are
migrated as 2 `budgetDocuments`, 2 `btcBalanceDocuments`, and 1
`financeDocuments` row; `btc-balance-snapshot` and `son-balances` also project
their account rows.

These numbers were measured before this docs-only update; this change did not
re-probe production. Re-verify with an authenticated `tables:rowCounts` request
using `format: "convex_encoded_json"`, then read each typed table/document. A
count alone does not prove money or ownership is correct.

---

## 4. Domain invariants — break these and you corrupt the ledger

These are the cross-client contract, not style preferences. The integration tree
enforces the rules in `shared/domain` (TypeScript), `android/domain` (Kotlin),
language-neutral fixtures and Swift.

1. **Money is integer minor units.** `bigint` in TS, `Long` in Kotlin, `v.int64()`
   in Convex. USD is cents, BTC is satoshis. Never a float, never `x * 100` — parse
   lexically. A `v.float64()` money column is a defect, full stop.

2. **`canSeeDataOwnedBy` is WIDER than `sharesNetWorthWith`.** Adults can see
   everyone's records; adult net worth only aggregates adults. A child's balance
   must never roll into an adult total. These two rules look similar and are not —
   `listBtcBuys`/`listBtcAccounts` take an explicit `scope` so the choice is named
   at the call site.

3. **Adult and child files both store purchases as POSITIVE amounts.**
   Refunds are negative, and Income contributes zero. Production measurement
   found 888 positive purchases and 16 genuine negative refunds among Victor's
   905 rows; Mason's 6 rows are positive. Verify this against a real
   `tables:listTransactions` response, not only a fixture.

4. **`spendAmount` is a signed budget contribution.** Positive means spent;
   negative means a credit or refund and reduces derived spend. Use
   `displaySpendAmount` only for the rendering magnitude.
   `hasOppositeSpendSign` flags a credit/refund; do not hide it with `abs`.

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

8. **Canonical totals have exactly one source.** Adult BTC net worth uses one
   adult `btcBalanceDocuments` total: 5.41782856 BTC as of 2026-07-16. Never add
   overlapping `btcAccounts` or the older 4.87970749 BTC
   `balanceDocuments` observation. Income uses only the 16-row `income` table
   ($34,893.47); transaction Income mirrors add zero. The 31-row
   `btcBillPays` ledger ($25,634.05) is displayed separately and adds to no
   existing total because balances already reflect it. Verify each rule by
   reading the named production source and tracing the client aggregator.

9. **An empty required financial source is unavailable, not zero.** Render a
   confident zero only when the authoritative source is present and explicitly
   reports zero. Empty non-financial collections are different: zero open todos
   is a valid result. Verify both the source-presence flag/count and the rendered
   state; a numeric assertion alone cannot distinguish missing from zero.

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
  versioned/redacted JSON evidence and a backend-generated frozen-plan
  fingerprint. Apply is bound to the reviewed fingerprint.
- `scripts/verify-read-auth.sh` — reports `OPEN`, `ENFORCED`,
  `TOKEN-UNCONFIGURED`, `WRONG-KNOWN-GOOD`, `OUTAGE`, `CLOSED-UNCONFIRMED`, or
  `UNKNOWN`. `ENFORCED` requires anonymous and wrong-token rejection plus a
  successful supplied known-good token, so "shut" is distinguishable from
  "working"
- The verifier has **seven states**, not five. The list above is copied from the
  script's `usage()` contract; do not collapse an outage, missing deployment
  token, wrong known-good token, or unconfirmed closure into "closed".
- Do not copy a test count from this handoff. Run the commands in `AGENTS.md`,
  require nonzero discovered-test counts, and inspect current GitHub checks.

### Clients

- Linux, Android, and Swift contain authenticated row transports, strict tagged
  int64 decoding, and screen-level row-read paths. Runtime gates and compatible
  blob paths remain; inspect the actual release configuration rather than
  assuming source presence means a shipped client has enabled rows.
- A required financial row source that is absent or empty must surface as
  unavailable/error, never as a fabricated `$0.00`. This does not apply to
  genuinely empty non-financial collections.
- **Swift does not natively decode Convex tagged integers.** The tagged
  `{"$integer":"<base64>"}` shape is produced when the HTTP request names
  `format: "convex_encoded_json"`; `format: "json"` instead produces a decimal
  string such as `"2500"` for `v.int64()`. The tag contains exactly eight
  little-endian two's-complement bytes. This app uses a custom `URLSession`
  client, not the native Convex Swift SDK. PR
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

### A. Deploy the corrected transaction projection — **Victor's approval required**

The schema, row API, and migration are already live. The next release sequence
has a strict order:

1. Review and deploy the Convex bundle containing the corrected transaction
   projection.
2. Send an authenticated `tables:listTransactions` request with
   `format: "convex_encoded_json"`.
3. Measure the response: every non-Income row has
   `spendAmount == amountCents`, every Income row has `spendAmount == 0`, refunds
   remain negative, and the response is complete.
4. Re-run read-auth verification and require `STATE: ENFORCED`.
5. Only after those checks pass may any client build containing the corrected
   strict projection contract start.

This order is load-bearing. The fixed client rejects any contradictory row, and
one rejected row discards the whole response. Building or shipping the client
before the backend is verified reproduces the 100% read outage.

### B. Verify client row cutovers before enabling or releasing them

Linux, Android, and Swift already contain screen-level row-read paths. Verify the
runtime gates and actual release configuration; source code existing in a branch
does not prove a shipped build uses it.

All three HTTP paths must explicitly request `format: "convex_encoded_json"` and
strictly decode `{"$integer":"<base64>"}` as eight little-endian two's-complement
bytes. A request capture plus a real decoded response is the verification; a
unit test that only feeds a hand-written tagged object does not prove the request
selected the tagged wire format.

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
reviewed writeback path is approved for production use, that data goes in through
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
- Do not infer current escape-hatch state from an old PR or transcript. Fresh
  authorized evidence that `ALLOW_TOKENLESS_READ` and `ALLOW_TOKENLESS_SYNC`
  are absent is a deploy precondition.

---

## 7. Things that will bite you

- **The row API is deployed and populated.** The row schema and authenticated
  `tables:*` functions are live on `keen-elephant-452`; verify counts and
  contents independently.
- **Swift app builds require CI/macOS and approval.** Android's domain and
  configured unit/lint checks can run with the pinned Gradle path in `AGENTS.md`;
  neither local result substitutes for current GitHub checks.
- **The escape hatch outranks the token.** `ALLOW_TOKENLESS_READ=true` admits a call
  even when `CONVEX_READ_TOKEN` is set. That is deliberate and documented, and it is
  why `verify-read-auth.sh` sends a deliberately-wrong control credential: it is the
  only automated way to catch a set token silently doing nothing.
- **A deployed row API does not prove a completed client cutover.**
  In this production deployment the backfill is complete, but client live modes
  can still be gated. Verify the release configuration independently. Never
  interpret an empty required financial table as a confident zero, and do not
  mutate `dataFiles`, `syncVersions` or `todoTombstones`.
- **`spendAmount` is not a display absolute value.** A refund must remain
  negative so it reduces the month's derived spend. Use
  `displaySpendAmount` to render a magnitude and preserve
  `hasOppositeSpendSign` for corrupt/ambiguous legacy rows.
- **Swift needs the repository's tagged-int64 decoder when requests use
  `format: "convex_encoded_json"`.** It uses a custom HTTP client;
  `JSONDecoder` does not natively turn Convex `{"$integer":"<base64>"}` into
  `Int64`, and it also does not coerce the decimal strings produced by
  `format: "json"` into `Int64`.
- **Convex deploy comes before the corrected client build.** Verify a real
  response satisfies the corrected spend invariant first. The client rejects one
  bad projection row by discarding the whole response.
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
