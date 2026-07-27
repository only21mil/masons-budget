# Net-worth snapshot contamination: repair assessment

Status: decision document only. This document does not authorize or implement a
migration, correction, or deletion.

## Executive finding

PR #67 corrected `MC2SyncService.recordNetWorthSnapshot()` so that new snapshots
use `sharesNetWorth(with:)`, not the wider `canSee(dataOwnedBy:)` rule. Before
that fix, an adult sync loaded Mason's accounts for visibility and then included
them in the persisted adult net-worth aggregate.

For affected Victor and Rachel snapshots:

- `btcValue` includes Mason's `son-balances` accounts.
- `holdingsValue` includes Mason's `mason_401k` account when that account was
  present in `finances`.
- `totalValue` includes both contaminated components because it is stored as
  `btcValue + holdingsValue`.
- `date` and `owner` are not changed by this aggregation bug. They remain useful
  for locating candidate rows. This statement is limited to PR #67's bug; it is
  not a general audit of owner tagging in every historical app build.

Mason and Maddox rows are not contaminated by this bug. A child can see only
their own accounts, so the old wide rule and the corrected net-worth-sharing
rule select the same accounts for a child.

**Exact repair is not possible from the known surviving current-state data.**
The child contribution was summed before storage, and neither the adult
snapshot nor the surviving Convex blobs retain enough historical inputs to
separate it afterward. An estimate must not be written into a financial record.
Unless exact archival evidence is found, the integrity-preserving repair is to
remove the affected adult rows and show an honest gap.

## What the sync path stored

An adult `syncAll()` performs these relevant operations before recording the
snapshot:

1. `syncBTCAccounts()` loads the shared adult BTC snapshot.
2. `syncSonBalances()` loads Mason's Strike, River, and Coldcard balances and
   persists them as Mason-owned `BTCAccount` models.
3. `syncFinances()` maps both adult retirement accounts and the sibling
   `mason_401k` entry into `HoldingAccount` models.
4. `recordNetWorthSnapshot()` fetches every local BTC and holding account,
   filters the accounts, values them using the then-current stored BTC, VOO, and
   IBIT prices, and persists one aggregate row for the active member.

The defective filter admitted every account an adult could see. PR #67 changed
both filters to the narrower sharing rule. The resulting field-level status is:

| Stored field | Status in an affected adult row | Reason |
| --- | --- | --- |
| `btcValue` | Contaminated | Includes the USD value of Mason's three BTC accounts at the price used when the row was recorded. |
| `holdingsValue` | Contaminated when `mason_401k` was loaded | Includes Mason's live-valued 401(k) holdings, or the account total fallback. |
| `totalValue` | Contaminated | Stored as the sum of the preceding two fields. |
| `date` | Clean with respect to this bug | Records when the local snapshot was inserted. |
| `owner` | Clean with respect to this bug | Records the active profile; the aggregation bug did not rewrite it. |

`totalValue` is not a fourth independent observation. Its equality to
`btcValue + holdingsValue` can show internal consistency, but it cannot reveal
the child share.

The method deletes and replaces only today's row for the active member. Thus a
sync on the corrected build repairs today's Victor row only when Victor is
active, and today's Rachel row only when Rachel is active. It does not rewrite
older rows. Any later sync prunes all snapshots older than 90 days, but rows
inside that window remain available to charts and CSV export.

A failed child-file refresh does not prove a row is clean. Snapshot recording
still runs after individual sync errors, and previously cached child accounts
can remain in the local store. Conversely, a component is uncontaminated if the
corresponding child account was genuinely absent from that store. The snapshot
row itself has no provenance field that distinguishes those cases.

## Recoverability of the child contribution

### Evidence that survives

- `son-balances` contains only current `strike`, `river`, `coldcard`, `total`,
  and `lastUpdated` values. It has no daily balance series.
- `finances.mason_401k` contains current account/holding state and may contain
  contribution lots. It has no authoritative daily series of the value
  calculated by `liveValue`.
- Mason's BTC-buy records describe buys. They are not a balance ledger: they do
  not prove the opening balance or every transfer, sale, spend, correction, or
  custody change. They also do not preserve the price used by snapshot
  recording.
- `dataFiles` replaces the whole payload on update. `syncVersions` stores the
  current version and update timestamp, not prior payloads.
- A `NetWorthSnapshot` stores three USD aggregates, the owner, and the date. It
  does not store account-level contributions, BTC quantity, source-file
  versions, or the BTC/VOO/IBIT prices used for valuation.
- The app's market-price values are current cached values, not a price history
  tied to each snapshot.
- SwiftData is configured as a local persistent store. Convex does not hold
  these `NetWorthSnapshot` rows, so the production blobs cannot supply a second
  copy of the local history.

Historical buys or lots can support a reasonableness check, but reconstructing
a balance or price from them would be an estimate. That is not an exact repair.

### Potential archival evidence

A repair could be exact only if evidence outside the currently modeled data
provides the exact child component for every target row. Examples include:

- a preserved backup of the relevant `son-balances`, `finances`, and market
  price inputs for the exact snapshot time; or
- a Mason-owned `NetWorthSnapshot` proven to have been computed from identical
  account state and identical price inputs as the adult row.

A Mason snapshot merely sharing the same calendar date is not sufficient.
Profile syncs occur at different times, current-state blobs can change between
them, and market prices are refreshed before sync. The model stores no source
versions or valuation-input identifiers with which to prove equivalence.

Before deciding that no archive exists, Victor can separately check device
backups and any explicitly configured Convex backup/export retention. The
repository provides no evidence that such historical copies exist. A backup
must be inspected read-only and validated before it is treated as a repair
source.

## Repair options

### Option 1: Let the rows age out

**Cost:** No repair implementation. Corrected builds replace the active
member's row for the current day, and normal sync pruning removes rows once they
are older than 90 days.

**Risk:** Known-false values remain in charts, change calculations, and CSV
exports for as long as 90 days. Victor and Rachel share adult net-worth history,
so a contaminated row owned by either adult remains visible to both. This is
operationally easy but weak financial-data stewardship.

### Option 2: Correct rows from verified archival components

For each affected row, subtract the exact historical child `btcValue` from
`btcValue`, subtract the exact historical child `holdingsValue` from
`holdingsValue`, and recompute `totalValue` from the corrected components using
exact decimal arithmetic.

**Cost:** Locate and validate archival evidence for every row; define the
affected interval separately for each device/profile; preserve a before-state
export; implement and review an approved, idempotent local-store repair; and
verify component and total invariants afterward.

**Risk:** A same-day but non-contemporaneous child value, a reconstructed market
price, or an incomplete balance ledger silently creates plausible-looking
false history. Partial evidence must not be generalized to uncovered rows.

**Availability:** Not currently available from the known surviving data. This
option becomes valid only for rows whose exact inputs can be proven.

### Option 3: Delete affected adult rows and show a gap

Delete the candidate Victor/Rachel snapshots created by a contaminated build,
without synthesizing replacements. New corrected snapshots then continue the
series.

**Cost:** An approved, reviewed, idempotent local-store repair is still needed.
Because snapshots are local, every affected installation must receive it. The
repair window must be based on the build actually installed on each device, not
just PR merge dates. A read-only inventory and protected before-state export
should precede any deletion.

**Risk:** The chart and exports have a visible gap, and clean adult rows inside a
conservatively selected interval may also be removed because rows carry no app
build or provenance marker. The gap is honest and explainable; fabricated
precision is not.

### Option 4: Keep but visually label suspect rows

Add provenance/status metadata and teach every chart, calculation, and export
to distinguish suspect values.

**Cost:** A model change, UI and export work, backfill logic, and cross-client
policy for data that currently exists only in local SwiftData.

**Risk:** A missed consumer can still present the contaminated number as real.
The original values remain available for accidental reuse. This preserves
forensic evidence but is not a correction.

## Recommendation

First, preserve a read-only inventory of the affected local stores and check for
genuine archival inputs. Do not modify any snapshot during that evidence check.

If exact, timestamp-matched child components can be proven for particular rows,
Victor may approve exact component-wise correction for only those rows. For
every other affected row, choose Option 3: delete it and show an honest gap.
Do not infer the child share from today's balance, buys, contribution lots,
historical market quotes, interpolation, or a merely same-day Mason snapshot.

If Victor prefers no immediate local-store repair, Option 1 is safer than an
estimate but must be accepted explicitly as temporary display of known
contamination. Option 4 adds complexity without restoring truth and is not
recommended as the primary repair.

## Requirements for any later approved repair

This assessment intentionally supplies no migration. A future repair proposal
should, at minimum:

- inventory counts and min/max dates by device and owner without logging
  financial values;
- identify the contaminated-build interval from actual TestFlight installation
  history and the per-profile first corrected snapshot;
- preserve the original local store or an encrypted before-state export;
- be idempotent and scoped only to `NetWorthSnapshot`;
- use exact stored numeric representations, never binary floating-point
  estimation;
- never touch `dataFiles`, `syncVersions`, or `todoTombstones`;
- report corrected, deleted, skipped, and ambiguous row counts;
- verify that every retained row satisfies
  `totalValue == btcValue + holdingsValue`; and
- require Victor's explicit approval before any write or deletion.
