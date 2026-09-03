import type { FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it } from "vitest";

import {
  freshSecret,
  pairMobileDevice,
  setDeploymentEnv,
  testConvex,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";
import type { DeviceProfile } from "./deviceAuth";

useIsolatedDeploymentEnv();

type T = ReturnType<typeof testConvex>;
type UpsertResult = {
  ok: true;
  entityId: string;
  outcome: "inserted" | "updated";
};
type DeleteResult = { ok: true; entityId: string; removed: boolean };
const CURRENT_MONTH = new Date().toISOString().slice(0, 7);
type RestoreResult = {
  ok: true;
  entityId: string;
  updatedAtMs: number;
};

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
  restoreTodo: mutation<Record<string, unknown>, RestoreResult>(
    "tables:restoreTodoFromDevice",
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
  upsertBtcTransfer: mutation<Record<string, unknown>, UpsertResult>(
    "tables:upsertBtcTransferFromDevice",
  ),
  deleteBtcTransfer: mutation<Record<string, unknown>, DeleteResult>(
    "tables:deleteBtcTransferFromDevice",
  ),
};

let t: T;
let syncToken: string;

beforeEach(() => {
  t = testConvex();
  syncToken = freshSecret();
  setDeploymentEnv({ CONVEX_SYNC_TOKEN: syncToken });
});

async function fullDevice(
  deviceId = "linux-device",
  profile: DeviceProfile = "victor",
) {
  return await pairMobileDevice(t, syncToken, deviceId, [
    "todos:write",
    "transactions:write",
    "budget:write",
    "bitcoin:write",
  ], profile);
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
      month: CURRENT_MONTH,
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
      month: CURRENT_MONTH,
      coinbaseOneBalanceCents: 0n,
      categories: [],
      mtdIncomeCents: 0n,
      ytdIncomeCents: 0n,
      monthlyHistory: [],
      updatedAtMs: 1,
    });
  });
}

async function seedBtcLedger(owner: "victor" | "mason") {
  const sourceFile = owner === "victor" ? "btc-balance-snapshot" : "son-balances";
  const key = owner === "victor" ? "river" : "son-river-mason";
  const accountKey = "river";
  await t.run(async (ctx) => {
    await ctx.db.insert("btcBalanceDocuments", {
      sourceFile,
      owner,
      schemaVersion: 2n,
      asOf: "2026-07-30T00:00:00.000Z",
      accounts: [
        {
          key: accountKey,
          label: "River",
          custody: "exchange",
          sats: 1_000_000n,
          fiatCents: 1_000n,
        },
      ],
      totals: {
        sats: 1_000_000n,
        fiatCents: 1_000n,
        exchangeSats: 1_000_000n,
        selfCustodySats: 0n,
      },
      postingActivatedAtMs: 1,
      updatedAtMs: 1,
    });
    await ctx.db.insert("btcAccounts", {
      key,
      owner,
      label: "River",
      custody: "exchange",
      sats: 1_000_000n,
      fiatCents: 1_000n,
      asOf: "2026-07-30T00:00:00.000Z",
      schemaVersion: 2n,
      sourceFile,
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

  it("requires bitcoin authority for sat-Income and Bitcoin-spend postings", async () => {
    await seedBtcLedger("victor");
    const transactionOnly = await pairMobileDevice(
      t,
      syncToken,
      "transaction-only-bitcoin-test",
      ["transactions:write"],
    );
    const full = await fullDevice("transaction-and-bitcoin-test");
    const income = {
      id: "device-sat-income",
      owner: "victor" as const,
      date: "2026-07-30",
      merchant: "Bitcoin income",
      amountCents: 1n,
      amountSats: 100n,
      kind: "credit" as const,
      category: "Income",
    };

    await expect(
      t.mutation(api.upsertTransaction, {
        ...authArgs(transactionOnly),
        owner: "victor",
        sourceFile: "transactions",
        transaction: income,
      }),
    ).rejects.toThrow(/Unauthorized mobile device/);
    await expect(
      t.mutation(api.upsertTransaction, {
        ...authArgs(transactionOnly),
        owner: "victor",
        sourceFile: "transactions",
        transaction: {
          ...income,
          id: "device-zeus-lightning-spend",
          merchant: "Zeus Lightning merchant",
          amountCents: 100n,
          amountSats: 50n,
          bitcoinAccountKey: "river",
          kind: "spend",
          category: "Food",
          card: "zeus_lightning",
        },
      }),
    ).rejects.toThrow(/Unauthorized mobile device/);
    await expect(
      t.mutation(api.upsertTransaction, {
        ...authArgs(transactionOnly),
        owner: "victor",
        sourceFile: "transactions",
        transaction: { ...income, id: "ordinary-income", amountSats: undefined },
      }),
    ).resolves.toMatchObject({ outcome: "inserted" });
    await t.mutation(api.upsertTransaction, {
      ...authArgs(full),
      owner: "victor",
      sourceFile: "transactions",
      transaction: income,
    });
    const baseUpdatedAtMs = await transactionRevision(income.id);

    await expect(
      t.mutation(api.upsertTransaction, {
        ...authArgs(transactionOnly),
        owner: "victor",
        sourceFile: "transactions",
        baseUpdatedAtMs,
        transaction: { ...income, note: "unauthorized edit" },
      }),
    ).rejects.toThrow(/Unauthorized mobile device/);
    await expect(
      t.mutation(api.deleteTransaction, {
        ...authArgs(transactionOnly),
        owner: "victor",
        sourceFile: "transactions",
        entityId: income.id,
        baseUpdatedAtMs,
      }),
    ).rejects.toThrow(/Unauthorized mobile device/);
    await expect(
      t.mutation(api.deleteTransaction, {
        ...authArgs(full),
        owner: "victor",
        sourceFile: "transactions",
        entityId: income.id,
        baseUpdatedAtMs,
      }),
    ).resolves.toMatchObject({ removed: true });
  });

  it("enforces the closed payment-source matrix at the device boundary", async () => {
    await seedBtcLedger("victor");
    const device = await fullDevice("payment-source-matrix-device");
    const request = (transaction: Record<string, unknown>, baseUpdatedAtMs?: number) =>
      t.mutation(api.upsertTransaction, {
        ...authArgs(device),
        owner: "victor",
        sourceFile: "transactions",
        baseUpdatedAtMs,
        transaction,
      });
    const base = {
      owner: "victor" as const,
      date: "2026-07-30",
      merchant: "Merchant",
      amountCents: 100n,
      kind: "spend" as const,
      category: "Food",
    };

    await expectDeviceError(
      request({ ...base, id: "label-source", card: "On-chain" }),
      "VALIDATION_FAILED",
    );
    await expectDeviceError(
      request({ ...base, id: "unknown-source", card: "visa" }),
      "VALIDATION_FAILED",
    );
    await expectDeviceError(
      request({ ...base, id: "wrong-route", card: "river_bitcoin_bill_pay" }),
      "VALIDATION_FAILED",
    );
    await expectDeviceError(
      request({
        ...base,
        id: "fiat-bitcoin-fields",
        card: "aven",
        amountSats: 50n,
        bitcoinAccountKey: "river",
      }),
      "VALIDATION_FAILED",
    );
    for (const source of [
      "coinbase_card",
      "aven",
      "sofi_card",
      "capital_one_vx",
    ]) {
      await expectDeviceError(
        request({
          ...base,
          id: `fiat-income-${source}`,
          merchant: "Invalid card income",
          kind: "credit",
          category: "Income",
          card: source,
        }),
        "VALIDATION_FAILED",
        `fiat-income-${source}`,
      );
    }
    await expect(
      request({ ...base, id: "fiat-spend", card: "coinbase_card" }),
    ).resolves.toMatchObject({ outcome: "inserted" });
    await expect(
      request({
        ...base,
        id: "fiat-refund",
        merchant: "Card refund",
        amountCents: -100n,
        kind: "credit",
        card: "aven",
      }),
    ).resolves.toMatchObject({ outcome: "inserted" });
    await expect(
      request({
        ...base,
        id: "income-no-source",
        merchant: "Payroll",
        kind: "credit",
        category: "Income",
      }),
    ).resolves.toMatchObject({ outcome: "inserted" });
    for (const source of ["river", "zeus_lightning", "zeus_on_chain", "strike"]) {
      await expect(
        request({
          ...base,
          id: `valid-${source}`,
          card: source,
          amountSats: 50n,
          bitcoinAccountKey: "river",
        }),
      ).resolves.toMatchObject({ outcome: "inserted" });
    }
    for (const source of ["river", "zeus_lightning", "zeus_on_chain", "strike"]) {
      await expect(
        request({
          ...base,
          id: `income-${source}`,
          merchant: "Bitcoin income",
          kind: "credit",
          category: "Income",
          card: source,
          amountSats: 60n,
          bitcoinAccountKey: "river",
        }),
      ).resolves.toMatchObject({ outcome: "inserted" });
    }
    await expectDeviceError(
      request({
        ...base,
        id: "income-missing-account",
        merchant: "Bitcoin income",
        kind: "credit",
        category: "Income",
        card: "strike",
        amountSats: 60n,
      }),
      "VALIDATION_FAILED",
    );
    await expectDeviceError(
      request({
        ...base,
        id: "spend-as-credit",
        merchant: "Refund",
        amountCents: -100n,
        kind: "credit",
        card: "zeus_lightning",
        amountSats: 60n,
        bitcoinAccountKey: "river",
      }),
      "VALIDATION_FAILED",
    );
    for (const source of ["lightning", "on_chain"]) {
      await expectDeviceError(
        request({
          ...base,
          id: `retired-${source}`,
          card: source,
          amountSats: 50n,
          bitcoinAccountKey: "river",
        }),
        "VALIDATION_FAILED",
      );
    }

    await t.run(async (ctx) => {
      await ctx.db.insert("transactions", {
        txId: "legacy-card",
        owner: "victor",
        date: "2026-07-30",
        month: "2026-07",
        merchant: "Legacy merchant",
        amountCents: 100n,
        category: "Food",
        card: "Legacy Card",
        sourceFile: "transactions",
        updatedAtMs: 1,
      });
    });
    await expect(
      request(
        { ...base, id: "legacy-card", card: "Legacy Card", note: "metadata edit" },
        1,
      ),
    ).resolves.toMatchObject({ outcome: "updated" });
    const legacyRevision = await transactionRevision("legacy-card");
    await expectDeviceError(
      request(
        { ...base, id: "legacy-card", card: "different legacy value" },
        legacyRevision,
      ),
      "VALIDATION_FAILED",
    );
    await expectDeviceError(
      request({ ...base, id: "legacy-card" }, legacyRevision),
      "VALIDATION_FAILED",
    );

    for (const source of ["lightning", "on_chain"]) {
      const id = `legacy-${source}`;
      await t.run(async (ctx) => {
        await ctx.db.insert("transactions", {
          txId: id,
          owner: "victor",
          date: "2026-07-30",
          month: "2026-07",
          merchant: "Legacy Bitcoin merchant",
          amountCents: 100n,
          category: "Food",
          card: source,
          amountSats: 50n,
          bitcoinAccountKey: "river",
          balancePostingVersion: 1n,
          sourceFile: "transactions",
          updatedAtMs: 1,
        });
      });
      await expect(
        request(
          {
            ...base,
            id,
            card: source,
            amountSats: 50n,
            bitcoinAccountKey: "river",
            note: "metadata edit",
          },
          1,
        ),
      ).resolves.toMatchObject({ outcome: "updated" });
      await expectDeviceError(
        request(
          {
            ...base,
            id,
            merchant: "Legacy Bitcoin income",
            kind: "credit",
            category: "Income",
            card: source,
            amountSats: 50n,
            bitcoinAccountKey: "river",
          },
          await transactionRevision(id),
        ),
        "VALIDATION_FAILED",
      );
    }

    const state = await t.run(async (ctx) => ({
      rows: await ctx.db.query("transactions").collect(),
      balance: await ctx.db
        .query("btcBalanceDocuments")
        .withIndex("by_source_file", (q) =>
          q.eq("sourceFile", "btc-balance-snapshot"),
        )
        .unique(),
    }));
    expect(state.rows.map((row) => row.txId).sort()).toEqual([
      "fiat-refund",
      "fiat-spend",
      "income-no-source",
      "income-river",
      "income-strike",
      "income-zeus_lightning",
      "income-zeus_on_chain",
      "legacy-card",
      "legacy-lightning",
      "legacy-on_chain",
      "valid-river",
      "valid-strike",
      "valid-zeus_lightning",
      "valid-zeus_on_chain",
    ]);
    expect(state.balance!.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "river", sats: 1_000_040n }),
      ]),
    );
  });

  it("requires transaction and Bitcoin authority for linked income buys", async () => {
    await seedBtcLedger("victor");
    const bitcoinOnly = await pairMobileDevice(t, syncToken, "linked-buy-bitcoin-only", [
      "bitcoin:write",
    ]);
    const transactionOnly = await pairMobileDevice(
      t,
      syncToken,
      "linked-buy-transaction-only",
      ["transactions:write"],
    );
    const full = await fullDevice("linked-buy-full");
    const pair = {
      owner: "rachel" as const,
      sourceFile: "bitcoin-buys" as const,
      buy: {
        id: "device-linked-income",
        owner: "rachel" as const,
        date: "2026-07-30",
        source: "river",
        sats: 100n,
        priceUsdCents: 2_500_000n,
        usdCents: 25n,
      },
      linkedIncome: {
        id: "device-linked-income",
        owner: "rachel" as const,
        date: "2026-07-30",
        amountCents: 25n,
        source: "Payroll",
        sourceFile: "income" as const,
      },
    };

    await expect(
      t.mutation(api.upsertBtcBuy, { ...authArgs(bitcoinOnly), ...pair }),
    ).rejects.toThrow(/Unauthorized mobile device/);
    await expect(
      t.mutation(api.upsertBtcBuy, { ...authArgs(transactionOnly), ...pair }),
    ).rejects.toThrow(/Unauthorized mobile device/);
    await expect(
      t.mutation(api.upsertBtcBuy, { ...authArgs(full), ...pair }),
    ).resolves.toMatchObject({ outcome: "inserted" });
    await expect(
      t.mutation(api.upsertBtcBuy, { ...authArgs(full), ...pair }),
    ).resolves.toMatchObject({ outcome: "updated" });

    const rows = await t.run(async (ctx) => ({
      income: await ctx.db.query("income").collect(),
      buys: await ctx.db.query("btcBuys").collect(),
      balance: await ctx.db
        .query("btcBalanceDocuments")
        .withIndex("by_source_file", (q) => q.eq("sourceFile", "btc-balance-snapshot"))
        .unique(),
    }));
    expect(rows.income).toHaveLength(1);
    expect(rows.income[0]).toMatchObject({ owner: "victor", sourceKey: "id:device-linked-income" });
    expect(rows.buys).toHaveLength(1);
    expect(rows.buys[0]).toMatchObject({ owner: "victor", buyId: "device-linked-income" });
    expect(rows.balance?.totals.sats).toBe(1_000_100n);
    await expect(
      t.mutation(api.deleteBtcBuy, {
        ...authArgs(full),
        owner: "rachel",
        sourceFile: "bitcoin-buys",
        entityId: "device-linked-income",
        baseUpdatedAtMs: rows.buys[0]!.updatedAtMs,
      }),
    ).rejects.toThrow(/cannot be deleted until paired correction and deletion/);
  });

  it("rejects owner/source and request/payload owner mismatches", async () => {
    const device = await fullDevice("mismatch-device", "mason");
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
        activeProfile: "mason",
        owner: "mason",
        sourceFile: "todos",
        operation: "create",
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
          activeProfile: "victor",
          owner: "victor",
          sourceFile: "todos",
          operation: "create",
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
          activeProfile: "victor",
          owner: "victor",
          sourceFile: "todos",
          operation: "create",
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
          activeProfile: "victor",
          owner: "victor",
          sourceFile: "todos",
          operation: "create",
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
            budgetEffect: "budget_category",
            platform: "river_bitcoin_bill_pay",
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
  it("accepts nanosecond todo timestamps on add and update", async () => {
    const device = await fullDevice("todo-timestamp-device");
    const request = {
      ...authArgs(device),
      activeProfile: "victor" as const,
      owner: "victor" as const,
      sourceFile: "todos" as const,
      operation: "create" as const,
      todo: {
        id: "todo-high-precision",
        owner: "victor" as const,
        title: "High precision",
        done: false,
        flagged: false,
        createdAt: "2026-08-01T12:03:02.123456789Z",
        updatedAt: "2026-08-01T12:03:02.123456789Z",
      },
    };

    await expect(t.mutation(api.upsertTodo, request)).resolves.toMatchObject({
      outcome: "inserted",
    });
    const revision = await todoRevision(request.todo.id);
    const updatedAt = "2026-08-01T12:04:03.987654321Z";
    await expect(
      t.mutation(api.upsertTodo, {
        ...request,
        operation: "update",
        baseUpdatedAtMs: revision,
        todo: { ...request.todo, done: true, updatedAt },
      }),
    ).resolves.toMatchObject({ outcome: "updated" });

    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("todos")
        .withIndex("by_todo_id", (q) => q.eq("todoId", request.todo.id))
        .unique(),
    );
    expect(stored).toMatchObject({
      createdAt: request.todo.createdAt,
      updatedAt,
      done: true,
    });
  });

  it.each([
    ["malformed", "2026-08-01 12:03:02.123Z"],
    ["oversized", "2026-08-01T12:03:02.1234567890Z"],
    ["unparseable", "2026-13-01T12:03:02.123Z"],
  ])("rejects %s todo timestamps", async (_case, updatedAt) => {
    const device = await fullDevice(`todo-${_case}-timestamp-device`);

    await expectDeviceError(
      t.mutation(api.upsertTodo, {
        ...authArgs(device),
        activeProfile: "victor",
        owner: "victor",
        sourceFile: "todos",
        operation: "create",
        todo: {
          id: `todo-${_case}-timestamp`,
          owner: "victor",
          title: "Invalid timestamp",
          done: false,
          flagged: false,
          createdAt: updatedAt,
          updatedAt,
        },
      }),
      "VALIDATION_FAILED",
    );
  });

  it("atomically marks every runtime-owned source at its first successful write", async () => {
    await seedBudgets();
    await seedBtcLedger("victor");
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
      activeProfile: "victor",
      owner: "victor",
      sourceFile: "todos",
      operation: "create",
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
      month: CURRENT_MONTH,
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
        budgetEffect: "budget_category",
        platform: "river_bitcoin_bill_pay",
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
      baseUpdatedAtMs: await btcDocumentRevision("btc-balance-snapshot"),
      account: {
        key: "lock-account",
        owner: "victor",
        label: "Account",
        custody: "exchange",
        sats: 0n,
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
    const device = await fullDevice("cross-owner-todo-device", "mason");
    const upsert = {
      ...authArgs(device),
      activeProfile: "mason" as const,
      owner: "mason",
      sourceFile: "todos",
      operation: "create" as const,
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
        activeProfile: "victor",
        owner: "victor",
        todo: { ...upsert.todo, owner: "victor" },
      }),
    ).rejects.toThrow(/must match credential profile mason/);
    await t.mutation(api.deleteTodo, {
      ...authArgs(device),
      activeProfile: "mason",
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

  it("restores only the matching device-deleted todo revision", async () => {
    const device = await fullDevice("todo-restore-device", "mason");
    const todo = {
      id: "todo-restore",
      owner: "mason" as const,
      title: "Homework",
      done: false,
      flagged: true,
      lane: "personal",
      project: "School",
      area: "Home",
      due: "2026-08-01",
      notes: "Bring the worksheet",
      priority: 2n,
      createdAt: "2026-07-30T12:00:00.000Z",
      updatedAt: "2026-07-30T12:01:00.000Z",
    };
    const request = {
      ...authArgs(device),
      activeProfile: "mason" as const,
      owner: "mason" as const,
      sourceFile: "todos" as const,
      operation: "create" as const,
      todo,
    };
    await t.mutation(api.upsertTodo, request);
    const baseUpdatedAtMs = await todoRevision(todo.id);
    await t.mutation(api.deleteTodo, {
      ...authArgs(device),
      activeProfile: "mason",
      owner: "mason",
      sourceFile: "todos",
      entityId: todo.id,
      baseUpdatedAtMs,
    });

    // Normal upsert remains fenced; only the restore endpoint may consume the
    // exact tombstone created by the accepted delete.
    await expectDeviceError(
      t.mutation(api.upsertTodo, request),
      "ENTITY_DELETED",
      todo.id,
    );
    const restored = await t.mutation(api.restoreTodo, {
      ...authArgs(device),
      activeProfile: "mason",
      owner: "mason",
      sourceFile: "todos",
      entityId: todo.id,
      baseUpdatedAtMs,
    });
    expect(restored).toMatchObject({
      ok: true,
      entityId: todo.id,
    });
    expect(restored.updatedAtMs).toBeGreaterThan(baseUpdatedAtMs);

    const state = await t.run(async (ctx) => ({
      row: await ctx.db
        .query("todos")
        .withIndex("by_todo_id", (q) => q.eq("todoId", todo.id))
        .unique(),
      rowTombstones: await ctx.db.query("rowTombstones").collect(),
      legacyTombstones: await ctx.db.query("todoTombstones").collect(),
    }));
    expect(state.row).toMatchObject({
      todoId: todo.id,
      owner: todo.owner,
      title: todo.title,
      done: todo.done,
      flagged: todo.flagged,
      lane: todo.lane,
      project: todo.project,
      area: todo.area,
      due: todo.due,
      notes: todo.notes,
      priority: todo.priority,
      createdAt: todo.createdAt,
      updatedAt: todo.updatedAt,
      updatedAtMs: restored.updatedAtMs,
      sourceFile: "todos",
    });
    expect(state.rowTombstones).toEqual([]);
    expect(state.legacyTombstones.map((row) => row.id)).toEqual([todo.id]);
  });

  it("restores the exact migrated server row and keeps its stale blob suppressed", async () => {
    const device = await fullDevice("todo-provenance-restore-device", "mason");
    const todoId = "todo-migrated-restore";
    const migrationRaw = {
      id: todoId,
      text: "Stale legacy title",
      completed: false,
      owner: "mason",
      archimedes_request_id: "hidden-field",
      extension: { retained: true },
    };
    const original = {
      todoId,
      owner: "mason" as const,
      title: "Authoritative row title",
      done: false,
      flagged: true,
      lane: "personal",
      project: "School",
      area: "Home",
      due: "2026-08-03",
      notes: "Typed row is newer than the blob",
      priority: 3n,
      createdAt: "2026-07-20T12:00:00.000Z",
      updatedAt: "2026-07-30T12:01:00.000Z",
      updatedAtMs: 1_750_000_000_000,
      sourceFile: "todos",
      migrationRaw,
      migrationSourceIndex: 17,
    };
    await t.run(async (ctx) => {
      await ctx.db.insert("todos", original);
      await ctx.db.insert("dataFiles", {
        name: "todos",
        data: [{ id: todoId, title: "Stale legacy title", owner: "mason" }],
        version: 1,
        updatedAt: 1,
      });
    });

    await t.mutation(api.deleteTodo, {
      ...authArgs(device),
      activeProfile: "mason",
      owner: "mason",
      sourceFile: "todos",
      entityId: todoId,
      baseUpdatedAtMs: original.updatedAtMs,
    });

    const deleted = await t.run(async (ctx) => ({
      row: await ctx.db
        .query("todos")
        .withIndex("by_todo_id", (q) => q.eq("todoId", todoId))
        .unique(),
      tombstone: await ctx.db
        .query("rowTombstones")
        .withIndex("by_entity", (q) =>
          q.eq("entityType", "todo").eq("sourceFile", "todos").eq("entityId", todoId),
        )
        .unique(),
      legacy: await ctx.db
        .query("todoTombstones")
        .withIndex("by_todo_id", (q) => q.eq("id", todoId))
        .unique(),
    }));
    expect(deleted.row).toBeNull();
    expect(deleted.tombstone).toMatchObject({
      owner: original.owner,
      deletedFromUpdatedAtMs: original.updatedAtMs,
      todoRestoreCapsule: original,
    });
    expect(deleted.legacy).toMatchObject({ id: todoId });

    // Restore accepts no client row or replacement capsule. Identity/owner and
    // the accepted revision select the server-owned capsule.
    const restored = await t.mutation(api.restoreTodo, {
      ...authArgs(device),
      activeProfile: "mason",
      owner: "mason",
      sourceFile: "todos",
      entityId: todoId,
      baseUpdatedAtMs: original.updatedAtMs,
    });

    const restoredState = await t.run(async (ctx) => ({
      row: await ctx.db
        .query("todos")
        .withIndex("by_todo_id", (q) => q.eq("todoId", todoId))
        .unique(),
      rowTombstone: await ctx.db
        .query("rowTombstones")
        .withIndex("by_entity", (q) =>
          q.eq("entityType", "todo").eq("sourceFile", "todos").eq("entityId", todoId),
        )
        .unique(),
      legacy: await ctx.db
        .query("todoTombstones")
        .withIndex("by_todo_id", (q) => q.eq("id", todoId))
        .unique(),
      blob: await ctx.db
        .query("dataFiles")
        .withIndex("by_name", (q) => q.eq("name", "todos"))
        .unique(),
    }));
    expect(restoredState.row).toMatchObject({
      ...original,
      updatedAtMs: restored.updatedAtMs,
    });
    expect(restoredState.row!.migrationRaw).toEqual(migrationRaw);
    expect(restoredState.rowTombstone).toBeNull();
    expect(restoredState.legacy).toMatchObject({ id: todoId });
    expect(restoredState.blob!.data).toEqual([
      { id: todoId, title: "Stale legacy title", owner: "mason" },
    ]);

    // Later row-native edits must not clear the compatibility marker and expose
    // the unchanged stale blob.
    await t.mutation(api.upsertTodo, {
      ...authArgs(device),
      activeProfile: "mason",
      owner: "mason",
      sourceFile: "todos",
      operation: "update",
      baseUpdatedAtMs: restored.updatedAtMs,
      todo: {
        id: todoId,
        owner: "mason",
        title: "Edited after restore",
        done: false,
        flagged: true,
      },
    });
    const legacyAfterEdit = await t.run(async (ctx) =>
      ctx.db
        .query("todoTombstones")
        .withIndex("by_todo_id", (q) => q.eq("id", todoId))
        .unique(),
    );
    expect(legacyAfterEdit).toMatchObject({ id: todoId });
  });

  it("rejects unauthorized, wrong-owner, stale, and non-deleted restores", async () => {
    const device = await fullDevice("todo-restore-conflict-device", "mason");
    const unauthorized = await pairMobileDevice(
      t,
      syncToken,
      "transaction-only-restore-device",
      ["transactions:write"],
    );
    const todo = {
      id: "todo-restore-conflict",
      owner: "mason" as const,
      title: "Original",
      done: false,
      flagged: false,
    };
    const request = {
      ...authArgs(device),
      activeProfile: "mason" as const,
      owner: "mason" as const,
      sourceFile: "todos" as const,
      operation: "create" as const,
      todo,
    };
    const restoreRequest = {
      ...authArgs(device),
      activeProfile: "mason" as const,
      owner: "mason" as const,
      sourceFile: "todos" as const,
      entityId: todo.id,
    };
    await t.mutation(api.upsertTodo, request);
    const firstRevision = await todoRevision(todo.id);
    await t.mutation(api.deleteTodo, {
      ...authArgs(device),
      activeProfile: "mason",
      owner: "mason",
      sourceFile: "todos",
      entityId: todo.id,
      baseUpdatedAtMs: firstRevision,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", device.deviceId))
        .unique();
      await ctx.db.patch(row!._id, { lastSeenAt: 0 });
    });

    await expectDeviceError(
      t.mutation(api.restoreTodo, {
        ...restoreRequest,
        ...authArgs(unauthorized),
        baseUpdatedAtMs: firstRevision,
      }),
      "DEVICE_UNAUTHORIZED",
    );
    await expectDeviceError(
      t.mutation(api.restoreTodo, {
        ...restoreRequest,
        activeProfile: "victor",
        owner: "victor",
        baseUpdatedAtMs: firstRevision,
      }),
      "OWNER_MISMATCH",
      todo.id,
    );
    await expectDeviceError(
      t.mutation(api.restoreTodo, {
        ...restoreRequest,
        baseUpdatedAtMs: firstRevision + 1,
      }),
      "ENTITY_CONFLICT",
      todo.id,
    );
    await expectDeviceError(
      t.mutation(api.restoreTodo, {
        ...restoreRequest,
        entityId: "never-deleted",
        baseUpdatedAtMs: firstRevision,
      }),
      "ENTITY_NOT_FOUND",
      "never-deleted",
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("rowTombstones", {
        entityType: "todo",
        sourceFile: "todos",
        entityId: "deleted-without-capsule",
        owner: "mason",
        deletedAtMs: firstRevision + 1,
        deletedFromUpdatedAtMs: firstRevision,
      });
    });
    await expectDeviceError(
      t.mutation(api.restoreTodo, {
        ...restoreRequest,
        entityId: "deleted-without-capsule",
        baseUpdatedAtMs: firstRevision,
      }),
      "ENTITY_CONFLICT",
      "deleted-without-capsule",
    );

    const firstRestore = await t.mutation(api.restoreTodo, {
      ...restoreRequest,
      baseUpdatedAtMs: firstRevision,
    });
    await expectDeviceError(
      t.mutation(api.restoreTodo, {
        ...restoreRequest,
        baseUpdatedAtMs: firstRevision,
      }),
      "ENTITY_CONFLICT",
      todo.id,
    );

    await t.mutation(api.upsertTodo, {
      ...request,
      operation: "update",
      baseUpdatedAtMs: firstRestore.updatedAtMs,
      todo: { ...todo, title: "Newer" },
    });
    const newerRevision = await todoRevision(todo.id);
    await t.mutation(api.deleteTodo, {
      ...authArgs(device),
      activeProfile: "mason",
      owner: "mason",
      sourceFile: "todos",
      entityId: todo.id,
      baseUpdatedAtMs: newerRevision,
    });
    await expectDeviceError(
      t.mutation(api.restoreTodo, {
        ...restoreRequest,
        baseUpdatedAtMs: firstRevision,
      }),
      "ENTITY_CONFLICT",
      todo.id,
    );

    const state = await t.run(async (ctx) => ({
      row: await ctx.db
        .query("todos")
        .withIndex("by_todo_id", (q) => q.eq("todoId", todo.id))
        .unique(),
      tombstone: await ctx.db
        .query("rowTombstones")
        .withIndex("by_entity", (q) =>
          q
            .eq("entityType", "todo")
            .eq("sourceFile", "todos")
            .eq("entityId", todo.id),
        )
        .unique(),
      device: await ctx.db
        .query("mobileDevices")
        .withIndex("by_device_id", (q) => q.eq("deviceId", device.deviceId))
        .unique(),
    }));
    expect(state.row).toBeNull();
    expect(state.tombstone!.owner).toBe("mason");
    expect(state.tombstone!.deletedFromUpdatedAtMs).toBe(newerRevision);
    expect(state.device!.lastSeenAt).toBeGreaterThan(0);
  });

  it("rejects stale todo writes without changing the row, tombstones, or lastSeen", async () => {
    const device = await fullDevice("stale-todo-device", "mason");
    const upsert = {
      ...authArgs(device),
      activeProfile: "mason" as const,
      owner: "mason",
      sourceFile: "todos",
      operation: "create" as const,
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
      operation: "update",
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
        operation: "update",
        baseUpdatedAtMs: revision,
        todo: { ...upsert.todo, title: "Stale" },
      }),
      "ENTITY_CONFLICT",
      "todo-occ",
    );
    await expectDeviceError(
      t.mutation(api.deleteTodo, {
        ...authArgs(device),
        activeProfile: "mason",
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
      month: CURRENT_MONTH,
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
      month: CURRENT_MONTH,
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
        month: "1900-01",
        entityId: "Groceries",
        baseUpdatedAtMs: renamedRevision,
      }),
    ).rejects.toThrow(/limited to the current month/);
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

  it("supports Mason, rejects folded collisions, and requires a positive revision", async () => {
    await seedBudgets();
    // Mason's budget is mason-surface: the credential must carry mason's
    // profile, because the resolved owner derives from the credential (H1).
    const device = await fullDevice("mason-budget-delete-device", "mason");
    await t.run(async (ctx) => {
      const mason = await ctx.db
        .query("budgetDocuments")
        .withIndex("by_source_file", (q) => q.eq("sourceFile", "mason-budget"))
        .unique();
      await ctx.db.patch(mason!._id, {
        categories: [{ name: "School", budgetCents: 1_000n }],
      });
      const adult = await ctx.db
        .query("budgetDocuments")
        .withIndex("by_source_file", (q) => q.eq("sourceFile", "budget"))
        .unique();
      await ctx.db.patch(adult!._id, {
        categories: [
          { name: "Food", budgetCents: 1_000n },
          { name: "food", budgetCents: 2_000n },
        ],
      });
    });

    await expect(
      t.mutation(api.deleteBudgetCategory, {
        ...authArgs(device),
        owner: "mason",
        sourceFile: "mason-budget",
        month: CURRENT_MONTH,
        entityId: "school",
        baseUpdatedAtMs: await budgetRevision("mason-budget"),
      }),
    ).resolves.toMatchObject({ removed: true });

    // The folded-collision guard is exercised on the adult surface, which
    // needs its own credential-bound owner.
    const adultDevice = await fullDevice("adult-budget-delete-device");
    await expectDeviceError(
      t.mutation(api.deleteBudgetCategory, {
        ...authArgs(adultDevice),
        owner: "victor",
        sourceFile: "budget",
        month: CURRENT_MONTH,
        entityId: "food",
        baseUpdatedAtMs: await budgetRevision("budget"),
      }),
      "VALIDATION_FAILED",
      "food",
    );
    await expectDeviceError(
      t.mutation(api.deleteBudgetCategory, {
        ...authArgs(device),
        owner: "mason",
        sourceFile: "mason-budget",
        month: CURRENT_MONTH,
        entityId: "School",
        baseUpdatedAtMs: 0,
      }),
      "VALIDATION_FAILED",
    );
  });
});

describe("device bitcoin mutations", () => {
  it("stores missing buy fees as zero, preserves manual cents, and rejects negatives", async () => {
    await seedBtcLedger("victor");
    const device = await fullDevice("buy-fee-device");
    const buy = {
      owner: "victor",
      date: new Date().toISOString().slice(0, 10),
      source: "river",
      sats: 1_000n,
      priceUsdCents: 10_000_000n,
      usdCents: 100n,
    } as const;

    await t.mutation(api.upsertBtcBuy, {
      ...authArgs(device),
      owner: "victor",
      sourceFile: "bitcoin-buys",
      buy: { ...buy, id: "buy-fee-default" },
    });
    await t.mutation(api.upsertBtcBuy, {
      ...authArgs(device),
      owner: "victor",
      sourceFile: "bitcoin-buys",
      buy: { ...buy, id: "buy-fee-manual", feeUsdCents: 125n },
    });
    await expectDeviceError(
      t.mutation(api.upsertBtcBuy, {
        ...authArgs(device),
        owner: "victor",
        sourceFile: "bitcoin-buys",
        buy: { ...buy, id: "buy-fee-negative", feeUsdCents: -1n },
      }),
      "VALIDATION_FAILED",
    );

    const rows = await t.run(async (ctx) => ctx.db.query("btcBuys").collect());
    expect(
      Object.fromEntries(rows.map((row) => [row.buyId, row.feeUsdCents])),
    ).toEqual({ "buy-fee-default": 0n, "buy-fee-manual": 125n });
  });

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
          budgetEffect: "budget_category",
          platform: "river_bitcoin_bill_pay",
          amountUsdCents: 100n,
          btcSpentSats: 1n,
          btcPriceCents: 10_000_000n,
          feeUsdCents: 0n,
        },
      }),
      "OWNER_MISMATCH",
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
    await seedBtcLedger("victor");
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
      month: CURRENT_MONTH,
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
        budgetEffect: "budget_category",
        platform: "river_bitcoin_bill_pay",
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
      baseUpdatedAtMs: await btcDocumentRevision("btc-balance-snapshot"),
      account: {
        key: "rachel-shared",
        owner: "rachel",
        label: "Shared account",
        custody: "exchange",
        sats: 0n,
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
      billEffect: (await ctx.db.query("btcBillPays").unique())!.budgetEffect,
      accountDocument: (await ctx.db
        .query("btcBalanceDocuments")
        .withIndex("by_source_file", (q) =>
          q.eq("sourceFile", "btc-balance-snapshot"),
        )
        .unique())!.owner,
      accountMirror: (await ctx.db
        .query("btcAccounts")
        .withIndex("by_owner_key", (q) =>
          q.eq("owner", "victor").eq("key", "rachel-shared"),
        )
        .unique())!.owner,
    }));
    expect(owners).toEqual({
      transaction: "victor",
      budget: "victor",
      buy: "victor",
      bill: "victor",
      billEffect: "budget_category",
      accountDocument: "victor",
      accountMirror: "victor",
    });
  });

  it("upserts and deletes buys and bill pays with cross-owner protection", async () => {
    await seedBtcLedger("victor");
    await seedBtcLedger("mason");
    const device = await fullDevice();
    // Mason-owned surfaces need a mason-profile credential: the resolved owner
    // derives from the credential, not the request (H1).
    const masonDevice = await fullDevice("mason-buy-device", "mason");
    await expect(
      t.mutation(api.upsertBtcBuy, {
        ...authArgs(masonDevice),
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
        ...authArgs(masonDevice),
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
        ...authArgs(masonDevice),
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
        budgetEffect: "budget_category",
        platform: "river_bitcoin_bill_pay",
        amountUsdCents: 5_000n,
        btcSpentSats: 50_000n,
        btcPriceCents: 10_000_000n,
        feeUsdCents: 0n,
      },
    };
    await expectDeviceError(
      t.mutation(api.upsertBtcBillPay, {
        ...billPay,
        billPay: { ...billPay.billPay, platform: undefined },
      }),
      "VALIDATION_FAILED",
    );
    await expectDeviceError(
      t.mutation(api.upsertBtcBillPay, {
        ...billPay,
        billPay: { ...billPay.billPay, platform: "River Bitcoin Bill Pay" },
      }),
      "VALIDATION_FAILED",
    );
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
    // The credential profile gates the request owner before the owner↔source
    // mapping is ever consulted.
    await expect(
      t.mutation(api.upsertBtcBillPay, {
        ...billPay,
        owner: "mason",
        billPay: { ...billPay.billPay, owner: "mason" },
      }),
    ).rejects.toThrow(/must match credential profile victor/);
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
    // son-balances is mason-owned, so the credential must carry mason's profile.
    const device = await fullDevice("mason-balance-device", "mason");
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
    await t.mutation(api.upsertBtcAccount, {
      ...base,
      baseUpdatedAtMs: beforeDelete.document!.updatedAtMs,
      account: {
        key: "strike",
        owner: "mason",
        label: "Strike",
        custody: "exchange",
        sats: 0n,
        asOf: "2026-07-30T00:00:00.000Z",
      },
    });
    await expect(
      t.mutation(api.deleteBtcAccount, {
        ...base,
        entityId: "strike",
        baseUpdatedAtMs: await btcDocumentRevision("son-balances"),
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

  it("keeps activated account quantities ledger-controlled and protects referenced accounts", async () => {
    await seedBtcLedger("victor");
    const device = await fullDevice();
    const base = {
      ...authArgs(device),
      owner: "victor",
      sourceFile: "btc-balance-snapshot",
    };
    await expectDeviceError(
      t.mutation(api.upsertBtcAccount, {
        ...base,
        baseUpdatedAtMs: await btcDocumentRevision("btc-balance-snapshot"),
        account: {
          key: "river",
          owner: "victor",
          label: "River",
          custody: "exchange",
          sats: 999_999n,
          asOf: "2026-08-01T00:00:00.000Z",
        },
      }),
      "ENTITY_CONFLICT",
      "river",
    );
    await expectDeviceError(
      t.mutation(api.upsertBtcAccount, {
        ...base,
        baseUpdatedAtMs: await btcDocumentRevision("btc-balance-snapshot"),
        account: {
          key: "coldcard",
          owner: "victor",
          label: "Coldcard",
          custody: "self_custody",
          sats: 1n,
          asOf: "2026-08-01T00:00:00.000Z",
        },
      }),
      "ENTITY_CONFLICT",
      "coldcard",
    );
    await t.mutation(api.upsertBtcAccount, {
      ...base,
      baseUpdatedAtMs: await btcDocumentRevision("btc-balance-snapshot"),
      account: {
        key: "coldcard",
        owner: "victor",
        label: "Coldcard",
        custody: "self_custody",
        sats: 0n,
        asOf: "2026-08-01T00:00:00.000Z",
      },
    });
    await expect(
      t.mutation(api.upsertBtcAccount, {
        ...base,
        baseUpdatedAtMs: await btcDocumentRevision("btc-balance-snapshot"),
        account: {
          key: "decoy",
          owner: "victor",
          label: "River",
          custody: "exchange",
          sats: 0n,
          asOf: "2026-08-01T00:00:00.000Z",
        },
      }),
    ).rejects.toThrow(/missing or ambiguous/);
    await expect(
      t.mutation(api.upsertBtcAccount, {
        ...base,
        baseUpdatedAtMs: await btcDocumentRevision("btc-balance-snapshot"),
        account: {
          key: "coldcard",
          owner: "victor",
          label: "River",
          custody: "self_custody",
          sats: 0n,
          asOf: "2026-08-01T00:00:00.000Z",
        },
      }),
    ).rejects.toThrow(/missing or ambiguous/);
    await expectDeviceError(
      t.mutation(api.deleteBtcAccount, {
        ...base,
        entityId: "river",
        baseUpdatedAtMs: await btcDocumentRevision("btc-balance-snapshot"),
      }),
      "ENTITY_CONFLICT",
      "river",
    );
    await t.mutation(api.upsertBtcTransfer, {
      ...authArgs(device),
      owner: "victor",
      sourceFile: "btc-transfers",
      transfer: {
        id: "to-coldcard",
        owner: "victor",
        date: "2026-08-01",
        fromAccountKey: "river",
        toAccountKey: "coldcard",
        sats: 1_000n,
        feeSats: 0n,
      },
    });
    await t.mutation(api.upsertBtcTransfer, {
      ...authArgs(device),
      owner: "victor",
      sourceFile: "btc-transfers",
      transfer: {
        id: "from-coldcard",
        owner: "victor",
        date: "2026-08-01",
        fromAccountKey: "coldcard",
        toAccountKey: "river",
        sats: 1_000n,
        feeSats: 0n,
      },
    });
    await expectDeviceError(
      t.mutation(api.deleteBtcAccount, {
        ...base,
        entityId: "coldcard",
        baseUpdatedAtMs: await btcDocumentRevision("btc-balance-snapshot"),
      }),
      "ENTITY_CONFLICT",
      "coldcard",
    );
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

// ─────────────────────────────────────────────────────────────────────────────
// H1 regression: every money-surface device mutation derives its owner from the
// credential's server-stored profile. A paired child credential must not be
// able to write or delete any other family member's ledger, no matter what
// `owner` the request names.
// ─────────────────────────────────────────────────────────────────────────────
describe("money writes bind to the credential profile", () => {
  it("blocks a child credential from every adult money surface", async () => {
    const mason = await fullDevice("h1-mason-device", "mason");

    const upserts = [
      {
        name: "upsertTransaction",
        call: () =>
          t.mutation(api.upsertTransaction, {
            ...authArgs(mason),
            owner: "victor",
            sourceFile: "transactions",
            transaction: {
              id: "h1-tx",
              owner: "victor",
              date: "2026-07-30",
              merchant: "Must not land",
              amountCents: 1_500n,
              kind: "spend",
              category: "Groceries",
              card: "river",
              amountSats: 1_000n,
              bitcoinAccountKey: "river",
            },
          }),
      },
      {
        name: "upsertBudgetCategory",
        call: () =>
          t.mutation(api.upsertBudgetCategory, {
            ...authArgs(mason),
            owner: "victor",
            sourceFile: "budget",
            month: CURRENT_MONTH,
            category: { name: "Food", budgetCents: 1n },
          }),
      },
      {
        name: "upsertBtcBuy",
        call: () =>
          t.mutation(api.upsertBtcBuy, {
            ...authArgs(mason),
            owner: "victor",
            sourceFile: "bitcoin-buys",
            buy: {
              id: "h1-buy",
              owner: "victor",
              date: "2026-07-30",
              source: "river",
              sats: 100n,
              priceUsdCents: 10_000_000n,
              usdCents: 1_000n,
            },
          }),
      },
      {
        name: "upsertBtcBillPay",
        call: () =>
          t.mutation(api.upsertBtcBillPay, {
            ...authArgs(mason),
            owner: "victor",
            sourceFile: "bitcoin-bill-pays",
            billPay: {
              id: "h1-bill",
              owner: "victor",
              date: "2026-07-30",
              merchant: "Must not land",
              category: "Bills",
              budgetEffect: "budget_category",
              platform: "river_bitcoin_bill_pay",
              amountUsdCents: 100n,
              btcSpentSats: 1n,
              btcPriceCents: 10_000_000n,
              feeUsdCents: 0n,
            },
          }),
      },
      {
        name: "upsertBtcTransfer",
        call: () =>
          t.mutation(api.upsertBtcTransfer, {
            ...authArgs(mason),
            owner: "victor",
            sourceFile: "btc-transfers",
            transfer: {
              id: "h1-transfer",
              owner: "victor",
              date: "2026-07-30",
              fromAccountKey: "river",
              toAccountKey: "coldcard",
              sats: 1n,
              feeSats: 0n,
            },
          }),
      },
      {
        name: "upsertBtcAccount",
        call: () =>
          t.mutation(api.upsertBtcAccount, {
            ...authArgs(mason),
            owner: "victor",
            sourceFile: "btc-balance-snapshot",
            account: {
              key: "h1-account",
              owner: "victor",
              label: "Must not land",
              custody: "exchange",
              sats: 0n,
              asOf: "2026-07-30T00:00:00.000Z",
            },
          }),
      },
    ];

    for (const upsert of upserts) {
      await expectDeviceError(upsert.call(), "OWNER_MISMATCH");
    }

    const deletes = [
      {
        name: "deleteTransaction",
        call: () =>
          t.mutation(api.deleteTransaction, {
            ...authArgs(mason),
            owner: "victor",
            sourceFile: "transactions",
            entityId: "h1-tx",
            baseUpdatedAtMs: 1,
          }),
      },
      {
        name: "deleteBudgetCategory",
        call: () =>
          t.mutation(api.deleteBudgetCategory, {
            ...authArgs(mason),
            owner: "victor",
            sourceFile: "budget",
            month: CURRENT_MONTH,
            entityId: "Food",
            baseUpdatedAtMs: 1,
          }),
      },
      {
        name: "deleteBtcBuy",
        call: () =>
          t.mutation(api.deleteBtcBuy, {
            ...authArgs(mason),
            owner: "victor",
            sourceFile: "bitcoin-buys",
            entityId: "h1-buy",
            baseUpdatedAtMs: 1,
          }),
      },
      {
        name: "deleteBtcBillPay",
        call: () =>
          t.mutation(api.deleteBtcBillPay, {
            ...authArgs(mason),
            owner: "victor",
            sourceFile: "bitcoin-bill-pays",
            entityId: "h1-bill",
            baseUpdatedAtMs: 1,
          }),
      },
      {
        name: "deleteBtcTransfer",
        call: () =>
          t.mutation(api.deleteBtcTransfer, {
            ...authArgs(mason),
            owner: "victor",
            sourceFile: "btc-transfers",
            entityId: "h1-transfer",
            baseUpdatedAtMs: 1,
          }),
      },
      {
        name: "deleteBtcAccount",
        call: () =>
          t.mutation(api.deleteBtcAccount, {
            ...authArgs(mason),
            owner: "victor",
            sourceFile: "btc-balance-snapshot",
            entityId: "h1-account",
            baseUpdatedAtMs: 1,
          }),
      },
    ];

    for (const deletion of deletes) {
      await expectDeviceError(deletion.call(), "OWNER_MISMATCH");
    }

    const state = await t.run(async (ctx) => ({
      transactions: await ctx.db.query("transactions").collect(),
      buys: await ctx.db.query("btcBuys").collect(),
      billPays: await ctx.db.query("btcBillPays").collect(),
      transfers: await ctx.db.query("btcTransfers").collect(),
      tombstones: await ctx.db.query("rowTombstones").collect(),
      budget: await ctx.db
        .query("budgetDocuments")
        .withIndex("by_source_file", (q) => q.eq("sourceFile", "budget"))
        .unique(),
    }));
    expect(state.transactions).toHaveLength(0);
    expect(state.buys).toHaveLength(0);
    expect(state.billPays).toHaveLength(0);
    expect(state.transfers).toHaveLength(0);
    expect(state.tombstones).toHaveLength(0);
    // Nothing was created either: without a credential-bound owner the adult
    // budget document is never touched, so it still does not exist.
    expect(state.budget).toBeNull();
  });

  it("lets Rachel's credential drive the shared adult ledger under either spelling", async () => {
    const rachel = await fullDevice("h1-rachel-device", "rachel");
    const today = new Date().toISOString().slice(0, 10);

    for (const owner of ["victor", "rachel"] as const) {
      await t.mutation(api.upsertTransaction, {
        ...authArgs(rachel),
        owner,
        sourceFile: "transactions",
        transaction: {
          id: `h1-rachel-${owner}`,
          owner,
          date: today,
          merchant: "Household spend",
          amountCents: 2_500n,
          kind: "spend",
          category: "Groceries",
        },
      });
    }

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("transactions")
        .filter((q) => q.eq(q.field("owner"), "victor"))
        .collect(),
    );
    expect(rows.map((row) => row.txId).sort()).toEqual([
      "h1-rachel-rachel",
      "h1-rachel-victor",
    ]);
  });

  it("refuses money writes for a credential that predates profiles", async () => {
    const deviceToken = freshSecret();
    await t.run(async (ctx) => {
      await ctx.db.insert("mobileDevices", {
        deviceId: "h1-unprofiled-device",
        name: "Legacy credential",
        tokenHash: await (async () => {
          const data = new TextEncoder().encode(deviceToken);
          const digest = await crypto.subtle.digest("SHA-256", data);
          return Array.from(new Uint8Array(digest))
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
        })(),
        pairedAt: Date.now(),
        lastSeenAt: Date.now(),
        pairId: "h1-legacy-pair",
        capabilities: ["transactions:write"],
        profile: undefined,
      });
    });

    await expectDeviceError(
      t.mutation(api.upsertTransaction, {
        deviceId: "h1-unprofiled-device",
        deviceToken,
        owner: "mason",
        sourceFile: "mason-transactions",
        transaction: {
          id: "h1-legacy-tx",
          owner: "mason",
          date: "2026-07-30",
          merchant: "Must not land",
          amountCents: 100n,
          kind: "spend",
          category: "Other",
        },
      }),
      "PROFILE_BINDING_REQUIRED",
    );
  });
});

describe("money magnitude caps", () => {
  it("rejects a single line item beyond the $1M sanity limit on every money surface", async () => {
    await seedBudgets();
    const device = await fullDevice("cap-device");
    const today = new Date().toISOString().slice(0, 10);

    await expectDeviceError(
      t.mutation(api.upsertTransaction, {
        ...authArgs(device),
        owner: "victor",
        sourceFile: "transactions",
        transaction: {
          id: "cap-tx",
          owner: "victor",
          date: today,
          merchant: "Typo",
          amountCents: 100_000_001n,
          kind: "spend",
          category: "Other",
        },
      }),
      "VALIDATION_FAILED",
    );
    await expectDeviceError(
      t.mutation(api.upsertTransaction, {
        ...authArgs(device),
        owner: "victor",
        sourceFile: "transactions",
        transaction: {
          id: "cap-tx-sats",
          owner: "victor",
          date: today,
          merchant: "Typo",
          amountCents: 100n,
          kind: "spend",
          category: "Groceries",
          card: "river",
          amountSats: 1_000_000_001n,
          bitcoinAccountKey: "river",
        },
      }),
      "VALIDATION_FAILED",
    );
    await expectDeviceError(
      t.mutation(api.upsertBtcBuy, {
        ...authArgs(device),
        owner: "victor",
        sourceFile: "bitcoin-buys",
        buy: {
          id: "cap-buy",
          owner: "victor",
          date: today,
          source: "river",
          sats: 1_000_000_001n,
          priceUsdCents: 1n,
          usdCents: 1n,
        },
      }),
      "VALIDATION_FAILED",
    );
    await expectDeviceError(
      t.mutation(api.upsertBudgetCategory, {
        ...authArgs(device),
        owner: "victor",
        sourceFile: "budget",
        month: CURRENT_MONTH,
        category: { name: "Cap", budgetCents: 100_000_001n },
      }),
      "VALIDATION_FAILED",
    );
  });

  it("applies the same sign and magnitude rules to the admin budget upsert", async () => {
    await seedBudgets();
    const adminUpsertBudgetCategory =
      "tables:upsertBudgetCategory" as unknown as Parameters<
        typeof t.mutation
      >[0];
    for (const budgetCents of [-1n, 100_000_001n]) {
      await expect(
        t.mutation(adminUpsertBudgetCategory, {
          viewer: "victor",
          month: CURRENT_MONTH,
          category: { name: "Parity", budgetCents },
          token: syncToken,
        } as never),
      ).rejects.toThrow(/must not be negative|sanity limit/);
    }
    const budget = await t.run(async (ctx) =>
      ctx.db
        .query("budgetDocuments")
        .withIndex("by_source_file", (q) => q.eq("sourceFile", "budget"))
        .unique(),
    );
    expect(
      budget!.categories.find((category) => category.name === "Parity"),
    ).toBeUndefined();
  });
});
