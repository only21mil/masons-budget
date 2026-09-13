import type { FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it } from "vitest";
import { freshSecret, pairMobileDevice, setDeploymentEnv, testConvex, useIsolatedDeploymentEnv } from "./harness.test-utils";
import type { DeviceProfile } from "./deviceAuth";
useIsolatedDeploymentEnv();
const mutation = (path: string) => path as unknown as FunctionReference<"mutation", "public", Record<string, unknown>, unknown>;
const upsert = mutation("tables:upsertIncomeFromDevice");
const remove = mutation("tables:deleteIncomeFromDevice");
const date = new Date().toISOString().slice(0, 10);
let t: ReturnType<typeof testConvex>;
let token: string;
beforeEach(() => { t = testConvex(); token = freshSecret(); setDeploymentEnv({ CONVEX_SYNC_TOKEN: token }); });
const device = async (profile: DeviceProfile = "victor", capabilities: Array<"transactions:write" | "todos:write"> = ["transactions:write"]) => { const { deviceId, deviceToken } = await pairMobileDevice(t, token, `income-${profile}`, capabilities, profile); return { deviceId, deviceToken }; };
const input = (owner = "victor", id = "income-1") => ({ owner, sourceFile: "income", income: { id, owner, date, amountCents: 12345n, source: "Salary" } });
const row = () => t.run((ctx) => ctx.db.query("income").first());
const state = () => t.run(async (ctx) => ({ income: await ctx.db.query("income").collect(), devices: await ctx.db.query("mobileDevices").collect(), tombstones: await ctx.db.query("rowTombstones").collect(), locks: await ctx.db.query("runtimeSourceLocks").collect() }));

describe("standalone device income", () => {
  it("canonicalizes adult owners, retries once, and fences corrections", async () => {
    const credential = await device("rachel");
    const request = { ...credential, ...input("rachel") };
    expect(await t.mutation(upsert, request)).toMatchObject({ outcome: "inserted" });
    const first = (await row())!;
    expect(first.owner).toBe("victor");
    expect(first.sourceKey).toBe("id:income-1");
    expect(await t.mutation(upsert, request)).toMatchObject({ outcome: "updated" });
    expect(await row()).toEqual(first);
    const correction = { ...request, income: { ...request.income, amountCents: 22222n } };
    await expect(t.mutation(upsert, correction)).rejects.toThrow(/REVISION_REQUIRED/);
    await expect(t.mutation(upsert, { ...correction, baseUpdatedAtMs: first.updatedAtMs - 1 })).rejects.toThrow(/ENTITY_CONFLICT/);
    await t.mutation(upsert, { ...correction, baseUpdatedAtMs: first.updatedAtMs });
    expect((await row())!.updatedAtMs).toBeGreaterThan(first.updatedAtMs);
    expect((await row())!.amountCents).toBe(22222n);
    expect(await t.run((ctx) => ctx.db.query("transactions").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("btcBuys").collect())).toEqual([]);
  });
  it("updates and deletes migrated income without duplicating provenance-based source keys", async () => {
    const credential = await device();
    await t.run((ctx) => ctx.db.insert("income", { incomeId: "legacy-key", sourceKey: "hash:legacy-key", owner: "victor", date, month: date.slice(0, 7), amountCents: 100n, source: "Old source", sourceFile: "income", updatedAtMs: 42, raw: { historical: true } }));
    await t.mutation(upsert, { ...credential, ...input("victor", "legacy-key"), baseUpdatedAtMs: 42 });
    const rows = await t.run((ctx) => ctx.db.query("income").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceKey: "hash:legacy-key", raw: { historical: true }, amountCents: 12345n });
    await t.mutation(remove, { ...credential, owner: "victor", sourceFile: "income", entityId: "legacy-key", baseUpdatedAtMs: rows[0]!.updatedAtMs });
    expect(await row()).toBeNull();
  });

  it("requires transactions capability for create and delete without changing state", async () => {
    const credential = await device("victor", ["todos:write"]);
    const before = await state();
    await expect(t.mutation(upsert, { ...credential, ...input() })).rejects.toThrow(/DEVICE_UNAUTHORIZED/);
    await expect(t.mutation(remove, { ...credential, owner: "victor", sourceFile: "income", entityId: "income-1", baseUpdatedAtMs: 1 })).rejects.toThrow(/DEVICE_UNAUTHORIZED/);
    expect(await state()).toEqual(before);
  });
  it("isolates child writes and reads, including collisions with another owner's id", async () => {
    const mason = await device("mason");
    const adult = await device();
    await t.mutation(upsert, { ...adult, ...input("victor", "adult-income") });
    for (const owner of ["victor", "rachel", "maddox"]) {
      await expect(t.mutation(upsert, { ...mason, ...input(owner) })).rejects.toThrow(/OWNER_MISMATCH/);
    }
    await expect(t.mutation(upsert, { ...mason, ...input("mason", "adult-income") })).rejects.toThrow(/OWNER_MISMATCH/);
    await t.mutation(upsert, { ...mason, ...input("mason", "child-income") });
    const list = "tables:listIncome" as unknown as FunctionReference<"query", "public", Record<string, unknown>, { rows: Array<{ owner: string }> }>;
    const childRows = await t.query(list, { ...mason, viewer: "mason" });
    expect(childRows.rows.map((entry) => entry.owner)).toEqual(["mason"]);
    const adultRows = await t.query(list, { ...adult, viewer: "victor" });
    expect(adultRows.rows.map((entry) => entry.owner).sort()).toEqual(["mason", "victor"]);
    const adultRow = (await t.run((ctx) => ctx.db.query("income").collect())).find((entry) => entry.owner === "victor")!;
    await expect(t.mutation(remove, { ...mason, owner: "mason", sourceFile: "income", entityId: "adult-income", baseUpdatedAtMs: adultRow.updatedAtMs })).rejects.toThrow(/OWNER_MISMATCH/);
  });
  it("deletes with a revision tombstone, retries exactly, and rejects resurrection", async () => {
    const credential = await device();
    const request = { ...credential, ...input() };
    await t.mutation(upsert, request);
    const first = (await row())!;
    const deletion = { ...credential, owner: "victor", sourceFile: "income", entityId: "income-1", baseUpdatedAtMs: first.updatedAtMs };
    await expect(t.mutation(remove, { ...deletion, baseUpdatedAtMs: first.updatedAtMs - 1 })).rejects.toThrow(/ENTITY_CONFLICT/);
    expect(await t.mutation(remove, deletion)).toMatchObject({ removed: true });
    expect(await t.mutation(remove, deletion)).toMatchObject({ removed: false });
    expect(await row()).toBeNull();
    expect((await state()).tombstones[0]).toMatchObject({ entityType: "income", entityId: "income-1", owner: "victor", deletedFromUpdatedAtMs: first.updatedAtMs });
    await expect(t.mutation(upsert, request)).rejects.toThrow(/ENTITY_DELETED/);
    await expect(t.mutation(remove, { ...deletion, entityId: "never-seen" })).rejects.toThrow(/ENTITY_NOT_FOUND/);
    await expect(t.mutation(remove, { ...deletion, baseUpdatedAtMs: first.updatedAtMs - 1 })).rejects.toThrow(/ENTITY_CONFLICT/);
  });
  it("rejects invalid amount, date, source, identity, and mismatched nested owner atomically", async () => {
    const credential = await device();
    const valid = input();
    for (const patch of [{ amountCents: 0n }, { amountCents: -1n }, { date: "2026-02-30" }, { source: "" }, { source: "   " }, { id: " spaced " }, { owner: "mason" }]) {
      const before = await state();
      await expect(t.mutation(upsert, { ...credential, ...valid, income: { ...valid.income, ...patch } })).rejects.toThrow();
      expect(await state()).toEqual(before);
    }
  });
  it("preserves linked-buy income against standalone changes and deletion", async () => {
    const credential = await device();
    await t.mutation(upsert, { ...credential, ...input() });
    await t.run((ctx) => ctx.db.insert("btcBuys", { buyId: "income-1", owner: "victor", date, month: date.slice(0, 7), source: "Salary", sats: 100n, priceUsdCents: 100n, usdCents: 12345n, feeUsdCents: 0n, sourceFile: "bitcoin-buys", updatedAtMs: Date.now(), linkedIncomeId: "income-1" }));
    const original = (await row())!;
    await expect(t.mutation(upsert, { ...credential, ...input(), baseUpdatedAtMs: original.updatedAtMs })).rejects.toThrow(/VALIDATION_FAILED/);
    await expect(t.mutation(remove, { ...credential, owner: "victor", sourceFile: "income", entityId: "income-1", baseUpdatedAtMs: original.updatedAtMs })).rejects.toThrow(/VALIDATION_FAILED/);
    expect(await row()).toEqual(original);
  });
  it("rejects resurrecting deleted income through the linked-buy writer", async () => {
    const credential = await device();
    await t.mutation(upsert, { ...credential, ...input() });
    await t.mutation(remove, { ...credential, owner: "victor", sourceFile: "income", entityId: "income-1", baseUpdatedAtMs: (await row())!.updatedAtMs });
    await expect(t.mutation(mutation("tables:upsertBtcBuy"), { token, sourceFile: "bitcoin-buys", buy: { id: "income-1", owner: "victor", date, source: "Salary", sats: 100n, priceUsdCents: 100n, usdCents: 12345n }, linkedIncome: { ...input().income, sourceFile: "income" } })).rejects.toThrow(/ENTITY_DELETED/);
    expect(await row()).toBeNull();
  });
});
