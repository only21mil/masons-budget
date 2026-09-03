import { convexToJson } from "convex/values";
import type { FunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";

import type { FamilyMember } from "@vogel-vault/domain/family";
import { deriveMoneyOutToday } from "@vogel-vault/domain/moneyOutToday";
import type {
  BTCBillPay,
  Transaction,
} from "@vogel-vault/domain/readModel";

import {
  freshSecret,
  pairMobileDevice,
  setDeploymentEnv,
  testConvex,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";

useIsolatedDeploymentEnv();

type PublicEnvelope<Row> = { rows: Row[]; complete: boolean };

type PublicTransaction = {
  txId: string;
  owner: FamilyMember;
  date: string;
  month: string;
  merchant: string;
  amountCents: bigint;
  category: string;
  card?: string;
  note?: string;
  updatedAtMs: number;
};

type PublicTodo = {
  todoId: string;
  owner: FamilyMember;
  title: string;
};

type PublicBtcBuy = {
  buyId: string;
  owner: FamilyMember;
  date: string;
  feeUsdCents: bigint;
  updatedAtMs: number;
};

type PublicBtcBillPay = {
  billPayId: string;
  owner: FamilyMember;
  date: string;
  merchant: string;
  category: string;
  budgetEffect: "budget_category" | "credit_card_payment";
  amountUsdCents: bigint;
  btcSpentSats: bigint;
  btcPriceCents: bigint;
  platform?: string;
  note?: string;
  feeUsdCents: bigint;
  reference?: string;
  updatedAtMs: number;
};

type PublicBtcTransfer = { transferId: string };
type PublicBtcAccount = { key: string; sats: bigint };
type PublicBudget = {
  document: null | {
    owner: FamilyMember;
    month: string;
    categories: Array<{ name: string; budgetCents: bigint }>;
    updatedAtMs: number;
  };
  complete: boolean;
};

type UpsertResult = {
  ok: true;
  entityId: string;
  outcome: "inserted" | "updated";
};
type DeleteResult = { ok: true; entityId: string; removed: boolean };

const query = <Args extends Record<string, unknown>, Result>(path: string) =>
  path as unknown as FunctionReference<"query", "public", Args, Result>;
const mutation = <Args extends Record<string, unknown>, Result>(path: string) =>
  path as unknown as FunctionReference<"mutation", "public", Args, Result>;

const api = {
  listTransactions: query<
    { viewer: FamilyMember; month?: string; token?: string },
    PublicEnvelope<PublicTransaction>
  >("tables:listTransactions"),
  listTodos: query<
    { viewer: FamilyMember; token?: string },
    PublicEnvelope<PublicTodo>
  >("tables:listTodos"),
  listBtcBuys: query<
    {
      viewer: FamilyMember;
      scope: "visible" | "netWorth";
      month?: string;
      token?: string;
    },
    PublicEnvelope<PublicBtcBuy>
  >("tables:listBtcBuys"),
  listBtcBillPays: query<
    {
      viewer: FamilyMember;
      scope: "visible" | "netWorth";
      month?: string;
      token?: string;
    },
    PublicEnvelope<PublicBtcBillPay>
  >("tables:listBtcBillPays"),
  listBtcTransfers: query<
    {
      viewer: FamilyMember;
      scope: "visible" | "netWorth";
      month?: string;
      token?: string;
    },
    PublicEnvelope<PublicBtcTransfer>
  >("tables:listBtcTransfers"),
  listBtcAccounts: query<
    {
      viewer: FamilyMember;
      scope: "visible" | "netWorth";
      token?: string;
    },
    PublicEnvelope<PublicBtcAccount>
  >("tables:listBtcAccounts"),
  getBudgetDocument: query<
    { viewer: FamilyMember; scope: "netWorth"; token?: string },
    PublicBudget
  >("tables:getBudgetDocument"),
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
  upsertBtcTransfer: mutation<Record<string, unknown>, UpsertResult>(
    "tables:upsertBtcTransferFromDevice",
  ),
  deleteBtcTransfer: mutation<Record<string, unknown>, DeleteResult>(
    "tables:deleteBtcTransferFromDevice",
  ),
  upsertBtcAccount: mutation<Record<string, unknown>, UpsertResult>(
    "tables:upsertBtcAccountFromDevice",
  ),
  deleteBtcAccount: mutation<Record<string, unknown>, DeleteResult>(
    "tables:deleteBtcAccountFromDevice",
  ),
};

function authArgs(device: { deviceId: string; deviceToken: string }) {
  return { deviceId: device.deviceId, deviceToken: device.deviceToken };
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

function transactionForMoneyOut(row: PublicTransaction): Transaction {
  return {
    id: row.txId,
    updatedAtMs: row.updatedAtMs,
    date: row.date,
    merchant: row.merchant,
    amount: row.amountCents,
    category: row.category,
    card: row.card ?? null,
    note: row.note ?? null,
    owner: row.owner,
  };
}

function billPayForMoneyOut(row: PublicBtcBillPay): BTCBillPay {
  return {
    id: row.billPayId,
    updatedAtMs: row.updatedAtMs,
    date: row.date,
    merchant: row.merchant,
    category: row.category,
    budgetEffect: row.budgetEffect,
    amountUsd: row.amountUsdCents,
    btcSpentSats: row.btcSpentSats,
    btcPrice: row.btcPriceCents,
    platform: row.platform ?? null,
    note: row.note ?? null,
    feeUsd: row.feeUsdCents,
    reference: row.reference ?? null,
    owner: row.owner,
  };
}

describe("frozen redesign public read conformance", () => {
  it("provides exact-profile tasks and all fields needed for Money Out Today", async () => {
    const t = testConvex();
    const token = freshSecret();
    setDeploymentEnv({ CONVEX_READ_TOKEN: token });
    const date = "2026-08-25";
    const month = "2026-08";
    const transactions = [
      ["adult-spend", date, 2_500n, "Groceries", "victor"],
      ["adult-refund", date, -3_000n, "Groceries", "victor"],
      ["adult-income", date, 9_000n, "iNcOmE", "victor"],
      ["adult-card-transfer", date, 3_000n, "cReDiT CaRd PaYmEnT", "victor"],
      ["noncanonical-rachel", date, 700n, "Shopping", "rachel"],
      ["mason-spend", date, 600n, "Entertainment", "mason"],
      ["other-day", "2026-08-24", 10_000n, "Shopping", "victor"],
    ] as const;
    const billPays = [
      ["adult-bill", "rachel", 1_000n, 25n, "budget_category"],
      [
        "adult-credit-card-payment",
        "victor",
        5_000n,
        10n,
        "credit_card_payment",
      ],
      ["mason-bill", "mason", 200n, 5n, "budget_category"],
    ] as const;

    await t.run(async (ctx) => {
      for (const [txId, rowDate, amountCents, category, owner] of transactions) {
        await ctx.db.insert("transactions", {
          txId,
          owner,
          date: rowDate,
          month,
          merchant: txId,
          amountCents,
          category,
          sourceFile:
            owner === "mason" ? "mason-transactions" : "transactions",
          updatedAtMs: 1,
        });
      }
      for (const [billPayId, owner, amountUsdCents, feeUsdCents, budgetEffect] of billPays) {
        await ctx.db.insert("btcBillPays", {
          billPayId,
          owner,
          date,
          month,
          merchant: billPayId,
          category: "Bills",
          budgetEffect,
          amountUsdCents,
          btcSpentSats: 1n,
          btcPriceCents: 1n,
          platform: "river_bitcoin_bill_pay",
          feeUsdCents,
          sourceFile: "bitcoin-bill-pays",
          updatedAtMs: 1,
        });
      }
      for (const owner of ["victor", "rachel", "mason", "maddox"] as const) {
        await ctx.db.insert("todos", {
          todoId: `todo-${owner}`,
          owner,
          title: `${owner} private`,
          done: false,
          flagged: false,
          updatedAtMs: 1,
          sourceFile: "todos",
        });
      }
    });

    const expected = {
      victor: { owner: "victor", totalCents: 1_225n, ids: [
        "adult-spend",
        "adult-refund",
        "noncanonical-rachel",
        "adult-bill",
      ] },
      rachel: { owner: "victor", totalCents: 1_225n, ids: [
        "adult-spend",
        "adult-refund",
        "noncanonical-rachel",
        "adult-bill",
      ] },
      mason: { owner: "mason", totalCents: 805n, ids: [
        "mason-spend",
        "mason-bill",
      ] },
      maddox: { owner: "maddox", totalCents: 0n, ids: [] },
    } as const;

    for (const activeProfile of ["victor", "rachel", "mason", "maddox"] as const) {
      const transactionResponse = await t.query(api.listTransactions, {
        viewer: activeProfile,
        month,
        token,
      });
      const billPayResponse = await t.query(api.listBtcBillPays, {
        viewer: activeProfile,
        scope: "visible",
        month,
        token,
      });
      const result = deriveMoneyOutToday({
        activeProfile,
        date,
        transactions: transactionResponse.rows.map(transactionForMoneyOut),
        billPays: billPayResponse.rows.map(billPayForMoneyOut),
      });
      expect(result.owner).toBe(expected[activeProfile].owner);
      expect(result.totalCents).toBe(expected[activeProfile].totalCents);
      expect(result.sources.map((source) => source.row.id).sort()).toEqual(
        [...expected[activeProfile].ids].sort(),
      );

      const todos = await t.query(api.listTodos, {
        viewer: activeProfile,
        token,
      });
      expect(todos.rows.map((todo) => todo.todoId)).toEqual([
        `todo-${activeProfile}`,
      ]);
    }
  });

  it("projects optional fees as exact tagged int64 boundary values", async () => {
    const t = testConvex();
    const token = freshSecret();
    setDeploymentEnv({ CONVEX_READ_TOKEN: token });
    const maxInt64 = (1n << 63n) - 1n;
    await t.run(async (ctx) => {
      await ctx.db.insert("btcBuys", {
        buyId: "fee-missing",
        owner: "victor",
        date: "2026-08-25",
        month: "2026-08",
        source: "river",
        sats: 1n,
        priceUsdCents: 1n,
        usdCents: 1n,
        sourceFile: "bitcoin-buys",
        updatedAtMs: 1,
      });
      await ctx.db.insert("btcBuys", {
        buyId: "fee-max",
        owner: "victor",
        date: "2026-08-25",
        month: "2026-08",
        source: "river",
        sats: 1n,
        priceUsdCents: 1n,
        usdCents: 1n,
        feeUsdCents: maxInt64,
        sourceFile: "bitcoin-buys",
        updatedAtMs: 2,
      });
    });

    const response = await t.query(api.listBtcBuys, {
      viewer: "rachel",
      scope: "netWorth",
      month: "2026-08",
      token,
    });
    const fees = Object.fromEntries(
      response.rows.map((row) => [row.buyId, row.feeUsdCents]),
    );
    expect(fees).toEqual({ "fee-missing": 0n, "fee-max": maxInt64 });
    expect(convexToJson(fees["fee-missing"]!)).toEqual({
      $integer: "AAAAAAAAAAA=",
    });
    expect(convexToJson(fees["fee-max"]!)).toEqual({
      $integer: "/////////38=",
    });
  });
});

describe("frozen redesign device mutation conformance", () => {
  it("authorizes Rachel's current-month category delete with an exact revision", async () => {
    const t = testConvex();
    const syncToken = freshSecret();
    const readToken = freshSecret();
    setDeploymentEnv({
      CONVEX_SYNC_TOKEN: syncToken,
      CONVEX_READ_TOKEN: readToken,
    });
    const month = new Date().toISOString().slice(0, 7);
    await t.run(async (ctx) => {
      await ctx.db.insert("budgetDocuments", {
        sourceFile: "budget",
        owner: "victor",
        month,
        coinbaseOneBalanceCents: 0n,
        categories: [
          { name: "Groceries", budgetCents: 10_000n },
          { name: "Bills", budgetCents: 20_000n },
        ],
        mtdIncomeCents: 0n,
        ytdIncomeCents: 0n,
        monthlyHistory: [],
        updatedAtMs: 501,
      });
    });
    const unauthorized = await pairMobileDevice(
      t,
      syncToken,
      "todo-only-category-device",
      ["todos:write"],
    );
    const request = {
      owner: "rachel",
      sourceFile: "budget",
      month,
      entityId: "Groceries",
      baseUpdatedAtMs: 501,
    };
    await expectDeviceError(
      t.mutation(api.deleteBudgetCategory, {
        ...authArgs(unauthorized),
        ...request,
      }),
      "DEVICE_UNAUTHORIZED",
    );

    const device = await pairMobileDevice(
      t,
      syncToken,
      "budget-category-device",
      ["budget:write"],
    );
    await expectDeviceError(
      t.mutation(api.deleteBudgetCategory, {
        ...authArgs(device),
        ...request,
        baseUpdatedAtMs: 500,
      }),
      "ENTITY_CONFLICT",
      "Groceries",
    );
    await expectDeviceError(
      t.mutation(api.deleteBudgetCategory, {
        ...authArgs(device),
        ...request,
        month: "1900-01",
      }),
      "ENTITY_CONFLICT",
      "Groceries",
    );
    await expect(
      t.mutation(api.deleteBudgetCategory, {
        ...authArgs(device),
        ...request,
      }),
    ).resolves.toEqual({
      ok: true,
      entityId: "Groceries",
      removed: true,
    });
    await expect(
      t.mutation(api.deleteBudgetCategory, {
        ...authArgs(device),
        ...request,
      }),
    ).resolves.toEqual({
      ok: true,
      entityId: "Groceries",
      removed: false,
    });

    const budget = await t.query(api.getBudgetDocument, {
      viewer: "rachel",
      scope: "netWorth",
      token: readToken,
    });
    expect(budget.document).toMatchObject({
      owner: "victor",
      month,
      categories: [{ name: "Bills", budgetCents: 20_000n }],
    });
    const tombstone = await t.run(async (ctx) =>
      ctx.db
        .query("rowTombstones")
        .withIndex("by_entity", (q) =>
          q
            .eq("entityType", "budgetCategory")
            .eq("sourceFile", "budget")
            .eq("entityId", "groceries"),
        )
        .unique(),
    );
    expect(tombstone).toMatchObject({
      owner: "victor",
      deletedFromUpdatedAtMs: 501,
    });
  });

  it("blocks delayed Bitcoin creates after revision-fenced deletes", async () => {
    const t = testConvex();
    const syncToken = freshSecret();
    const readToken = freshSecret();
    setDeploymentEnv({
      CONVEX_SYNC_TOKEN: syncToken,
      CONVEX_READ_TOKEN: readToken,
    });
    const device = await pairMobileDevice(
      t,
      syncToken,
      "bitcoin-tombstone-device",
      ["bitcoin:write"],
    );
    const auth = authArgs(device);
    const date = new Date().toISOString().slice(0, 10);
    const month = date.slice(0, 7);
    // The row-layer money cap (writeback parity) bounds device-path fees, so
    // the boundary-value wire encoding stays covered by the insert-seeded
    // projection test instead.
    const maxCappedFee = 99_999_999n;
    const asOf = `${date}T00:00:00.000Z`;

    await t.run(async (ctx) => {
      const accounts = [
        {
          key: "river",
          label: "River",
          custody: "exchange" as const,
          sats: 2_000_000n,
        },
        {
          key: "coldcard",
          label: "Coldcard",
          custody: "self_custody" as const,
          sats: 1_000_000n,
        },
      ];
      await ctx.db.insert("btcBalanceDocuments", {
        sourceFile: "btc-balance-snapshot",
        owner: "victor",
        schemaVersion: 2n,
        asOf,
        accounts,
        totals: {
          sats: 3_000_000n,
          exchangeSats: 2_000_000n,
          selfCustodySats: 1_000_000n,
        },
        postingActivatedAtMs: 1,
        updatedAtMs: 10,
      });
      for (const account of accounts) {
        await ctx.db.insert("btcAccounts", {
          ...account,
          owner: "victor",
          asOf,
          schemaVersion: 2n,
          sourceFile: "btc-balance-snapshot",
          updatedAtMs: 10,
        });
      }
    });

    const buy = {
      id: "deleted-buy",
      owner: "victor",
      date,
      source: "river",
      sats: 100n,
      priceUsdCents: 10_000_000n,
      usdCents: 100n,
    };
    const buyRequest = {
      ...auth,
      owner: "victor",
      sourceFile: "bitcoin-buys",
      buy,
    };
    await t.mutation(api.upsertBtcBuy, buyRequest);
    const zeroFeeRead = await t.query(api.listBtcBuys, {
      viewer: "rachel",
      scope: "netWorth",
      month,
      token: readToken,
    });
    expect(zeroFeeRead.rows).toEqual([
      expect.objectContaining({ buyId: buy.id, feeUsdCents: 0n }),
    ]);
    const initialBuyRevision = zeroFeeRead.rows[0]!.updatedAtMs;
    await t.mutation(api.upsertBtcBuy, {
      ...buyRequest,
      baseUpdatedAtMs: initialBuyRevision,
      buy: { ...buy, feeUsdCents: maxCappedFee },
    });
    const maxFeeRead = await t.query(api.listBtcBuys, {
      viewer: "rachel",
      scope: "netWorth",
      month,
      token: readToken,
    });
    expect(maxFeeRead.rows[0]!.feeUsdCents).toBe(maxCappedFee);

    const billPay = {
      id: "deleted-bill-pay",
      owner: "victor",
      date,
      merchant: "Utility",
      category: "Bills",
      budgetEffect: "budget_category",
      amountUsdCents: 100n,
      btcSpentSats: 10n,
      btcPriceCents: 10_000_000n,
      platform: "river_bitcoin_bill_pay",
      feeUsdCents: 25n,
    };
    const billPayRequest = {
      ...auth,
      owner: "victor",
      sourceFile: "bitcoin-bill-pays",
      billPay,
    };
    await t.mutation(api.upsertBtcBillPay, billPayRequest);

    const transfer = {
      id: "deleted-transfer",
      owner: "victor",
      date,
      fromAccountKey: "river",
      toAccountKey: "coldcard",
      sats: 5n,
      feeSats: 1n,
    };
    const transferRequest = {
      ...auth,
      owner: "victor",
      sourceFile: "btc-transfers",
      transfer,
    };
    await t.mutation(api.upsertBtcTransfer, transferRequest);

    const documentRevision = async () =>
      t.run(async (ctx) => {
        const document = await ctx.db
          .query("btcBalanceDocuments")
          .withIndex("by_source_file", (q) =>
            q.eq("sourceFile", "btc-balance-snapshot"),
          )
          .unique();
        return document!.updatedAtMs;
      });
    const account = {
      key: "watch-only",
      owner: "victor",
      label: "Watch only",
      custody: "self_custody",
      sats: 0n,
      asOf,
    };
    const accountRequest = {
      ...auth,
      owner: "victor",
      sourceFile: "btc-balance-snapshot",
      baseUpdatedAtMs: await documentRevision(),
      account,
    };
    await t.mutation(api.upsertBtcAccount, accountRequest);

    const revisions = await t.run(async (ctx) => ({
      buy: (await ctx.db
        .query("btcBuys")
        .withIndex("by_source_buy_id", (q) =>
          q.eq("sourceFile", "bitcoin-buys").eq("buyId", buy.id),
        )
        .unique())!.updatedAtMs,
      billPay: (await ctx.db
        .query("btcBillPays")
        .withIndex("by_source_bill_pay_id", (q) =>
          q
            .eq("sourceFile", "bitcoin-bill-pays")
            .eq("billPayId", billPay.id),
        )
        .unique())!.updatedAtMs,
      transfer: (await ctx.db
        .query("btcTransfers")
        .withIndex("by_transfer_id", (q) => q.eq("transferId", transfer.id))
        .unique())!.updatedAtMs,
    }));

    await t.mutation(api.deleteBtcBuy, {
      ...auth,
      owner: "victor",
      sourceFile: "bitcoin-buys",
      entityId: buy.id,
      baseUpdatedAtMs: revisions.buy,
    });
    await t.mutation(api.deleteBtcBillPay, {
      ...auth,
      owner: "victor",
      sourceFile: "bitcoin-bill-pays",
      entityId: billPay.id,
      baseUpdatedAtMs: revisions.billPay,
    });
    await t.mutation(api.deleteBtcTransfer, {
      ...auth,
      owner: "victor",
      sourceFile: "btc-transfers",
      entityId: transfer.id,
      baseUpdatedAtMs: revisions.transfer,
    });
    await t.mutation(api.deleteBtcAccount, {
      ...auth,
      owner: "victor",
      sourceFile: "btc-balance-snapshot",
      entityId: account.key,
      baseUpdatedAtMs: await documentRevision(),
    });

    await expectDeviceError(
      t.mutation(api.upsertBtcBuy, {
        ...buyRequest,
        buy: { ...buy, feeUsdCents: maxCappedFee },
      }),
      "ENTITY_DELETED",
      buy.id,
    );
    await expectDeviceError(
      t.mutation(api.upsertBtcBillPay, billPayRequest),
      "ENTITY_DELETED",
      billPay.id,
    );
    await expectDeviceError(
      t.mutation(api.upsertBtcTransfer, transferRequest),
      "ENTITY_DELETED",
      transfer.id,
    );
    await expectDeviceError(
      t.mutation(api.upsertBtcAccount, {
        ...accountRequest,
        baseUpdatedAtMs: undefined,
      }),
      "REVISION_REQUIRED",
      account.key,
    );

    const [buys, bills, transfers, accounts] = await Promise.all([
      t.query(api.listBtcBuys, {
        viewer: "rachel",
        scope: "netWorth",
        month,
        token: readToken,
      }),
      t.query(api.listBtcBillPays, {
        viewer: "rachel",
        scope: "netWorth",
        month,
        token: readToken,
      }),
      t.query(api.listBtcTransfers, {
        viewer: "rachel",
        scope: "netWorth",
        month,
        token: readToken,
      }),
      t.query(api.listBtcAccounts, {
        viewer: "rachel",
        scope: "netWorth",
        token: readToken,
      }),
    ]);
    expect(buys.rows).toEqual([]);
    expect(bills.rows).toEqual([]);
    expect(transfers.rows).toEqual([]);
    expect(accounts.rows.map((row) => row.key).sort()).toEqual([
      "coldcard",
      "river",
    ]);

    const tombstones = await t.run(async (ctx) =>
      ctx.db.query("rowTombstones").collect(),
    );
    expect(
      tombstones
        .filter((row) => row.entityType.startsWith("btc"))
        .map((row) => `${row.entityType}:${row.entityId}`)
        .sort(),
    ).toEqual([
      "btcAccount:watch-only",
      "btcBillPay:deleted-bill-pay",
      "btcBuy:deleted-buy",
      "btcTransfer:deleted-transfer",
    ]);
  });
});
