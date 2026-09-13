import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it } from "vitest";

import schema from "./schema";
import { OPERATOR_IMPORT_SCHEMA } from "./operatorImportValidation";

const modules: Record<string, () => Promise<unknown>> = {
  "./_generated/server.ts": () => import("./generatedServer.test-stub"),
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
type Manifest = ReturnType<typeof productionManifest>;

const EXPECTED_COUNTS: Counts = {
  transactions: 82,
  income: 2,
  btc_buys: 2,
  btc_bill_pays: 6,
};
const FP_A = `sha256:${"a".repeat(64)}`;
const PRIVATE_SENTINELS = [
  "PRIVATE-MERCHANT-0",
  "PRIVATE-NOTE-0",
  "PRIVATE-LOCATOR-0",
  "PRIVATE-REFERENCE-0",
  "8200",
] as const;

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

function income(index: number, overrides: Record<string, unknown> = {}) {
  return {
    kind: "income",
    op_id: `income-op-${index}`,
    record_id: `income-record-${index}`,
    source_locator: `income-locator-${index}`,
    owner: "victor",
    source_file: "income",
    date: `2026-08-${String(index + 1).padStart(2, "0")}`,
    amount_cents: String(500_000 + index),
    source: `Paycheck ${index}`,
    logged_by: "operator",
    note: `Income note ${index}`,
    archimedes_request_id: `request-income-${index}`,
    ...overrides,
  };
}

function btcBuy(index: number, overrides: Record<string, unknown> = {}) {
  const sats = 100_000 + index;
  const priceUsdCents = 11_000_000 + index;
  const usdCents = Math.round((sats * priceUsdCents) / 100_000_000);
  return {
    kind: "btc_buy",
    op_id: `buy-op-${index}`,
    record_id: `buy-record-${index}`,
    source_locator: `buy-locator-${index}`,
    owner: "victor",
    source_file: "bitcoin-buys",
    date: `2026-08-${String(index + 3).padStart(2, "0")}`,
    source: index === 0 ? "River" : "Strike",
    sats: String(sats),
    price_usd_cents: String(priceUsdCents),
    usd_cents: String(usdCents),
    note: `Buy note ${index}`,
    status: "complete",
    cost_basis_status: "known",
    logged_by: "operator",
    archimedes_request_id: `request-buy-${index}`,
    ...overrides,
  };
}

function billPay(index: number, overrides: Record<string, unknown> = {}) {
  const amountUsdCents = 30_000 + index;
  const feeUsdCents = index;
  const btcPriceCents = 12_000_000 + index;
  const btcSpentSats = Math.round(
    ((amountUsdCents + feeUsdCents) * 100_000_000) / btcPriceCents,
  );
  return {
    kind: "btc_bill_pay",
    op_id: `bill-op-${index}`,
    record_id: `bill-record-${index}`,
    source_locator: `bill-locator-${index}`,
    owner: "victor",
    source_file: "bitcoin-bill-pays",
    date: `2026-08-${String(index + 5).padStart(2, "0")}`,
    merchant: `Bill merchant ${index}`,
    // Deliberately absent from the budget category catalog.
    category: "Debt Payoff Outside Budget",
    amount_usd_cents: String(amountUsdCents),
    btc_spent_sats: String(btcSpentSats),
    btc_price_cents: String(btcPriceCents),
    fee_usd_cents: String(feeUsdCents),
    platform: "River",
    note: `Bill note ${index}`,
    reference: `PRIVATE-REFERENCE-${index}`,
    budget_effect: "excluded_from_transactions",
    ...overrides,
  };
}

function productionManifest(batchId = "august-reviewed-batch") {
  return {
    schema: OPERATOR_IMPORT_SCHEMA,
    batch_id: batchId,
    ops: [
      ...Array.from({ length: 82 }, (_, index) => transaction(index)),
      ...Array.from({ length: 2 }, (_, index) => income(index)),
      ...Array.from({ length: 2 }, (_, index) => btcBuy(index)),
      ...Array.from({ length: 6 }, (_, index) => billPay(index)),
    ],
    duplicate_attestations: [],
    budget_advance: {
      source_file: "budget",
      expected_month: "July 2026",
      target_month: "August 2026",
      expected_updated_at_ms: "7000",
      history_mode: "preserve_existing",
    },
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

function cloneManifest<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

describe("operator import internal backend", () => {
  let t: Harness;

  beforeEach(async () => {
    t = convexTest(schema, modules);
    await seedBudgets(t);
  });

  it("preflights the exact 82/2/2/6 batch with zero writes", async () => {
    const before = await world(t);
    const result = await preflight(t, productionManifest());
    const after = await world(t);

    expect(result).toMatchObject({
      contract_version: 1,
      outcome: "ready",
      counts: EXPECTED_COUNTS,
      checks: { authEnforced: true, stateMatched: true },
    });
    expect(result.plan_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.state_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(after).toEqual(before);
  });

  it("rejects new adult Bitcoin history after live balance posting activates", async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert("btcBalanceDocuments", {
        sourceFile: "btc-balance-snapshot",
        owner: "victor",
        schemaVersion: 2n,
        asOf: "2026-08-01T00:00:00.000Z",
        accounts: [],
        totals: {
          sats: 0n,
          fiatCents: 0n,
          exchangeSats: 0n,
          selfCustodySats: 0n,
        },
        postingActivatedAtMs: 1,
        updatedAtMs: 1,
      });
    });

    await expectCode(
      preflight(t, smallManifest([btcBuy(0)])),
      "BTC_POSTING_ALREADY_ACTIVE",
    );
    await expect(preflight(t, smallManifest([transaction(0)]))).resolves.toMatchObject({
      outcome: "ready",
    });
  });

  it("atomically inserts all four row kinds, locks sources, advances only the intended budget fields, records a redacted receipt, and reads back", async () => {
    const manifest = productionManifest();
    const plan = await preflight(t, manifest);
    const applied = await apply(t, manifest, plan);

    expect(applied).toMatchObject({
      contract_version: 1,
      outcome: "applied",
      counts: EXPECTED_COUNTS,
      checks: { receiptRecorded: true, rowsMatched: true, completed: true },
    });

    const state = await world(t);
    expect(state.transactions).toHaveLength(82);
    expect(state.income).toHaveLength(2);
    expect(state.buys).toHaveLength(2);
    expect(state.billPays).toHaveLength(6);
    expect(state.receipts).toHaveLength(1);
    expect(state.locks.map((row) => row.sourceFile).sort()).toEqual([
      "bitcoin-bill-pays",
      "bitcoin-buys",
      "budget",
      "income",
      "transactions",
    ]);

    expect(state.transactions[0]).toMatchObject({
      txId: "tx-record-0",
      owner: "victor",
      date: "2026-08-01",
      month: "2026-08",
      merchant: "PRIVATE-MERCHANT-0",
      amountCents: 8200n,
      category: "Groceries",
      sourceFile: "transactions",
    });
    expect(state.income[0]).toMatchObject({
      sourceKey: "id:income-record-0",
      incomeId: "income-record-0",
      sourceFile: "income",
    });
    expect(state.income[0]).not.toHaveProperty("raw");
    expect(state.income[0]).not.toHaveProperty("migrationSourceIndex");
    expect(state.buys[0]).toMatchObject({
      buyId: "buy-record-0",
      sats: 100_000n,
      sourceFile: "bitcoin-buys",
    });
    expect(state.billPays[0]).toMatchObject({
      billPayId: "bill-record-0",
      category: "Debt Payoff Outside Budget",
      sourceFile: "bitcoin-bill-pays",
    });
    expect(state.transactions.some((row) => row.txId.startsWith("bill-"))).toBe(false);

    const adultBudget = state.budgets.find((row) => row.sourceFile === "budget")!;
    expect(adultBudget).toMatchObject({
      month: "August 2026",
      coinbaseOneBalanceCents: 12_550n,
      categories: [
        { name: "Groceries", icon: "cart", budgetCents: 90_000n },
        { name: "Utilities", icon: "bolt", budgetCents: 40_000n },
      ],
      effectiveApr: "19.99%",
      strategyNote: "Preserve this configuration",
      mtdIncomeCents: 0n,
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
      migrationRawJson: "preserve-raw-config",
      migrationSourceIndex: 9,
    });
    expect(adultBudget.income).toMatchObject({
      mtdIncomeCents: 0n,
      ytdIncomeCents: 3_000_000n,
      paychecks: [{ note: "Preserve paycheck" }],
    });
    expect(state.budgets.find((row) => row.sourceFile === "mason-budget")).toMatchObject({
      month: "July 2026",
      mtdIncomeCents: 111n,
      updatedAtMs: 7100,
    });

    const receiptText = JSON.stringify(state.receipts[0]);
    for (const sentinel of PRIVATE_SENTINELS) expect(receiptText).not.toContain(sentinel);
    expect(Object.keys(state.receipts[0]!).sort()).toEqual([
      "_creationTime",
      "_id",
      "appliedAtMs",
      "batchId",
      "budgetAppliedUpdatedAtMs",
      "budgetExpectedUpdatedAtMs",
      "budgetTargetFingerprint",
      "contractVersion",
      "counts",
      "manifestDigest",
      "planFingerprint",
      "stateFingerprint",
      "untouchedFingerprint",
    ]);

    await expect(t.query(fn.readback, {
      manifest,
      expected_plan_fingerprint: plan.plan_fingerprint,
    })).resolves.toMatchObject({
      contract_version: 1,
      outcome: "verified",
      counts: EXPECTED_COUNTS,
      checks: { rowsMatched: true, aggregatesMatched: true, untouchedMatched: true },
    });
  });

  it("returns already_applied on an exact retry without duplicates or revision changes", async () => {
    const manifest = productionManifest();
    const plan = await preflight(t, manifest);
    await apply(t, manifest, plan);
    const before = await world(t);

    const retry = await apply(t, manifest, plan);
    const after = await world(t);
    expect(retry.outcome).toBe("already_applied");
    expect(after).toEqual(before);
  });

  it("rejects the same batch id with different manifest content", async () => {
    const manifest = productionManifest();
    const plan = await preflight(t, manifest);
    await apply(t, manifest, plan);
    const changed = cloneManifest(manifest);
    const changedTransaction = changed.ops[0]!;
    if (!("amount_cents" in changedTransaction)) throw new Error("fixture drift");
    changedTransaction.amount_cents = "9999";

    await expectCode(preflight(t, changed), "BATCH_ID_CONFLICT");
    expect((await world(t)).receipts).toHaveLength(1);
  });

  it("accepts an existing identical row as a no-op and preserves its revision", async () => {
    const manifest = smallManifest([transaction(0)]);
    await t.run(async (ctx) => {
      await ctx.db.insert("transactions", {
        txId: "tx-record-0",
        owner: "victor",
        date: "2026-08-01",
        month: "2026-08",
        merchant: "PRIVATE-MERCHANT-0",
        amountCents: 8200n,
        category: "Groceries",
        card: "Card",
        note: "PRIVATE-NOTE-0",
        sourceFile: "transactions",
        updatedAtMs: 42,
      });
    });
    const plan = await preflight(t, manifest);
    expect((await apply(t, manifest, plan)).outcome).toBe("applied");
    const state = await world(t);
    expect(state.transactions).toHaveLength(1);
    expect(state.transactions[0]!.updatedAtMs).toBe(42);
    expect(state.locks).toHaveLength(0);
  });

  it("rejects an existing natural key with different content", async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert("transactions", {
        txId: "tx-record-0",
        owner: "victor",
        date: "2026-08-01",
        month: "2026-08",
        merchant: "Different merchant",
        amountCents: 8200n,
        category: "Groceries",
        sourceFile: "transactions",
        updatedAtMs: 42,
      });
    });
    await expectCode(
      preflight(t, smallManifest([transaction(0)])),
      "EXISTING_CONTENT_CONFLICT",
    );
  });

  it("rejects a semantic duplicate already present under another production id", async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert("transactions", {
        txId: "another-id",
        owner: "victor",
        date: "2026-08-01",
        month: "2026-08",
        merchant: " private-merchant-0 ",
        amountCents: 8200n,
        category: "groceries",
        card: "card",
        sourceFile: "transactions",
        updatedAtMs: 1,
      });
    });
    await expectCode(
      preflight(t, smallManifest([transaction(0)])),
      "SEMANTIC_PRODUCTION_DUPLICATE",
    );
  });

  it("blocks a tombstoned natural key", async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert("rowTombstones", {
        entityType: "transaction",
        sourceFile: "transactions",
        entityId: "tx-record-0",
        owner: "victor",
        deletedAtMs: 1,
      });
    });
    await expectCode(
      preflight(t, smallManifest([transaction(0)])),
      "TOMBSTONED_RECORD",
    );
  });

  it("blocks reimport of standalone income deleted by a device", async () => {
    await t.run((ctx) => ctx.db.insert("rowTombstones", {
      entityType: "income", sourceFile: "income", entityId: "income-record-0",
      owner: "victor", deletedAtMs: 1, deletedFromUpdatedAtMs: 0,
    }));
    await expectCode(preflight(t, smallManifest([income(0)])), "TOMBSTONED_RECORD");
  });

  it("an invalid final operation leaves no partial rows, receipt, lock, or budget change", async () => {
    const ops = Array.from({ length: 91 }, (_, index) => transaction(index));
    ops.push(transaction(91, { amount_cents: "not-an-integer" }));
    const manifest = smallManifest(ops, "invalid-final-row", {
      source_file: "budget",
      expected_month: "July 2026",
      target_month: "August 2026",
      expected_updated_at_ms: "7000",
      history_mode: "preserve_existing",
    });
    const before = await world(t);
    await expectCode(preflight(t, manifest), "INVALID_INTEGER");
    const afterPreflight = await world(t);
    expect(afterPreflight).toEqual(before);
    await expectCode(
      t.mutation(fn.apply, {
        manifest,
        expected_plan_fingerprint: FP_A,
        expected_state_fingerprint: FP_A,
      }),
      "INVALID_INTEGER",
    );
    expect(await world(t)).toEqual(before);
  });

  it("rejects a wrong reviewed plan and a stale reviewed state before writes", async () => {
    const manifest = smallManifest([transaction(0)]);
    const plan = await preflight(t, manifest);
    await expectCode(
      t.mutation(fn.apply, {
        manifest,
        expected_plan_fingerprint: FP_A,
        expected_state_fingerprint: plan.state_fingerprint,
      }),
      "REVIEWED_PLAN_MISMATCH",
    );
    expect((await world(t)).receipts).toHaveLength(0);

    await t.run(async (ctx) => {
      await ctx.db.insert("transactions", {
        txId: "tx-record-0",
        owner: "victor",
        date: "2026-08-01",
        month: "2026-08",
        merchant: "PRIVATE-MERCHANT-0",
        amountCents: 8200n,
        category: "Groceries",
        card: "Card",
        note: "PRIVATE-NOTE-0",
        sourceFile: "transactions",
        updatedAtMs: 50,
      });
    });
    const existingPlan = await preflight(t, manifest);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("transactions").first();
      await ctx.db.patch(row!._id, { updatedAtMs: 51 });
    });
    // The plan fingerprint itself binds the complete pre-write state, so a
    // stale state changes both fingerprints and fails at the stronger plan gate.
    await expectCode(apply(t, manifest, existingPlan), "REVIEWED_PLAN_MISMATCH");
    const state = await world(t);
    expect(state.receipts).toHaveLength(0);
    expect(state.locks).toHaveLength(0);
    expect(state.transactions).toHaveLength(1);
  });

  it.each([
    ["wrong live revision", "July 2026", "August 2026", "7001", "BUDGET_STATE_CONFLICT"],
    ["same month", "July 2026", "July 2026", "7000", "INVALID_BUDGET_MONTH_TRANSITION"],
    ["backward", "July 2026", "June 2026", "7000", "INVALID_BUDGET_MONTH_TRANSITION"],
    ["oversized", "July 2026", "September 2028", "7000", "INVALID_BUDGET_MONTH_TRANSITION"],
  ])("rejects a %s budget advance", async (_name, expected, target, revision, code) => {
    const manifest = smallManifest([transaction(0)], `budget-${_name.replaceAll(" ", "-")}`, {
      source_file: "budget",
      expected_month: expected,
      target_month: target,
      expected_updated_at_ms: revision,
      history_mode: "preserve_existing",
    });
    await expectCode(preflight(t, manifest), code);
    expect((await world(t)).receipts).toHaveLength(0);
  });

  it("readback rejects an exact imported-row mismatch", async () => {
    const manifest = smallManifest([transaction(0)]);
    const plan = await preflight(t, manifest);
    await apply(t, manifest, plan);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("transactions").first();
      await ctx.db.patch(row!._id, { note: "tampered" });
    });
    await expectCode(
      t.query(fn.readback, {
        manifest,
        expected_plan_fingerprint: plan.plan_fingerprint,
      }),
      "READBACK_ROW_MISMATCH",
    );
  });

  it("readback rejects a change to untouched ledger state", async () => {
    const manifest = smallManifest([transaction(0)]);
    const plan = await preflight(t, manifest);
    await apply(t, manifest, plan);
    await t.run(async (ctx) => {
      await ctx.db.insert("transactions", {
        txId: "unrelated",
        owner: "victor",
        date: "2026-08-20",
        month: "2026-08",
        merchant: "Unrelated",
        amountCents: 1n,
        category: "Groceries",
        sourceFile: "transactions",
        updatedAtMs: 999,
      });
    });
    await expectCode(
      t.query(fn.readback, {
        manifest,
        expected_plan_fingerprint: plan.plan_fingerprint,
      }),
      "READBACK_UNTOUCHED_MISMATCH",
    );
  });
});
