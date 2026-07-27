# Convex row-query scalability audit

Audited against `convex/tables.ts` before the row tables become live. The
authoritative blob dataset contains 905 transactions, 31 Bitcoin buys, and 25
todos. The 10x and 100x transaction scenarios below are 9,050 and 90,500 rows.

Convex currently limits one query or mutation to 32,000 documents scanned and
16 MiB read. An indexed `.collect()` still scans its entire matching range;
`.take(n)` stops after the requested number of documents. Every Convex index
also has `_creationTime` as its final implicit tie-breaker.

## Inventory

| Public query | Index and database work | Unbounded collect? | 10x / 100x behavior |
|---|---|---:|---|
| `listTransactions`, no month | One `by_owner_date(owner, date)` range per visible owner, descending, `take(cap)` on each; JavaScript merges the owner ranges and applies the public cap. | No. `cap` is the explicit limit or 2,001. | Database reads remain bounded to at most 2,001 rows per visible owner. A complete snapshot fails closed above 2,000 rows as designed. An explicit limit remains efficient. |
| `listTransactions`, month | One `by_owner_month(owner, month)` range per visible owner, then `.collect()`; JavaScript sorts by date and applies the cap. | Yes, within every owner/month range. | With uniform dates, one month is roughly 754 / 7,542 rows; a concentrated month can contain all 9,050 / 90,500. The 100x case can exceed Convex's 32,000-document scan limit before the application cap is applied. |
| `listTodos` | One `by_owner_done(owner, done, updatedAtMs)` range for each visible owner and requested done state, descending, `take(cap)` on each; JavaScript merges and caps. | No. | Transaction growth does not affect it. At analogous todo growth, work remains bounded to `owners × done states × cap`. |
| `listBtcBuys`, no month | One `by_owner_date(owner, date)` range per in-scope owner, descending, `take(cap)` on each; JavaScript merges and caps. | No. | Transaction growth does not affect it; buy reads remain bounded per owner. |
| `listBtcBuys`, month | One `by_owner_month(owner, month)` range per in-scope owner, then `.collect()`; JavaScript sorts and caps. | Yes, within every owner/month range. | At 10x / 100x today's 31 buys, total scale is 310 / 3,100. That is still below the document limit, but cost grows linearly and a concentrated history has no bound. |
| `listBtcBillPays`, no month | One `by_owner_date(owner, date)` range per in-scope owner, descending, `take(cap)` on each; JavaScript merges and caps. | No. | Transaction growth does not affect it; reads remain bounded per owner. |
| `listBtcBillPays`, month | One `by_owner_month(owner, month)` range per in-scope owner, then `.collect()`; JavaScript sorts and caps. | Yes, within every owner/month range. | Linear in all matching bill payments. It eventually reaches the same scan ceiling if a month grows beyond 32,000 matching rows. |
| `listBtcAccounts` | One `by_owner_key(owner, key)` range per in-scope owner, `take(cap)`; JavaScript merges in owner/key order and caps. | No. | Unaffected by transaction growth and bounded per owner. Account keys are upserted by the same owner/key index, so the indexed key order matches the result order. |
| `getBudgetDocument` | `dataFiles.by_name(name).first()`. | No. | Constant database work. It reads one legacy blob; transaction growth is deliberately outside this document because spend is derived from `listTransactions`. |
| `getBtcSnapshotMetadata` | Up to three `dataFiles.by_name(name).first()` lookups. | No. | Constant database work. |
| `rowCounts` | Default `by_creation_time` index on each of the five row tables, `.collect()` on every table, then array length. | Yes, five full-table scans. | At 9,050 transactions it is linear and wasteful. At 90,500 transactions, the transaction scan alone exceeds the 32,000-document limit, so the query fails before it can return counts. |

Mutation lookup queries are bounded equality lookups: transaction, todo, buy,
and account upserts use their natural-key indexes plus `.first()`; todo deletion
uses `by_todo_id(...).first()`. They do not grow with table size. There is no
public bill-payment mutation in this file.

## Safe index additions

The schema now stages these indexes without changing any query result:

```ts
transactions.index("by_owner_month_date", ["owner", "month", "date"])
btcBuys.index("by_owner_month_date", ["owner", "month", "date"])
btcBillPays.index("by_owner_month_date", ["owner", "month", "date"])
```

They put date after the equality-constrained owner and month fields, so Convex
can read a month newest-first and stop at a bound:

```ts
ctx.db
  .query("transactions")
  .withIndex("by_owner_month_date", (q) =>
    q.eq("owner", owner).eq("month", month),
  )
  .order("desc")
  .take(cap)
```

The query switch is intentionally not part of this change. The public result
currently breaks equal-date ties by Convex `_id`, while the proposed index
breaks them by implicit `_creationTime`. Taking a bound in index order could
therefore change which rows survive at a limit boundary. The same latent
tie-boundary mismatch already exists in the no-month date queries and in
`listTodos`, whose JavaScript tie-breaker is `todoId` but whose index ends in
`_creationTime`. Resolving it requires an explicit ordering contract and
matching compound indexes, for example:

```ts
transactions: ["owner", "month", "date", "txId"]
btcBuys:       ["owner", "month", "date", "buyId"]
btcBillPays:   ["owner", "month", "date", "billPayId"]
todos:         ["owner", "done", "updatedAtMs", "todoId"]
```

Adopting those indexes for bounded reads would change the current equal-date or
equal-timestamp result order from `_id` to the natural ID. That must be reviewed
as an API order change and covered with boundary-tie tests before rollout.

`rowCounts` cannot be made scalable with an ordinary index: exact count still
requires visiting every row. Before the tables approach the scan ceiling,
replace it with a transactionally maintained aggregate/counter design, including
backfill and drift verification. A capped scan would only return an approximate
count and would change the query's content contract, so it is not done here.

## Convex references

- [Limits](https://docs.convex.dev/production/state/limits)
- [Indexes and index ordering](https://docs.convex.dev/database/reading-data/indexes/)
