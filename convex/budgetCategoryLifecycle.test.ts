import { readFileSync } from "node:fs";

import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it } from "vitest";

import {
  freshSecret,
  pairMobileDevice,
  setDeploymentEnv,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";
import schema from "./schema";
import type { DeviceProfile } from "./deviceAuth";

useIsolatedDeploymentEnv();

type FamilyMember = "victor" | "rachel" | "mason" | "maddox";
type BudgetSource = "budget" | "mason-budget";
type DeleteResult = { ok: true; entityId: string; removed: boolean };
type UpsertResult = {
  ok: true;
  entityId: string;
  outcome: "inserted" | "updated";
};

type AcceptedCase = {
  name: string;
  activeProfile: FamilyMember;
  sourceFile: BudgetSource;
  categoryName: string;
  baseUpdatedAtMs: number;
  expectedOwner: "victor" | "mason";
};

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../shared/domain/fixtures/budget-category-deletion-cases.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { contractVersion: number; accepted: AcceptedCase[] };

const modules: Record<string, () => Promise<unknown>> = {
  "./_generated/server.ts": () => import("./generatedServer.test-stub"),
  "./dataFiles.ts": () => import("./dataFiles"),
  "./dateValidation.ts": () => import("./dateValidation"),
  "./deviceAuth.ts": () => import("./deviceAuth"),
  "./migrate.ts": () => import("./migrate"),
  "./tables.ts": () => import("./tables"),
};

const mutation = <Args extends Record<string, unknown>, Result>(path: string) =>
  path as unknown as FunctionReference<"mutation", "public", Args, Result>;

const api = {
  deleteCategory: mutation<Record<string, unknown>, DeleteResult>(
    "tables:deleteBudgetCategoryFromDevice",
  ),
  upsertCategory: mutation<Record<string, unknown>, UpsertResult>(
    "tables:upsertBudgetCategoryFromDevice",
  ),
  migrateFile: "migrate:migrateFile" as unknown as FunctionReference<
    "mutation",
    "internal",
    { file: string },
    unknown
  >,
};

const CURRENT_MONTH = new Date().toISOString().slice(0, 7);

const BUDGET_MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Operator-import spelling for the trusted UTC current month. */
function englishCurrentMonth(canonical = CURRENT_MONTH): string {
  const [year, month] = canonical.split("-");
  return `${BUDGET_MONTH_NAMES[Number(month) - 1]} ${year}`;
}

function lifecycleTestConvex() {
  return convexTest(schema, modules);
}

type T = ReturnType<typeof lifecycleTestConvex>;

let t: T;
let syncToken: string;

beforeEach(() => {
  t = lifecycleTestConvex();
  syncToken = freshSecret();
  setDeploymentEnv({ CONVEX_SYNC_TOKEN: syncToken });
});

async function budgetDevice(
  deviceId: string,
  profile: DeviceProfile = "victor",
) {
  return await pairMobileDevice(t, syncToken, deviceId, ["budget:write"], profile);
}

async function seedBudget(
  sourceFile: BudgetSource,
  owner: "victor" | "mason",
  categories: string[],
  updatedAtMs: number,
  month: string = CURRENT_MONTH,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("budgetDocuments", {
      sourceFile,
      owner,
      month,
      coinbaseOneBalanceCents: 0n,
      categories: categories.map((name) => ({ name, budgetCents: 10_000n })),
      mtdIncomeCents: 0n,
      ytdIncomeCents: 0n,
      monthlyHistory: [],
      updatedAtMs,
    });
    await ctx.db.insert("dataFiles", {
      name: sourceFile,
      data: { deliberately: "stale legacy projection" },
      version: 1,
      updatedAt: 1,
    });
  });
}

async function expectDeviceError(request: Promise<unknown>, code: string) {
  try {
    await request;
    throw new Error(`Expected device error ${code}`);
  } catch (error) {
    expect((error as { data?: { code?: string } }).data?.code).toBe(code);
  }
}

describe("budget category deletion lifecycle", () => {
  it("honors the frozen identities and prevents stale replay or legacy backfill", async () => {
    expect(fixture.contractVersion).toBe(2);
    const device = await budgetDevice("category-lifecycle-device");

    for (const row of fixture.accepted) {
      await seedBudget(
        row.sourceFile,
        row.expectedOwner,
        [row.categoryName, "Keep"],
        row.baseUpdatedAtMs,
      );
      // The credential must carry the budget owner's profile: the resolved
      // owner derives from the credential, not the request (H1). Rachel's
      // credential canonicalizes onto the shared adult budget.
      const device = await budgetDevice(
        `category-lifecycle-${row.expectedOwner}`,
        row.activeProfile,
      );
      const request = {
        deviceId: device.deviceId,
        deviceToken: device.deviceToken,
        owner: row.activeProfile,
        sourceFile: row.sourceFile,
        month: CURRENT_MONTH,
        entityId: row.categoryName.toLocaleLowerCase("en-US"),
        baseUpdatedAtMs: row.baseUpdatedAtMs,
      };

      await expect(t.mutation(api.deleteCategory, request)).resolves.toEqual({
        ok: true,
        entityId: request.entityId,
        removed: true,
      });
      await expect(t.mutation(api.deleteCategory, request)).resolves.toEqual({
        ok: true,
        entityId: request.entityId,
        removed: false,
      });
      await expectDeviceError(
        t.mutation(api.upsertCategory, {
          deviceId: request.deviceId,
          deviceToken: request.deviceToken,
          owner: request.owner,
          sourceFile: request.sourceFile,
          month: request.month,
          baseUpdatedAtMs: request.baseUpdatedAtMs,
          category: { name: row.categoryName, budgetCents: 10_000n },
        }),
        "ENTITY_CONFLICT",
      );
      await expect(
        t.mutation(api.migrateFile, { file: row.sourceFile }),
      ).rejects.toThrow(/RUNTIME_SOURCE_LOCKED/);

      const state = await t.run(async (ctx) => ({
        budget: await ctx.db
          .query("budgetDocuments")
          .withIndex("by_source_file", (q) =>
            q.eq("sourceFile", row.sourceFile),
          )
          .unique(),
        tombstone: await ctx.db
          .query("rowTombstones")
          .withIndex("by_entity", (q) =>
            q
              .eq("entityType", "budgetCategory")
              .eq("sourceFile", row.sourceFile)
              .eq("entityId", request.entityId),
          )
          .unique(),
        lock: await ctx.db
          .query("runtimeSourceLocks")
          .withIndex("by_source_file", (q) =>
            q.eq("sourceFile", row.sourceFile),
          )
          .unique(),
      }));
      expect(state.budget!.categories.map((category) => category.name)).toEqual([
        "Keep",
      ]);
      expect(state.tombstone).toMatchObject({
        owner: row.expectedOwner,
        deletedFromUpdatedAtMs: row.baseUpdatedAtMs,
      });
      expect(state.lock).toMatchObject({ sourceFile: row.sourceFile });
    }
  });

  it("rejects categories used by either contributing owner-scoped ledger", async () => {
    const revision = fixture.accepted[0]!.baseUpdatedAtMs;
    await seedBudget(
      "budget",
      "victor",
      ["Groceries", "Utilities", "Empty"],
      revision,
    );
    const device = await budgetDevice("category-nonempty-device");
    await t.run(async (ctx) => {
      await ctx.db.insert("transactions", {
        txId: "adult-grocery",
        owner: "victor",
        date: `${CURRENT_MONTH}-01`,
        month: CURRENT_MONTH,
        merchant: "Market",
        amountCents: 100n,
        category: "Groceries",
        sourceFile: "transactions",
        updatedAtMs: 1,
      });
      await ctx.db.insert("transactions", {
        txId: "child-empty-name",
        owner: "mason",
        date: `${CURRENT_MONTH}-01`,
        month: CURRENT_MONTH,
        merchant: "School shop",
        amountCents: 100n,
        category: "Empty",
        sourceFile: "mason-transactions",
        updatedAtMs: 1,
      });
      await ctx.db.insert("transactions", {
        txId: "historical-empty-name",
        owner: "victor",
        date: "1900-01-01",
        month: "1900-01",
        merchant: "Old shop",
        amountCents: 100n,
        category: "Empty",
        sourceFile: "transactions",
        updatedAtMs: 1,
      });
      await ctx.db.insert("btcBillPays", {
        billPayId: "adult-utilities",
        owner: "victor",
        date: `${CURRENT_MONTH}-02`,
        month: CURRENT_MONTH,
        merchant: "Utility",
        category: "Utilities",
        budgetEffect: "budget_category",
        amountUsdCents: 100n,
        btcSpentSats: 1n,
        btcPriceCents: 10_000_000n,
        feeUsdCents: 0n,
        sourceFile: "bitcoin-bill-pays",
        updatedAtMs: 1,
      });
      await ctx.db.insert("btcBillPays", {
        billPayId: "excluded-empty-name",
        owner: "victor",
        date: `${CURRENT_MONTH}-03`,
        month: CURRENT_MONTH,
        merchant: "Card",
        category: "Empty",
        budgetEffect: "credit_card_payment",
        amountUsdCents: 100n,
        btcSpentSats: 1n,
        btcPriceCents: 10_000_000n,
        feeUsdCents: 0n,
        sourceFile: "bitcoin-bill-pays",
        updatedAtMs: 1,
      });
    });
    const request = (entityId: string) => ({
      deviceId: device.deviceId,
      deviceToken: device.deviceToken,
      owner: "rachel",
      sourceFile: "budget",
      month: CURRENT_MONTH,
      entityId,
      baseUpdatedAtMs: revision,
    });

    await expectDeviceError(
      t.mutation(api.deleteCategory, request("Groceries")),
      "ENTITY_CONFLICT",
    );
    await expectDeviceError(
      t.mutation(api.deleteCategory, request("Utilities")),
      "ENTITY_CONFLICT",
    );
    const blockedState = await t.run(async (ctx) => ({
      budget: await ctx.db
        .query("budgetDocuments")
        .withIndex("by_source_file", (q) => q.eq("sourceFile", "budget"))
        .unique(),
      tombstones: await ctx.db.query("rowTombstones").collect(),
      locks: await ctx.db.query("runtimeSourceLocks").collect(),
    }));
    expect(blockedState.budget!.categories).toHaveLength(3);
    expect(blockedState.budget!.updatedAtMs).toBe(revision);
    expect(blockedState.tombstones).toEqual([]);
    expect(blockedState.locks).toEqual([]);
    await expect(
      t.mutation(api.deleteCategory, request("Empty")),
    ).resolves.toMatchObject({ removed: true });
  });

  it("rejects wrong profiles, stale or invalid revisions, and historical months", async () => {
    const revision = fixture.accepted[0]!.baseUpdatedAtMs;
    await seedBudget("budget", "victor", ["Groceries"], revision);
    const device = await budgetDevice("category-fence-device");
    const request = {
      deviceId: device.deviceId,
      deviceToken: device.deviceToken,
      owner: "victor",
      sourceFile: "budget",
      month: CURRENT_MONTH,
      entityId: "Groceries",
      baseUpdatedAtMs: revision,
    };

    // The credential profile gates the request owner before the owner↔source
    // mapping is ever consulted.
    await expectDeviceError(
      t.mutation(api.deleteCategory, { ...request, owner: "maddox" }),
      "OWNER_MISMATCH",
    );
    await expectDeviceError(
      t.mutation(api.deleteCategory, {
        ...request,
        baseUpdatedAtMs: revision - 1,
      }),
      "ENTITY_CONFLICT",
    );
    for (const baseUpdatedAtMs of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expectDeviceError(
        t.mutation(api.deleteCategory, { ...request, baseUpdatedAtMs }),
        "VALIDATION_FAILED",
      );
    }
    await expectDeviceError(
      t.mutation(api.deleteCategory, { ...request, month: "1900-01" }),
      "ENTITY_CONFLICT",
    );

    const state = await t.run(async (ctx) => ({
      budget: await ctx.db
        .query("budgetDocuments")
        .withIndex("by_source_file", (q) => q.eq("sourceFile", "budget"))
        .unique(),
      tombstones: await ctx.db.query("rowTombstones").collect(),
      locks: await ctx.db.query("runtimeSourceLocks").collect(),
    }));
    expect(state.budget!.categories.map((category) => category.name)).toEqual([
      "Groceries",
    ]);
    expect(state.budget!.updatedAtMs).toBe(revision);
    expect(state.tombstones).toEqual([]);
    expect(state.locks).toEqual([]);
  });

  it("matches operator English month labels against device yyyy-MM without rewriting", async () => {
    const revision = fixture.accepted[0]!.baseUpdatedAtMs;
    const storedMonth = englishCurrentMonth();
    await seedBudget("budget", "victor", ["Groceries", "Keep"], revision, storedMonth);
    const device = await budgetDevice("category-english-month-device");
    const auth = {
      deviceId: device.deviceId,
      deviceToken: device.deviceToken,
      owner: "victor" as const,
      sourceFile: "budget" as const,
      month: CURRENT_MONTH,
    };

    await expect(
      t.mutation(api.upsertCategory, {
        ...auth,
        baseUpdatedAtMs: revision,
        category: { name: "Groceries", budgetCents: 12_500n },
      }),
    ).resolves.toMatchObject({ ok: true, outcome: "updated" });

    const afterUpsert = await t.run(async (ctx) =>
      ctx.db
        .query("budgetDocuments")
        .withIndex("by_source_file", (q) => q.eq("sourceFile", "budget"))
        .unique(),
    );
    expect(afterUpsert!.month).toBe(storedMonth);
    expect(afterUpsert!.categories).toEqual([
      { name: "Groceries", budgetCents: 12_500n },
      { name: "Keep", budgetCents: 10_000n },
    ]);

    await expect(
      t.mutation(api.deleteCategory, {
        ...auth,
        entityId: "Groceries",
        baseUpdatedAtMs: afterUpsert!.updatedAtMs,
      }),
    ).resolves.toEqual({
      ok: true,
      entityId: "Groceries",
      removed: true,
    });

    const afterDelete = await t.run(async (ctx) =>
      ctx.db
        .query("budgetDocuments")
        .withIndex("by_source_file", (q) => q.eq("sourceFile", "budget"))
        .unique(),
    );
    expect(afterDelete!.month).toBe(storedMonth);
    expect(afterDelete!.categories.map((category) => category.name)).toEqual([
      "Keep",
    ]);
  });
});
