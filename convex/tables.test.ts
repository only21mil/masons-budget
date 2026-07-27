// convex/tables.ts — row-table runtime API, visibility and auth.
//
// The four things these tests exist to stop, in order of how much they would
// cost if they happened:
//
//   1. Row-table work mutating `dataFiles`. Every shipped client still reads
//      the blobs and this is the only copy of the family's financial record.
//   2. A child's row landing on an adult owner, or an adult's row disappearing
//      from Rachel's screens. canSee is WIDER than sharesNetWorth; both
//      directions are asserted, on the same data, in the same test.
//   3. Money going through a float.
//   4. The auth mirror in tables.ts drifting from the gates in dataFiles.ts.
import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";

import schema from "./schema";
import {
  freshSecret,
  seedDataFile,
  setDeploymentEnv,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";

// A local module map rather than the shared one in harness.test-utils.ts:
// tables.ts is new and other lanes are editing that file right now, so this
// suite registers exactly what it needs and touches nothing shared.
const modules: Record<string, () => Promise<unknown>> = {
  "./_generated/server.ts": () => import("./generatedServer.test-stub"),
  "./dataFiles.ts": () => import("./dataFiles"),
  "./migrate.ts": () => import("./migrate"),
  "./tables.ts": () => import("./tables"),
  "./todoNormalize.ts": () => import("./todoNormalize"),
};

function testTables() {
  return convexTest(schema, modules);
}

type T = ReturnType<typeof testTables>;
type Member = "victor" | "rachel" | "mason" | "maddox";
type Scope = "visible" | "netWorth";

const fn = {
  listTransactions: "tables:listTransactions" as unknown as FunctionReference<
    "query",
    "public",
    { viewer: Member; month?: string; limit?: number; token?: string },
    Array<{
      txId: string;
      owner: Member;
      date: string;
      month: string;
      merchant: string;
      amountCents: bigint;
      category: string;
      card?: string;
      note?: string;
      sourceFile: string;
    }>
  >,
  listTodos: "tables:listTodos" as unknown as FunctionReference<
    "query",
    "public",
    { viewer: Member; done?: boolean; limit?: number; token?: string },
    Array<{
      todoId: string;
      owner: Member;
      title: string;
      done: boolean;
      flagged: boolean;
      due?: string;
      updatedAtMs: number;
    }>
  >,
  listBtcBuys: "tables:listBtcBuys" as unknown as FunctionReference<
    "query",
    "public",
    { viewer: Member; scope?: Scope; month?: string; token?: string },
    Array<{
      buyId: string;
      owner: Member;
      date: string;
      sats: bigint;
      priceUsdCents: bigint;
      usdCents: bigint;
      sourceFile: string;
    }>
  >,
  listBtcAccounts: "tables:listBtcAccounts" as unknown as FunctionReference<
    "query",
    "public",
    { viewer: Member; scope?: Scope; token?: string },
    Array<{
      key: string;
      owner: Member;
      label: string;
      custody: "exchange" | "self_custody";
      sats: bigint;
      fiatCents: bigint;
    }>
  >,
  rowCounts: "tables:rowCounts" as unknown as FunctionReference<
    "query",
    "public",
    { token?: string },
    {
      transactions: number;
      todos: number;
      btcBuys: number;
      btcAccounts: number;
    }
  >,
  migrateFile: "migrate:migrateFile" as unknown as FunctionReference<
    "mutation",
    "internal",
    { file: string; apply?: boolean; cursor?: number; batchSize?: number },
    unknown
  >,
  upsertTransaction: "tables:upsertTransaction" as unknown as FunctionReference<
    "mutation",
    "public",
    {
      transaction: {
        id: string;
        date: string;
        merchant: string;
        amountCents: bigint;
        category: string;
        card?: string;
        note?: string;
        owner?: Member;
      };
      sourceFile?: string;
      token?: string;
    },
    { txId: string; owner: Member; month: string; outcome: string }
  >,
  upsertTodo: "tables:upsertTodo" as unknown as FunctionReference<
    "mutation",
    "public",
    { todo: Record<string, unknown>; token?: string },
    { todoId: string; owner: Member; done: boolean; outcome: string }
  >,
  deleteTodo: "tables:deleteTodo" as unknown as FunctionReference<
    "mutation",
    "public",
    { todoId: string; token?: string },
    { todoId: string; removed: boolean }
  >,
  upsertBtcBuy: "tables:upsertBtcBuy" as unknown as FunctionReference<
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
        owner?: Member;
      };
      sourceFile?: string;
      token?: string;
    },
    { buyId: string; owner: Member; month: string; outcome: string }
  >,
  upsertBtcAccount: "tables:upsertBtcAccount" as unknown as FunctionReference<
    "mutation",
    "public",
    {
      account: {
        key: string;
        owner: Member;
        label: string;
        custody: "exchange" | "self_custody";
        sats: bigint;
        fiatCents: bigint;
        asOf: string;
        schemaVersion?: bigint;
      };
      sourceFile?: string;
      token?: string;
    },
    { key: string; owner: Member; outcome: string }
  >,
  // dataFiles entry points, used only by the auth-parity block.
  dataFilesGet: "dataFiles:get" as unknown as FunctionReference<
    "query",
    "public",
    { name: string; token?: string },
    unknown
  >,
  dataFilesSync: "dataFiles:sync" as unknown as FunctionReference<
    "mutation",
    "public",
    { name: string; data: unknown; token?: string },
    { name: string; version: number }
  >,
};

useIsolatedDeploymentEnv();

/**
 * Open both gates for the tests that are not about auth.
 *
 * The hatch outranks the token by design (see the banner in dataFiles.ts), so
 * this is the one setting that reliably admits every call without a secret
 * appearing anywhere in this file.
 */
function openGates() {
  setDeploymentEnv({
    ALLOW_TOKENLESS_READ: "true",
    ALLOW_TOKENLESS_SYNC: "true",
  });
}

// ── Synthetic fixtures. Shapes match MC2; none of the values are real. ──

const ADULT_TRANSACTIONS = [
  {
    id: "t-1",
    date: "2026-07-03",
    merchant: "Grocer",
    amount: -84.27,
    category: "Groceries",
    card: "amex",
    note: null,
  },
  {
    id: "t-2",
    date: "2026-07-19",
    merchant: "Payroll",
    amount: 2500,
    category: "Income",
    card: null,
    note: "",
  },
  {
    id: "t-3",
    date: "2026-06-28",
    merchant: "Hardware",
    amount: -1.15,
    category: "Home",
  },
];

// Child files record spend as a POSITIVE magnitude; adult files sign it
// negative. The row keeps the source's sign and records sourceFile so the
// convention stays recoverable.
const MASON_TRANSACTIONS = [
  { id: "m-1", date: "2026-07-04", merchant: "Game Store", amount: 60, category: "Fun" },
];

const ADULT_BUYS = [
  {
    id: "b-1",
    date: "2026-07-02",
    source: "strike",
    amount_sats: 250000,
    amount_btc: 0.0025,
    price_usd: 98000.5,
    usd: 245,
    status: "settled",
    logged_by: "mc2",
  },
];

const MASON_BUYS = [
  {
    id: "mb-1",
    date: "2026-07-05",
    source: "river",
    amount_btc: 0.001,
    price_usd: 99000,
    usd: 99,
  },
];

const SNAPSHOT = {
  schemaVersion: 2,
  asOf: "2026-07-18T12:00:00Z",
  accounts: {
    strike: { btc: 0.35, fiat: 34300.55, label: "Strike", custody: "exchange" },
    coldcard: { btc: 1.5, fiat: 147000, label: "Coldcard", custody: "self_custody" },
  },
  totals: { btc: 1.85, fiat: 181300.55 },
};

const SON_BALANCES = {
  strike: 0.004,
  river: 0.002,
  coldcard: 0.01,
  total: 0.016,
  lastUpdated: "2026-07-18T12:00:00Z",
};

const TODOS = [
  { id: "todo-1", title: "Pay the water bill", done: false, updated_at: "2026-07-10T09:00:00Z" },
  {
    id: "todo-2",
    title: "Mason: tidy room",
    owner: "mason",
    done: true,
    completed: true,
    updated_at: "2026-07-11T09:00:00Z",
  },
];

async function seedAll(t: T) {
  await seedDataFile(t, "transactions", ADULT_TRANSACTIONS);
  await seedDataFile(t, "mason-transactions", MASON_TRANSACTIONS);
  await seedDataFile(t, "bitcoin-buys", ADULT_BUYS);
  await seedDataFile(t, "mason-bitcoin-buys", MASON_BUYS);
  await seedDataFile(t, "btc-balance-snapshot", SNAPSHOT);
  await seedDataFile(t, "son-balances", SON_BALANCES);
  await seedDataFile(t, "todos", TODOS);
}

async function migrateAll(t: T) {
  for (const name of [
    "transactions",
    "mason-transactions",
    "bitcoin-buys",
    "mason-bitcoin-buys",
    "todos",
  ]) {
    await t.mutation(fn.migrateFile, { file: name, apply: true });
  }

  // btcAccounts is part of E1's runtime API but deliberately has no E2
  // migration. Seed it through that runtime API so these remain table/query
  // tests rather than inventing a second migration path.
  for (const account of [
    {
      key: "strike",
      owner: "victor" as const,
      label: "Strike",
      custody: "exchange" as const,
      sats: 35_000_000n,
      fiatCents: 3_430_055n,
      asOf: SNAPSHOT.asOf,
      schemaVersion: 2n,
    },
    {
      key: "coldcard",
      owner: "victor" as const,
      label: "Coldcard",
      custody: "self_custody" as const,
      sats: 150_000_000n,
      fiatCents: 14_700_000n,
      asOf: SNAPSHOT.asOf,
      schemaVersion: 2n,
    },
    {
      key: "son-strike-mason",
      owner: "mason" as const,
      label: "Strike",
      custody: "exchange" as const,
      sats: 400_000n,
      fiatCents: 0n,
      asOf: SON_BALANCES.lastUpdated,
    },
    {
      key: "son-river-mason",
      owner: "mason" as const,
      label: "River",
      custody: "exchange" as const,
      sats: 200_000n,
      fiatCents: 0n,
      asOf: SON_BALANCES.lastUpdated,
    },
    {
      key: "son-coldcard-mason",
      owner: "mason" as const,
      label: "Coldcard",
      custody: "self_custody" as const,
      sats: 1_000_000n,
      fiatCents: 0n,
      asOf: SON_BALANCES.lastUpdated,
    },
  ]) {
    await t.mutation(fn.upsertBtcAccount, { account });
  }
}

/**
 * Overwrite a blob that seedAll() already created.
 *
 * seedDataFile inserts, so calling it twice for one name leaves two documents
 * and the migration's `.first()` silently keeps reading the original — a test
 * that looks like it changed the input but did not.
 */
async function replaceDataFile(t: T, name: string, data: unknown) {
  await t.run(async (ctx) => {
    const doc = await ctx.db
      .query("dataFiles")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    if (!doc) throw new Error(`replaceDataFile: no seeded blob named ${name}`);
    await ctx.db.patch(doc._id, { data });
  });
}

/** Everything in `dataFiles` + its two satellite tables, as a comparable value. */
async function blobWorldSnapshot(t: T) {
  return await t.run(async (ctx) => {
    const files = await ctx.db.query("dataFiles").collect();
    const versions = await ctx.db.query("syncVersions").collect();
    const tombstones = await ctx.db.query("todoTombstones").collect();
    const strip = (docs: Array<Record<string, unknown>>) =>
      docs
        .map(({ _creationTime: _ignored, ...rest }) => rest)
        .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    return {
      files: strip(files),
      versions: strip(versions),
      tombstones: strip(tombstones),
    };
  });
}

let t: T;

beforeEach(async () => {
  t = testTables();
  openGates();
  await seedAll(t);
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the blob path is untouched", () => {
  it("the row mutations do not write dataFiles either", async () => {
    const before = await blobWorldSnapshot(t);

    await t.mutation(fn.upsertTransaction, {
      transaction: {
        id: "app-1",
        date: "2026-07-20",
        merchant: "Cafe",
        amountCents: -450n,
        category: "Food",
      },
    });
    await t.mutation(fn.upsertTodo, { todo: { id: "app-todo", title: "Ship it" } });
    await t.mutation(fn.deleteTodo, { todoId: "app-todo" });

    expect(await blobWorldSnapshot(t)).toEqual(before);
  });

  it("deleteTodo writes no tombstone — that table belongs to the blob path", async () => {
    await migrateAll(t);
    await t.mutation(fn.deleteTodo, { todoId: "todo-1" });

    const tombstones = await t.run(async (ctx) =>
      ctx.db.query("todoTombstones").collect(),
    );
    expect(tombstones).toHaveLength(0);
    expect(await t.query(fn.listTodos, { viewer: "victor" })).not.toContainEqual(
      expect.objectContaining({ todoId: "todo-1" }),
    );
  });
});

describe("money is integer minor units", () => {
  beforeEach(async () => {
    await migrateAll(t);
  });

  it("stores cents as bigint, never a float", async () => {
    const rows = await t.query(fn.listTransactions, { viewer: "victor" });
    for (const row of rows) {
      expect(typeof row.amountCents).toBe("bigint");
    }
  });

  it("parses through the lexical form, so 1.15 does not become 114 cents", async () => {
    // 1.15 * 100 === 114.99999999999999 in IEEE double, so anything that
    // truncates rather than rounds loses a cent here.
    //
    // Honest limit of this assertion: for the 2-dp USD and 8-dp BTC that MC2
    // actually emits, `Math.round(x * 100)` agrees with the lexical parser on
    // every value (checked exhaustively over the realistic range). The lexical
    // parser is here for robustness and for the string-valued amounts the
    // v.any() blob permits, not because the two disagree on this fixture.
    const rows = await t.query(fn.listTransactions, { viewer: "victor" });
    const hardware = rows.find((row) => row.txId === "t-3");
    expect(hardware?.amountCents).toBe(-115n);
  });

  it("keeps the sign the source file used", async () => {
    const rows = await t.query(fn.listTransactions, { viewer: "victor" });
    const adultSpend = rows.find((row) => row.txId === "t-1");
    const childSpend = rows.find((row) => row.txId === "m-1");

    // Adult files sign spending negative…
    expect(adultSpend?.amountCents).toBe(-8427n);
    expect(adultSpend?.sourceFile).toBe("transactions");
    // …child files record it as a positive magnitude. Both survive verbatim,
    // and sourceFile is what makes the convention recoverable per row.
    expect(childSpend?.amountCents).toBe(6000n);
    expect(childSpend?.sourceFile).toBe("mason-transactions");
  });

  it("prefers amount_sats over the lossy amount_btc mirror", async () => {
    const buys = await t.query(fn.listBtcBuys, { viewer: "victor" });
    const adult = buys.find((buy) => buy.buyId === "b-1");
    expect(adult?.sats).toBe(250000n);
    expect(adult?.priceUsdCents).toBe(9800050n);
    expect(adult?.usdCents).toBe(24500n);

    // …and falls back to amount_btc at 8 dp when the integer field is absent.
    const child = buys.find((buy) => buy.buyId === "mb-1");
    expect(child?.sats).toBe(100000n);
  });

  it("converts snapshot balances to sats and cents", async () => {
    const accounts = await t.query(fn.listBtcAccounts, { viewer: "victor" });
    const strike = accounts.find(
      (account) => account.key === "strike" && account.owner === "victor",
    );
    expect(strike?.sats).toBe(35000000n);
    expect(strike?.fiatCents).toBe(3430055n);
  });
});

describe("owner is first class, and the two visibility rules keep their widths", () => {
  beforeEach(async () => {
    await migrateAll(t);
  });

  it("adult records default to victor and Rachel still sees all of them", async () => {
    // The v0.3 bug: adult records carry owner "victor", so a strict
    // `owner === viewer` check leaves Rachel with empty screens.
    const victorRows = await t.query(fn.listTransactions, { viewer: "victor" });
    const rachelRows = await t.query(fn.listTransactions, { viewer: "rachel" });

    expect(victorRows.map((row) => row.txId).sort()).toEqual(
      rachelRows.map((row) => row.txId).sort(),
    );
    expect(rachelRows.length).toBeGreaterThan(0);
    expect(rachelRows.some((row) => row.owner === "victor")).toBe(true);
  });

  it("adults see the kids; kids see only themselves", async () => {
    const adult = await t.query(fn.listTransactions, { viewer: "rachel" });
    expect(adult.map((row) => row.owner)).toContain("mason");

    const mason = await t.query(fn.listTransactions, { viewer: "mason" });
    expect(mason.map((row) => row.owner)).toEqual(["mason"]);

    const maddox = await t.query(fn.listTransactions, { viewer: "maddox" });
    expect(maddox).toEqual([]);
  });

  it("canSee is WIDER than sharesNetWorth, on the same data, for the same adult", async () => {
    const visible = await t.query(fn.listBtcAccounts, {
      viewer: "victor",
      scope: "visible",
    });
    const netWorth = await t.query(fn.listBtcAccounts, {
      viewer: "victor",
      scope: "netWorth",
    });

    // Victor can SEE Mason's Coldcard on Mason's profile…
    expect(visible.map((a) => a.owner)).toContain("mason");
    // …and it must NOT be part of adult net worth.
    expect(netWorth.map((a) => a.owner)).not.toContain("mason");
    expect(netWorth.every((a) => a.owner === "victor" || a.owner === "rachel")).toBe(
      true,
    );
    // Backwards would mean either a leak or an empty screen; assert the gap is
    // real rather than the two queries having quietly become one.
    expect(netWorth.length).toBeLessThan(visible.length);
  });

  it("the same widths hold for btcBuys", async () => {
    const visible = await t.query(fn.listBtcBuys, {
      viewer: "victor",
      scope: "visible",
    });
    const netWorth = await t.query(fn.listBtcBuys, {
      viewer: "victor",
      scope: "netWorth",
    });
    expect(visible.map((b) => b.buyId)).toContain("mb-1");
    expect(netWorth.map((b) => b.buyId)).not.toContain("mb-1");
  });

  it("a child sharing an account key with an adult stays a separate row", async () => {
    // Both the adults and Mason have a "strike" account. Identity is
    // (owner, key); merging on key alone would put a child's stack in the
    // adult total.
    const accounts = await t.query(fn.listBtcAccounts, { viewer: "victor" });
    const mason = accounts.filter((account) => account.owner === "mason");
    expect(mason.map((account) => account.key).sort()).toEqual([
      "son-coldcard-mason",
      "son-river-mason",
      "son-strike-mason",
    ]);
    expect(mason.find((a) => a.key === "son-strike-mason")?.sats).toBe(400000n);
  });

  it("a garbage owner string in a CHILD file falls back to the child, not to an adult", async () => {
    // coerceOwner in the domain layer maps anything unrecognised to "victor",
    // an ADULT. Doing that to a row out of mason-transactions.json would put a
    // child's spending into the adult household view and into adult net worth.
    await seedDataFile(t, "maddox-transactions", [
      { id: "x-1", date: "2026-07-08", merchant: "Sweets", amount: 5, category: "Fun", owner: "Maddox " },
    ]);
    await t.mutation(fn.migrateFile, {
      file: "maddox-transactions",
      apply: true,
    });

    const row = (await t.query(fn.listTransactions, { viewer: "victor" })).find(
      (candidate) => candidate.txId === "x-1",
    );
    expect(row?.owner).toBe("maddox");

    const maddox = await t.query(fn.listTransactions, { viewer: "maddox" });
    expect(maddox.map((candidate) => candidate.txId)).toEqual(["x-1"]);
  });

  it("a recognised owner inside a file still wins over the file's default", async () => {
    await t.mutation(fn.upsertTodo, {
      todo: {
        id: "todo-3",
        title: "Mason chore",
        owner: "mason",
        updated_at: "2026-07-12T09:00:00Z",
      },
    });

    const mason = await t.query(fn.listTodos, { viewer: "mason" });
    expect(mason.map((todo) => todo.todoId)).toContain("todo-3");
  });
});

describe("indexed month and date", () => {
  beforeEach(async () => {
    await migrateAll(t);
  });

  it("derives month from date as a prefix, with no timezone in the way", async () => {
    const july = await t.query(fn.listTransactions, {
      viewer: "victor",
      month: "2026-07",
    });
    expect(july.map((row) => row.txId).sort()).toEqual(["m-1", "t-1", "t-2"]);
    expect(july.every((row) => row.month === "2026-07")).toBe(true);

    const june = await t.query(fn.listTransactions, {
      viewer: "victor",
      month: "2026-06",
    });
    expect(june.map((row) => row.txId)).toEqual(["t-3"]);
  });

  it("returns newest first and honours limit", async () => {
    const rows = await t.query(fn.listTransactions, { viewer: "victor", limit: 2 });
    expect(rows.map((row) => row.date)).toEqual(["2026-07-19", "2026-07-04"]);
  });

  it("a limit returns the newest overall, not the newest of one bucket", async () => {
    // listTodos reads by_owner_done, which orders by (owner, done, updatedAtMs).
    // Taking N from an owner-only range would hand back N *done* todos and no
    // open ones, because `done` sorts before the timestamp.
    // Both of these belong to the SAME owner, which is what makes the bucket
    // matter: the done one sorts ahead of the open one on the index even though
    // it is older.
    await t.mutation(fn.upsertTodo, {
      todo: {
        id: "older-done",
        title: "Older but done",
        done: true,
        updated_at: "2026-07-20T09:00:00Z",
      },
    });
    await t.mutation(fn.upsertTodo, {
      todo: {
        id: "recent-open",
        title: "Newest",
        done: false,
        updated_at: "2026-07-30T09:00:00Z",
      },
    });

    const newest = await t.query(fn.listTodos, { viewer: "victor", limit: 1 });
    expect(newest.map((todo) => todo.todoId)).toEqual(["recent-open"]);
  });

  it("scopes a month query to one owner for a child viewer", async () => {
    const rows = await t.query(fn.listTransactions, {
      viewer: "mason",
      month: "2026-07",
    });
    expect(rows.map((row) => row.txId)).toEqual(["m-1"]);
  });
});

describe("row mutations", () => {
  it("upserts one transaction without rewriting the others", async () => {
    await migrateAll(t);

    const first = await t.mutation(fn.upsertTransaction, {
      transaction: {
        id: "app-1",
        date: "2026-07-21",
        merchant: "Cafe",
        amountCents: -450n,
        category: "Food",
      },
    });
    expect(first).toMatchObject({ outcome: "inserted", month: "2026-07" });

    const second = await t.mutation(fn.upsertTransaction, {
      transaction: {
        id: "app-1",
        date: "2026-07-21",
        merchant: "Cafe",
        amountCents: -500n,
        category: "Food",
      },
    });
    expect(second.outcome).toBe("updated");

    const rows = await t.query(fn.listTransactions, { viewer: "victor" });
    expect(rows.filter((row) => row.txId === "app-1")).toHaveLength(1);
    expect(rows.find((row) => row.txId === "app-1")?.amountCents).toBe(-500n);
    expect((await t.query(fn.rowCounts, {})).transactions).toBe(5);
  });

  it("routes a child transaction to the child even with no owner supplied", async () => {
    await t.mutation(fn.upsertTransaction, {
      sourceFile: "mason-transactions",
      transaction: {
        id: "app-m1",
        date: "2026-07-22",
        merchant: "Comics",
        amountCents: 900n,
        category: "Fun",
      },
    });
    const mason = await t.query(fn.listTransactions, { viewer: "mason" });
    expect(mason.map((row) => row.txId)).toEqual(["app-m1"]);
  });

  it("upserts a btc buy and a btc account idempotently", async () => {
    const inserted = await t.mutation(fn.upsertBtcBuy, {
      buy: {
        id: "app-b1",
        date: "2026-07-23",
        source: "strike",
        sats: 123456n,
        priceUsdCents: 9800000n,
        usdCents: 12100n,
      },
    });
    expect(inserted.outcome).toBe("inserted");
    expect(
      (
        await t.mutation(fn.upsertBtcBuy, {
          buy: {
            id: "app-b1",
            date: "2026-07-23",
            source: "strike",
            sats: 123456n,
            priceUsdCents: 9800000n,
            usdCents: 12100n,
          },
        })
      ).outcome,
    ).toBe("updated");

    await t.mutation(fn.upsertBtcAccount, {
      account: {
        key: "strike",
        owner: "victor",
        label: "Strike",
        custody: "exchange",
        sats: 35000000n,
        fiatCents: 3430055n,
        asOf: "2026-07-26T00:00:00Z",
      },
    });
    expect(
      (
        await t.mutation(fn.upsertBtcAccount, {
          account: {
            key: "strike",
            owner: "victor",
            label: "Strike",
            custody: "exchange",
            sats: 36000000n,
            fiatCents: 3530055n,
            asOf: "2026-07-26T01:00:00Z",
          },
        })
      ).outcome,
    ).toBe("updated");

    const accounts = await t.query(fn.listBtcAccounts, { viewer: "victor" });
    expect(accounts.filter((a) => a.key === "strike")).toHaveLength(1);
    expect(accounts.find((a) => a.key === "strike")?.sats).toBe(36000000n);
  });

  it("refuses a sourceFile that holds a different kind of record", async () => {
    // "transactions" is both a file name and a table name, so the two can be
    // crossed by accident. A transaction row tagged with the todos file's
    // provenance would carry the wrong sign convention forever.
    await expect(
      t.mutation(fn.upsertTransaction, {
        sourceFile: "todos",
        transaction: {
          id: "wrong-1",
          date: "2026-07-24",
          merchant: "Nope",
          amountCents: -1n,
          category: "Other",
        },
      }),
    ).rejects.toThrow(/holds todos, not transactions/);
  });

  it("rejects an owner outside the closed set", async () => {
    await expect(
      t.mutation(fn.upsertTransaction, {
        transaction: {
          id: "bad-1",
          date: "2026-07-24",
          merchant: "Nope",
          amountCents: -1n,
          category: "Other",
          // The schema's literal union is what stops a typo'd owner becoming
          // "victor" by way of coerceOwner.
          owner: "Mason" as Member,
        },
      }),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("auth: the gates in tables.ts match the gates in dataFiles.ts", () => {
  const readEntryPoints = [
    { name: "listTransactions", call: (token?: string) => t.query(fn.listTransactions, { viewer: "victor", token }) },
    { name: "listTodos", call: (token?: string) => t.query(fn.listTodos, { viewer: "victor", token }) },
    { name: "listBtcBuys", call: (token?: string) => t.query(fn.listBtcBuys, { viewer: "victor", token }) },
    { name: "listBtcAccounts", call: (token?: string) => t.query(fn.listBtcAccounts, { viewer: "victor", token }) },
    { name: "rowCounts", call: (token?: string) => t.query(fn.rowCounts, { token }) },
  ] as const;

  const writeEntryPoints = [
    {
      name: "upsertTransaction",
      call: (token?: string) =>
        t.mutation(fn.upsertTransaction, {
          transaction: {
            id: "auth-1",
            date: "2026-07-25",
            merchant: "Probe",
            amountCents: -1n,
            category: "Other",
          },
          token,
        }),
    },
    {
      name: "upsertTodo",
      call: (token?: string) =>
        t.mutation(fn.upsertTodo, { todo: { id: "auth-todo", title: "Probe" }, token }),
    },
    {
      name: "deleteTodo",
      call: (token?: string) => t.mutation(fn.deleteTodo, { todoId: "auth-todo", token }),
    },
    {
      name: "upsertBtcBuy",
      call: (token?: string) =>
        t.mutation(fn.upsertBtcBuy, {
          buy: {
            id: "auth-b1",
            date: "2026-07-25",
            source: "strike",
            sats: 1n,
            priceUsdCents: 1n,
            usdCents: 1n,
          },
          token,
        }),
    },
    {
      name: "upsertBtcAccount",
      call: (token?: string) =>
        t.mutation(fn.upsertBtcAccount, {
          account: {
            key: "probe",
            owner: "victor",
            label: "Probe",
            custody: "exchange",
            sats: 1n,
            fiatCents: 1n,
            asOf: "2026-07-25T00:00:00Z",
          },
          token,
        }),
    },
  ] as const;

  beforeEach(() => {
    // Undo the openGates() in the outer beforeEach — these tests are about the
    // deployed default, which is both gates closed.
    delete process.env.ALLOW_TOKENLESS_READ;
    delete process.env.ALLOW_TOKENLESS_SYNC;
  });

  describe("no token configured, no hatch (the deployed default)", () => {
    for (const entry of readEntryPoints) {
      it(`${entry.name} fails closed`, async () => {
        await expect(entry.call()).rejects.toThrow(
          /CONVEX_READ_TOKEN is not configured/,
        );
      });
      it(`${entry.name} fails closed even when a token is supplied`, async () => {
        await expect(entry.call(freshSecret())).rejects.toThrow(
          /CONVEX_READ_TOKEN is not configured/,
        );
      });
    }

    for (const entry of writeEntryPoints) {
      it(`${entry.name} fails closed`, async () => {
        await expect(entry.call()).rejects.toThrow(
          /CONVEX_SYNC_TOKEN is not configured/,
        );
      });
    }
  });

  describe("token configured", () => {
    let readToken: string;
    let syncToken: string;

    beforeEach(() => {
      readToken = freshSecret();
      syncToken = freshSecret();
      setDeploymentEnv({
        CONVEX_READ_TOKEN: readToken,
        CONVEX_SYNC_TOKEN: syncToken,
      });
    });

    for (const entry of readEntryPoints) {
      it(`${entry.name} rejects a missing or wrong token and admits the right one`, async () => {
        await expect(entry.call()).rejects.toThrow(/invalid read token/);
        await expect(entry.call(freshSecret())).rejects.toThrow(/invalid read token/);
        await expect(entry.call(readToken)).resolves.toBeDefined();
      });
    }

    for (const entry of writeEntryPoints) {
      it(`${entry.name} rejects a missing or wrong token and admits the right one`, async () => {
        await expect(entry.call()).rejects.toThrow(/invalid sync token/);
        await expect(entry.call(freshSecret())).rejects.toThrow(/invalid sync token/);
        await expect(entry.call(syncToken)).resolves.toBeDefined();
      });
    }
  });

  describe("the hatch outranks the token, exactly as it does for dataFiles", () => {
    it("read: a set token is IGNORED while ALLOW_TOKENLESS_READ=true", async () => {
      setDeploymentEnv({
        CONVEX_READ_TOKEN: freshSecret(),
        ALLOW_TOKENLESS_READ: "true",
      });
      // Same env, same answer from both files. That equality is the contract.
      await expect(t.query(fn.dataFilesGet, { name: "todos" })).resolves.toBeDefined();
      await expect(
        t.query(fn.listTransactions, { viewer: "victor" }),
      ).resolves.toBeDefined();
    });

    it("sync: a set token is IGNORED while ALLOW_TOKENLESS_SYNC=true", async () => {
      setDeploymentEnv({
        CONVEX_SYNC_TOKEN: freshSecret(),
        ALLOW_TOKENLESS_SYNC: "true",
      });
      await expect(
        t.mutation(fn.dataFilesSync, { name: "probe", data: [] }),
      ).resolves.toBeDefined();
    });

    it("both files fail closed identically with neither hatch nor token", async () => {
      await expect(t.query(fn.dataFilesGet, { name: "todos" })).rejects.toThrow(
        /CONVEX_READ_TOKEN is not configured/,
      );
      await expect(
        t.query(fn.listTransactions, { viewer: "victor" }),
      ).rejects.toThrow(/CONVEX_READ_TOKEN is not configured/);

      await expect(
        t.mutation(fn.dataFilesSync, { name: "probe", data: [] }),
      ).rejects.toThrow(/CONVEX_SYNC_TOKEN is not configured/);
    });
  });
});
