import { readFileSync } from "node:fs";

import type { FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it } from "vitest";

import {
  freshSecret,
  pairMobileDevice,
  setDeploymentEnv,
  testConvex,
  type TestConvexInstance,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";

type FamilyMember = "victor" | "rachel" | "mason" | "maddox";

type MoneyOutSource =
  | {
      kind: "transaction";
      row: { txId: string };
      contributionCents: bigint;
    }
  | {
      kind: "btc_bill_pay";
      row: { billPayId: string };
      principalCents: bigint;
      feeUsdCents: bigint;
      contributionCents: bigint;
    };

type MoneyOutResult = {
  date: string;
  owner: FamilyMember;
  totalCents: bigint;
  sources: MoneyOutSource[];
};

const getMoneyOutToday =
  "tables:getMoneyOutToday" as unknown as FunctionReference<
    "query",
    "public",
    { viewer: FamilyMember; date: string; token?: string },
    MoneyOutResult
  >;

const upsertBtcBuy = "tables:upsertBtcBuy" as unknown as FunctionReference<
  "mutation",
  "public",
  {
    buy: {
      id: string;
      date: string;
      source: string;
      sats: bigint;
      priceUsdCents: bigint;
      usdCents: bigint;
      feeUsdCents?: bigint;
      owner?: FamilyMember;
    };
    sourceFile?: string;
    token?: string;
  },
  unknown
>;

const upsertBtcBillPay =
  "tables:upsertBtcBillPay" as unknown as FunctionReference<
    "mutation",
    "public",
    {
      billPay: {
        id: string;
        date: string;
        merchant: string;
        category: string;
        budgetEffect?: "budget_category" | "credit_card_payment";
        amountUsdCents: bigint;
        btcSpentSats: bigint;
        btcPriceCents: bigint;
        platform?: string;
        feeUsdCents?: bigint;
        owner?: FamilyMember;
      };
      token?: string;
    },
    unknown
  >;

const upsertBtcBillPayFromDevice =
  "tables:upsertBtcBillPayFromDevice" as unknown as FunctionReference<
    "mutation",
    "public",
    {
      deviceId: string;
      deviceToken: string;
      owner: FamilyMember;
      sourceFile: "bitcoin-bill-pays";
      billPay: {
        id: string;
        owner: FamilyMember;
        date: string;
        merchant: string;
        category: string;
        budgetEffect?: "budget_category" | "credit_card_payment";
        amountUsdCents: bigint;
        btcSpentSats: bigint;
        btcPriceCents: bigint;
        platform?: string;
        feeUsdCents?: bigint;
      };
    },
    unknown
  >;

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../shared/domain/fixtures/money-out-today-cases.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  contractVersion: number;
  date: string;
  transactions: Array<{
    id: string;
    date: string;
    amountCents: string;
    category: string;
    owner: FamilyMember;
  }>;
  billPays: Array<{
    id: string;
    date: string;
    principalCents: string;
    feeUsdCents: string;
    owner: FamilyMember;
    budgetEffect?: "budget_category" | "credit_card_payment";
  }>;
  cases: Array<{
    activeProfile: FamilyMember;
    expectedOwner: FamilyMember;
    expectedTotalCents: string;
    expectedSourceIds: string[];
  }>;
};

useIsolatedDeploymentEnv();

let t: TestConvexInstance;
let token: string;

beforeEach(() => {
  t = testConvex();
  token = freshSecret();
  setDeploymentEnv({
    CONVEX_READ_TOKEN: token,
    CONVEX_SYNC_TOKEN: token,
  });
});

async function seedContractFixture() {
  await t.run(async (ctx) => {
    for (const row of fixture.transactions) {
      await ctx.db.insert("transactions", {
        txId: row.id,
        owner: row.owner,
        date: row.date,
        month: row.date.slice(0, 7),
        merchant: row.id,
        amountCents: BigInt(row.amountCents),
        category: row.category,
        sourceFile: row.owner === "victor" || row.owner === "rachel"
          ? "transactions"
          : `${row.owner}-transactions`,
        updatedAtMs: 1,
      });
    }
    for (const row of fixture.billPays) {
      await ctx.db.insert("btcBillPays", {
        billPayId: row.id,
        owner: row.owner,
        date: row.date,
        month: row.date.slice(0, 7),
        merchant: row.id,
        category: "Bills",
        budgetEffect: row.budgetEffect ?? "budget_category",
        amountUsdCents: BigInt(row.principalCents),
        btcSpentSats: 1n,
        btcPriceCents: 1n,
        platform: "river_bitcoin_bill_pay",
        feeUsdCents: BigInt(row.feeUsdCents),
        sourceFile: "bitcoin-bill-pays",
        updatedAtMs: 1,
      });
    }
  });
}

function sourceId(source: MoneyOutSource): string {
  return source.kind === "transaction"
    ? source.row.txId
    : source.row.billPayId;
}

async function seedAdultBtcLedger() {
  await t.run(async (ctx) => {
    await ctx.db.insert("btcBalanceDocuments", {
      sourceFile: "btc-balance-snapshot",
      owner: "victor",
      schemaVersion: 2n,
      asOf: "2026-08-25T00:00:00.000Z",
      accounts: [
        {
          key: "river",
          label: "River",
          custody: "exchange",
          sats: 1_000_000n,
        },
      ],
      totals: {
        sats: 1_000_000n,
        exchangeSats: 1_000_000n,
        selfCustodySats: 0n,
      },
      postingActivatedAtMs: 1,
      updatedAtMs: 1,
    });
    await ctx.db.insert("btcAccounts", {
      key: "river",
      owner: "victor",
      label: "River",
      custody: "exchange",
      sats: 1_000_000n,
      asOf: "2026-08-25T00:00:00.000Z",
      schemaVersion: 2n,
      sourceFile: "btc-balance-snapshot",
      updatedAtMs: 1,
    });
  });
}

describe("Money Out Today backend contract", () => {
  it("matches the shared fixture for adult household and child profile scope", async () => {
    expect(fixture.contractVersion).toBe(1);
    await seedContractFixture();

    for (const row of fixture.cases) {
      const result = await t.query(getMoneyOutToday, {
        viewer: row.activeProfile,
        date: fixture.date,
        token,
      });
      expect(result.owner).toBe(row.expectedOwner);
      expect(result.totalCents).toBe(BigInt(row.expectedTotalCents));
      expect(result.sources.map(sourceId)).toEqual(row.expectedSourceIds);
    }
  });

  it("keeps refund signs and adds eligible bill-pay principal plus fee once", async () => {
    await seedContractFixture();
    const result = await t.query(getMoneyOutToday, {
      viewer: "rachel",
      date: fixture.date,
      token,
    });

    expect(result.sources.map(sourceId)).not.toContain("adult-income");
    expect(result.sources.map(sourceId)).not.toContain(
      "adult-credit-card-payment",
    );
    expect(
      result.sources.find((source) => sourceId(source) === "adult-refund")
        ?.contributionCents,
    ).toBe(-3_000n);
    expect(
      result.sources.find((source) => source.kind === "btc_bill_pay"),
    ).toMatchObject({
      principalCents: 1_000n,
      feeUsdCents: 25n,
      contributionCents: 1_025n,
    });
  });

  it("rejects invalid days and every signed-int64 addition overflow", async () => {
    await expect(
      t.query(getMoneyOutToday, {
        viewer: "victor",
        date: "2026-02-30",
        token,
      }),
    ).rejects.toThrow(/real ISO calendar date/);

    await t.run(async (ctx) => {
      for (const [txId, amountCents] of [
        ["positive-max", (1n << 63n) - 1n],
        ["positive-overflow", 1n],
        ["negative-min", -(1n << 63n)],
        ["negative-overflow", -1n],
      ] as const) {
        const date = txId.startsWith("positive")
          ? "2026-08-26"
          : "2026-08-27";
        await ctx.db.insert("transactions", {
          txId,
          owner: "victor",
          date,
          month: "2026-08",
          merchant: txId,
          amountCents,
          category: "Other",
          sourceFile: "transactions",
          updatedAtMs: 1,
        });
      }
      await ctx.db.insert("btcBillPays", {
        billPayId: "principal-fee-overflow",
        owner: "victor",
        date: "2026-08-28",
        month: "2026-08",
        merchant: "Overflow",
        category: "Bills",
        budgetEffect: "budget_category",
        amountUsdCents: (1n << 63n) - 1n,
        btcSpentSats: 1n,
        btcPriceCents: 1n,
        feeUsdCents: 1n,
        sourceFile: "bitcoin-bill-pays",
        updatedAtMs: 1,
      });
    });

    for (const date of ["2026-08-26", "2026-08-27", "2026-08-28"]) {
      await expect(
        t.query(getMoneyOutToday, { viewer: "victor", date, token }),
      ).rejects.toThrow(/fit signed int64/);
    }
  });

  it("stores omitted manual buy and bill-pay fees as exact zero", async () => {
    await t.mutation(upsertBtcBuy, {
      buy: {
        id: "manual-fee-buy-default",
        owner: "mason",
        date: "2026-08-25",
        source: "river",
        sats: 1_000n,
        priceUsdCents: 6_000_000n,
        usdCents: 60n,
      },
      sourceFile: "mason-bitcoin-buys",
      token,
    });
    await t.mutation(upsertBtcBillPay, {
      billPay: {
        id: "manual-fee-bill-default",
        owner: "mason",
        date: "2026-08-25",
        merchant: "Utility",
        category: "Bills",
        budgetEffect: "budget_category",
        amountUsdCents: 1_000n,
        btcSpentSats: 15_000n,
        btcPriceCents: 6_666_667n,
        platform: "river_bitcoin_bill_pay",
      },
      token,
    });

    const stored = await t.run(async (ctx) => ({
      buy: await ctx.db
        .query("btcBuys")
        .withIndex("by_source_buy_id", (q) =>
          q
            .eq("sourceFile", "mason-bitcoin-buys")
            .eq("buyId", "manual-fee-buy-default"),
        )
        .unique(),
      billPay: await ctx.db
        .query("btcBillPays")
        .withIndex("by_source_bill_pay_id", (q) =>
          q
            .eq("sourceFile", "bitcoin-bill-pays")
            .eq("billPayId", "manual-fee-bill-default"),
        )
        .unique(),
    }));
    expect(stored.buy?.feeUsdCents).toBe(0n);
    expect(stored.billPay?.feeUsdCents).toBe(0n);
  });

  it("defaults an omitted device River bill-pay fee before persistence", async () => {
    await seedAdultBtcLedger();
    const device = await pairMobileDevice(t, token, undefined, [
      "bitcoin:write",
    ]);
    await t.mutation(upsertBtcBillPayFromDevice, {
      deviceId: device.deviceId,
      deviceToken: device.deviceToken,
      owner: "victor",
      sourceFile: "bitcoin-bill-pays",
      billPay: {
        id: "device-fee-default",
        owner: "victor",
        date: "2026-08-25",
        merchant: "Utility",
        category: "Bills",
        budgetEffect: "budget_category",
        amountUsdCents: 1_000n,
        btcSpentSats: 15_000n,
        btcPriceCents: 6_666_667n,
        platform: "river_bitcoin_bill_pay",
      },
    });

    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("btcBillPays")
        .withIndex("by_source_bill_pay_id", (q) =>
          q
            .eq("sourceFile", "bitcoin-bill-pays")
            .eq("billPayId", "device-fee-default"),
        )
        .unique(),
    );
    expect(stored?.feeUsdCents).toBe(0n);
  });
});
