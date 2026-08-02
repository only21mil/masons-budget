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
  deleteTransaction: mutation<
    "public",
    Record<string, unknown>,
    Record<string, unknown>
  >("tables:deleteTransaction"),
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

  it("rejects invalid sync-token buys before they can debit River", async () => {
    const before = satsByKey(await snapshot());
    const valid = {
      id: "invalid-buy",
      date: "2026-08-01",
      source: "river",
      sats: 1n,
      priceUsdCents: 1n,
      usdCents: 1n,
    };
    for (const buy of [
      { ...valid, sats: 0n },
      { ...valid, sats: -1n },
      { ...valid, priceUsdCents: 0n },
      { ...valid, usdCents: 0n },
    ]) {
      await expect(t.mutation(api.buy, { buy })).rejects.toThrow(/must be positive/);
    }
    await expect(
      t.mutation(api.buy, { buy: { ...valid, date: "not-a-date" } }),
    ).rejects.toThrow();
    expect(satsByKey(await snapshot())).toEqual(before);
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
    const postedRevision = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("transactions")
          .withIndex("by_source_tx_id", (q) =>
            q.eq("sourceFile", "transactions").eq("txId", fiatIncome.id),
          )
          .unique()
      )!.updatedAtMs,
    );
    await expect(
      t.mutation(api.transaction, {
        transaction: fiatIncome,
        baseUpdatedAtMs: postedRevision,
      }),
    ).rejects.toThrow(/requires explicit amountSats/);
    await expect(
      t.mutation(api.transaction, {
        transaction: {
          ...fiatIncome,
          amountSats: 12_000n,
          bitcoinAccountKey: "coldcard",
        },
        baseUpdatedAtMs: postedRevision,
      }),
    ).rejects.toThrow(/cannot change its Bitcoin account/);
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

  it("reverses posted sat-Income once and fences delete retries", async () => {
    const income = {
      id: "delete-btc-income",
      date: "2026-08-01",
      merchant: "Income",
      amountCents: 1n,
      kind: "credit",
      category: "Income",
      amountSats: 12_000n,
    };
    await t.mutation(api.transaction, { transaction: income });
    const revision = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("transactions")
          .withIndex("by_source_tx_id", (q) =>
            q.eq("sourceFile", "transactions").eq("txId", income.id),
          )
          .unique()
      )!.updatedAtMs,
    );

    await expect(
      t.mutation(api.deleteTransaction, { txId: income.id }),
    ).rejects.toThrow(/baseUpdatedAtMs is required/);
    await expect(
      t.mutation(api.deleteTransaction, {
        txId: income.id,
        baseUpdatedAtMs: revision,
      }),
    ).resolves.toMatchObject({ removed: true });
    expect(satsByKey(await snapshot()).river).toBe(1_000_000n);

    await expect(
      t.mutation(api.deleteTransaction, {
        txId: income.id,
        baseUpdatedAtMs: revision,
      }),
    ).resolves.toMatchObject({ removed: false });
    await expect(
      t.mutation(api.deleteTransaction, {
        txId: income.id,
        baseUpdatedAtMs: revision - 1,
      }),
    ).rejects.toThrow(/does not match the current revision/);
    expect(satsByKey(await snapshot()).river).toBe(1_000_000n);
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

    await expect(
      t.mutation(api.transfer, {
        transfer: {
          id: "mason-transfer",
          owner: "mason",
          date: "2026-08-01",
          fromAccountKey: "strike",
          toAccountKey: "coldcard",
          sats: 1n,
          feeSats: 0n,
        },
      }),
    ).rejects.toThrow(/adult household ledger/);
    await expect(
      t.mutation(api.reconcile, {
        owner: "mason",
        expectedUpdatedAtMs: 1,
        asOf: "2026-08-01T00:00:00.000Z",
        accounts: [],
      }),
    ).rejects.toThrow(/adult household ledger/);
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

    const transferRevision = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("btcTransfers")
          .withIndex("by_transfer_id", (q) => q.eq("transferId", transfer.id))
          .unique()
      )!.updatedAtMs,
    );
    await t.mutation(api.transfer, {
      transfer: { ...transfer, sats: 110_000n, feeSats: 600n },
      baseUpdatedAtMs: transferRevision,
    });
    state = await snapshot();
    expect(satsByKey(state)).toEqual({
      river: 859_400n,
      coldcard: 2_110_000n,
    });
    expect(state.document.totals.sats).toBe(2_969_400n);

    const editedTransferRevision = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("btcTransfers")
          .withIndex("by_transfer_id", (q) => q.eq("transferId", transfer.id))
          .unique()
      )!.updatedAtMs,
    );
    await t.mutation(api.deleteTransfer, {
      transferId: "transfer-1",
      owner: "victor",
      baseUpdatedAtMs: editedTransferRevision,
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
    await t.run(async (ctx) => {
      await ctx.db.insert("transactions", {
        txId: "legacy-sat-income",
        owner: "victor",
        date: "2026-07-01",
        month: "2026-07",
        merchant: "Legacy Bitcoin income",
        amountCents: 1n,
        category: "Income",
        amountSats: 10_000n,
        sourceFile: "transactions",
        updatedAtMs: 5,
      });
    });
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
    const legacy = {
      id: "legacy-sat-income",
      date: "2026-07-01",
      merchant: "Legacy Bitcoin income",
      amountCents: 1n,
      kind: "credit",
      category: "Income",
      amountSats: 10_000n,
    };
    const legacyRevision = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("transactions")
          .withIndex("by_source_tx_id", (q) =>
            q.eq("sourceFile", "transactions").eq("txId", legacy.id),
          )
          .unique()
      )!.updatedAtMs,
    );
    await t.mutation(api.transaction, {
      transaction: legacy,
      baseUpdatedAtMs: legacyRevision,
    });
    expect(satsByKey(await snapshot())).toEqual({
      river: 1_250_000n,
      coldcard: 2_500_000n,
    });
    await t.mutation(api.transaction, {
      transaction: { ...legacy, amountSats: 11_000n },
      baseUpdatedAtMs: legacyRevision,
    });
    expect(satsByKey(await snapshot())).toEqual({
      river: 1_251_000n,
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

  it("refuses activation when River is missing or ambiguous", async () => {
    t = testConvex();
    setDeploymentEnv({ ALLOW_TOKENLESS_SYNC: "true" });
    await seedLedger(t, false);
    await t.run(async (ctx) => {
      const document = await ctx.db
        .query("btcBalanceDocuments")
        .withIndex("by_source_file", (q) =>
          q.eq("sourceFile", "btc-balance-snapshot"),
        )
        .unique();
      await ctx.db.patch(document!._id, {
        accounts: document!.accounts.map((account) =>
          account.key === "coldcard" ? { ...account, label: "River" } : account,
        ),
      });
    });

    await expect(
      t.mutation(api.reconcile, {
        owner: "victor",
        expectedUpdatedAtMs: 10,
        asOf: "2026-08-01T20:00:00.000Z",
        accounts: [
          { key: "river", label: "River", custody: "exchange", sats: 1n },
          {
            key: "coldcard",
            label: "River",
            custody: "self_custody",
            sats: 1n,
          },
        ],
      }),
    ).rejects.toThrow(/missing or ambiguous/);
    expect((await snapshot()).document.postingActivatedAtMs).toBeUndefined();
  });
});

const accountMutation = mutation<
  "public",
  Record<string, unknown>,
  Record<string, unknown>
>("tables:upsertBtcAccount");

async function deactivate() {
  await t.run(async (ctx) => {
    const document = await ctx.db
      .query("btcBalanceDocuments")
      .withIndex("by_source_file", (q) =>
        q.eq("sourceFile", "btc-balance-snapshot"),
      )
      .unique();
    await ctx.db.patch(document!._id, {
      postingActivatedAtMs: undefined,
      updatedAtMs: 10,
    });
  });
}

describe("pre-activation cutover repair", () => {
  const riverAccount = {
    key: "river",
    owner: "victor",
    label: "River",
    custody: "exchange",
    sats: 1_000_000n,
    fiatCents: 100_000n,
    asOf: "2026-07-30T00:00:00.000Z",
    schemaVersion: 2n,
  };

  it("repairs a missing mirror instead of reporting a silent no-op", async () => {
    // Document already matches; only the mirror is gone. This is exactly the
    // state reconcileBtcAccounts refuses to activate, and the runbook sends the
    // operator back through upsertBtcAccount to repair it.
    await deactivate();
    await t.run(async (ctx) => {
      const mirror = await ctx.db
        .query("btcAccounts")
        .withIndex("by_owner_key", (q) =>
          q.eq("owner", "victor").eq("key", "river"),
        )
        .unique();
      await ctx.db.delete(mirror!._id);
    });
    expect((await snapshot()).mirrors.map((row) => row.key)).not.toContain(
      "river",
    );

    await t.mutation(accountMutation, { account: riverAccount });

    const repaired = (await snapshot()).mirrors.find(
      (row) => row.key === "river",
    );
    expect(repaired).toBeDefined();
    expect(repaired!.sats).toBe(1_000_000n);
  });

  it("repairs a divergent mirror quantity", async () => {
    await deactivate();
    await t.run(async (ctx) => {
      const mirror = await ctx.db
        .query("btcAccounts")
        .withIndex("by_owner_key", (q) =>
          q.eq("owner", "victor").eq("key", "river"),
        )
        .unique();
      await ctx.db.patch(mirror!._id, { sats: 7n });
    });

    await t.mutation(accountMutation, { account: riverAccount });

    const repaired = (await snapshot()).mirrors.find(
      (row) => row.key === "river",
    );
    expect(repaired!.sats).toBe(1_000_000n);
  });

  it("never moves the document revision backwards on an unfenced write", async () => {
    await deactivate();
    await t.run(async (ctx) => {
      const document = await ctx.db
        .query("btcBalanceDocuments")
        .withIndex("by_source_file", (q) =>
          q.eq("sourceFile", "btc-balance-snapshot"),
        )
        .unique();
      // Push the revision past wall clock, as a burst of fenced writes does.
      await ctx.db.patch(document!._id, { updatedAtMs: Date.now() + 60_000 });
    });
    const raised = (await snapshot()).document.updatedAtMs;

    await t.mutation(accountMutation, {
      account: { ...riverAccount, label: "River Exchange" },
    });

    expect((await snapshot()).document.updatedAtMs).toBeGreaterThan(raised);
  });
});

describe("operator transfer correction without a device revision", () => {
  it("deletes a transfer through the full-admin path and reverses both legs", async () => {
    await t.mutation(api.transfer, {
      transfer: {
        id: "tf-runbook",
        owner: "victor",
        date: "2026-08-01",
        fromAccountKey: "river",
        toAccountKey: "coldcard",
        sats: 100_000n,
        feeSats: 500n,
      },
    });
    expect(satsByKey(await snapshot())).toMatchObject({
      river: 899_500n,
      coldcard: 2_100_000n,
    });

    // Runbook step 7 supplies no revision; the operator credential is the fence.
    const removed = await t.mutation(api.deleteTransfer, {
      transferId: "tf-runbook",
      owner: "victor",
    });
    expect(removed).toMatchObject({ removed: true });
    expect(satsByKey(await snapshot())).toMatchObject({
      river: 1_000_000n,
      coldcard: 2_000_000n,
    });
  });
});

describe("activation baseline marking", () => {
  async function seedLegacyIncome(
    txId: string,
    date: string,
    extra: Record<string, unknown> = {},
  ) {
    await t.run(async (ctx) => {
      await ctx.db.insert("transactions", {
        txId,
        owner: "victor",
        date,
        month: date.slice(0, 7),
        merchant: "Payroll",
        amountCents: -1000n,
        category: "Income",
        amountSats: 50_000n,
        sourceFile: "transactions",
        updatedAtMs: 5,
        ...extra,
      });
    });
  }

  async function reconcileFresh() {
    await deactivate();
    return await t.mutation(api.reconcile, {
      owner: "victor",
      expectedUpdatedAtMs: 10,
      asOf: "2026-07-31T00:00:00.000Z",
      accounts: [
        { key: "river", label: "River", custody: "exchange", sats: 1_000_000n },
        {
          key: "coldcard",
          label: "Coldcard",
          custody: "self_custody",
          sats: 2_000_000n,
        },
      ],
    });
  }

  async function readRow(txId: string) {
    return await t.run(async (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_source_tx_id", (q) =>
          q.eq("sourceFile", "transactions").eq("txId", txId),
        )
        .unique(),
    );
  }

  it("skips legacy Income dated after asOf so a later delete cannot debit River", async () => {
    await seedLegacyIncome("tx-after", "2026-08-05");
    const result = (await reconcileFresh()) as unknown as {
      baselinedIncomeTxIds: string[];
      skippedIncomeTxIds: string[];
    };
    expect(result.skippedIncomeTxIds).toContain("tx-after");
    expect(result.baselinedIncomeTxIds).not.toContain("tx-after");
    expect((await readRow("tx-after"))!.balancePostingVersion).toBeUndefined();
  });

  it("preserves an existing account key rather than re-pointing it at River", async () => {
    await seedLegacyIncome("tx-coldcard", "2026-07-20", {
      bitcoinAccountKey: "coldcard",
    });
    const result = (await reconcileFresh()) as unknown as {
      baselinedIncomeTxIds: string[];
    };
    expect(result.baselinedIncomeTxIds).toContain("tx-coldcard");
    const row = await readRow("tx-coldcard");
    expect(row!.bitcoinAccountKey).toBe("coldcard");
    expect(row!.balancePostingVersion).toBe(1n);
  });

  it("baselines an in-window row against River and leaves balances untouched", async () => {
    await seedLegacyIncome("tx-in-window", "2026-07-20");
    const before = satsByKey(await snapshot());
    const result = (await reconcileFresh()) as unknown as {
      baselinedIncomeTxIds: string[];
    };
    expect(result.baselinedIncomeTxIds).toContain("tx-in-window");
    expect((await readRow("tx-in-window"))!.bitcoinAccountKey).toBe("river");
    expect(satsByKey(await snapshot())).toMatchObject(before);
  });

  it("rejects an asOf that does not start with a real calendar date", async () => {
    await deactivate();
    await expect(
      t.mutation(api.reconcile, {
        owner: "victor",
        expectedUpdatedAtMs: 10,
        asOf: "not-a-date",
        accounts: [
          {
            key: "river",
            label: "River",
            custody: "exchange",
            sats: 1_000_000n,
          },
          {
            key: "coldcard",
            label: "Coldcard",
            custody: "self_custody",
            sats: 2_000_000n,
          },
        ],
      }),
    ).rejects.toThrow(/real ISO date/);
  });
});

describe("activation baseline durability and edit safety", () => {
  async function seedLegacy(txId: string, date: string, extra: Record<string, unknown> = {}) {
    await t.run(async (ctx) => {
      await ctx.db.insert("transactions", {
        txId,
        owner: "victor",
        date,
        month: "2026-07",
        merchant: "Payroll",
        amountCents: -1000n,
        category: "Income",
        amountSats: 50_000n,
        sourceFile: "transactions",
        updatedAtMs: 5,
        ...extra,
      });
    });
  }

  it("skips a legacy row whose date is not a real calendar date", async () => {
    // A leading space sorts below the cutoff while naming a later day, so a raw
    // lexical compare would baseline a row that is not in the opening balances.
    await seedLegacy("tx-malformed", " 2026-12-01");
    await deactivate();
    const result = (await t.mutation(api.reconcile, {
      owner: "victor",
      expectedUpdatedAtMs: 10,
      asOf: "2026-07-31T00:00:00.000Z",
      accounts: [
        { key: "river", label: "River", custody: "exchange", sats: 1_000_000n },
        {
          key: "coldcard",
          label: "Coldcard",
          custody: "self_custody",
          sats: 2_000_000n,
        },
      ],
    })) as unknown as { skippedIncomeTxIds: string[] };
    expect(result.skippedIncomeTxIds).toContain("tx-malformed");
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_source_tx_id", (q) =>
          q.eq("sourceFile", "transactions").eq("txId", "tx-malformed"),
        )
        .unique(),
    );
    expect(row!.balancePostingVersion).toBeUndefined();
  });

  it("records the baseline inventory durably on the document", async () => {
    await seedLegacy("tx-kept", "2026-07-20");
    await seedLegacy("tx-late", "2026-08-09");
    await deactivate();
    await t.mutation(api.reconcile, {
      owner: "victor",
      expectedUpdatedAtMs: 10,
      asOf: "2026-07-31T00:00:00.000Z",
      accounts: [
        { key: "river", label: "River", custody: "exchange", sats: 1_000_000n },
        {
          key: "coldcard",
          label: "Coldcard",
          custody: "self_custody",
          sats: 2_000_000n,
        },
      ],
    });
    const stored = (await snapshot()).document.activationBaseline;
    expect(stored?.asOf).toBe("2026-07-31T00:00:00.000Z");
    expect(stored?.baselinedIncomeTxIds).toContain("tx-kept");
    expect(stored?.skippedIncomeTxIds).toContain("tx-late");
  });

  it("keeps a baselined self-custody row on its own account through an edit", async () => {
    await seedLegacy("tx-cold", "2026-07-20", { bitcoinAccountKey: "coldcard" });
    await deactivate();
    await t.mutation(api.reconcile, {
      owner: "victor",
      expectedUpdatedAtMs: 10,
      asOf: "2026-07-31T00:00:00.000Z",
      accounts: [
        { key: "river", label: "River", custody: "exchange", sats: 1_000_000n },
        {
          key: "coldcard",
          label: "Coldcard",
          custody: "self_custody",
          sats: 2_000_000n,
        },
      ],
    });
    const before = satsByKey(await snapshot());

    const revision = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("transactions")
          .withIndex("by_source_tx_id", (q) =>
            q.eq("sourceFile", "transactions").eq("txId", "tx-cold"),
          )
          .unique()
      )!.updatedAtMs,
    );
    // An ordinary metadata edit must not walk the sats over to River.
    await t.mutation(api.transaction, {
      transaction: {
        id: "tx-cold",
        date: "2026-07-20",
        merchant: "Payroll renamed",
        amountCents: 1000n,
        kind: "credit",
        category: "Income",
        amountSats: 50_000n,
      },
      baseUpdatedAtMs: revision,
    });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_source_tx_id", (q) =>
          q.eq("sourceFile", "transactions").eq("txId", "tx-cold"),
        )
        .unique(),
    );
    expect(row!.bitcoinAccountKey).toBe("coldcard");
    expect(satsByKey(await snapshot())).toMatchObject(before);
  });

  it("requires a revision to change a transfer even on the full-admin path", async () => {
    await t.mutation(api.transfer, {
      transfer: {
        id: "tf-fence",
        owner: "victor",
        date: "2026-08-01",
        fromAccountKey: "river",
        toAccountKey: "coldcard",
        sats: 10_000n,
        feeSats: 100n,
      },
    });
    const afterCreate = satsByKey(await snapshot());
    await expect(
      t.mutation(api.transfer, {
        transfer: {
          id: "tf-fence",
          owner: "victor",
          date: "2026-08-01",
          fromAccountKey: "river",
          toAccountKey: "coldcard",
          sats: 20_000n,
          feeSats: 100n,
        },
      }),
    ).rejects.toThrow(/baseUpdatedAtMs is required/);
    expect(satsByKey(await snapshot())).toMatchObject(afterCreate);
  });
});

describe("operator readback and delayed-retry safety", () => {
  const listDocuments = mutation<
    "public",
    Record<string, unknown>,
    { rows: Array<Record<string, unknown>> }
  >("tables:listBtcBalanceDocuments");

  it("exposes activationBaseline through the production read path", async () => {
    // Writing it durably is not enough: the runbook tells the operator to read
    // it back, and the only sanctioned read is this projection.
    setDeploymentEnv({ ALLOW_TOKENLESS_SYNC: "true", ALLOW_TOKENLESS_READ: "true" });
    await t.run(async (ctx) => {
      await ctx.db.insert("transactions", {
        txId: "tx-readback",
        owner: "victor",
        date: "2026-07-20",
        month: "2026-07",
        merchant: "Payroll",
        amountCents: -1000n,
        category: "Income",
        amountSats: 50_000n,
        sourceFile: "transactions",
        updatedAtMs: 5,
      });
    });
    await deactivate();
    await t.mutation(api.reconcile, {
      owner: "victor",
      expectedUpdatedAtMs: 10,
      asOf: "2026-07-31T00:00:00.000Z",
      accounts: [
        { key: "river", label: "River", custody: "exchange", sats: 1_000_000n },
        {
          key: "coldcard",
          label: "Coldcard",
          custody: "self_custody",
          sats: 2_000_000n,
        },
      ],
    });

    const documents = (await t.query(
      listDocuments as never,
      { viewer: "victor", scope: "netWorth" } as never,
    )) as unknown as { rows: Array<Record<string, unknown>> };
    const baseline = documents.rows[0]!.activationBaseline as {
      asOf: string;
      baselinedIncomeTxIds: string[];
      skippedIncomeTxIds: string[];
    };
    expect(baseline.asOf).toBe("2026-07-31T00:00:00.000Z");
    expect(baseline.baselinedIncomeTxIds).toContain("tx-readback");
  });

  it("refuses a delayed full-admin create replay after the transfer was deleted", async () => {
    const transfer = {
      id: "tf-replay",
      owner: "victor",
      date: "2026-08-01",
      fromAccountKey: "river",
      toAccountKey: "coldcard",
      sats: 10_000n,
      feeSats: 100n,
    };
    await t.mutation(api.transfer, { transfer });
    await t.mutation(api.deleteTransfer, {
      transferId: "tf-replay",
      owner: "victor",
    });
    const afterDelete = satsByKey(await snapshot());

    // The original create, retried late through the full-admin path.
    await expect(t.mutation(api.transfer, { transfer })).rejects.toThrow(
      /deleted Bitcoin transfer id cannot be silently resurrected/,
    );
    expect(satsByKey(await snapshot())).toMatchObject(afterDelete);
  });
});

describe("delayed full-admin create cannot resurrect deleted rows", () => {
  it("refuses a replayed sat-Income create after deletion", async () => {
    const income = {
      id: "income-resurrect",
      date: "2026-08-01",
      merchant: "Bitcoin income",
      amountCents: 1n,
      amountSats: 15_000n,
      kind: "credit",
      category: "Income",
    };
    await t.mutation(api.transaction, { transaction: income });
    const revision = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("transactions")
          .withIndex("by_source_tx_id", (q) =>
            q.eq("sourceFile", "transactions").eq("txId", "income-resurrect"),
          )
          .unique()
      )!.updatedAtMs,
    );
    await t.mutation(api.deleteTransaction, {
      txId: "income-resurrect",
      sourceFile: "transactions",
      baseUpdatedAtMs: revision,
    });
    const afterDelete = satsByKey(await snapshot());

    // The original create, retried late through the full-admin path. Before the
    // fix the tombstone was invisible to non-optimistic callers and this
    // re-credited River.
    await expect(
      t.mutation(api.transaction, { transaction: income }),
    ).rejects.toThrow(/cannot be silently resurrected/);
    expect(satsByKey(await snapshot())).toMatchObject(afterDelete);
  });
});
