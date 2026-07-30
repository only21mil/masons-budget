import type { FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it } from "vitest";

import {
  freshSecret,
  pairMobileDevice,
  setDeploymentEnv,
  testConvex,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";

useIsolatedDeploymentEnv();

type T = ReturnType<typeof testConvex>;
type UpsertResult = {
  ok: true;
  entityId: string;
  outcome: "inserted" | "updated";
};
type DeleteResult = { ok: true; entityId: string; removed: boolean };

const mutation = <Args extends Record<string, unknown>, Result>(path: string) =>
  path as unknown as FunctionReference<"mutation", "public", Args, Result>;

const api = {
  upsertTransaction: mutation<Record<string, unknown>, UpsertResult>(
    "tables:upsertTransactionFromDevice",
  ),
  deleteTransaction: mutation<Record<string, unknown>, DeleteResult>(
    "tables:deleteTransactionFromDevice",
  ),
  upsertTodo: mutation<Record<string, unknown>, UpsertResult>(
    "tables:upsertTodoFromDevice",
  ),
  deleteTodo: mutation<Record<string, unknown>, DeleteResult>(
    "tables:deleteTodoFromDevice",
  ),
  upsertBudgetCategory: mutation<Record<string, unknown>, UpsertResult>(
    "tables:upsertBudgetCategoryFromDevice",
  ),
  deleteBudgetCategory: mutation<Record<string, unknown>, DeleteResult>(
    "tables:deleteBudgetCategoryFromDevice",
  ),
  upsertBtcBuy: mutation<Record<string, unknown>, UpsertResult>(
    "tables:upsertBtcBuyFromDevice",
  ),
  deleteBtcBuy: mutation<Record<string, unknown>, DeleteResult>(
    "tables:deleteBtcBuyFromDevice",
  ),
  upsertBtcBillPay: mutation<Record<string, unknown>, UpsertResult>(
    "tables:upsertBtcBillPayFromDevice",
  ),
  deleteBtcBillPay: mutation<Record<string, unknown>, DeleteResult>(
    "tables:deleteBtcBillPayFromDevice",
  ),
  upsertBtcAccount: mutation<Record<string, unknown>, UpsertResult>(
    "tables:upsertBtcAccountFromDevice",
  ),
  deleteBtcAccount: mutation<Record<string, unknown>, DeleteResult>(
    "tables:deleteBtcAccountFromDevice",
  ),
};

let t: T;
let syncToken: string;

beforeEach(() => {
  t = testConvex();
  syncToken = freshSecret();
  setDeploymentEnv({ CONVEX_SYNC_TOKEN: syncToken });
});

async function fullDevice(deviceId = "linux-device") {
  return await pairMobileDevice(t, syncToken, deviceId, [
    "todos:write",
    "transactions:write",
    "budget:write",
    "bitcoin:write",
  ]);
}

async function transactionRevision(txId: string) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("transactions")
      .withIndex("by_source_tx_id", (q) =>
        q.eq("sourceFile", "transactions").eq("txId", txId),
      )
      .unique();
    return row!.updatedAtMs;
  });
}

async function todoRevision(todoId: string) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("todos")
      .withIndex("by_todo_id", (q) => q.eq("todoId", todoId))
      .unique();
    return row!.updatedAtMs;
  });
}

async function budgetRevision(sourceFile: "budget" | "mason-budget") {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("budgetDocuments")
      .withIndex("by_source_file", (q) => q.eq("sourceFile", sourceFile))
      .unique();
    return row!.updatedAtMs;
  });
}

async function buyRevision(
  buyId: string,
  sourceFile: "bitcoin-buys" | "mason-bitcoin-buys" = "bitcoin-buys",
) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("btcBuys")
      .withIndex("by_source_buy_id", (q) =>
        q.eq("sourceFile", sourceFile).eq("buyId", buyId),
      )
      .unique();
    return row!.updatedAtMs;
  });
}

async function billPayRevision(billPayId: string) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("btcBillPays")
      .withIndex("by_source_bill_pay_id", (q) =>
        q.eq("sourceFile", "bitcoin-bill-pays").eq("billPayId", billPayId),
      )
      .unique();
    return row!.updatedAtMs;
  });
}

async function btcDocumentRevision(
  sourceFile: "btc-balance-snapshot" | "son-balances",
) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("btcBalanceDocuments")
      .withIndex("by_source_file", (q) => q.eq("sourceFile", sourceFile))
      .unique();
    return row!.updatedAtMs;
  });
}

async function expectDeviceError(
  request: Promise<unknown>,
  code: string,
  entityId?: string,
) {
  try {
    await request;
    throw new Error(`Expected device error ${code}`);
  } catch (error) {
    const data = (error as { data?: Record<string, unknown> }).data;
    expect(data?.code).toBe(code);
    if (entityId !== undefined) expect(data?.entityId).toBe(entityId);
  }
}

function authArgs(device: { deviceId: string; deviceToken: string }) {
  return {
    deviceId: device.deviceId,
    deviceToken: device.deviceToken,
  };
}

async function seedBudgets() {
  await t.run(async (ctx) => {
    await ctx.db.insert("budgetDocuments", {
      sourceFile: "budget",
      owner: "victor",
      month: "2026-07",
      coinbaseOneBalanceCents: 0n,
      categories: [
        { name: "Food", icon: "fork", budgetCents: 40_000n },
        { name: "Fun", icon: "game", budgetCents: 20_000n },
      ],
      mtdIncomeCents: 0n,
      ytdIncomeCents: 0n,
      monthlyHistory: [],
      updatedAtMs: 1,
    });
    await ctx.db.insert("budgetDocuments", {
      sourceFile: "mason-budget",
      owner: "mason",
      month: "2026-07",
      coinbaseOneBalanceCents: 0n,
      categories: [],
      mtdIncomeCents: 0n,
      ytdIncomeCents: 0n,
      monthlyHistory: [],
      updatedAtMs: 1,
    });
  });
}

describe("device row authorization", () => {
  it("requires the operation capability and leaves lastSeen unchanged on rejection", async () => {
    const device = await pairMobileDevice(t, syncToken, "todo-only");
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", device.deviceId))
        .unique();
      await ctx.db.patch(row!._id, { lastSeenAt: 0 });
    });
    await expect(
      t.mutation(api.upsertTransaction, {
        ...authArgs(device),
        owner: "victor",
        sourceFile: "transactions",
        transaction: {
          id: "tx-1",
          owner: "victor",
          date: "2026-07-30",
          merchant: "Store",
          amountCents: 100n,
          kind: "spend",
          category: "Food",
        },
      }),
    ).rejects.toThrow(/Unauthorized mobile device/);
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", device.deviceId))
        .unique(),
    );
    expect(stored!.lastSeenAt).toBe(0);
  });

  it("rejects owner/source and request/payload owner mismatches", async () => {
    const device = await fullDevice();
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", device.deviceId))
        .unique();
      await ctx.db.patch(row!._id, { lastSeenAt: 0 });
    });
    await expect(
      t.mutation(api.upsertTransaction, {
        ...authArgs(device),
        owner: "mason",
        sourceFile: "transactions",
        transaction: {
          id: "tx-1",
          owner: "mason",
          date: "2026-07-30",
          merchant: "Store",
          amountCents: 100n,
          kind: "spend",
          category: "Food",
        },
      }),
    ).rejects.toThrow(/belongs to victor/);
    await expect(
      t.mutation(api.upsertTodo, {
        ...authArgs(device),
        owner: "mason",
        sourceFile: "todos",
        todo: {
          id: "todo-1",
          owner: "victor",
          title: "Wrong owner",
          done: false,
          flagged: false,
        },
      }),
    ).rejects.toThrow(/owner does not match/);
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", device.deviceId))
        .unique(),
    );
    expect(stored!.lastSeenAt).toBe(0);
  });

  it("validates every device resource before writing or marking the device seen", async () => {
    const device = await fullDevice("validation-device");
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", device.deviceId))
        .unique();
      await ctx.db.patch(row!._id, { lastSeenAt: 0 });
    });

    const invalidRequests = [
      () =>
        t.mutation(api.upsertTransaction, {
          ...authArgs(device),
          owner: "victor",
          sourceFile: "transactions",
          transaction: {
            id: " spaced-id ",
            owner: "victor",
            date: "2026-07-30",
            merchant: "Store",
            amountCents: 100n,
            kind: "spend",
            category: "Food",
          },
        }),
      () =>
        t.mutation(api.upsertTodo, {
          ...authArgs(device),
          owner: "victor",
          sourceFile: "todos",
          todo: {
            id: "todo-invalid",
            owner: "victor",
            title: "control\u0000character",
            done: false,
            flagged: false,
          },
        }),
      () =>
        t.mutation(api.upsertTodo, {
          ...authArgs(device),
          owner: "victor",
          sourceFile: "todos",
          todo: {
            id: "todo-invalid-due",
            owner: "victor",
            title: "Invalid due",
            done: false,
            flagged: false,
            due: "2026-02-30",
          },
        }),
      () =>
        t.mutation(api.upsertTodo, {
          ...authArgs(device),
          owner: "victor",
          sourceFile: "todos",
          todo: {
            id: "todo-invalid-timestamp",
            owner: "victor",
            title: "Invalid timestamp",
            done: false,
            flagged: false,
            updatedAt: "2026-07-30 12:00:00",
          },
        }),
      () =>
        t.mutation(api.upsertBudgetCategory, {
          ...authArgs(device),
          owner: "victor",
          sourceFile: "budget",
          month: "2026-07",
          category: { name: "Food", budgetCents: -1n },
        }),
      () =>
        t.mutation(api.upsertBtcBuy, {
          ...authArgs(device),
          owner: "victor",
          sourceFile: "bitcoin-buys",
          buy: {
            id: "buy-invalid",
            owner: "victor",
            date: "2026-07-30",
            source: "strike",
            sats: -1n,
            priceUsdCents: 10_000_000n,
            usdCents: 100n,
          },
        }),
      () =>
        t.mutation(api.upsertBtcBillPay, {
          ...authArgs(device),
          owner: "victor",
          sourceFile: "bitcoin-bill-pays",
          billPay: {
            id: "bill-invalid",
            owner: "victor",
            date: "2026-07-30",
            merchant: "",
            category: "Bills",
            amountUsdCents: 100n,
            btcSpentSats: 1n,
            btcPriceCents: 10_000_000n,
            feeUsdCents: 0n,
          },
        }),
      () =>
        t.mutation(api.upsertBtcAccount, {
          ...authArgs(device),
          owner: "victor",
          sourceFile: "btc-balance-snapshot",
          account: {
            key: " account ",
            owner: "victor",
            label: "Account",
            custody: "exchange",
            sats: -1n,
            asOf: "2026-07-30T00:00:00.000Z",
          },
        }),
      () =>
        t.mutation(api.upsertBtcAccount, {
          ...authArgs(device),
          owner: "victor",
          sourceFile: "btc-balance-snapshot",
          account: {
            key: "invalid-as-of",
            owner: "victor",
            label: "Account",
            custody: "exchange",
            sats: 1n,
            asOf: "2026-07-30",
          },
        }),
      () =>
        t.mutation(api.deleteTransaction, {
          ...authArgs(device),
          owner: "victor",
          sourceFile: "transactions",
          entityId: "tx-invalid",
          baseUpdatedAtMs: 1.5,
        }),
    ];

    for (const request of invalidRequests) {
      await expectDeviceError(request(), "VALIDATION_FAILED");
    }

    const state = await t.run(async (ctx) => ({
      transactions: await ctx.db.query("transactions").collect(),
      todos: await ctx.db.query("todos").collect(),
      budgets: await ctx.db.query("budgetDocuments").collect(),
      buys: await ctx.db.query("btcBuys").collect(),
      bills: await ctx.db.query("btcBillPays").collect(),
      accounts: await ctx.db.query("btcAccounts").collect(),
      balanceDocuments: await ctx.db.query("btcBalanceDocuments").collect(),
      tombstones: await ctx.db.query("rowTombstones").collect(),
      locks: await ctx.db.query("runtimeSourceLocks").collect(),
      device: await ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", device.deviceId))
        .unique(),
    }));
    expect(state).toMatchObject({
      transactions: [],
      todos: [],
      budgets: [],
      buys: [],
      bills: [],
      accounts: [],
      balanceDocuments: [],
      tombstones: [],
      locks: [],
    });
    expect(state.device!.lastSeenAt).toBe(0);
  });

  it("fails closed when a physical natural key is already duplicated", async () => {
    const device = await fullDevice("duplicate-key-device");
    await t.run(async (ctx) => {
      for (const owner of ["victor", "mason"] as const) {
        await ctx.db.insert("transactions", {
          txId: "duplicate-id",
          owner,
          date: "2026-07-30",
          month: "2026-07",
          merchant: `${owner} row`,
          amountCents: 100n,
          category: "Food",
          sourceFile: "transactions",
          updatedAtMs: 1,
        });
      }
      const row = await ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", device.deviceId))
        .unique();
      await ctx.db.patch(row!._id, { lastSeenAt: 0 });
    });

    await expect(
      t.mutation(api.upsertTransaction, {
        ...authArgs(device),
        owner: "victor",
        sourceFile: "transactions",
        baseUpdatedAtMs: 1,
        transaction: {
          id: "duplicate-id",
          owner: "victor",
          date: "2026-07-30",
          merchant: "Must not land",
          amountCents: 100n,
          kind: "spend",
          category: "Food",
        },
      }),
    ).rejects.toThrow();

    const state = await t.run(async (ctx) => ({
      merchants: (await ctx.db.query("transactions").collect()).map(
        (row) => row.merchant,
      ),
      locks: await ctx.db.query("runtimeSourceLocks").collect(),
      device: await ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", device.deviceId))
        .unique(),
    }));
    expect(state.merchants.sort()).toEqual(["mason row", "victor row"]);
    expect(state.locks).toEqual([]);
    expect(state.device!.lastSeenAt).toBe(0);
  });
});

describe("device transaction and todo mutations", () => {
  it("atomically marks every runtime-owned source at its first successful write", async () => {
    await seedBudgets();
    const device = await fullDevice("source-lock-device");
    const auth = authArgs(device);

    await t.mutation(api.upsertTransaction, {
      ...auth,
      owner: "victor",
      sourceFile: "transactions",
      transaction: {
        id: "lock-transaction",
        owner: "victor",
        date: "2026-07-30",
        merchant: "Store",
        amountCents: 100n,
        kind: "spend",
        category: "Food",
      },
    });
    await t.mutation(api.upsertTodo, {
      ...auth,
      owner: "victor",
      sourceFile: "todos",
      todo: {
        id: "lock-todo",
        owner: "victor",
        title: "Locked",
        done: false,
        flagged: false,
        due: "2026-08-15",
        createdAt: "2026-07-30T00:00:00.000Z",
      },
    });
    await t.mutation(api.upsertBudgetCategory, {
      ...auth,
      owner: "victor",
      sourceFile: "budget",
      month: "2026-07",
      baseUpdatedAtMs: await budgetRevision("budget"),
      category: { name: "Locked category", budgetCents: 100n },
    });
    await t.mutation(api.upsertBtcBuy, {
      ...auth,
      owner: "victor",
      sourceFile: "bitcoin-buys",
      buy: {
        id: "lock-buy",
        owner: "victor",
        date: "2026-07-30",
        source: "strike",
        sats: 1n,
        priceUsdCents: 10_000_000n,
        usdCents: 100n,
      },
    });
    await t.mutation(api.upsertBtcBillPay, {
      ...auth,
      owner: "victor",
      sourceFile: "bitcoin-bill-pays",
      billPay: {
        id: "lock-bill",
        owner: "victor",
        date: "2026-07-30",
        merchant: "Utility",
        category: "Bills",
        amountUsdCents: 100n,
        btcSpentSats: 1n,
        btcPriceCents: 10_000_000n,
        feeUsdCents: 0n,
      },
    });
    await t.mutation(api.upsertBtcAccount, {
      ...auth,
      owner: "victor",
      sourceFile: "btc-balance-snapshot",
      account: {
        key: "lock-account",
        owner: "victor",
        label: "Account",
        custody: "exchange",
        sats: 1n,
        asOf: "2026-07-30T00:00:00.000Z",
      },
    });

    const locks = await t.run(async (ctx) =>
      ctx.db.query("runtimeSourceLocks").collect(),
    );
    expect(locks.map((lock) => lock.sourceFile).sort()).toEqual([
      "bitcoin-bill-pays",
      "bitcoin-buys",
      "btc-balance-snapshot",
      "budget",
      "todos",
      "transactions",
    ]);
  });

  it("returns exact outcomes and leaves idempotent tombstones", async () => {
    const device = await fullDevice();
    const transactionArgs = {
      ...authArgs(device),
      owner: "victor",
      sourceFile: "transactions",
      transaction: {
        id: "tx-1",
        owner: "victor",
        date: "2026-07-30",
        merchant: "Store",
        amountCents: 100n,
        kind: "spend",
        category: "Food",
      },
    };
    await expect(
      t.mutation(api.upsertTransaction, transactionArgs),
    ).resolves.toEqual({
      ok: true,
      entityId: "tx-1",
      outcome: "inserted",
    });
    const firstRevision = await transactionRevision("tx-1");
    await expect(
      t.mutation(api.upsertTransaction, {
        ...transactionArgs,
        baseUpdatedAtMs: firstRevision,
      }),
    ).resolves.toEqual({
      ok: true,
      entityId: "tx-1",
      outcome: "updated",
    });
    const updatedRevision = await transactionRevision("tx-1");
    const deleteArgs = {
      ...authArgs(device),
      owner: "victor",
      sourceFile: "transactions",
      entityId: "tx-1",
      baseUpdatedAtMs: updatedRevision,
    };
    await expect(
      t.mutation(api.deleteTransaction, deleteArgs),
    ).resolves.toEqual({
      ok: true,
      entityId: "tx-1",
      removed: true,
    });
    await expect(
      t.mutation(api.deleteTransaction, deleteArgs),
    ).resolves.toEqual({
      ok: true,
      entityId: "tx-1",
      removed: false,
    });
    const tombstones = await t.run(async (ctx) =>
      ctx.db.query("rowTombstones").collect(),
    );
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      entityType: "transaction",
      sourceFile: "transactions",
      entityId: "tx-1",
    });
  });

  it("rejects stale financial row updates and deletes with structured codes", async () => {
    const device = await fullDevice();
    const base = {
      ...authArgs(device),
      owner: "victor",
      sourceFile: "transactions",
      transaction: {
        id: "tx-occ",
        owner: "victor",
        date: "2026-07-30",
        merchant: "Original",
        amountCents: 100n,
        kind: "spend",
        category: "Food",
      },
    };
    await t.mutation(api.upsertTransaction, base);
    const revision = await transactionRevision("tx-occ");
    await t.mutation(api.upsertTransaction, {
      ...base,
      baseUpdatedAtMs: revision,
      transaction: { ...base.transaction, merchant: "Current" },
    });
    await expectDeviceError(
      t.mutation(api.upsertTransaction, {
        ...base,
        baseUpdatedAtMs: revision,
        transaction: { ...base.transaction, merchant: "Stale" },
      }),
      "ENTITY_CONFLICT",
      "tx-occ",
    );
    await expectDeviceError(
      t.mutation(api.deleteTransaction, {
        ...authArgs(device),
        owner: "victor",
        sourceFile: "transactions",
        entityId: "tx-occ",
        baseUpdatedAtMs: revision,
      }),
      "ENTITY_CONFLICT",
      "tx-occ",
    );
    await expectDeviceError(
      t.mutation(api.deleteTransaction, {
        ...authArgs(device),
        owner: "victor",
        sourceFile: "transactions",
        entityId: "never-created",
        baseUpdatedAtMs: 1,
      }),
      "ENTITY_NOT_FOUND",
      "never-created",
    );
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_source_tx_id", (q) =>
          q.eq("sourceFile", "transactions").eq("txId", "tx-occ"),
        )
        .unique(),
    );
    expect(row!.merchant).toBe("Current");
  });

  it("blocks cross-owner todo replacement and preserves both tombstone systems", async () => {
    const device = await fullDevice();
    const upsert = {
      ...authArgs(device),
      owner: "mason",
      sourceFile: "todos",
      todo: {
        id: "todo-1",
        owner: "mason",
        title: "Homework",
        done: false,
        flagged: true,
      },
    };
    await t.mutation(api.upsertTodo, upsert);
    const revision = await todoRevision("todo-1");
    await expect(
      t.mutation(api.upsertTodo, {
        ...upsert,
        owner: "victor",
        todo: { ...upsert.todo, owner: "victor" },
      }),
    ).rejects.toThrow(/belongs to mason/);
    await t.mutation(api.deleteTodo, {
      ...authArgs(device),
      owner: "mason",
      sourceFile: "todos",
      entityId: "todo-1",
      baseUpdatedAtMs: revision,
    });
    const markers = await t.run(async (ctx) => ({
      row: await ctx.db.query("rowTombstones").collect(),
      legacy: await ctx.db.query("todoTombstones").collect(),
    }));
    expect(markers.row).toHaveLength(1);
    expect(markers.legacy.map((row) => row.id)).toEqual(["todo-1"]);
  });

  it("rejects stale todo writes without changing the row, tombstones, or lastSeen", async () => {
    const device = await fullDevice();
    const upsert = {
      ...authArgs(device),
      owner: "mason",
      sourceFile: "todos",
      todo: {
        id: "todo-occ",
        owner: "mason",
        title: "Original",
        done: false,
        flagged: false,
      },
    };
    await t.mutation(api.upsertTodo, upsert);
    const revision = await todoRevision("todo-occ");
    await t.mutation(api.upsertTodo, {
      ...upsert,
      baseUpdatedAtMs: revision,
      todo: { ...upsert.todo, title: "Current" },
    });
    const seenBefore = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", device.deviceId))
        .unique();
      return row!.lastSeenAt;
    });
    await expectDeviceError(
      t.mutation(api.upsertTodo, {
        ...upsert,
        baseUpdatedAtMs: revision,
        todo: { ...upsert.todo, title: "Stale" },
      }),
      "ENTITY_CONFLICT",
      "todo-occ",
    );
    await expectDeviceError(
      t.mutation(api.deleteTodo, {
        ...authArgs(device),
        owner: "mason",
        sourceFile: "todos",
        entityId: "todo-occ",
        baseUpdatedAtMs: revision,
      }),
      "ENTITY_CONFLICT",
      "todo-occ",
    );
    const state = await t.run(async (ctx) => ({
      row: await ctx.db
        .query("todos")
        .withIndex("by_todo_id", (q) => q.eq("todoId", "todo-occ"))
        .unique(),
      rowTombstones: await ctx.db.query("rowTombstones").collect(),
      legacyTombstones: await ctx.db.query("todoTombstones").collect(),
      device: await ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", device.deviceId))
        .unique(),
    }));
    expect(state.row!.title).toBe("Current");
    expect(state.rowTombstones).toEqual([]);
    expect(state.legacyTombstones).toEqual([]);
    expect(state.device!.lastSeenAt).toBe(seenBefore);
  });
});

describe("device budget mutations", () => {
  it("uses one folded identity for mixed-case deletion retries and migration suppression", async () => {
    await seedBudgets();
    const device = await fullDevice();
    const baseUpdatedAtMs = await budgetRevision("budget");
    const request = {
      ...authArgs(device),
      owner: "victor",
      sourceFile: "budget",
      month: "2026-07",
      entityId: "food",
      baseUpdatedAtMs,
    };

    await expect(
      t.mutation(api.deleteBudgetCategory, request),
    ).resolves.toMatchObject({ entityId: "food", removed: true });
    await expect(
      t.mutation(api.deleteBudgetCategory, request),
    ).resolves.toMatchObject({ entityId: "food", removed: false });

    const state = await t.run(async (ctx) => ({
      budget: await ctx.db
        .query("budgetDocuments")
        .withIndex("by_source_file", (q) => q.eq("sourceFile", "budget"))
        .unique(),
      tombstones: await ctx.db
        .query("rowTombstones")
        .withIndex("by_entity", (q) =>
          q.eq("entityType", "budgetCategory").eq("sourceFile", "budget"),
        )
        .collect(),
      lock: await ctx.db
        .query("runtimeSourceLocks")
        .withIndex("by_source_file", (q) => q.eq("sourceFile", "budget"))
        .unique(),
    }));
    expect(state.budget!.categories.map((category) => category.name)).toEqual([
      "Fun",
    ]);
    expect(state.tombstones.map((row) => row.entityId)).toEqual(["food"]);
    expect(state.lock).toMatchObject({ sourceFile: "budget" });
  });

  it("renames in place, rejects collisions/stale months, and deletes idempotently", async () => {
    await seedBudgets();
    const device = await fullDevice();
    const base = {
      ...authArgs(device),
      owner: "victor",
      sourceFile: "budget",
      month: "2026-07",
    };
    const initialRevision = await budgetRevision("budget");
    await expect(
      t.mutation(api.upsertBudgetCategory, {
        ...base,
        baseUpdatedAtMs: initialRevision,
        previousName: "Food",
        category: { name: "Fun", budgetCents: 50_000n },
      }),
    ).rejects.toThrow(/already exists/);
    await expect(
      t.mutation(api.upsertBudgetCategory, {
        ...base,
        baseUpdatedAtMs: initialRevision,
        previousName: "Food",
        category: { name: "Groceries", budgetCents: 50_000n },
      }),
    ).resolves.toEqual({
      ok: true,
      entityId: "Groceries",
      outcome: "updated",
    });
    const budget = await t.run(async (ctx) =>
      ctx.db
        .query("budgetDocuments")
        .withIndex("by_source_file", (q) => q.eq("sourceFile", "budget"))
        .unique(),
    );
    expect(budget!.categories.map((category) => category.name)).toEqual([
      "Groceries",
      "Fun",
    ]);
    const renamedRevision = budget!.updatedAtMs;
    await expectDeviceError(
      t.mutation(api.upsertBudgetCategory, {
        ...base,
        baseUpdatedAtMs: initialRevision,
        previousName: "Fun",
        category: { name: "Entertainment", budgetCents: 20_000n },
      }),
      "ENTITY_CONFLICT",
      "Fun",
    );
    await expect(
      t.mutation(api.deleteBudgetCategory, {
        ...base,
        month: "2026-06",
        entityId: "Groceries",
        baseUpdatedAtMs: renamedRevision,
      }),
    ).rejects.toThrow(/does not match/);
    const deleteArgs = {
      ...base,
      entityId: "Groceries",
      baseUpdatedAtMs: renamedRevision,
    };
    await expect(
      t.mutation(api.deleteBudgetCategory, deleteArgs),
    ).resolves.toEqual({
      ok: true,
      entityId: "Groceries",
      removed: true,
    });
    await expect(
      t.mutation(api.deleteBudgetCategory, deleteArgs),
    ).resolves.toEqual({
      ok: true,
      entityId: "Groceries",
      removed: false,
    });
  });
});

describe("device bitcoin mutations", () => {
  it("rejects child writes to the adult-only bill-pay source before side effects", async () => {
    const device = await fullDevice("child-bill-device");
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", device.deviceId))
        .unique();
      await ctx.db.patch(row!._id, { lastSeenAt: 0 });
    });

    await expectDeviceError(
      t.mutation(api.upsertBtcBillPay, {
        ...authArgs(device),
        owner: "mason",
        sourceFile: "bitcoin-bill-pays",
        billPay: {
          id: "child-bill",
          owner: "mason",
          date: "2026-07-30",
          merchant: "Must not land",
          category: "Bills",
          amountUsdCents: 100n,
          btcSpentSats: 1n,
          btcPriceCents: 10_000_000n,
          feeUsdCents: 0n,
        },
      }),
      "OWNER_SOURCE_MISMATCH",
    );

    const state = await t.run(async (ctx) => ({
      bills: await ctx.db.query("btcBillPays").collect(),
      locks: await ctx.db.query("runtimeSourceLocks").collect(),
      device: await ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", device.deviceId))
        .unique(),
    }));
    expect(state.bills).toEqual([]);
    expect(state.locks).toEqual([]);
    expect(state.device!.lastSeenAt).toBe(0);
  });

  it("canonicalizes Rachel financial intent into the shared Victor ledger", async () => {
    await seedBudgets();
    const device = await fullDevice();
    const auth = authArgs(device);
    await t.mutation(api.upsertTransaction, {
      ...auth,
      owner: "rachel",
      sourceFile: "transactions",
      transaction: {
        id: "rachel-tx",
        owner: "rachel",
        date: "2026-07-30",
        merchant: "Shared",
        amountCents: 100n,
        kind: "spend",
        category: "Food",
      },
    });
    await t.mutation(api.upsertBudgetCategory, {
      ...auth,
      owner: "rachel",
      sourceFile: "budget",
      month: "2026-07",
      baseUpdatedAtMs: await budgetRevision("budget"),
      category: { name: "Rachel shared", budgetCents: 1_000n },
    });
    await t.mutation(api.upsertBtcBuy, {
      ...auth,
      owner: "rachel",
      sourceFile: "bitcoin-buys",
      buy: {
        id: "rachel-buy",
        owner: "rachel",
        date: "2026-07-30",
        source: "strike",
        sats: 10n,
        priceUsdCents: 10_000_000n,
        usdCents: 100n,
      },
    });
    await t.mutation(api.upsertBtcBillPay, {
      ...auth,
      owner: "rachel",
      sourceFile: "bitcoin-bill-pays",
      billPay: {
        id: "rachel-bill",
        owner: "rachel",
        date: "2026-07-30",
        merchant: "Shared bill",
        category: "Bills",
        amountUsdCents: 100n,
        btcSpentSats: 10n,
        btcPriceCents: 10_000_000n,
        feeUsdCents: 0n,
      },
    });
    await t.mutation(api.upsertBtcAccount, {
      ...auth,
      owner: "rachel",
      sourceFile: "btc-balance-snapshot",
      account: {
        key: "rachel-shared",
        owner: "rachel",
        label: "Shared account",
        custody: "exchange",
        sats: 10n,
        asOf: "2026-07-30T00:00:00.000Z",
      },
    });

    const owners = await t.run(async (ctx) => ({
      transaction: (await ctx.db.query("transactions").unique())!.owner,
      budget: (await ctx.db
        .query("budgetDocuments")
        .withIndex("by_source_file", (q) => q.eq("sourceFile", "budget"))
        .unique())!.owner,
      buy: (await ctx.db.query("btcBuys").unique())!.owner,
      bill: (await ctx.db.query("btcBillPays").unique())!.owner,
      accountDocument: (await ctx.db
        .query("btcBalanceDocuments")
        .withIndex("by_source_file", (q) =>
          q.eq("sourceFile", "btc-balance-snapshot"),
        )
        .unique())!.owner,
      accountMirror: (await ctx.db.query("btcAccounts").unique())!.owner,
    }));
    expect(owners).toEqual({
      transaction: "victor",
      budget: "victor",
      buy: "victor",
      bill: "victor",
      accountDocument: "victor",
      accountMirror: "victor",
    });
  });

  it("upserts and deletes buys and bill pays with cross-owner protection", async () => {
    const device = await fullDevice();
    await expect(
      t.mutation(api.upsertBtcBuy, {
        ...authArgs(device),
        owner: "mason",
        sourceFile: "mason-bitcoin-buys",
        buy: {
          id: "buy-1",
          owner: "mason",
          date: "2026-07-30",
          source: "strike",
          sats: 10_000n,
          priceUsdCents: 10_000_000n,
          usdCents: 1_000n,
        },
      }),
    ).resolves.toEqual({
      ok: true,
      entityId: "buy-1",
      outcome: "inserted",
    });
    const buyBase = await buyRevision("buy-1", "mason-bitcoin-buys");
    await expectDeviceError(
      t.mutation(api.upsertBtcBuy, {
        ...authArgs(device),
        owner: "mason",
        sourceFile: "mason-bitcoin-buys",
        baseUpdatedAtMs: buyBase - 1,
        buy: {
          id: "buy-1",
          owner: "mason",
          date: "2026-07-30",
          source: "strike",
          sats: 20_000n,
          priceUsdCents: 10_000_000n,
          usdCents: 2_000n,
        },
      }),
      "ENTITY_CONFLICT",
      "buy-1",
    );
    await expect(
      t.mutation(api.deleteBtcBuy, {
        ...authArgs(device),
        owner: "mason",
        sourceFile: "mason-bitcoin-buys",
        entityId: "buy-1",
        baseUpdatedAtMs: buyBase,
      }),
    ).resolves.toMatchObject({ removed: true });

    const billPay = {
      ...authArgs(device),
      owner: "victor",
      sourceFile: "bitcoin-bill-pays",
      billPay: {
        id: "bill-1",
        owner: "victor",
        date: "2026-07-30",
        merchant: "Utility",
        category: "Bills",
        amountUsdCents: 5_000n,
        btcSpentSats: 50_000n,
        btcPriceCents: 10_000_000n,
        feeUsdCents: 0n,
      },
    };
    await t.mutation(api.upsertBtcBillPay, billPay);
    const billBase = await billPayRevision("bill-1");
    await expectDeviceError(
      t.mutation(api.upsertBtcBillPay, {
        ...billPay,
        baseUpdatedAtMs: billBase - 1,
        billPay: { ...billPay.billPay, amountUsdCents: 5_100n },
      }),
      "ENTITY_CONFLICT",
      "bill-1",
    );
    await expect(
      t.mutation(api.upsertBtcBillPay, {
        ...billPay,
        owner: "mason",
        billPay: { ...billPay.billPay, owner: "mason" },
      }),
    ).rejects.toThrow(/belongs to victor/);
    await expect(
      t.mutation(api.deleteBtcBillPay, {
        ...authArgs(device),
        owner: "victor",
        sourceFile: "bitcoin-bill-pays",
        entityId: "bill-1",
        baseUpdatedAtMs: billBase,
      }),
    ).resolves.toMatchObject({ removed: true });
  });

  it("reconciles the canonical balance document, exact totals, and row mirror", async () => {
    const device = await fullDevice();
    const base = {
      ...authArgs(device),
      owner: "mason",
      sourceFile: "son-balances",
    };
    await t.mutation(api.upsertBtcAccount, {
      ...base,
      account: {
        key: "strike",
        owner: "mason",
        label: "Strike",
        custody: "exchange",
        sats: 100n,
        asOf: "2026-07-30T00:00:00.000Z",
        schemaVersion: 1n,
        fiatValuation: {
          cents: 200n,
          priceCents: 10_000_000n,
          quotedAt: "2026-07-30T00:00:00.000Z",
          source: "trusted-quote",
          confidence: "reviewed",
        },
      },
    });
    const strikeDocumentRevision = await btcDocumentRevision("son-balances");
    await t.mutation(api.upsertBtcAccount, {
      ...base,
      baseUpdatedAtMs: strikeDocumentRevision,
      account: {
        key: "coldcard",
        owner: "mason",
        label: "Coldcard",
        custody: "self_custody",
        sats: 300n,
        asOf: "2026-07-30T00:00:00.000Z",
        fiatValuation: { cents: 400n },
      },
    });
    await expectDeviceError(
      t.mutation(api.upsertBtcAccount, {
        ...base,
        baseUpdatedAtMs: strikeDocumentRevision,
        account: {
          key: "ledger",
          owner: "mason",
          label: "Stale",
          custody: "exchange",
          sats: 1n,
          asOf: "2026-07-30T00:00:00.000Z",
        },
      }),
      "ENTITY_CONFLICT",
      "ledger",
    );
    const beforeDelete = await t.run(async (ctx) => ({
      document: await ctx.db
        .query("btcBalanceDocuments")
        .withIndex("by_source_file", (q) => q.eq("sourceFile", "son-balances"))
        .unique(),
      mirrors: await ctx.db
        .query("btcAccounts")
        .withIndex("by_owner_key", (q) => q.eq("owner", "mason"))
        .collect(),
    }));
    expect(beforeDelete.document!.totals).toEqual({
      sats: 400n,
      fiatCents: 600n,
      exchangeSats: 100n,
      selfCustodySats: 300n,
    });
    expect(beforeDelete.document!.accounts[0]!.fiatValuation).toMatchObject({
      cents: 200n,
      source: "trusted-quote",
      confidence: "reviewed",
    });
    expect(beforeDelete.mirrors.map((row) => row.key).sort()).toEqual([
      "son-coldcard-mason",
      "son-strike-mason",
    ]);
    await expect(
      t.mutation(api.deleteBtcAccount, {
        ...base,
        entityId: "strike",
        baseUpdatedAtMs: beforeDelete.document!.updatedAtMs,
      }),
    ).resolves.toEqual({
      ok: true,
      entityId: "strike",
      removed: true,
    });
    const afterDelete = await t.run(async (ctx) => ({
      document: await ctx.db
        .query("btcBalanceDocuments")
        .withIndex("by_source_file", (q) => q.eq("sourceFile", "son-balances"))
        .unique(),
      mirrors: await ctx.db.query("btcAccounts").collect(),
    }));
    expect(afterDelete.document!.accounts.map((row) => row.key)).toEqual([
      "coldcard",
    ]);
    expect(afterDelete.document!.totals.sats).toBe(300n);
    expect(afterDelete.mirrors.map((row) => row.key)).toEqual([
      "son-coldcard-mason",
    ]);
  });

  it("preserves valuation when omitted and never invents zero for a new account", async () => {
    const device = await fullDevice();
    const base = {
      ...authArgs(device),
      owner: "victor",
      sourceFile: "btc-balance-snapshot",
    };
    await t.mutation(api.upsertBtcAccount, {
      ...base,
      account: {
        key: "strike",
        owner: "victor",
        label: "Strike",
        custody: "exchange",
        sats: 100n,
        asOf: "2026-07-30T00:00:00.000Z",
        fiatValuation: { cents: 250n, source: "reviewed-quote" },
      },
    });
    const initialRevision = await btcDocumentRevision("btc-balance-snapshot");
    await t.mutation(api.upsertBtcAccount, {
      ...base,
      baseUpdatedAtMs: initialRevision,
      account: {
        key: "strike",
        owner: "victor",
        label: "Strike",
        custody: "exchange",
        sats: 125n,
        asOf: "2026-07-30T01:00:00.000Z",
      },
    });
    const updatedRevision = await btcDocumentRevision("btc-balance-snapshot");
    await t.mutation(api.upsertBtcAccount, {
      ...base,
      baseUpdatedAtMs: updatedRevision,
      account: {
        key: "zeus",
        owner: "victor",
        label: "Zeus",
        custody: "self_custody",
        sats: 50n,
        asOf: "2026-07-30T01:00:00.000Z",
      },
    });
    const document = await t.run(async (ctx) =>
      ctx.db
        .query("btcBalanceDocuments")
        .withIndex("by_source_file", (q) =>
          q.eq("sourceFile", "btc-balance-snapshot"),
        )
        .unique(),
    );
    expect(
      document!.accounts.find((account) => account.key === "strike")!
        .fiatValuation,
    ).toMatchObject({ cents: 250n, source: "reviewed-quote" });
    expect(
      document!.accounts.find((account) => account.key === "zeus"),
    ).not.toHaveProperty("fiatValuation");
    expect(document!.totals.fiatCents).toBeUndefined();
  });
});
