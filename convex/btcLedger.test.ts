import type { FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it } from "vitest";

import {
  setDeploymentEnv,
  testConvex,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";

useIsolatedDeploymentEnv();

type T = ReturnType<typeof testConvex>;
const mutation = <
  Visibility extends "public" | "internal",
  Args extends Record<string, unknown>,
  Result,
>(path: string) =>
  path as unknown as FunctionReference<"mutation", Visibility, Args, Result>;

const api = {
  buy: mutation<"public", Record<string, unknown>, Record<string, unknown>>(
    "tables:upsertBtcBuy",
  ),
  billPay: mutation<"public", Record<string, unknown>, Record<string, unknown>>(
    "tables:upsertBtcBillPay",
  ),
  transaction: mutation<
    "public",
    Record<string, unknown>,
    Record<string, unknown>
  >("tables:upsertTransaction"),
  transfer: mutation<"public", Record<string, unknown>, Record<string, unknown>>(
    "tables:upsertBtcTransfer",
  ),
  deleteTransfer: mutation<
    "public",
    Record<string, unknown>,
    Record<string, unknown>
  >("tables:deleteBtcTransfer"),
  reconcile: mutation<
    "internal",
    Record<string, unknown>,
    { updatedAccounts: number; updatedAtMs: number }
  >("btcLedger:reconcileBtcAccounts"),
};

let t: T;

beforeEach(async () => {
  t = testConvex();
  setDeploymentEnv({ ALLOW_TOKENLESS_SYNC: "true" });
  await seedLedger(t, true);
});

async function seedLedger(instance: T, activated: boolean) {
  await instance.run(async (ctx) => {
    const asOf = "2026-07-30T00:00:00.000Z";
    const accounts = [
      {
        key: "river",
        label: "River",
        custody: "exchange" as const,
        sats: 1_000_000n,
        fiatCents: 100_000n,
      },
      {
        key: "coldcard",
        label: "Coldcard",
        custody: "self_custody" as const,
        sats: 2_000_000n,
        fiatCents: 200_000n,
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
        fiatCents: 300_000n,
        exchangeSats: 1_000_000n,
        selfCustodySats: 2_000_000n,
      },
      source: "test",
      ...(activated ? { postingActivatedAtMs: 1 } : {}),
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
}

async function snapshot(instance = t) {
  return await instance.run(async (ctx) => {
    const document = await ctx.db
      .query("btcBalanceDocuments")
      .withIndex("by_source_file", (q) =>
        q.eq("sourceFile", "btc-balance-snapshot"),
      )
      .unique();
    const mirrors = await ctx.db
      .query("btcAccounts")
      .withIndex("by_owner_custody", (q) => q.eq("owner", "victor"))
      .collect();
    return { document: document!, mirrors };
  });
}

function satsByKey(state: Awaited<ReturnType<typeof snapshot>>) {
  return Object.fromEntries(
    state.document.accounts.map((account) => [account.key, account.sats]),
  );
}

describe("Bitcoin balance posting", () => {
  it("posts new buys and explicitly-satted Income to River without replaying legacy fiat Income", async () => {
    const buy = {
      id: "buy-1",
      date: "2026-08-01",
      source: "paycheck",
      sats: 25_000n,
      priceUsdCents: 10_000_000n,
      usdCents: 2_500n,
    };
    await t.mutation(api.buy, { buy });
    await t.mutation(api.buy, { buy });
    await t.mutation(api.transaction, {
      transaction: {
        id: "fiat-income",
        date: "2026-08-01",
        merchant: "Payroll",
        amountCents: 100_000n,
        kind: "credit",
        category: "Income",
      },
    });
    await t.mutation(api.transaction, {
      transaction: {
        id: "btc-income",
        date: "2026-08-01",
        merchant: "Bitcoin income",
        amountCents: 1n,
        amountSats: 15_000n,
        kind: "credit",
        category: "Income",
      },
    });

    const state = await snapshot();
    expect(satsByKey(state)).toEqual({
      river: 1_040_000n,
      coldcard: 2_000_000n,
    });
    expect(state.document.totals.sats).toBe(3_040_000n);
    expect(state.mirrors.find((row) => row.key === "river")?.sats).toBe(
      1_040_000n,
    );
  });

  it("posts an existing unposted transaction when it is edited into sat-denominated Income", async () => {
    const fiatIncome = {
      id: "edited-btc-income",
      date: "2026-08-01",
      merchant: "Income",
      amountCents: 1n,
      kind: "credit",
      category: "Income",
    };
    await t.mutation(api.transaction, { transaction: fiatIncome });
    await t.mutation(api.transaction, {
      transaction: { ...fiatIncome, amountSats: 12_000n },
    });
    await t.mutation(api.transaction, {
      transaction: { ...fiatIncome, amountSats: 12_000n },
    });

    const state = await snapshot();
    expect(satsByKey(state)).toEqual({
      river: 1_012_000n,
      coldcard: 2_000_000n,
    });
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_source_tx_id", (q) =>
          q.eq("sourceFile", "transactions").eq("txId", "edited-btc-income"),
        )
        .unique(),
    );
    expect(stored?.amountSats).toBe(12_000n);
    expect(stored?.bitcoinAccountKey).toBe("river");
    expect(stored?.balancePostingVersion).toBe(1n);
  });

  it("keeps child financial rows working without routing them into the adult River ledger", async () => {
    const before = satsByKey(await snapshot());
    await t.mutation(api.buy, {
      sourceFile: "mason-bitcoin-buys",
      buy: {
        id: "mason-buy",
        owner: "mason",
        date: "2026-08-01",
        source: "allowance",
        sats: 25_000n,
        priceUsdCents: 10_000_000n,
        usdCents: 2_500n,
      },
    });
    await t.mutation(api.billPay, {
      billPay: {
        id: "mason-bill-pay",
        owner: "mason",
        date: "2026-08-01",
        merchant: "Merchant",
        category: "Spending",
        amountUsdCents: 1_000n,
        btcSpentSats: 10_000n,
        btcPriceCents: 10_000_000n,
        feeUsdCents: 0n,
      },
    });
    const childIncome = {
      id: "mason-btc-income",
      owner: "mason",
      date: "2026-08-01",
      merchant: "Bitcoin allowance",
      amountCents: 1n,
      kind: "credit",
      category: "Income",
    };
    await t.mutation(api.transaction, {
      sourceFile: "mason-transactions",
      transaction: childIncome,
    });
    await t.mutation(api.transaction, {
      sourceFile: "mason-transactions",
      transaction: { ...childIncome, amountSats: 5_000n },
    });

    expect(satsByKey(await snapshot())).toEqual(before);
    const rows = await t.run(async (ctx) => ({
      buy: await ctx.db
        .query("btcBuys")
        .withIndex("by_source_buy_id", (q) =>
          q.eq("sourceFile", "mason-bitcoin-buys").eq("buyId", "mason-buy"),
        )
        .unique(),
      billPay: await ctx.db
        .query("btcBillPays")
        .withIndex("by_source_bill_pay_id", (q) =>
          q
            .eq("sourceFile", "bitcoin-bill-pays")
            .eq("billPayId", "mason-bill-pay"),
        )
        .unique(),
      transaction: await ctx.db
        .query("transactions")
        .withIndex("by_source_tx_id", (q) =>
          q.eq("sourceFile", "mason-transactions").eq("txId", "mason-btc-income"),
        )
        .unique(),
    }));
    expect(rows.buy?.balancePostingVersion).toBeUndefined();
    expect(rows.billPay?.balancePostingVersion).toBeUndefined();
    expect(rows.transaction?.balancePostingVersion).toBeUndefined();
  });

  it("debits bill pays from River and transfers principal plus fee atomically", async () => {
    await t.mutation(api.billPay, {
      billPay: {
        id: "bill-1",
        date: "2026-08-01",
        merchant: "Utility",
        category: "Bills",
        amountUsdCents: 10_000n,
        btcSpentSats: 30_000n,
        btcPriceCents: 10_000_000n,
        feeUsdCents: 0n,
      },
    });
    const transfer = {
      id: "transfer-1",
      owner: "victor",
      date: "2026-08-01",
      fromAccountKey: "river",
      toAccountKey: "coldcard",
      sats: 100_000n,
      feeSats: 500n,
    };
    await t.mutation(api.transfer, { transfer });
    await t.mutation(api.transfer, { transfer });

    let state = await snapshot();
    expect(satsByKey(state)).toEqual({
      river: 869_500n,
      coldcard: 2_100_000n,
    });
    expect(state.document.totals.sats).toBe(2_969_500n);
    expect(state.document.totals.exchangeSats).toBe(869_500n);
    expect(state.document.totals.selfCustodySats).toBe(2_100_000n);
    expect(state.document.totals.fiatCents).toBeUndefined();
    expect(state.document.accounts.every((account) => account.fiatCents === undefined)).toBe(
      true,
    );

    await t.mutation(api.transfer, {
      transfer: { ...transfer, sats: 110_000n, feeSats: 600n },
    });
    state = await snapshot();
    expect(satsByKey(state)).toEqual({
      river: 859_400n,
      coldcard: 2_110_000n,
    });
    expect(state.document.totals.sats).toBe(2_969_400n);

    await t.mutation(api.deleteTransfer, {
      transferId: "transfer-1",
      owner: "victor",
    });
    state = await snapshot();
    expect(satsByKey(state)).toEqual({
      river: 970_000n,
      coldcard: 2_000_000n,
    });
    expect(state.document.totals.sats).toBe(2_970_000n);
  });

  it("rejects invalid and underfunded transfers without partial balance changes", async () => {
    const before = satsByKey(await snapshot());
    await expect(
      t.mutation(api.transfer, {
        transfer: {
          id: "same-account",
          owner: "victor",
          date: "2026-08-01",
          fromAccountKey: "river",
          toAccountKey: "river",
          sats: 1n,
          feeSats: 0n,
        },
      }),
    ).rejects.toThrow(/different/);
    await expect(
      t.mutation(api.transfer, {
        transfer: {
          id: "underfunded",
          owner: "victor",
          date: "2026-08-01",
          fromAccountKey: "river",
          toAccountKey: "coldcard",
          sats: 1_000_001n,
          feeSats: 0n,
        },
      }),
    ).rejects.toThrow(/insufficient funds/);
    expect(satsByKey(await snapshot())).toEqual(before);
  });

  it("reconciles existing opening accounts once and closes after the first posted event", async () => {
    t = testConvex();
    setDeploymentEnv({ ALLOW_TOKENLESS_SYNC: "true" });
    await seedLedger(t, false);
    await expect(
      t.mutation(api.buy, {
        buy: {
          id: "blocked-before-reconcile",
          date: "2026-08-01",
          source: "river",
          sats: 1n,
          priceUsdCents: 10_000_000n,
          usdCents: 1n,
        },
      }),
    ).rejects.toThrow(/not active until opening reconciliation completes/);
    expect(satsByKey(await snapshot())).toEqual({
      river: 1_000_000n,
      coldcard: 2_000_000n,
    });
    await expect(
      t.mutation(api.reconcile, {
        owner: "victor",
        expectedUpdatedAtMs: 10,
        asOf: "2026-08-01T20:00:00.000Z",
        accounts: [],
      }),
    ).rejects.toThrow(/must provide every canonical Bitcoin account/);
    await expect(
      t.mutation(api.reconcile, {
        owner: "victor",
        expectedUpdatedAtMs: 10,
        asOf: "2026-08-01T20:00:00.000Z",
        accounts: [
          {
            key: "river",
            label: "River",
            custody: "exchange",
            sats: 1_250_000n,
          },
        ],
      }),
    ).rejects.toThrow(/must provide every canonical Bitcoin account/);
    expect(satsByKey(await snapshot())).toEqual({
      river: 1_000_000n,
      coldcard: 2_000_000n,
    });
    const reconciled = await t.mutation(api.reconcile, {
      owner: "victor",
      expectedUpdatedAtMs: 10,
      asOf: "2026-08-01T20:00:00.000Z",
      accounts: [
        {
          key: "river",
          label: "River",
          custody: "exchange",
          sats: 1_250_000n,
        },
        {
          key: "coldcard",
          label: "Coldcard",
          custody: "self_custody",
          sats: 2_500_000n,
        },
      ],
    });
    expect(reconciled.updatedAccounts).toBe(2);
    expect(satsByKey(await snapshot())).toEqual({
      river: 1_250_000n,
      coldcard: 2_500_000n,
    });

    await t.mutation(api.buy, {
      buy: {
        id: "closes-reconcile",
        date: "2026-08-01",
        source: "river",
        sats: 1n,
        priceUsdCents: 10_000_000n,
        usdCents: 1n,
      },
    });
    const current = await snapshot();
    await expect(
      t.mutation(api.reconcile, {
        owner: "victor",
        expectedUpdatedAtMs: current.document.updatedAtMs,
        asOf: "2026-08-01T21:00:00.000Z",
        accounts: [
          {
            key: "river",
            label: "River",
            custody: "exchange",
            sats: 1n,
          },
        ],
      }),
    ).rejects.toThrow(/closed after the first posted Bitcoin event/);
  });
});
