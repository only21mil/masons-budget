import { ConvexError, v } from "convex/values";
import type {
  WithoutSystemFields,
  WithOptionalSystemFields,
} from "convex/server";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

export const COUNTED_TABLES = [
  "transactions",
  "todos",
  "btcBuys",
  "btcBillPays",
  "btcTransfers",
  "btcAccounts",
  "income",
  "balanceDocuments",
  "budgetDocuments",
  "btcBalanceDocuments",
  "financeDocuments",
] as const;
type CountedTable = (typeof COUNTED_TABLES)[number];
type Counts = Doc<"rowCountStates">["counts"];
type OwnedRow = { owner?: string };
const emptyCounts = (): Counts => ({
  total: 0n,
  victor: 0n,
  rachel: 0n,
  mason: 0n,
  maddox: 0n,
});

export function countState(ctx: QueryCtx, table: CountedTable) {
  return ctx.db
    .query("rowCountStates")
    .withIndex("by_table", (q) => q.eq("table", table))
    .unique();
}

function adjust(counts: Counts, row: OwnedRow | null, delta: bigint) {
  if (!row) return;
  counts.total += delta;
  if (
    row.owner === "victor" ||
    row.owner === "rachel" ||
    row.owner === "mason" ||
    row.owner === "maddox"
  ) {
    counts[row.owner] += delta;
  }
}

async function changed(
  ctx: MutationCtx,
  table: CountedTable,
  before: OwnedRow | null,
  after: OwnedRow | null,
) {
  const state = await countState(ctx, table);
  const counts = { ...(state?.counts ?? emptyCounts()) };
  // Until a baseline exists, only the revision is meaningful. Never publish
  // negative or partial counts as an exact result.
  if (state?.ready) {
    adjust(counts, before, -1n);
    adjust(counts, after, 1n);
  }
  const value = {
    table,
    revision: (state?.revision ?? 0n) + 1n,
    ready: state?.ready ?? false,
    counts,
  };
  if (state) await ctx.db.patch(state._id, value);
  else await ctx.db.insert("rowCountStates", value);
}

function countedTable(ctx: MutationCtx, id: string): CountedTable | undefined {
  return COUNTED_TABLES.find((table) => ctx.db.normalizeId(table, id) !== null);
}

/** All production typed-row writes use this boundary, including migration and
 * ledger helpers. It keeps the native writer's validation and transaction.
 * Uncounted bookkeeping writes are passed through without changing revisions.
 */
export function trackedDb(ctx: MutationCtx) {
  return {
    async insert<T extends TableNames>(
      table: T,
      value: WithoutSystemFields<Doc<T>>,
    ) {
      const id = await ctx.db.insert(table, value);
      if (COUNTED_TABLES.some((counted) => counted === table)) {
        await changed(ctx, table as CountedTable, null, value as OwnedRow);
      }
      return id;
    },
    async patch<T extends TableNames>(id: Id<T>, value: Partial<Doc<T>>) {
      const table = countedTable(ctx, id);
      const before = table ? await ctx.db.get(id) : null;
      await ctx.db.patch(id, value);
      if (table)
        await changed(
          ctx,
          table,
          before as OwnedRow | null,
          { ...before, ...value } as OwnedRow,
        );
    },
    async replace<T extends TableNames>(
      id: Id<T>,
      value: WithOptionalSystemFields<Doc<T>>,
    ) {
      const table = countedTable(ctx, id);
      const before = table ? await ctx.db.get(id) : null;
      await ctx.db.replace(id, value);
      if (table)
        await changed(ctx, table, before as OwnedRow | null, value as OwnedRow);
    },
    async delete<T extends TableNames>(id: Id<T>) {
      const table = countedTable(ctx, id);
      const before = table ? await ctx.db.get(id) : null;
      await ctx.db.delete(id);
      if (table && before) await changed(ctx, table, before as OwnedRow, null);
    },
  };
}

export async function exactRowCounts(ctx: QueryCtx) {
  const result: Partial<Record<CountedTable, number>> = {};
  for (const table of COUNTED_TABLES) {
    const state = await countState(ctx, table);
    if (!state?.ready)
      throw new ConvexError("Row counts are awaiting initialization.");
    const count = Number(state.counts.total);
    if (!Number.isSafeInteger(count))
      throw new ConvexError("Row count exceeds the numeric response range.");
    result[table] = count;
  }
  return result as Record<CountedTable, number>;
}

/** Internal, resumable and idempotent. Run only under approved deployment/data
 * operation authority. Each call reads at most 256 rows. A concurrent typed-row
 * write invalidates the accumulated baseline; the next call starts it again.
 * Re-running a ready table is a no-op. No legacy blobs are read or changed.
 */
export async function backfillCountsPage(ctx: MutationCtx, table: string) {
  if (!COUNTED_TABLES.some((name) => name === table))
    throw new ConvexError("Unknown counted table.");
  const name = table as CountedTable;
  const state = await countState(ctx, name);
  if (state?.ready) return { complete: true, restarted: false };
  const revision = state?.revision ?? 0n;
  const previous = state?.backfill;
  const resume = previous?.revision === revision ? previous : undefined;
  const counts = { ...(resume?.counts ?? emptyCounts()) };
  const page = await ctx.db
    .query(name)
    .paginate({
      cursor: resume?.cursor ?? null,
      numItems: 256,
      maximumRowsRead: 256,
    });
  for (const row of page.page) adjust(counts, row as OwnedRow, 1n);
  const value = {
    table: name,
    revision,
    ready: page.isDone,
    counts: page.isDone ? counts : emptyCounts(),
    backfill: page.isDone
      ? undefined
      : { revision, cursor: page.continueCursor, counts },
  };
  if (state) await ctx.db.patch(state._id, value);
  else await ctx.db.insert("rowCountStates", value);
  return {
    complete: page.isDone,
    restarted: previous !== undefined && resume === undefined,
  };
}

export const backfillRowCounts = internalMutation({
  args: { table: v.string() },
  handler: (ctx, { table }) => backfillCountsPage(ctx, table),
});
