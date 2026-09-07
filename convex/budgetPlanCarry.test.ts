import type { FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it } from "vitest";

import type { DeviceProfile } from "./deviceAuth";
import {
  freshSecret,
  pairMobileDevice,
  setDeploymentEnv,
  testConvex,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";

useIsolatedDeploymentEnv();

type BudgetSource = "budget" | "mason-budget";
type CarryResult = {
  ok: true;
  outcome: "copied" | "already-copied";
  sourceFile: BudgetSource;
  fromMonth: string;
  toMonth: string;
  categoryCount: number;
  updatedAtMs: number;
};

const copyPlan = "tables:copyBudgetPlanForwardFromDevice" as unknown as FunctionReference<
  "mutation",
  "public",
  Record<string, unknown>,
  CarryResult
>;

const copyPlanSync = "tables:copyBudgetPlanForward" as unknown as FunctionReference<
  "mutation",
  "public",
  Record<string, unknown>,
  CarryResult
>;

type T = ReturnType<typeof testConvex>;

let t: T;
let syncToken: string;

beforeEach(() => {
  t = testConvex();
  syncToken = freshSecret();
  setDeploymentEnv({ CONVEX_SYNC_TOKEN: syncToken });
});

const CATEGORIES = [
  { name: "Groceries", icon: "cart", budgetCents: 90_000n },
  { name: "Utilities", budgetCents: 40_000n },
  { name: "Dining", icon: "fork", budgetCents: 25_000n },
];

async function budgetDevice(
  deviceId = "budget-carry-device",
  profile: DeviceProfile = "victor",
  capabilities: Array<"budget:write" | "transactions:write"> = ["budget:write"],
) {
  return await pairMobileDevice(t, syncToken, deviceId, capabilities, profile);
}

/** Seed one adult budget plus ledger rows that a carry must never touch. */
async function seedAdultBudget(month = "August 2026", updatedAtMs = 1_000) {
  await t.run(async (ctx) => {
    await ctx.db.insert("budgetDocuments", {
      sourceFile: "budget",
      owner: "victor",
      month,
      coinbaseOneBalanceCents: 12_345n,
      categories: CATEGORIES,
      effectiveApr: "4.5",
      strategyNote: "Keep the plan steady.",
      income: {
        weeklyGrossCents: 200_000n,
        weeklyStrikeCents: 10_000n,
        weeklyRiverCents: 5_000n,
        payFrequency: "weekly",
        monthlyGrossCents: 866_000n,
        mtdIncomeCents: 400_000n,
        ytdIncomeCents: 6_500_000n,
        paychecks: [
          { date: "2026-08-07", source: "employer", amountCents: 200_000n, netCents: 150_000n },
        ],
      },
      mtdIncomeCents: 400_000n,
      ytdIncomeCents: 6_500_000n,
      monthlyHistory: [
        { month: "2026-07", incomeCents: 800_000n, expensesCents: 600_000n, savingsBps: 2_500n },
      ],
      allowance: { weeklyCents: 2_000n, source: "chores" },
      updatedAtMs,
    });
    await ctx.db.insert("transactions", {
      txId: "aug-tx",
      owner: "victor",
      date: "2026-08-20",
      month: "2026-08",
      merchant: "Market",
      amountCents: 4_200n,
      category: "Groceries",
      sourceFile: "transactions",
      updatedAtMs: 500,
    });
    await ctx.db.insert("income", {
      sourceKey: "aug-income",
      incomeId: "aug-income",
      owner: "victor",
      date: "2026-08-07",
      month: "2026-08",
      amountCents: 200_000n,
      source: "employer",
      sourceFile: "income",
      updatedAtMs: 500,
    });
  });
}

async function seedMasonBudget(month = "2026-08", updatedAtMs = 7) {
  await t.run(async (ctx) => {
    await ctx.db.insert("budgetDocuments", {
      sourceFile: "mason-budget",
      owner: "mason",
      month,
      coinbaseOneBalanceCents: 0n,
      categories: [{ name: "Fun", budgetCents: 3_000n }],
      mtdIncomeCents: 0n,
      ytdIncomeCents: 0n,
      monthlyHistory: [],
      updatedAtMs,
    });
  });
}

async function snapshot() {
  return await t.run(async (ctx) => ({
    budget: await ctx.db
      .query("budgetDocuments")
      .withIndex("by_source_file", (q) => q.eq("sourceFile", "budget"))
      .unique(),
    mason: await ctx.db
      .query("budgetDocuments")
      .withIndex("by_source_file", (q) => q.eq("sourceFile", "mason-budget"))
      .unique(),
    transactions: await ctx.db.query("transactions").collect(),
    income: await ctx.db.query("income").collect(),
    carries: await ctx.db.query("budgetPlanCarries").collect(),
    locks: await ctx.db.query("runtimeSourceLocks").collect(),
    dataFiles: await ctx.db.query("dataFiles").collect(),
  }));
}

async function expectDeviceError(request: Promise<unknown>, code: string) {
  try {
    await request;
    throw new Error(`Expected device error ${code}`);
  } catch (error) {
    const data = (error as { data?: Record<string, unknown> }).data;
    expect(data?.code).toBe(code);
  }
}

function authArgs(device: { deviceId: string; deviceToken: string }) {
  return { deviceId: device.deviceId, deviceToken: device.deviceToken };
}

describe("copyBudgetPlanForwardFromDevice", () => {
  it("copies every plan field into the next month and leaves the ledger alone", async () => {
    await seedAdultBudget();
    const before = await snapshot();
    const device = await budgetDevice();

    const result = await t.mutation(copyPlan, {
      ...authArgs(device),
      owner: "rachel",
      sourceFile: "budget",
      fromMonth: "2026-08",
      toMonth: "2026-09",
      baseUpdatedAtMs: 1_000,
    });

    expect(result).toMatchObject({
      ok: true,
      outcome: "copied",
      sourceFile: "budget",
      fromMonth: "2026-08",
      toMonth: "2026-09",
      categoryCount: 3,
    });
    expect(result.updatedAtMs).toBeGreaterThan(1_000);

    const after = await snapshot();
    // The stored spelling is preserved so the operator month advance still
    // recognises the document.
    expect(after.budget!.month).toBe("September 2026");
    expect(after.budget!.categories).toEqual(CATEGORIES);
    expect(after.budget!.coinbaseOneBalanceCents).toBe(12_345n);
    expect(after.budget!.effectiveApr).toBe("4.5");
    expect(after.budget!.strategyNote).toBe("Keep the plan steady.");
    expect(after.budget!.allowance).toEqual({ weeklyCents: 2_000n, source: "chores" });
    expect(after.budget!.mtdIncomeCents).toBe(0n);
    expect(after.budget!.income).toEqual({
      ...before.budget!.income!,
      mtdIncomeCents: 0n,
    });
    expect(after.budget!.ytdIncomeCents).toBe(6_500_000n);
    expect(after.budget!.monthlyHistory).toEqual(before.budget!.monthlyHistory);
    expect(after.budget!.updatedAtMs).toBe(result.updatedAtMs);

    expect(after.transactions).toEqual(before.transactions);
    expect(after.income).toEqual(before.income);
    expect(after.dataFiles).toEqual([]);
    expect(after.locks.map((lock) => lock.sourceFile)).toEqual(["budget"]);
    expect(after.carries).toHaveLength(1);
    expect(after.carries[0]).toMatchObject({
      sourceFile: "budget",
      owner: "victor",
      fromMonth: "2026-08",
      toMonth: "2026-09",
      categoryCount: 3,
      fromUpdatedAtMs: 1_000,
      appliedUpdatedAtMs: result.updatedAtMs,
      deviceId: device.deviceId,
    });
  });

  it("defaults to the plan's own month and the month after it", async () => {
    await seedAdultBudget("2026-12", 42);
    const device = await budgetDevice();

    const result = await t.mutation(copyPlan, {
      ...authArgs(device),
      owner: "victor",
      sourceFile: "budget",
      baseUpdatedAtMs: 42,
    });

    expect(result).toMatchObject({ outcome: "copied", fromMonth: "2026-12", toMonth: "2027-01" });
    const after = await snapshot();
    // A canonical yyyy-MM document keeps that spelling.
    expect(after.budget!.month).toBe("2027-01");
  });

  it("answers a replay as already-copied without writing again", async () => {
    await seedAdultBudget();
    const device = await budgetDevice();
    const request = {
      ...authArgs(device),
      owner: "victor",
      sourceFile: "budget",
      fromMonth: "2026-08",
      toMonth: "2026-09",
      baseUpdatedAtMs: 1_000,
    };

    const first = await t.mutation(copyPlan, request);
    const second = await t.mutation(copyPlan, request);

    expect(second).toEqual({ ...first, outcome: "already-copied" });
    const after = await snapshot();
    expect(after.carries).toHaveLength(1);
    expect(after.budget!.updatedAtMs).toBe(first.updatedAtMs);
    expect(after.budget!.month).toBe("September 2026");
  });

  it("refuses when the target month already has a plan that was not copied by this route", async () => {
    await seedAdultBudget("September 2026");
    const device = await budgetDevice();

    await expectDeviceError(
      t.mutation(copyPlan, {
        ...authArgs(device),
        owner: "victor",
        sourceFile: "budget",
        fromMonth: "2026-08",
        toMonth: "2026-09",
        baseUpdatedAtMs: 1_000,
      }),
      "PLAN_EXISTS",
    );
    await expectDeviceError(
      t.mutation(copyPlan, {
        ...authArgs(device),
        owner: "victor",
        sourceFile: "budget",
        fromMonth: "2026-07",
        toMonth: "2026-08",
        baseUpdatedAtMs: 1_000,
      }),
      "PLAN_EXISTS",
    );
    // A fromMonth that names a month the plan never held is a conflict, not a
    // silent re-anchoring.
    await expectDeviceError(
      t.mutation(copyPlan, {
        ...authArgs(device),
        owner: "victor",
        sourceFile: "budget",
        fromMonth: "2026-10",
        toMonth: "2026-11",
        baseUpdatedAtMs: 1_000,
      }),
      "ENTITY_CONFLICT",
    );
    const after = await snapshot();
    expect(after.budget!.month).toBe("September 2026");
    expect(after.carries).toEqual([]);
  });

  it("refuses a stale revision and refuses to guess a missing month", async () => {
    await seedAdultBudget();
    const device = await budgetDevice();

    await expectDeviceError(
      t.mutation(copyPlan, {
        ...authArgs(device),
        owner: "victor",
        sourceFile: "budget",
        fromMonth: "2026-08",
        toMonth: "2026-09",
        baseUpdatedAtMs: 999,
      }),
      "ENTITY_CONFLICT",
    );
    await expect(
      t.mutation(copyPlan, {
        ...authArgs(device),
        owner: "victor",
        sourceFile: "budget",
        fromMonth: "2026-08",
        toMonth: "2026-09",
      }),
    ).rejects.toThrow();
    const after = await snapshot();
    expect(after.budget!.month).toBe("August 2026");
    expect(after.budget!.updatedAtMs).toBe(1_000);
    expect(after.carries).toEqual([]);
  });

  it("requires exactly one month forward unless the request allows a gap", async () => {
    await seedAdultBudget();
    const device = await budgetDevice();
    const base = { ...authArgs(device), owner: "victor", sourceFile: "budget", baseUpdatedAtMs: 1_000 };

    await expectDeviceError(
      t.mutation(copyPlan, { ...base, fromMonth: "2026-08", toMonth: "2026-08" }),
      "VALIDATION_FAILED",
    );
    await expectDeviceError(
      t.mutation(copyPlan, { ...base, fromMonth: "2026-08", toMonth: "2026-07" }),
      "VALIDATION_FAILED",
    );
    await expectDeviceError(
      t.mutation(copyPlan, { ...base, fromMonth: "2026-08", toMonth: "2026-10" }),
      "VALIDATION_FAILED",
    );
    await expectDeviceError(
      t.mutation(copyPlan, { ...base, fromMonth: "2026-8", toMonth: "2026-09" }),
      "VALIDATION_FAILED",
    );
    await expectDeviceError(
      t.mutation(copyPlan, { ...base, fromMonth: "2026-08", toMonth: "2028-10", allowGap: true }),
      "VALIDATION_FAILED",
    );

    const skipped = await t.mutation(copyPlan, {
      ...base,
      fromMonth: "2026-08",
      toMonth: "2026-10",
      allowGap: true,
    });
    expect(skipped).toMatchObject({ outcome: "copied", toMonth: "2026-10" });
    const after = await snapshot();
    expect(after.budget!.month).toBe("October 2026");
    // The skipped month is left missing, never fabricated.
    expect(after.carries.map((row) => [row.fromMonth, row.toMonth])).toEqual([
      ["2026-08", "2026-10"],
    ]);
  });

  it("refuses an unbound credential, a foreign owner, and a missing capability", async () => {
    await seedAdultBudget();
    await seedMasonBudget();
    const deviceToken = freshSecret();
    await t.run(async (ctx) => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(deviceToken),
      );
      await ctx.db.insert("mobileDevices", {
        deviceId: "unbound-carry-device",
        name: "Legacy credential",
        tokenHash: Array.from(new Uint8Array(digest))
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
        pairedAt: Date.now(),
        lastSeenAt: Date.now(),
        pairId: "unbound-carry-pair",
        capabilities: ["budget:write"],
        profile: undefined,
      });
    });

    await expectDeviceError(
      t.mutation(copyPlan, {
        deviceId: "unbound-carry-device",
        deviceToken,
        owner: "victor",
        sourceFile: "budget",
        fromMonth: "2026-08",
        toMonth: "2026-09",
        baseUpdatedAtMs: 1_000,
      }),
      "PROFILE_BINDING_REQUIRED",
    );

    const mason = await budgetDevice("mason-carry-device", "mason");
    await expectDeviceError(
      t.mutation(copyPlan, {
        ...authArgs(mason),
        owner: "victor",
        sourceFile: "budget",
        fromMonth: "2026-08",
        toMonth: "2026-09",
        baseUpdatedAtMs: 1_000,
      }),
      "OWNER_MISMATCH",
    );
    await expectDeviceError(
      t.mutation(copyPlan, {
        ...authArgs(mason),
        owner: "mason",
        sourceFile: "budget",
        fromMonth: "2026-08",
        toMonth: "2026-09",
        baseUpdatedAtMs: 1_000,
      }),
      "OWNER_SOURCE_MISMATCH",
    );

    const readOnly = await budgetDevice("no-budget-capability", "victor", ["transactions:write"]);
    await expectDeviceError(
      t.mutation(copyPlan, {
        ...authArgs(readOnly),
        owner: "victor",
        sourceFile: "budget",
        fromMonth: "2026-08",
        toMonth: "2026-09",
        baseUpdatedAtMs: 1_000,
      }),
      "DEVICE_UNAUTHORIZED",
    );

    const after = await snapshot();
    expect(after.budget!.month).toBe("August 2026");
    expect(after.carries).toEqual([]);
  });

  it("carries Mason's plan under Mason's own credential", async () => {
    await seedMasonBudget();
    const mason = await budgetDevice("mason-carry-device", "mason");

    const result = await t.mutation(copyPlan, {
      ...authArgs(mason),
      owner: "mason",
      sourceFile: "mason-budget",
      fromMonth: "2026-08",
      toMonth: "2026-09",
      baseUpdatedAtMs: 7,
    });

    expect(result).toMatchObject({ outcome: "copied", sourceFile: "mason-budget", categoryCount: 1 });
    const after = await snapshot();
    expect(after.mason!.month).toBe("2026-09");
    expect(after.mason!.categories).toEqual([{ name: "Fun", budgetCents: 3_000n }]);
  });

  it("reports a missing budget document instead of creating one", async () => {
    const device = await budgetDevice();
    await expectDeviceError(
      t.mutation(copyPlan, {
        ...authArgs(device),
        owner: "victor",
        sourceFile: "budget",
        baseUpdatedAtMs: 0,
      }),
      "ENTITY_NOT_FOUND",
    );
    const after = await snapshot();
    expect(after.budget).toBeNull();
    expect(after.carries).toEqual([]);
  });
});

describe("copyBudgetPlanForward (sync token)", () => {
  it("copies under the household sync token and attributes the receipt to sync-token", async () => {
    await seedAdultBudget();

    const result = await t.mutation(copyPlanSync, {
      token: syncToken,
      owner: "rachel",
      sourceFile: "budget",
      fromMonth: "2026-08",
      toMonth: "2026-09",
      baseUpdatedAtMs: 1_000,
    });

    expect(result).toMatchObject({
      ok: true,
      outcome: "copied",
      sourceFile: "budget",
      fromMonth: "2026-08",
      toMonth: "2026-09",
      categoryCount: 3,
    });
    const after = await snapshot();
    expect(after.budget!.month).toBe("September 2026");
    expect(after.carries).toHaveLength(1);
    expect(after.carries[0]).toMatchObject({
      deviceId: "sync-token",
      owner: "victor",
      fromMonth: "2026-08",
      toMonth: "2026-09",
    });
  });

  it("rejects a missing or wrong sync token before touching the plan", async () => {
    await seedAdultBudget();
    const request = {
      owner: "victor",
      sourceFile: "budget",
      fromMonth: "2026-08",
      toMonth: "2026-09",
      baseUpdatedAtMs: 1_000,
    };

    await expect(t.mutation(copyPlanSync, request)).rejects.toThrow(/invalid sync token|not configured/);
    await expect(
      t.mutation(copyPlanSync, { ...request, token: "wrong-token" }),
    ).rejects.toThrow(/invalid sync token/);

    const after = await snapshot();
    expect(after.budget!.month).toBe("August 2026");
    expect(after.carries).toEqual([]);
  });

  it("never accepts allowGap on the sync-token route", async () => {
    await seedAdultBudget();

    await expectDeviceError(
      t.mutation(copyPlanSync, {
        token: syncToken,
        owner: "victor",
        sourceFile: "budget",
        fromMonth: "2026-08",
        toMonth: "2026-10",
        baseUpdatedAtMs: 1_000,
      }),
      "VALIDATION_FAILED",
    );

    const after = await snapshot();
    expect(after.budget!.month).toBe("August 2026");
    expect(after.carries).toEqual([]);
  });
});
