import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "./schema";
import { OPERATOR_IMPORT_SCHEMA } from "./operatorImportValidation";

const modules: Record<string, () => Promise<unknown>> = {
  "./_generated/server.ts": () => import("./generatedServer.test-stub"),
  "./tables.ts": () => import("./tables"),
  "./operatorImport.ts": () => import("./operatorImport"),
  "./operatorImportValidation.ts": () => import("./operatorImportValidation"),
};

type Counts = {
  transactions: number;
  income: number;
  btc_buys: number;
  btc_bill_pays: number;
};
type Preflight = {
  contract_version: number;
  outcome: "ready";
  counts: Counts;
  checks: Record<string, boolean>;
  plan_fingerprint: string;
  state_fingerprint: string;
};
type ApplyResult = {
  contract_version: number;
  outcome: "applied" | "already_applied";
  counts: Counts;
  checks: Record<string, boolean>;
};
type Readback = {
  contract_version: number;
  outcome: "verified";
  counts: Counts;
  checks: Record<string, boolean>;
};

// The visibility is part of this type: all three entry points must remain
// internal-only. A public FunctionReference is not assignable here.
const fn = {
  preflight: "operatorImport:preflightBatch" as unknown as FunctionReference<
    "query",
    "internal",
    { manifest: unknown },
    Preflight
  >,
  apply: "operatorImport:applyBatch" as unknown as FunctionReference<
    "mutation",
    "internal",
    {
      manifest: unknown;
      expected_plan_fingerprint: string;
      expected_state_fingerprint: string;
    },
    ApplyResult
  >,
  readback: "operatorImport:readbackBatch" as unknown as FunctionReference<
    "query",
    "internal",
    { manifest: unknown; expected_plan_fingerprint: string },
    Readback
  >,
};

type Harness = ReturnType<typeof convexTest>;
const FP_A = `sha256:${"a".repeat(64)}`;

function transaction(index: number, overrides: Record<string, unknown> = {}) {
  return {
    kind: "transaction",
    op_id: `tx-op-${index}`,
    record_id: `tx-record-${index}`,
    source_locator: `PRIVATE-LOCATOR-${index}`,
    owner: "victor",
    source_file: "transactions",
    date: `2026-08-${String((index % 28) + 1).padStart(2, "0")}`,
    merchant: `PRIVATE-MERCHANT-${index}`,
    amount_cents: String(8200 + index),
    transaction_kind: "spend",
    category: index % 2 === 0 ? "Groceries" : "Utilities",
    card: "Card",
    note: `PRIVATE-NOTE-${index}`,
    ...overrides,
  };
}

function smallManifest(
  ops: unknown[],
  batchId = "small-reviewed-batch",
  budgetAdvance?: Record<string, unknown>,
) {
  return {
    schema: OPERATOR_IMPORT_SCHEMA,
    batch_id: batchId,
    ops,
    duplicate_attestations: [],
    ...(budgetAdvance === undefined ? {} : { budget_advance: budgetAdvance }),
  };
}

async function seedBudgets(t: Harness) {
  await t.run(async (ctx) => {
    await ctx.db.insert("budgetDocuments", {
      sourceFile: "budget",
      owner: "victor",
      month: "July 2026",
      coinbaseOneBalanceCents: 12_550n,
      categories: [
        { name: "Groceries", icon: "cart", budgetCents: 90_000n },
        { name: "Utilities", icon: "bolt", budgetCents: 40_000n },
      ],
      effectiveApr: "19.99%",
      strategyNote: "Preserve this configuration",
      income: {
        weeklyGrossCents: 120_000n,
        weeklyStrikeCents: 10_000n,
        weeklyRiverCents: 5_000n,
        payFrequency: "weekly",
        monthlyGrossCents: 480_000n,
        mtdIncomeCents: 250_000n,
        ytdIncomeCents: 3_000_000n,
        paychecks: [
          {
            date: "2026-07-25",
            platform: "Payroll",
            source: "Employer",
            amountCents: 120_000n,
            netCents: 90_000n,
            note: "Preserve paycheck",
          },
        ],
      },
      mtdIncomeCents: 250_000n,
      ytdIncomeCents: 3_000_000n,
      monthlyHistory: [
        {
          month: "June 2026",
          incomeCents: 480_000n,
          expensesCents: 320_000n,
          savingsBps: 3333n,
        },
      ],
      allowance: { weeklyCents: 2_100n, source: "Household" },
      updatedAtMs: 7000,
      migrationRawJson: "preserve-raw-config",
      migrationSourceIndex: 9,
    });
    await ctx.db.insert("budgetDocuments", {
      sourceFile: "mason-budget",
      owner: "mason",
      month: "July 2026",
      coinbaseOneBalanceCents: 0n,
      categories: [{ name: "Fun", budgetCents: 20_000n }],
      mtdIncomeCents: 111n,
      ytdIncomeCents: 222n,
      monthlyHistory: [],
      updatedAtMs: 7100,
    });
  });
}

async function world(t: Harness) {
  return await t.run(async (ctx) => ({
    transactions: await ctx.db.query("transactions").collect(),
    income: await ctx.db.query("income").collect(),
    buys: await ctx.db.query("btcBuys").collect(),
    billPays: await ctx.db.query("btcBillPays").collect(),
    receipts: await ctx.db.query("operatorBatches").collect(),
    locks: await ctx.db.query("runtimeSourceLocks").collect(),
    tombstones: await ctx.db.query("rowTombstones").collect(),
    budgets: await ctx.db.query("budgetDocuments").collect(),
  }));
}

async function expectCode(request: Promise<unknown>, code: string) {
  try {
    await request;
    throw new Error(`Expected Convex error ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<{ code: string }>).data).toEqual({ code });
  }
}

async function preflight(t: Harness, manifest: unknown) {
  return await t.query(fn.preflight, { manifest });
}

async function apply(t: Harness, manifest: unknown, plan: Preflight) {
  return await t.mutation(fn.apply, {
    manifest,
    expected_plan_fingerprint: plan.plan_fingerprint,
    expected_state_fingerprint: plan.state_fingerprint,
  });
}

describe("transaction supersession regressions", () => {
  let t: Harness;
  beforeEach(async () => { t = convexTest(schema, modules); await seedBudgets(t); vi.stubEnv("ALLOW_TOKENLESS_READ", "true"); });
  afterEach(() => vi.unstubAllEnvs());
  async function seed() {
    const m = smallManifest([transaction(0)], "audit-seed");
    await apply(t, m, await preflight(t, m));
  }
  function correction(id: string, amount: string) {
    return transaction(0, { op_id: id, record_id: id, source_locator: id,
      amount_cents: amount, supersedes_record_id: "tx-record-0" });
  }
  it("rejects competing batches against a retired target and preserves exact replay", async () => {
    await seed();
    const first = smallManifest([correction("replacement-a", "1000")], "audit-first");
    const second = smallManifest([correction("replacement-b", "1100")], "audit-second");
    const firstPlan = await preflight(t, first);
    const secondPlan = await preflight(t, second);
    await apply(t, first, firstPlan);
    const before = await world(t);
    await expectCode(preflight(t, second), "CORRECTION_TARGET_MISSING");
    await expectCode(apply(t, second, secondPlan), "CORRECTION_TARGET_MISSING");
    // Reusing even the identical replacement under a fresh batch is not a retry.
    await expectCode(preflight(t, { ...first, batch_id: "new-batch-id" }), "CORRECTION_TARGET_MISSING");
    expect((await preflight(t, first)).plan_fingerprint).toBe(firstPlan.plan_fingerprint);
    expect((await apply(t, first, firstPlan)).outcome).toBe("already_applied");
    expect((await t.query(fn.readback, { manifest: first, expected_plan_fingerprint: firstPlan.plan_fingerprint })).outcome).toBe("verified");
    expect(await world(t)).toEqual(before);
    expect(before.transactions.map(r => r.txId)).toEqual(["replacement-a"]);
    expect(before.transactions.reduce((sum, r) => sum + r.amountCents, 0n)).toBe(1000n);
    expect(before.tombstones).toHaveLength(1);
  });
  it("allows a later correction to target the current replacement", async () => {
    await seed();
    const first = smallManifest([correction("replacement-a", "1000")], "audit-first");
    await apply(t, first, await preflight(t, first));
    const second = smallManifest([{ ...correction("replacement-b", "1100"), supersedes_record_id: "replacement-a" }], "audit-second");
    const plan = await preflight(t, second);
    await apply(t, second, plan);
    expect((await world(t)).transactions.map(r => r.txId)).toEqual(["replacement-b"]);
    expect((await world(t)).tombstones.map(r => r.entityId).sort()).toEqual(["replacement-a", "tx-record-0"]);
    expect((await t.query(fn.readback, { manifest: second, expected_plan_fingerprint: plan.plan_fingerprint })).outcome).toBe("verified");
  });
  it("rejects duplicate correction targets before planning or mutation", async () => {
    await seed();
    const before = await world(t);
    const m = smallManifest([correction("replacement-a", "1000"), correction("replacement-b", "1100")], "audit-double-target");
    await expectCode(preflight(t, m), "DUPLICATE_CORRECTION_TARGET");
    await expectCode(t.mutation(fn.apply, { manifest: m, expected_plan_fingerprint: FP_A, expected_state_fingerprint: FP_A }), "DUPLICATE_CORRECTION_TARGET");
    expect(await world(t)).toEqual(before);
  });
  it.each([false, true])("rejects a device tombstone as correction provenance (live target: %s)", async (live) => {
    await seed();
    await t.run(async ctx => {
      if (!live) await ctx.db.delete((await ctx.db.query("transactions").collect())[0]._id);
      await ctx.db.insert("rowTombstones", { entityType: "transaction", sourceFile: "transactions", entityId: "tx-record-0", owner: "victor", deletedAtMs: 1 });
    });
    const before = await world(t);
    const m = smallManifest([correction("replacement-a", "1000")], "audit-device-delete");
    await expectCode(preflight(t, m), live ? "TOMBSTONED_RECORD" : "CORRECTION_TARGET_MISSING");
    expect(await world(t)).toEqual(before);
  });
  it("locks a deletion-only source and preserves the existing replacement provenance on replay", async () => {
    await t.run(async ctx => {
      for (const [id, amount] of [["tx-record-0", 8200n], ["replacement-a", 1000n]] as const) {
        await ctx.db.insert("transactions", { txId: id, owner: "victor", sourceFile: "transactions",
          date: "2026-08-01", month: "2026-08", merchant: "PRIVATE-MERCHANT-0",
          amountCents: amount, category: "Groceries", card: "Card", note: "PRIVATE-NOTE-0",
          migrationRaw: { sentinel: id }, updatedAtMs: 1 });
      }
    });
    const existing = (await world(t)).transactions.find(r => r.txId === "replacement-a");
    const m = smallManifest([correction("replacement-a", "1000")], "audit-existing-correction");
    const plan = await preflight(t, m);
    expect((await apply(t, m, plan)).outcome).toBe("applied");
    const after = await world(t);
    expect(after.transactions).toEqual([existing]);
    expect(after.locks).toHaveLength(1);
    expect(after.locks[0].sourceFile).toBe("transactions");
    expect(after.tombstones).toHaveLength(1);
    expect((await apply(t, m, plan)).outcome).toBe("already_applied");
    expect((await t.query(fn.readback, { manifest: m, expected_plan_fingerprint: plan.plan_fingerprint })).outcome).toBe("verified");
    expect(await world(t)).toEqual(after);
  });
  it("projects the corrected amount and preserves unrelated provenance and compatibility blobs", async () => {
    await seed();
    const untouchedId = await t.run(async ctx => {
      await ctx.db.insert("dataFiles", { name: "transactions", data: "compatibility-sentinel", updatedAt: 1, version: 1 });
      return await ctx.db.insert("transactions", { txId: "unrelated-provenance", owner: "victor", sourceFile: "transactions",
        date: "2026-07-01", month: "2026-07", merchant: "untouched", amountCents: 5n, category: "Groceries",
        migrationRaw: { sentinel: "private-original" }, updatedAtMs: 1 });
    });
    const before = await t.run(async ctx => ({ untouched: await ctx.db.get(untouchedId), blobs: await ctx.db.query("dataFiles").collect() }));
    const m = smallManifest([correction("replacement-a", "1000")], "audit-projection");
    const plan = await preflight(t, m);
    await apply(t, m, plan);
    const query = "tables:listTransactions" as unknown as FunctionReference<"query", "public", { viewer: "rachel"; month: string }, { rows: Array<{txId: string; amountCents: bigint; spendAmount: bigint; owner: string}> }>;
    const projected = await t.query(query, { viewer: "rachel", month: "2026-08" });
    expect(projected.rows).toHaveLength(1);
    expect(projected.rows[0]).toMatchObject({ txId: "replacement-a", owner: "victor", amountCents: 1000n, spendAmount: 1000n });
    expect(await t.run(async ctx => ({ untouched: await ctx.db.get(untouchedId), blobs: await ctx.db.query("dataFiles").collect() }))).toEqual(before);
    const corrected = (await world(t)).transactions.find(r => r.txId === "replacement-a");
    expect(corrected).not.toHaveProperty("migrationRaw");
    expect((await preflight(t, m)).plan_fingerprint).toBe(plan.plan_fingerprint);
  });
  it("rejects a stale reviewed plan when the target changes", async () => {
    await seed();
    const m = smallManifest([correction("replacement-a", "1000")], "audit-stale-target");
    const plan = await preflight(t, m);
    await t.run(async ctx => { const row = (await ctx.db.query("transactions").collect())[0]; await ctx.db.patch(row._id, { amountCents: 8300n }); });
    const before = await world(t);
    await expectCode(apply(t, m, plan), "REVIEWED_PLAN_MISMATCH");
    expect(await world(t)).toEqual(before);
  });
});
