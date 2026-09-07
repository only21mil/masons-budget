import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  COUNTED_TABLES,
  backfillCountsPage,
  countState,
  exactRowCounts,
  trackedDb,
} from "./rowTracking";
import {
  freshSecret,
  setDeploymentEnv,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";

const modules = {
  "./_generated/server.ts": () => import("./generatedServer.test-stub"),
  "./tables.ts": () => import("./tables"),
  "./rowTracking.ts": () => import("./rowTracking"),
};
const createTest = () => convexTest(schema, modules);
let t: ReturnType<typeof createTest>;
let token: string;
useIsolatedDeploymentEnv();
beforeEach(() => {
  t = createTest();
  token = freshSecret();
  setDeploymentEnv({ CONVEX_READ_TOKEN: token, CONVEX_SYNC_TOKEN: token });
});

function transaction(index: number, owner: "victor" | "mason" = "victor") {
  return {
    txId: `synthetic-${index}`,
    owner,
    date: "2026-07-19",
    month: "2026-07",
    merchant: "Synthetic",
    amountCents: 1n,
    category: "Other",
    sourceFile: owner === "victor" ? "transactions" : "mason-transactions",
    updatedAtMs: 1,
  };
}

async function initialize() {
  for (const table of COUNTED_TABLES) {
    while (!(await t.run((ctx) => backfillCountsPage(ctx, table))).complete) {
      /* bounded calls */
    }
  }
}

describe("bounded transaction snapshots", () => {
  it("pages 2,305 tied rows exactly once in the index order, including monthly and child reads", async () => {
    await t.run(async (ctx) => {
      for (let i = 0; i < 2305; i++)
        await trackedDb(ctx).insert(
          "transactions",
          transaction(i, i % 3 ? "victor" : "mason"),
        );
    });
    for (const viewer of ["rachel", "mason"] as const) {
      for (const month of [undefined, "2026-07"]) {
        const expected = await t.run(async (ctx) =>
          (
            await ctx.db
              .query("transactions")
              .withIndex("by_date")
              .order("desc")
              .collect()
          )
            .filter((row) => viewer === "rachel" || row.owner === "mason")
            .map((row) => row.txId),
        );
        let cursor: string | undefined;
        const ids: string[] = [];
        let calls = 0;
        do {
          const page = await t.query(api.tables.pageTransactions, {
            viewer,
            month,
            cursor,
            token,
          });
          expect(page.rows.length).toBeLessThanOrEqual(256);
          for (const row of page.rows) {
            expect(row).not.toHaveProperty("_id");
            expect(row).not.toHaveProperty("_creationTime");
            expect(row).not.toHaveProperty("sourceFile");
          }
          ids.push(...page.rows.map((row) => row.txId));
          expect(page.complete).toBe(page.cursor === null);
          cursor = page.cursor ?? undefined;
          expect(++calls).toBeLessThan(50);
        } while (cursor);
        expect(ids).toEqual(expected);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
    await expect(
      t.query(api.tables.listTransactions, { viewer: "victor", token }),
    ).rejects.toThrow("complete snapshot");
  });

  it.each(["insert", "update", "move", "delete"] as const)(
    "rejects a continuation after a concurrent %s and permits a fresh traversal",
    async (change) => {
      const ids = await t.run(async (ctx) => {
        const result = [];
        for (let i = 0; i < 300; i++)
          result.push(
            await trackedDb(ctx).insert("transactions", transaction(i)),
          );
        return result;
      });
      const first = await t.query(api.tables.pageTransactions, {
        viewer: "victor",
        token,
      });
      expect(first.complete).toBe(false);
      await t.run(async (ctx) => {
        const db = trackedDb(ctx);
        if (change === "insert")
          await db.insert("transactions", transaction(301));
        if (change === "update")
          await db.patch(ids[0], { date: "2026-08-01", month: "2026-08" });
        if (change === "move") await db.patch(ids[0], { owner: "mason" });
        if (change === "delete") await db.delete(ids[0]);
      });
      await expect(
        t.query(api.tables.pageTransactions, {
          viewer: "victor",
          cursor: first.cursor!,
          token,
        }),
      ).rejects.toThrow("snapshot changed");
      await expect(
        t.query(api.tables.pageTransactions, { viewer: "victor", token }),
      ).resolves.toMatchObject({ complete: false });
    },
  );

  it("binds continuations to viewer and month and authenticates every page", async () => {
    await t.run(async (ctx) => {
      for (let i = 0; i < 300; i++)
        await trackedDb(ctx).insert("transactions", transaction(i));
    });
    const first = await t.query(api.tables.pageTransactions, {
      viewer: "victor",
      token,
    });
    const cursor = first.cursor!;
    await expect(
      t.query(api.tables.pageTransactions, { viewer: "mason", cursor, token }),
    ).rejects.toThrow("cursor");
    await expect(
      t.query(api.tables.pageTransactions, {
        viewer: "victor",
        month: "2026-07",
        cursor,
        token,
      }),
    ).rejects.toThrow("cursor");
    await expect(
      t.query(api.tables.pageTransactions, {
        viewer: "victor",
        cursor,
        token: freshSecret(),
      }),
    ).rejects.toThrow("Unauthorized");
    await expect(
      t.query(api.tables.pageTransactions, {
        viewer: "victor",
        cursor: "broken",
        token,
      }),
    ).rejects.toThrow("cursor");
  });

  it("takes tied legacy list limits from the same total order for all dated feed partitions", async () => {
    await t.run(async (ctx) => {
      for (let i = 0; i < 35; i++) {
        await trackedDb(ctx).insert("transactions", transaction(i));
        await trackedDb(ctx).insert("btcBuys", {
          buyId: `buy-${i}`,
          owner: "victor",
          date: "2026-07-19",
          month: "2026-07",
          source: "river",
          sats: 1n,
          priceUsdCents: 1n,
          usdCents: 1n,
          sourceFile: "bitcoin-buys",
          updatedAtMs: 1,
        });
        await trackedDb(ctx).insert("btcBillPays", {
          billPayId: `pay-${i}`,
          owner: "victor",
          date: "2026-07-19",
          month: "2026-07",
          merchant: "Synthetic",
          category: "Other",
          amountUsdCents: 1n,
          btcSpentSats: 1n,
          btcPriceCents: 1n,
          feeUsdCents: 0n,
          sourceFile: "bitcoin-bill-pays",
          updatedAtMs: 1,
        });
      }
    });
    for (const month of [undefined, "2026-07"]) {
      const args = {
        viewer: "victor" as const,
        scope: "visible" as const,
        month,
        token,
      };
      const transactions = await t.query(api.tables.listTransactions, {
        viewer: args.viewer,
        month,
        token,
      });
      const buys = await t.query(api.tables.listBtcBuys, args);
      const pays = await t.query(api.tables.listBtcBillPays, args);
      // A globally bounded list must be a prefix of its complete counterpart.
      expect(
        (
          await t.query(api.tables.listTransactions, {
            viewer: args.viewer,
            month,
            token,
            limit: 7,
          })
        ).rows,
      ).toEqual(transactions.rows.slice(0, 7));
      expect(
        (await t.query(api.tables.listBtcBuys, { ...args, limit: 7 })).rows,
      ).toEqual(buys.rows.slice(0, 7));
      expect(
        (await t.query(api.tables.listBtcBillPays, { ...args, limit: 7 })).rows,
      ).toEqual(pays.rows.slice(0, 7));
      expect(transactions.rows.map((row) => row.txId)).toEqual(
        Array.from({ length: 35 }, (_, i) => `synthetic-${34 - i}`),
      );
    }
  });
});

describe("transactional exact row counts", () => {
  it("fails closed before initialization and backfills 2,305 historical rows in bounded idempotent calls", async () => {
    await t.run(async (ctx) => {
      // Deliberately bypass tracking to model pre-deployment stored rows.
      for (let i = 0; i < 2305; i++)
        await ctx.db.insert(
          "transactions",
          transaction(i, i % 3 ? "victor" : "mason"),
        );
    });
    await expect(t.query(api.tables.rowCounts, { token })).rejects.toThrow(
      "initialization",
    );
    const first = await t.mutation(internal.rowTracking.backfillRowCounts, {
      table: "transactions",
    });
    expect(first.complete).toBe(false);
    expect(
      (await t.run((ctx) => countState(ctx, "transactions")))?.backfill?.counts
        .total,
    ).toBe(256n);
    await initialize();
    expect((await t.query(api.tables.rowCounts, { token })).transactions).toBe(
      2305,
    );
    const before = await t.run((ctx) => countState(ctx, "transactions"));
    expect(before?.counts).toEqual({
      total: 2305n,
      victor: 1536n,
      rachel: 0n,
      mason: 769n,
      maddox: 0n,
    });
    await initialize();
    expect(await t.run((ctx) => countState(ctx, "transactions"))).toEqual(
      before,
    );
  });

  it.each(["insert", "update", "move", "delete"] as const)(
    "restarts a partial baseline after a concurrent %s",
    async (change) => {
      const id = await t.run(async (ctx) => {
        for (let i = 1; i < 550; i++)
          await ctx.db.insert("transactions", transaction(i));
        return ctx.db.insert("transactions", transaction(0));
      });
      await t.run((ctx) => backfillCountsPage(ctx, "transactions"));
      await t.run(async (ctx) => {
        if (change === "insert")
          await trackedDb(ctx).insert(
            "transactions",
            transaction(551, "mason"),
          );
        if (change === "update")
          await trackedDb(ctx).patch(id, { merchant: "Changed" });
        if (change === "move")
          await trackedDb(ctx).patch(id, { owner: "mason" });
        if (change === "delete") await trackedDb(ctx).delete(id);
      });
      expect(
        (await t.run((ctx) => backfillCountsPage(ctx, "transactions")))
          .restarted,
      ).toBe(true);
      await initialize();
      const full = await t.run((ctx) => ctx.db.query("transactions").collect());
      const state = await t.run((ctx) => countState(ctx, "transactions"));
      expect(state?.counts.total).toBe(BigInt(full.length));
      expect(state?.counts.mason).toBe(
        BigInt(full.filter((row) => row.owner === "mason").length),
      );
    },
  );

  it("tracks owner moves, replacements, no-op adoption, deletion and transaction rollback", async () => {
    await initialize();
    const id = await t.run((ctx) =>
      trackedDb(ctx).insert("transactions", transaction(1)),
    );
    await t.run((ctx) => trackedDb(ctx).patch(id, { owner: "mason" }));
    expect(
      (await t.run((ctx) => countState(ctx, "transactions")))?.counts,
    ).toMatchObject({ total: 1n, victor: 0n, mason: 1n });
    await t.run((ctx) => trackedDb(ctx).replace(id, transaction(1)));
    await t.run((ctx) => trackedDb(ctx).patch(id, transaction(1)));
    expect((await t.query(api.tables.rowCounts, { token })).transactions).toBe(
      1,
    );
    await expect(
      t.run(async (ctx) => {
        await trackedDb(ctx).insert("transactions", transaction(2));
        throw new Error("abort synthetic transaction");
      }),
    ).rejects.toThrow("abort");
    expect((await t.query(api.tables.rowCounts, { token })).transactions).toBe(
      1,
    );
    await t.run((ctx) => trackedDb(ctx).delete(id));
    expect((await t.query(api.tables.rowCounts, { token })).transactions).toBe(
      0,
    );
  });

  it("answers counts without querying any row table", async () => {
    await initialize();
    const result = await t.run(async (ctx) => {
      const original = ctx.db.query.bind(ctx.db);
      ctx.db.query = ((table: string) => {
        if (table !== "rowCountStates")
          throw new Error("Unexpected row-table scan");
        return original("rowCountStates");
      }) as typeof ctx.db.query;
      return exactRowCounts(ctx);
    });
    expect(Object.values(result)).toEqual(COUNTED_TABLES.map(() => 0));
  });
});
