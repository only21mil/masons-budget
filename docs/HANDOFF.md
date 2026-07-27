# The Vogel Vault — build handoff

**Written 2026-07-26 against `main` at `beeb6aa`.** Supersedes `PLAN.md`, which is
archival. If you are picking this up cold, read this file first and trust it over
anything in `PLAN.md` or the older wiki entries.

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

---

## 3. Where things actually stand

### The single most important fact

**Nothing has been deployed to Convex.** The row schema, the backfill migration and
the writeback path are all merged to `main` and fully tested, but
`keen-elephant-452` still has only the original blob tables. The new tables do not
exist there yet. Do not assume otherwise.

### What is live in production right now

- `dataFiles` — 13 JSON blob documents, the family's entire financial record
- `syncVersions`, `todoTombstones` — the blob path's bookkeeping
- `mobilePairings`, `mobileDevices` — device pairing, predates this work
- **Read authentication is ENFORCED.** Verified four ways on 2026-07-26: no token
  blocked, wrong token blocked, correct token returns 13 files, `dataFiles:get`
  blocked without a token. Before that day the data was publicly readable.
- The `ALLOW_TOKENLESS_READ` escape hatch has been **removed** from production.

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

These are enforced in `shared/domain` (TypeScript), mirrored in `android/domain`
(Kotlin), pinned by language-neutral JSON fixtures both suites load, and mirrored
again in Swift. They are not style preferences.

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

4. **Budget spend is DERIVED from that month's transactions.** Never a reported
   total. July's budget shows July's transactions only.

5. **`owner` is a closed literal union.** This is load-bearing: `coerceOwner` maps
   any unrecognised owner string to `"victor"` — an **adult** — so a single typo
   would promote a child's row into the adult view and adult net worth. The schema
   refuses unknown owners rather than coercing them.

6. **The blob path must stay byte-identical during migration.** Every shipped client
   still reads it. A bumped `syncVersions` version makes every client re-download
   everything; a touched `todoTombstones` row can resurrect a deleted todo.
   `snapshotBlobWorld` in `convex/migrate.test.ts` guards all three tables.

---

## 5. What is done

### Backend (Convex)

- `convex/schema.ts` — row tables: `transactions`, `todos`, `btcBuys`,
  `btcAccounts`, `btcBillPays`, plus the closed owner union and indexes
- `convex/tables.ts` — runtime queries and upsert mutations
- `convex/migrate.ts` — the **sole** blob→row migration. `internalMutation`, so it
  is unreachable over HTTP. `apply` defaults to `false`. Verified three ways: row
  count, exact summed money per column, canonical-JSON round-trip. Idempotent via a
  deterministic `sourceKey`.
- `convex/writeback.ts` — validating write path (`createTransaction`,
  `editTransaction`, `createTodo`, `editTodo`). Rejects, never coerces. Keeps an
  append-only audit of what an edit replaced.
- `convex/dataFiles.ts` — the blob path, now behind fail-closed read/sync auth
- `scripts/convex-migrate.mjs` — migration driver, dry run by default
- `scripts/verify-read-auth.sh` — reports ENFORCED / OPEN / OUTAGE /
  CLOSED-UNCONFIRMED / UNKNOWN with a control probe, so "shut" is distinguishable
  from "broken"
- **394 Convex tests, 75 domain tests, all green in CI**

### Clients

- **Linux** — Electron shell with a hardened boundary (contextIsolation, sandbox,
  no node integration) guarded by 112 static checks in
  `linux/scripts/qa-preload-boundary.mjs`. 20 pages, component library, month
  picker, CSV export through a reviewed preload channel, Convex read plumbing
  behind a flag.
- **Android** — Compose app for the Fold, adaptive folded/unfolded layouts, month
  picker, real app icon, Convex read plumbing behind a flag, Roborazzi screenshots
  without an emulator. **A 14MB debug APK builds in CI on every push** with a stable
  debug keystore, so successive builds install over each other.
- **iOS** — month-scoping regression tests, a way to inject the Convex read token.
  Archive and export succeed in CI.

### Infrastructure

- CI (`clients.yml`) builds and tests domain, Linux and Android, and produces design
  packets for visual review
- `deploy.yml` signs with an App Store Connect API key (the old p12 path is retired)
  and preserves the signed `.ipa` as an artifact even when upload fails
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

1. Deploy the schema to `keen-elephant-452` (the tables do not exist there yet)
2. `node scripts/convex-migrate.mjs` — dry run, the default
3. Read the three-way verification output: row count, summed money per column,
   canonical round-trip. All three must agree.
4. `node scripts/convex-migrate.mjs --apply --prod --confirm-production`
5. Re-run `scripts/verify-read-auth.sh --expect enforced` afterwards

Do not skip step 3. The dry run is the same code path as the writer, stopped one
line short of `db.insert`, so what it reports is what will happen.

### B. Cut the clients over to the new tables

Currently every client reads `dataFiles` blobs. Once the rows exist:

- Wire Linux and Android to the row queries (task #7)
- Send the read token from both clients (task #14) — they cannot read production
  without it now
- **Known trap:** Convex encodes `v.int64()` over HTTP as
  `{"$integer": "<base64>"}`. Swift's client handles this; the Linux and Android
  HTTP readers need a decoder before they can read a single money column.
- Add Room persistence to Android (task #10)

### C. TestFlight — **Victor's approval required**

Archive and export already succeed. Upload fails:

```
APP STORE CONNECT API list-apps: status code 500  (x5)
Cannot determine the Apple ID from Bundle ID 'com.sats21m.masonsbudget'
```

Before retrying, confirm an app record for `com.sats21m.masonsbudget` **exists in
App Store Connect** and the API key's role can see it. TestFlight lives inside App
Store Connect, so even a testers-only build needs that record — it is a container,
not a store listing. Five consecutive 500s over hours is long for a transient
outage, so rule the record out before assuming Apple is simply down.

A retry is now cheap either way: the run preserves the signed `.ipa` as an artifact,
so a failed upload still yields something you can push through Transporter by hand.

### D. Linux packaging — **approval-gated**

`linux-client-dist` is a 369KB renderer bundle, not a runnable application. Getting
a real app onto the Yoga and Framework needs an Electron package (`.deb` or
AppImage). Never built.

### E. Backfill the missing transactions

Victor is reconstructing transaction history by hand and will hand it over. Once the
row tables exist and the writeback path is deployed, that data goes in through
`convex/writeback.ts`, which validates rather than trusts.

### F. Smaller, tracked

- Generalize `install-task-board-nudge`: it wires 1 of 3 hooks on a fresh machine
- `rowCounts` and the month queries use `.collect()` — fine at 905 rows, revisit
  well before it is not

---

## 7. Things that will bite you

- **Nothing is deployed to Convex.** Said twice on purpose.
- **CI is the first compile for Swift and Kotlin.** No workstation in the fleet can
  build them. A green local run proves nothing about those two clients.
- **The escape hatch outranks the token.** `ALLOW_TOKENLESS_READ=true` admits a call
  even when `CONVEX_READ_TOKEN` is set. That is deliberate and documented, and it is
  why `verify-read-auth.sh` sends a deliberately-wrong control credential: it is the
  only automated way to catch a set token silently doing nothing.
- **Two clients read the blob path and will until every one is cut over.** Do not
  mutate `dataFiles`, `syncVersions` or `todoTombstones` from the migration.
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
token is sent as a query argument, never in argv. `scripts/verify-read-auth.sh` is
the observable signal for every step of a cutover — it probes `dataFiles:list`
(metadata only, hardcoded, never `dataFiles:get`) with no credential, a wrong
credential, and if available the real one, and classifies the deployment from the
pair. `--expect enforced` deliberately fails on OUTAGE, because "nobody can read,
including me" is a rollback trigger, not a successful cutover.
