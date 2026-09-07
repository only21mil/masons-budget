# Bounded row feeds and exact counts

This source contract covers Buzz issues `c1480bf8`, `2cabca45`, and `73a92853`.
Deployment, count initialization, authenticated codegen, and Apple acceptance
are separate authorized operations. No production backfill accompanies this
source change.

## Ordering and continuation

The existing list endpoints retain their envelopes and explicit-limit behavior.
A limit is an incomplete diagnostic result. An omitted limit still requires a
complete result of at most 2,000 rows. Each owner partition reads at most the
requested limit, or 2,001 rows for the complete-result check. Monthly transaction,
buy, and bill-pay reads now use the existing owner/month/date index and bounded
descending reads.

The global dated-list order is date descending, then Convex creation time
descending, then Convex document ID descending. Income also orders by income ID
descending between date and creation time. Todos use updated time descending,
then creation time and document ID descending. Accounts use owner/key ascending,
then creation time and document ID ascending. Each partition's comparator agrees
with the index before the global merge, so a bounded result is a prefix of the
complete result even when many rows share a date. Public row projections still
omit internal IDs, creation times and migration provenance. Business IDs and
their existing uniqueness rules do not change.

`tables:pageTransactions` adds a complete-snapshot route. It accepts `viewer`,
optional canonical `month`, optional opaque `cursor`, and existing read
credentials. Each call authenticates the viewer and applies the same visibility
rule as `listTransactions`. It returns `rows`, `complete`, and a nullable
`cursor`. Only `complete: true` with `cursor: null` ends a traversal. Each call
requests at most 256 rows and sets `maximumRowsRead: 256`. Owner filtering can
therefore yield a short or empty nonterminal page. Clients must follow it.

The page query uses the global date index, or month/date index, to retain the
same newest-first order across owners. The server filters ownership before
returning projected rows. Children never receive adult rows. This trades extra
bounded pages for sparse child histories against a complicated per-owner merge
cursor. No owner-specific sort key needs to be added to stored transactions.

The continuation contains a versioned viewer/month binding, table revision and
native Convex continuation. Its representation is private to the server, not an
application sort key or authorization credential. Clients preserve it exactly,
never inspect or construct it, and restart without a cursor after a failure.
The query checks authorization independently of cursor contents.

Every tracked transaction write increments the table revision in the same
database transaction. A continuation fails if an insert, edit, owner move,
delete, operator import, ledger reconciliation or legacy adoption occurred since
the first page. This includes writes outside the requested month or owner, a
conservative choice that avoids mixed snapshots. A failed transaction rolls back
both data and revision. The result represents the unchanged database state
through the final query; writes after that query belong to the next sync.
Continuous writes can prevent a traversal from finishing. The client keeps its
previous snapshot and retries on its next sync, without an unbounded retry loop.

Apple accumulates every page inside `ConvexRowReader.transactionSnapshot` and
validates each row before returning. Missing, repeated or contradictory cursors,
transport failure, a revision failure, cancellation, or a bad row throws before
`ConvexDataReader` can produce a row-authoritative replacement batch. The
existing sync service replaces persisted rows only after that batch returns.
The missing-row-API legacy fallback keeps its existing non-authoritative source
marker.

## Counts and write coverage

`rowCountStates` holds one row per counted table with a total, four exact stored
owner counts, readiness and an integer revision. This counts table rows, not
nested accounts inside document rows. A document without a top-level owner
contributes only to its table total. Per-owner counts are internal metadata;
the public `rowCounts` response retains its existing total-per-table shape and
read-token authorization.

`trackedDb` maintains counts and revisions transactionally at these write sites:

| Source | Counted writes |
| --- | --- |
| `convex/tables.ts` | Runtime/device creates, edits, replacements, deletion, linked income, document adoption and mirror maintenance |
| `convex/btcLedger.ts` | Posted balance/document updates, mirror updates and activation baselines |
| `convex/operatorImport.ts` | Atomic transaction, income, buy, bill-pay inserts and budget advancement |
| `convex/migrate.ts` | Typed-row/document insertion and adoption patching |

All future typed-row writers must use this helper. It delegates normal Convex
validation and rollback. A same-table edit preserves the total; an owner move
decrements the old owner and increments the new one. Uncounted lock, tombstone
and receipt writes pass through without changing count states. Direct dashboard
edits or ad hoc writers bypass this contract and are not supported maintenance
routes.

`rowCounts` performs eleven indexed metadata lookups and no row-table reads.
Write and count-read costs are independent of table size. One metadata row per
table creates same-table write contention under heavy concurrent traffic; Convex
transaction retries retain exactness. Sharding is unnecessary for this household
workload and would complicate the revision fence.

## Approved initialization procedure

This procedure is reviewable source guidance, not permission to execute it.
Do not rerun the historical blob migration or use a legacy blob writer.

1. Complete independent review, authenticated generated-schema verification,
   the required Apple checks, and the existing deployment approval procedure.
   Deploy all tracked writers together with the schema and query changes.
2. Through the established authenticated admin route, invoke the internal
   function `rowTracking:backfillRowCounts` with `{ "table": "transactions" }`.
   Repeat the same arguments until it returns `complete: true`. Each invocation
   reads at most 256 source rows and persists its continuation atomically.
3. Repeat for `todos`, `btcBuys`, `btcBillPays`, `btcTransfers`, `btcAccounts`,
   `income`, `balanceDocuments`, `budgetDocuments`, `btcBalanceDocuments`, and
   `financeDocuments`. Never loop without an operator bound; repeated
   `restarted: true` means writes are preventing a stable baseline.
4. Verify the authenticated public `rowCounts` response. Retain only structural
   success/readiness evidence under the existing privacy rules. No row payloads
   are needed for this check.

Until every table is ready, `rowCounts` fails with an initialization error. It
never returns partial counts as exact or scans tables as a fallback. Page reads
use revisions immediately and do not depend on count readiness.

If a writer commits between baseline pages, the next backfill call discards the
partial tally and restarts from the beginning. If a writer races the final page,
Convex transaction conflict handling forces the finalizer or writer to retry.
A ready table is an idempotent no-op, including after a lost final response.
This procedure creates metadata only; it never modifies source rows or blobs.

## Synthetic verification

`convex/rowTracking.test.ts` exercises 2,305 tied transactions, all/month and
adult/child traversals, cursor scope and authorization, concurrent mutations,
bounded historical backfill, owner counts, retry, replacement and rollback.
`convex/tables.test.ts` compares initialized totals and every owner count against
a full synthetic recount after each existing runtime scenario. Apple source
tests cover complete accumulation beyond 2,000 rows, empty filtered pages,
failure before publication and malformed continuation rejection. App-target
execution belongs to the approved Apple verification route.
