// L-8 regression: the legacy blob append doors validate the record class the
// shipped readers decode. The MC2-era doors stay open — whole payloads keep
// flowing — but a sync-token holder can no longer put non-cents floats,
// impossible dates, or sign-flipped money into blobs shipped clients parse.
import type { FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it } from "vitest";

import {
  freshSecret,
  readDataFile,
  setDeploymentEnv,
  testConvex,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";

const mutation = <Args extends Record<string, unknown>, Result>(path: string) =>
  path as unknown as FunctionReference<"mutation", "public", Args, Result>;

type AppendTxnResult = { name: string; version: number; id: string };

const api = {
  appendTransaction: mutation<
    {
      name?: "transactions" | "mason-transactions";
      transaction: {
        id: string;
        date: string;
        merchant: string;
        amount: number;
        category: string;
        card?: string | null;
        note?: string | null;
      };
      token?: string;
    },
    AppendTxnResult
  >("dataFiles:appendTransaction"),
  appendBillPay: mutation<
    {
      billPay: {
        id: string;
        date: string;
        merchant: string;
        category: string;
        amount_usd: number;
        btc_spent: number;
        btc_price?: number | null;
        platform?: string | null;
        note?: string | null;
        fee_usd?: number | null;
        reference?: string | null;
        owner?: string | null;
      };
      token?: string;
    },
    AppendTxnResult
  >("dataFiles:appendBillPay"),
};

useIsolatedDeploymentEnv();

type T = ReturnType<typeof testConvex>;

let t: T;
let syncToken: string;

beforeEach(() => {
  t = testConvex();
  syncToken = freshSecret();
  setDeploymentEnv({ CONVEX_SYNC_TOKEN: syncToken });
});

const validTxn = {
  id: "legacy-txn-1",
  date: "2026-07-26",
  merchant: "Costco",
  amount: 12.34,
  category: "Groceries",
};

describe("appendTransaction validates the blob record class", () => {
  it("accepts an exact-cents legacy record", async () => {
    await expect(
      t.mutation(api.appendTransaction, { transaction: validTxn, token: syncToken }),
    ).resolves.toMatchObject({ id: "legacy-txn-1", version: 1 });
  });

  it("rejects amounts that are not exact cents", async () => {
    for (const amount of [1.005, 12.345, 0.1 + 0.2, -1.999]) {
      await expect(
        t.mutation(api.appendTransaction, {
          transaction: { ...validTxn, amount },
          token: syncToken,
        }),
      ).rejects.toThrow(/exact number of cents/);
    }
  });

  it("rejects zero amounts and sign-flipped Income", async () => {
    await expect(
      t.mutation(api.appendTransaction, {
        transaction: { ...validTxn, amount: 0 },
        token: syncToken,
      }),
    ).rejects.toThrow(/must not be zero/);
    await expect(
      t.mutation(api.appendTransaction, {
        transaction: { ...validTxn, amount: -5, category: "Income" },
        token: syncToken,
      }),
    ).rejects.toThrow(/Income.*positive/);
    // Refunds are negative non-Income rows and stay legitimate.
    await expect(
      t.mutation(api.appendTransaction, {
        transaction: { ...validTxn, amount: -5, id: "legacy-refund" },
        token: syncToken,
      }),
    ).resolves.toMatchObject({ id: "legacy-refund" });
  });

  it("rejects the $1M overflow before it lands in the blob", async () => {
    await expect(
      t.mutation(api.appendTransaction, {
        transaction: { ...validTxn, amount: 1_000_000.01 },
        token: syncToken,
      }),
    ).rejects.toThrow(/sanity limit/);
  });

  it("rejects impossible and malformed dates", async () => {
    for (const date of ["2026-02-30", "not-a-date", "26-07-2026"]) {
      await expect(
        t.mutation(api.appendTransaction, {
          transaction: { ...validTxn, date },
          token: syncToken,
        }),
      ).rejects.toThrow(/real ISO calendar date/);
    }
  });
});

describe("appendBillPay validates the blob record class", () => {
  const validBillPay = {
    id: "legacy-bill-1",
    date: "2026-07-26",
    merchant: "River",
    category: "Bills",
    amount_usd: 100.25,
    btc_spent: 0.00097531,
    btc_price: 102_800.11,
    platform: "river_bitcoin_bill_pay",
    owner: "victor",
  };

  it("accepts an exact legacy bill pay", async () => {
    await expect(
      t.mutation(api.appendBillPay, { billPay: validBillPay, token: syncToken }),
    ).resolves.toMatchObject({ id: "legacy-bill-1" });
    const stored = await readDataFile(t, "bitcoin-bill-pays");
    expect((stored!.data as { bill_pays: unknown[] }).bill_pays).toHaveLength(1);
  });

  it("rejects non-positive principals and non-exact units", async () => {
    for (const patch of [
      { amount_usd: 0 },
      { amount_usd: -5 },
      { amount_usd: 1.005 },
      { btc_spent: 0 },
      { btc_spent: -0.1 },
      { btc_spent: 0.0000000001 },
      { btc_price: 0 },
      { fee_usd: -1 },
    ]) {
      await expect(
        t.mutation(api.appendBillPay, {
          billPay: { ...validBillPay, ...patch },
          token: syncToken,
        }),
      ).rejects.toThrow(/positive|exact|not be negative/);
    }
  });

  it("rejects impossible dates and unknown owners", async () => {
    await expect(
      t.mutation(api.appendBillPay, {
        billPay: { ...validBillPay, date: "2026-02-30" },
        token: syncToken,
      }),
    ).rejects.toThrow(/real ISO calendar date/);
    await expect(
      t.mutation(api.appendBillPay, {
        billPay: { ...validBillPay, owner: "nobody" },
        token: syncToken,
      }),
    ).rejects.toThrow(/family member/);
  });
});
