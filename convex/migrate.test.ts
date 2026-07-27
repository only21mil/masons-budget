// Tests for the dataFiles → tables backfill.
//
// Scale is deliberate: the fixtures are the real production counts — 905
// transactions, 31 BTC buys, 25 todos — in the real MC2 field shapes taken from
// MasonsBudget/.../MC2DTOs.swift and MC2ReaderTests.swift. A migration that
// only ever ran over six rows would not have exercised the batching, the
// duplicate keys, or the sums that actually matter.
//
// Nothing here touches a deployment: convex-test runs the functions in a mock
// of the Convex runtime, same as the rest of this suite.

import type { FunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "./schema";
import {
  MIGRATION_SOURCES,
  MONEY_COLUMNS,
  canonicalJson,
  contentFingerprint,
  extractRows,
  formatMinorUnits,
  fnv1a64,
  parseMinorUnits as migrateParseMinorUnits,
  projectFile,
  resolveClosedAdultOwner,
  resolveOwner,
  sourceKeyFor,
} from "./migrate";

// The domain parser, imported for real rather than re-implemented, so the
// copy inside convex/migrate.ts is checked against its source of truth.
import {
  parseCents as domainParseCents,
  parseMinorUnits as domainParseMinorUnits,
} from "../shared/domain/src/money";

const modules: Record<string, () => Promise<unknown>> = {
  "./_generated/server.ts": () => import("./generatedServer.test-stub"),
  "./migrate.ts": () => import("./migrate"),
};

function harness() {
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof harness>;

interface Verification {
  file: string;
  table: string;
  ok: boolean;
  blobRowCount: number;
  tableRowCount: number;
  blobSums: Record<string, string>;
  tableSums: Record<string, string>;
  exactRoundTrip: boolean;
  firstMismatchIndex: number | null;
  problems: string[];
}

interface MigrateResult {
  file: string;
  table: string;
  applied: boolean;
  blobPresent: boolean;
  blobRowCount: number;
  scanned: number;
  inserted: number;
  updated: number;
  unchanged: number;
  cursor: number;
  nextCursor: number | null;
  done: boolean;
  verifiedInTransaction: boolean;
  verification: Verification | null;
}

const api = {
  status: "migrate:status" as unknown as FunctionReference<
    "query",
    "internal",
    Record<string, never>,
    {
      files: {
        file: string;
        table: string;
        blobPresent: boolean;
        blobRowCount: number | null;
        blobUnreadable: boolean;
        migratedRowCount: number;
      }[];
      skippedDocumentShapedFiles: string[];
    }
  >,
  migrateFile: "migrate:migrateFile" as unknown as FunctionReference<
    "mutation",
    "internal",
    { file: string; apply?: boolean; cursor?: number; batchSize?: number },
    MigrateResult
  >,
  verifyFile: "migrate:verifyFile" as unknown as FunctionReference<
    "query",
    "internal",
    { file: string },
    Verification
  >,
};

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Deterministic PRNG — the fixtures must be identical on every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MERCHANTS = [
  "Kroger",
  "Shell",
  "Amazon",
  "Café Grumpy", // non-ASCII on purpose: the hash walks UTF-16 code units
  "Duke Energy",
  "Strike",
  "Chick-fil-A",
];
const CATEGORIES = ["Groceries", "Gas", "Shopping", "Dining", "Utilities", "Income"];

/**
 * 905 adult transactions in the exact MC2Transaction shape.
 *
 * Seeded with the awkward cases on purpose:
 *   - amounts as JSON numbers AND as strings (MC2 has emitted both)
 *   - 0.1 + 0.2, the canonical float trap
 *   - a third-decimal amount that must round half away from zero
 *   - rows with no `id`, including two byte-identical ones
 *   - a duplicated `id`
 *   - positive Income rows among negative spend rows
 */
function makeTransactions(): Record<string, unknown>[] {
  const random = mulberry32(0x5a75);
  const rows: Record<string, unknown>[] = [];

  for (let index = 0; index < 897; index += 1) {
    const category = CATEGORIES[Math.floor(random() * CATEGORIES.length)]!;
    const isIncome = category === "Income";
    const dollars = Math.floor(random() * 40000) / 100;
    const month = 1 + Math.floor(random() * 12);
    const day = 1 + Math.floor(random() * 28);

    const row: Record<string, unknown> = {
      id: `t${String(index).padStart(4, "0")}`,
      date: `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      merchant: MERCHANTS[Math.floor(random() * MERCHANTS.length)]!,
      // Half the rows carry the amount lexically, which is how MC2's Python
      // writers emit Decimal values.
      amount: index % 2 === 0 ? (isIncome ? dollars : -dollars) : `${isIncome ? "" : "-"}${dollars.toFixed(2)}`,
      category,
    };
    if (index % 3 === 0) row.card = "Amex 1005";
    if (index % 7 === 0) row.note = "recurring";
    rows.push(row);
  }

  // 897 + 8 awkward rows = 905.
  rows.push({
    id: "t-float-trap",
    date: "2026-03-01",
    merchant: "Kroger",
    amount: -(0.1 + 0.2), // -0.30000000000000004
    category: "Groceries",
  });
  rows.push({
    id: "t-half-up",
    date: "2026-03-02",
    merchant: "Shell",
    amount: "-0.005", // rounds to -1 cent, half away from zero
    category: "Gas",
  });
  rows.push({
    id: "t-big",
    date: "2026-03-03",
    merchant: "Duke Energy",
    amount: "-246813.57",
    category: "Utilities",
  });
  rows.push({
    id: "t-zero",
    date: "2026-03-04",
    merchant: "Amazon",
    amount: 0,
    category: "Shopping",
  });
  // Two byte-identical rows with no id. These are two real transactions
  // (same coffee, same day) and must not collapse into one.
  rows.push({ date: "2026-03-05", merchant: "Café Grumpy", amount: -4.75, category: "Dining" });
  rows.push({ date: "2026-03-05", merchant: "Café Grumpy", amount: -4.75, category: "Dining" });
  // A duplicated id — MC2 has shipped these.
  rows.push({ id: "t-dupe", date: "2026-03-06", merchant: "Shell", amount: -30.0, category: "Gas" });
  rows.push({ id: "t-dupe", date: "2026-03-06", merchant: "Shell", amount: -31.5, category: "Gas" });

  return rows;
}

const TRANSACTIONS = makeTransactions();

/** 31 BTC buys in the MC2BTCBuy shape, including archimedes_request_id. */
function makeBtcBuys(): Record<string, unknown>[] {
  const random = mulberry32(0xb7c);
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < 31; index += 1) {
    const sats = 100_000 + Math.floor(random() * 900_000);
    const priceUsd = (60000 + Math.floor(random() * 2000000) / 100).toFixed(2);
    rows.push({
      id: `b-strike-2026-${String(1 + (index % 12)).padStart(2, "0")}-${String(1 + (index % 28)).padStart(2, "0")}-${index}`,
      date: `2026-${String(1 + (index % 12)).padStart(2, "0")}-${String(1 + (index % 28)).padStart(2, "0")}`,
      source: index % 3 === 0 ? "Strike" : "River",
      amount_sats: sats,
      amount_btc: sats / 1e8,
      price_usd: priceUsd,
      usd: (Math.floor(random() * 100000) / 100).toFixed(2),
      note: index % 5 === 0 ? "Direct deposit auto-buy" : null,
      status: "complete",
      cost_basis_status: index % 4 === 0 ? "pending" : "complete",
      logged_by: "user-screenshot",
      // Carried by every real buy and named in no domain type — the reason
      // every migrated row keeps its original object.
      archimedes_request_id: `arch-2026-${index}`,
    });
  }
  return rows;
}

/** 25 todos, mixed dialect, in the `{ todos: [...] }` wrapper MC2 writes. */
function makeTodos(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < 25; index += 1) {
    const useLegacyDialect = index % 3 === 0;
    rows.push(
      useLegacyDialect
        ? {
            id: `s${1750000000000 + index}`,
            text: `Legacy todo ${index}`,
            completed: index % 2 === 0,
            flag: index % 5 === 0,
            due_date: index % 4 === 0 ? "2026-08-01" : null,
            category: "sats",
            updated_at: "2026-07-18T10:00:00Z",
          }
        : {
            id: `vv-${index}`,
            title: `Todo ${index}`,
            done: index % 2 === 1,
            flagged: index % 7 === 0,
            due: index % 3 === 1 ? "2026-08-15" : null,
            project: "Vogel Vault",
            area: "home",
            notes: index % 6 === 0 ? "check with Rachel" : null,
            owner: index % 8 === 0 ? "rachel" : undefined,
            created_by: "vogel-vault",
            updated_at: "2026-07-18T11:00:00Z",
          },
    );
  }
  // JSON has no `undefined`; strip it the way a real export would.
  return rows.map((row) => JSON.parse(JSON.stringify(row)) as Record<string, unknown>);
}

/**
 * Mason's transactions. THE SIGN CONVENTION IS THE POINT: child MC2 files
 * record spend as a POSITIVE magnitude while adult files sign it negative. The
 * migration must preserve both verbatim.
 */
function makeMasonTransactions(): Record<string, unknown>[] {
  return [
    { id: "m001", date: "2026-07-02", merchant: "Game Store", amount: 60.0, category: "Fun" },
    { id: "m002", date: "2026-07-09", merchant: "Allowance", amount: 20.0, category: "Income" },
    { id: "m003", date: "2026-07-11", merchant: "Snacks", amount: 4.25, category: "Food" },
  ];
}

function makeBillPays(): Record<string, unknown>[] {
  return [
    {
      id: "bp-001",
      date: "2026-06-01",
      merchant: "Duke Energy",
      category: "Utilities",
      amount_usd: 184.22,
      btc_spent: 0.0027,
      btc_price: "68271.41",
      platform: "Strike",
      note: null,
      fee_usd: 0.35,
      reference: "REF-9912",
    },
    {
      id: "bp-002",
      date: "2026-06-15",
      merchant: "City Water",
      category: "Utilities",
      amount_usd: "62.40",
      btc_spent: "0.00091",
      btc_price: 68500.0,
      platform: "River",
      fee_usd: 0,
      reference: null,
    },
  ];
}

const BTC_BUYS = makeBtcBuys();
const TODOS = makeTodos();
const MASON_TRANSACTIONS = makeMasonTransactions();
const BILL_PAYS = makeBillPays();
const INCOME = Array.from({ length: 16 }, (_, index) => ({
  id: `income-${String(index + 1).padStart(2, "0")}`,
  date: `2026-${String(1 + (index % 7)).padStart(2, "0")}-${String(1 + index).padStart(2, "0")}`,
  amount:
    index === 0
      ? 1234.56
      : index === 1
        ? "987.65"
        : Number((800 + index * 17.25).toFixed(2)),
  source: index % 2 === 0 ? "payroll" : "refund",
  logged_by: index % 3 === 0 ? "victor" : "archimedes",
  note: index % 4 === 0 ? "production-shaped income fixture" : null,
  archimedes_request_id: `income-arch-${index}`,
}));

const BALANCES = {
  cashapp: 0,
  coldcard: 0.12345678,
  river: 0.87654321,
  strike: 0,
  zeus: 0,
  total: 0.99999999,
  cashapp_fiat: 0,
  coldcard_fiat: 12345.67,
  river_fiat: 87654.32,
  strike_fiat: 0,
  zeus_fiat: 0,
  total_fiat: 99999.99,
  lastRefreshed: "2026-07-26T23:59:59Z",
  btc_sync: {
    anchor_balances: {
      cashapp: 0,
      coldcard: 0.12345677,
      river: 0.8765432,
      strike: 0,
      zeus: 0,
      total: 0.99999997,
    },
    anchor_date: "2026-07-20",
    anchor_source: "reconciliation-ledger",
    notes: ["coldcard verified", "river event replayed"],
    reconciled_at: "2026-07-26T23:50:00Z",
    reconciled_from_events: true,
  },
};

async function seedBlob(t: Harness, name: string, data: unknown, version = 7) {
  await t.run(async (ctx) => {
    await ctx.db.insert("dataFiles", { name, data, version, updatedAt: 1_700_000_000_000 });
    await ctx.db.insert("syncVersions", { name, version, updatedAt: 1_700_000_000_000 });
  });
}

async function seedAll(t: Harness) {
  await seedBlob(t, "transactions", TRANSACTIONS);
  await seedBlob(t, "mason-transactions", MASON_TRANSACTIONS);
  await seedBlob(t, "bitcoin-buys", BTC_BUYS);
  await seedBlob(t, "bitcoin-bill-pays", { bill_pays: BILL_PAYS, generated_at: "2026-07-18" });
  await seedBlob(t, "todos", { todos: TODOS });
  await seedBlob(t, "income", INCOME);
  await seedBlob(t, "balances", BALANCES);
}

async function rowsIn(
  t: Harness,
  table:
    | "transactions"
    | "btcBuys"
    | "btcBillPays"
    | "todos"
    | "income"
    | "balanceDocuments",
) {
  return await t.run(async (ctx) => await ctx.db.query(table).collect());
}

/**
 * Every table the blob path owns, byte-for-byte.
 *
 * Deliberately all three, not just `dataFiles`. The migration projects blobs
 * into rows and must leave the blob world exactly as it found it, because the
 * shipped iOS, Linux and Android clients still read from it and will keep doing
 * so until every one of them is cut over. Two of these are easy to get wrong in
 * a way no other assertion would catch:
 *
 *   syncVersions   — a bumped version tells every client the file changed, so
 *                    all of them re-download the whole thing for nothing.
 *   todoTombstones — a migration that resurrects a deleted todo, or drops a
 *                    tombstone, silently un-deletes something the family
 *                    deleted on purpose.
 *
 * The reconciliation of PR #40 and #38 dropped the only test covering these
 * two along with the API it tested, and the surviving suite narrowed to
 * `dataFiles` alone. Widened here so all four call sites get the full guard.
 */
async function snapshotBlobWorld(t: Harness) {
  return await t.run(async (ctx) => {
    const files = (await ctx.db.query("dataFiles").collect())
      .map((doc) => canonicalJson({ name: doc.name, version: doc.version, updatedAt: doc.updatedAt, data: doc.data }))
      .sort();
    const versions = (await ctx.db.query("syncVersions").collect())
      .map((doc) => canonicalJson({ name: doc.name, version: doc.version, updatedAt: doc.updatedAt }))
      .sort();
    const tombstones = (await ctx.db.query("todoTombstones").collect())
      .map((doc) => canonicalJson({ id: doc.id, deletedAt: doc.deletedAt }))
      .sort();
    return { files, versions, tombstones };
  });
}

// ─── Fixture sanity ──────────────────────────────────────────────────────────

describe("fixtures match the real export", () => {
  test("the production counts", () => {
    expect(TRANSACTIONS).toHaveLength(905);
    expect(BTC_BUYS).toHaveLength(31);
    expect(TODOS).toHaveLength(25);
    expect(INCOME).toHaveLength(16);
  });
});

// ─── Money ───────────────────────────────────────────────────────────────────

describe("money survives exactly", () => {
  // convex/migrate.ts carries a copy of the domain parser because Convex
  // functions cannot import from outside convex/. This is the check that keeps
  // the copy honest.
  const CASES: [unknown, number][] = [
    [-12.34, 2],
    ["-12.34", 2],
    [0.1 + 0.2, 2],
    ["-0.005", 2],
    ["0.005", 2],
    [0, 2],
    ["-246813.57", 2],
    ["1234567890.99", 2],
    [null, 2],
    [undefined, 2],
    ["", 2],
    ["0.00732371", 8],
    [0.00732371, 8],
    ["4.51718914", 8],
    ["-0.000000005", 8],
    [1e-8, 8],
  ];

  test("the copy in convex/migrate.ts agrees with shared/domain", () => {
    for (const [value, scale] of CASES) {
      expect(migrateParseMinorUnits(value, scale)).toBe(domainParseMinorUnits(value, scale));
    }
  });

  test("the float trap does not reach the ledger", () => {
    // 0.1 + 0.2 is 0.30000000000000004. Multiplying by 100 gives
    // 30.000000000000004; the lexical parse gives exactly 30 cents.
    expect(migrateParseMinorUnits(0.1 + 0.2, 2)).toBe(30n);
    expect(migrateParseMinorUnits("-0.005", 2)).toBe(-1n); // half away from zero
    expect(migrateParseMinorUnits("0.005", 2)).toBe(1n);
  });

  test("formatMinorUnits round-trips without a float", () => {
    expect(formatMinorUnits(-24681357n, 2)).toBe("-246813.57");
    expect(formatMinorUnits(732371n, 8)).toBe("0.00732371");
    expect(formatMinorUnits(0n, 2)).toBe("0.00");
  });

  test("every bigint column a projection writes is declared in MONEY_COLUMNS", () => {
    // If a money column were missing from this list, a value corrupted in that
    // column would sail past the sum check.
    const blobs: Record<string, unknown> = {
      transactions: TRANSACTIONS,
      "bitcoin-buys": BTC_BUYS,
      "bitcoin-bill-pays": { bill_pays: BILL_PAYS },
      todos: { todos: TODOS },
      income: INCOME,
      balances: BALANCES,
    };
    for (const source of MIGRATION_SOURCES) {
      const data = blobs[source.file];
      if (data === undefined) continue;
      const projected = projectFile(source, data);
      expect(projected).not.toBeNull();
      const bigintColumns = new Set<string>();
      const collectBigints = (value: unknown, path = "") => {
        if (typeof value === "bigint") {
          bigintColumns.add(path);
          return;
        }
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return;
        }
        for (const [key, nested] of Object.entries(value)) {
          collectBigints(nested, path === "" ? key : `${path}.${key}`);
        }
      };
      for (const doc of projected!.docs) {
        collectBigints(doc);
      }
      expect([...bigintColumns].sort()).toEqual([...MONEY_COLUMNS[source.kind]].sort());
    }
  });
});

// ─── Keying ──────────────────────────────────────────────────────────────────

describe("source keys are deterministic and total", () => {
  test("the same blob produces the same keys twice", () => {
    const first = projectFile(MIGRATION_SOURCES[0], TRANSACTIONS)!;
    const second = projectFile(MIGRATION_SOURCES[0], TRANSACTIONS)!;
    expect(first.docs.map((doc) => doc.txId)).toEqual(
      second.docs.map((doc) => doc.txId),
    );
  });

  test("905 rows produce 905 distinct keys despite duplicate ids and id-less twins", () => {
    const { docs } = projectFile(MIGRATION_SOURCES[0], TRANSACTIONS)!;
    expect(new Set(docs.map((doc) => doc.txId)).size).toBe(905);
  });

  test("two byte-identical id-less rows stay two rows", () => {
    const seen = new Map<string, number>();
    const row = { date: "2026-03-05", merchant: "Café Grumpy", amount: -4.75 };
    const first = sourceKeyFor({ ...row }, seen);
    const second = sourceKeyFor({ ...row }, seen);
    expect(first.sourceKey).not.toBe(second.sourceKey);
    expect(first.externalId).toBeNull();
  });

  test("key order does not depend on JSON key order", () => {
    const a = sourceKeyFor({ merchant: "Shell", amount: -1, date: "2026-01-01" }, new Map());
    const b = sourceKeyFor({ date: "2026-01-01", amount: -1, merchant: "Shell" }, new Map());
    expect(a.sourceKey).toBe(b.sourceKey);
  });

  test("the hash separates strings a 32-bit hash would be lucky to", () => {
    expect(fnv1a64("Café Grumpy")).not.toBe(fnv1a64("Cafe Grumpy"));
    expect(fnv1a64("")).toHaveLength(16);
  });
});

// ─── Owner ───────────────────────────────────────────────────────────────────

describe("owner resolution matches the domain normalizers", () => {
  test("absent owner takes the file's fallback", () => {
    expect(resolveOwner(undefined, "mason")).toBe("mason");
    expect(resolveOwner(undefined, "victor")).toBe("victor");
  });

  test("an explicit owner is kept", () => {
    expect(resolveOwner("rachel", "victor")).toBe("rachel");
    expect(resolveOwner("maddox", "victor")).toBe("maddox");
  });

  test("an unrecognised owner falls back to the source file owner", () => {
    // E1 is authoritative: a typo in a child file must not promote the row to
    // the adult household.
    expect(resolveOwner("nobody", "mason")).toBe("mason");
  });

  test("Mason's rows land on mason and adult rows on victor", async () => {
    const mason = MIGRATION_SOURCES.find((source) => source.file === "mason-transactions")!;
    const adult = MIGRATION_SOURCES.find((source) => source.file === "transactions")!;
    expect(projectFile(mason, MASON_TRANSACTIONS)!.docs.every((doc) => doc.owner === "mason")).toBe(true);
    expect(projectFile(adult, TRANSACTIONS)!.docs.every((doc) => doc.owner === "victor")).toBe(true);
  });

  test("new adult sources use the closed union and refuse disagreement", () => {
    expect(resolveClosedAdultOwner(undefined, "victor", "income")).toBe("victor");
    expect(resolveClosedAdultOwner("rachel", "victor", "income")).toBe("rachel");
    expect(() =>
      resolveClosedAdultOwner("Victor", "victor", "income"),
    ).toThrow(/not a known family member/);
    expect(() =>
      resolveClosedAdultOwner("mason", "victor", "income"),
    ).toThrow(/adult-household source/);

    const incomeSource = MIGRATION_SOURCES.find(
      (source) => source.file === "income",
    )!;
    expect(() =>
      projectFile(incomeSource, [{ ...INCOME[0], owner: "nobody" }]),
    ).toThrow(/not a known family member/);
    expect(() =>
      projectFile(incomeSource, [{ ...INCOME[0], owner: "mason" }]),
    ).toThrow(/adult-household source/);
  });
});

// ─── Blob shapes ─────────────────────────────────────────────────────────────

describe("blob shapes", () => {
  test("bare arrays, wrapped arrays and both todo dialects", () => {
    expect(extractRows([{ id: "a" }], null)).toHaveLength(1);
    expect(extractRows({ bill_pays: [{ id: "a" }] }, "bill_pays")).toHaveLength(1);
    expect(extractRows({ todos: [{ id: "a" }] }, "todos")).toHaveLength(1);
    expect(extractRows([{ id: "a" }], "todos")).toHaveLength(1);
  });

  test("an unreadable shape is null, never an empty array", () => {
    // "we could not read this" must never report as "there is nothing here".
    expect(extractRows({ month: "2026-07" }, null)).toBeNull();
    expect(extractRows({ bill_pays: "nope" }, "bill_pays")).toBeNull();
    expect(extractRows([1, 2, 3], null)).toBeNull();
    expect(extractRows(null, null)).toBeNull();
  });
});

// ─── Dry run ─────────────────────────────────────────────────────────────────

describe("dry run", () => {
  test("reports the full plan and writes nothing", async () => {
    const t = harness();
    await seedAll(t);
    const before = await snapshotBlobWorld(t);

    const result = await t.mutation(api.migrateFile, { file: "transactions" });

    expect(result.applied).toBe(false);
    expect(result.blobRowCount).toBe(905);
    expect(result.inserted).toBe(905);
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(result.done).toBe(true);
    expect(result.verifiedInTransaction).toBe(false);

    expect(await rowsIn(t, "transactions")).toHaveLength(0);
    expect(await snapshotBlobWorld(t)).toEqual(before);
  });

  test("apply: false is the default", async () => {
    const t = harness();
    await seedAll(t);
    await t.mutation(api.migrateFile, { file: "bitcoin-buys" });
    expect(await rowsIn(t, "btcBuys")).toHaveLength(0);
  });

  test("the plan equals what the write then does", async () => {
    const t = harness();
    await seedAll(t);
    const planned = await t.mutation(api.migrateFile, { file: "transactions", apply: false });
    const applied = await t.mutation(api.migrateFile, { file: "transactions", apply: true });
    expect(applied.inserted).toBe(planned.inserted);
    expect(applied.updated).toBe(planned.updated);
    expect(applied.unchanged).toBe(planned.unchanged);
  });
});

// ─── The migration ───────────────────────────────────────────────────────────

describe("migrating every file", () => {
  test("every declared source lands and verifies in-transaction", async () => {
    const t = harness();
    await seedAll(t);

    const results: MigrateResult[] = [];
    for (const source of MIGRATION_SOURCES) {
      results.push(await t.mutation(api.migrateFile, { file: source.file, apply: true }));
    }

    const byFile = new Map(results.map((result) => [result.file, result]));

    expect(byFile.get("transactions")!.inserted).toBe(905);
    expect(byFile.get("bitcoin-buys")!.inserted).toBe(31);
    expect(byFile.get("todos")!.inserted).toBe(25);
    expect(byFile.get("mason-transactions")!.inserted).toBe(3);
    expect(byFile.get("bitcoin-bill-pays")!.inserted).toBe(2);
    expect(byFile.get("income")!.inserted).toBe(16);
    expect(byFile.get("balances")!.inserted).toBe(1);
    // No blob for these two; skipped, not invented.
    expect(byFile.get("maddox-transactions")!.blobPresent).toBe(false);
    expect(byFile.get("mason-bitcoin-buys")!.blobPresent).toBe(false);

    for (const result of results) {
      if (!result.blobPresent) continue;
      expect(result.verifiedInTransaction).toBe(true);
      expect(result.verification!.ok).toBe(true);
      expect(result.verification!.exactRoundTrip).toBe(true);
    }

    // transactions and mason-transactions share one table.
    expect(await rowsIn(t, "transactions")).toHaveLength(908);
    expect(await rowsIn(t, "btcBuys")).toHaveLength(31);
    expect(await rowsIn(t, "todos")).toHaveLength(25);
    expect(await rowsIn(t, "btcBillPays")).toHaveLength(2);
    expect(await rowsIn(t, "income")).toHaveLength(16);
    expect(await rowsIn(t, "balanceDocuments")).toHaveLength(1);
  });

  test("the summed amounts equal the blob, computed independently", async () => {
    const t = harness();
    await seedAll(t);
    await t.mutation(api.migrateFile, { file: "transactions", apply: true });

    // Independent expectation: the domain parser over the raw fixture, not the
    // migration's own sum.
    let expected = 0n;
    for (const row of TRANSACTIONS) expected += domainParseCents(row.amount);

    const rows = await rowsIn(t, "transactions");
    let actual = 0n;
    for (const row of rows) actual += row.amountCents;

    expect(actual).toBe(expected);

    const verification = await t.query(api.verifyFile, { file: "transactions" });
    expect(verification.ok).toBe(true);
    expect(verification.tableSums.amountCents).toBe(formatMinorUnits(expected, 2));
    expect(verification.blobSums.amountCents).toBe(verification.tableSums.amountCents);
  });

  test("BTC sats and USD both survive, and amount_sats beats amount_btc", async () => {
    const t = harness();
    await seedAll(t);
    await t.mutation(api.migrateFile, { file: "bitcoin-buys", apply: true });

    const rows = await rowsIn(t, "btcBuys");
    let sats = 0n;
    for (const row of rows) sats += row.sats;
    let expectedSats = 0n;
    for (const row of BTC_BUYS) expectedSats += BigInt(String(row.amount_sats));
    expect(sats).toBe(expectedSats);

    const verification = await t.query(api.verifyFile, { file: "bitcoin-buys" });
    expect(verification.ok).toBe(true);
    expect(Object.keys(verification.tableSums).sort()).toEqual(["priceUsdCents", "sats", "usdCents"]);
  });

  test("income and balances preserve exact cents, sats, and reconciliation provenance", async () => {
    const t = harness();
    await seedAll(t);
    await t.mutation(api.migrateFile, { file: "income", apply: true });
    await t.mutation(api.migrateFile, { file: "balances", apply: true });

    const incomeRows = await rowsIn(t, "income");
    const expectedIncome = INCOME.reduce(
      (sum, row) => sum + domainParseCents(row.amount),
      0n,
    );
    expect(incomeRows.reduce((sum, row) => sum + row.amountCents, 0n)).toBe(
      expectedIncome,
    );
    expect(new Set(incomeRows.map((row) => row.sourceKey)).size).toBe(16);
    expect(incomeRows.every((row) => row.owner === "victor")).toBe(true);
    expect(incomeRows.find((row) => row.incomeId === "income-01")).toMatchObject({
      month: "2026-01",
      amountCents: 123456n,
      source: "payroll",
      loggedBy: "victor",
      archimedesRequestId: "income-arch-0",
    });

    const [balance] = await rowsIn(t, "balanceDocuments");
    expect(balance).toMatchObject({
      owner: "victor",
      coldcardSats: 12_345_678n,
      riverSats: 87_654_321n,
      totalSats: 99_999_999n,
      coldcardFiatCents: 1_234_567n,
      totalFiatCents: 9_999_999n,
      btcSync: {
        anchorBalancesSats: {
          coldcardSats: 12_345_677n,
          riverSats: 87_654_320n,
          totalSats: 99_999_997n,
        },
        anchorDate: "2026-07-20",
        anchorSource: "reconciliation-ledger",
        notes: ["coldcard verified", "river event replayed"],
        reconciledAt: "2026-07-26T23:50:00Z",
        reconciledFromEvents: true,
      },
    });

    const incomeVerification = await t.query(api.verifyFile, { file: "income" });
    expect(incomeVerification).toMatchObject({
      ok: true,
      exactRoundTrip: true,
      blobRowCount: 16,
      tableRowCount: 16,
    });
    expect(incomeVerification.tableSums.amountCents).toBe(
      formatMinorUnits(expectedIncome, 2),
    );

    const balanceVerification = await t.query(api.verifyFile, {
      file: "balances",
    });
    expect(balanceVerification).toMatchObject({
      ok: true,
      exactRoundTrip: true,
      blobRowCount: 1,
      tableRowCount: 1,
    });
    expect(balanceVerification.tableSums.coldcardSats).toBe("0.12345678");
    expect(balanceVerification.tableSums.totalFiatCents).toBe("99999.99");
    expect(
      balanceVerification.tableSums[
        "btcSync.anchorBalancesSats.coldcardSats"
      ],
    ).toBe("0.12345677");
    expect(canonicalJson(balance!.raw)).toBe(canonicalJson(BALANCES));
  });

  test("child files keep their positive spend and adult files keep their negative", async () => {
    const t = harness();
    await seedAll(t);
    await t.mutation(api.migrateFile, { file: "mason-transactions", apply: true });
    await t.mutation(api.migrateFile, { file: "transactions", apply: true });

    const rows = await rowsIn(t, "transactions");
    const mason = rows.filter((row) => row.sourceFile === "mason-transactions");
    // 60.00 at the Game Store is spend recorded as +6000, exactly as MC2 wrote
    // it. Normalising the sign here would change what every client displays.
    expect(mason.find((row) => row.merchant === "Game Store")!.amountCents).toBe(6000n);
    expect(mason.every((row) => row.amountCents >= 0n)).toBe(true);

    const adultSpend = rows.find((row) => row.txId === "t-big")!;
    expect(adultSpend.amountCents).toBe(-24681357n);
  });

  test("fields no domain type mentions survive in migration provenance", async () => {
    const t = harness();
    await seedAll(t);
    await t.mutation(api.migrateFile, { file: "bitcoin-buys", apply: true });
    const rows = await rowsIn(t, "btcBuys");
    for (const row of rows) {
      expect(
        (row.migrationRaw as Record<string, unknown>)
          .archimedes_request_id,
      ).toMatch(/^arch-2026-/);
    }
  });

  test("both todo dialects normalise and the wrapper is unwrapped", async () => {
    const t = harness();
    await seedAll(t);
    await t.mutation(api.migrateFile, { file: "todos", apply: true });
    const rows = await rowsIn(t, "todos");
    expect(rows).toHaveLength(25);
    // Legacy rows use text/completed/flag/due_date.
    const legacy = rows.find((row) => row.todoId === "s1750000000000")!;
    expect(legacy.title).toBe("Legacy todo 0");
    expect(legacy.done).toBe(true);
    expect(legacy.flagged).toBe(true);
    expect(legacy.due).toBe("2026-08-01");
    // An explicit owner beats the file fallback even on the shared todos file.
    expect(rows.some((row) => row.owner === "rachel")).toBe(true);
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe("running it twice", () => {
  test("income rows and the balances document insert zero rows on a second run", async () => {
    const t = harness();
    await seedAll(t);

    const incomeFirst = await t.mutation(api.migrateFile, {
      file: "income",
      apply: true,
    });
    const incomeSecond = await t.mutation(api.migrateFile, {
      file: "income",
      apply: true,
    });
    const balancesFirst = await t.mutation(api.migrateFile, {
      file: "balances",
      apply: true,
    });
    const balancesSecond = await t.mutation(api.migrateFile, {
      file: "balances",
      apply: true,
    });

    expect(incomeFirst.inserted).toBe(16);
    expect(incomeSecond).toMatchObject({
      inserted: 0,
      updated: 0,
      unchanged: 16,
    });
    expect(balancesFirst.inserted).toBe(1);
    expect(balancesSecond).toMatchObject({
      inserted: 0,
      updated: 0,
      unchanged: 1,
    });
  });

  test("does not duplicate 905 transactions", async () => {
    const t = harness();
    await seedAll(t);

    const first = await t.mutation(api.migrateFile, { file: "transactions", apply: true });
    const second = await t.mutation(api.migrateFile, { file: "transactions", apply: true });
    const third = await t.mutation(api.migrateFile, { file: "transactions", apply: true });

    expect(first.inserted).toBe(905);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(905);
    expect(third.unchanged).toBe(905);
    expect(await rowsIn(t, "transactions")).toHaveLength(905);
  });

  test("a re-run does not rewrite updatedAtMs", async () => {
    const t = harness();
    await seedAll(t);
    await t.mutation(api.migrateFile, { file: "bitcoin-buys", apply: true });
    const before = (await rowsIn(t, "btcBuys")).map((row) => row.updatedAtMs);
    await t.mutation(api.migrateFile, { file: "bitcoin-buys", apply: true });
    const after = (await rowsIn(t, "btcBuys")).map((row) => row.updatedAtMs);
    expect(after).toEqual(before);
  });

  test("a batched run resumes and a later full run finds nothing to do", async () => {
    const t = harness();
    await seedAll(t);

    let cursor: number | null = 0;
    let inserted = 0;
    let batches = 0;
    while (cursor !== null) {
      const result: MigrateResult = await t.mutation(api.migrateFile, {
        file: "transactions",
        apply: true,
        cursor,
        batchSize: 100,
      });
      inserted += result.inserted;
      cursor = result.nextCursor;
      batches += 1;
      // Batched runs cannot verify in-transaction; the standalone proof covers
      // them and the script runs it.
      expect(result.verifiedInTransaction).toBe(false);
    }

    expect(batches).toBe(10);
    expect(inserted).toBe(905);
    expect(await rowsIn(t, "transactions")).toHaveLength(905);
    expect((await t.query(api.verifyFile, { file: "transactions" })).ok).toBe(true);

    const rerun = await t.mutation(api.migrateFile, { file: "transactions", apply: true });
    expect(rerun.inserted).toBe(0);
    expect(rerun.unchanged).toBe(905);
  });

  test("an interrupted run is repaired, not duplicated", async () => {
    const t = harness();
    await seedAll(t);
    // Simulate a run that died after the first 300 rows.
    await t.mutation(api.migrateFile, { file: "transactions", apply: true, cursor: 0, batchSize: 300 });
    expect(await rowsIn(t, "transactions")).toHaveLength(300);

    const repair = await t.mutation(api.migrateFile, { file: "transactions", apply: true });
    expect(repair.inserted).toBe(605);
    expect(repair.unchanged).toBe(300);
    expect(await rowsIn(t, "transactions")).toHaveLength(905);
    expect(repair.verification!.ok).toBe(true);
  });

  test("an edited blob updates the row in place instead of adding one", async () => {
    const t = harness();
    await seedAll(t);
    await t.mutation(api.migrateFile, { file: "mason-transactions", apply: true });

    const edited = MASON_TRANSACTIONS.map((row) =>
      row.id === "m003" ? { ...row, amount: 4.5 } : row,
    );
    await t.run(async (ctx) => {
      const doc = await ctx.db
        .query("dataFiles")
        .withIndex("by_name", (q) => q.eq("name", "mason-transactions"))
        .first();
      await ctx.db.patch(doc!._id, { data: edited, version: 8 });
    });

    const result = await t.mutation(api.migrateFile, { file: "mason-transactions", apply: true });
    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.unchanged).toBe(2);

    const rows = await rowsIn(t, "transactions");
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.txId === "m003")!.amountCents).toBe(450n);
  });
});

// ─── The blob is never touched ───────────────────────────────────────────────

describe("dataFiles is left alone", () => {
  test("an applied migration changes no blob, version or sync row", async () => {
    const t = harness();
    await seedAll(t);
    const beforeFiles = await snapshotBlobWorld(t);
    const beforeVersions = await t.run(
      async (ctx) => (await ctx.db.query("syncVersions").collect()).map((doc) => canonicalJson({ n: doc.name, v: doc.version })).sort(),
    );

    for (const source of MIGRATION_SOURCES) {
      await t.mutation(api.migrateFile, { file: source.file, apply: true });
    }

    expect(await snapshotBlobWorld(t)).toEqual(beforeFiles);
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("syncVersions").collect()).map((doc) => canonicalJson({ n: doc.name, v: doc.version })).sort(),
      ),
    ).toEqual(beforeVersions);
  });
});

// ─── Verification actually catches things ────────────────────────────────────

describe("verification is a real check, not a formality", () => {
  async function migrated() {
    const t = harness();
    await seedAll(t);
    await t.mutation(api.migrateFile, { file: "transactions", apply: true });
    return t;
  }

  test("a dropped row fails the count check", async () => {
    const t = await migrated();
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("transactions").collect();
      await ctx.db.delete(rows[17]!._id);
    });

    const verification = await t.query(api.verifyFile, { file: "transactions" });
    expect(verification.ok).toBe(false);
    expect(verification.tableRowCount).toBe(904);
    expect(verification.blobRowCount).toBe(905);
    expect(verification.problems.join(" ")).toContain("row count");
  });

  test("a single altered cent fails the sum check", async () => {
    const t = await migrated();
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("transactions").collect();
      await ctx.db.patch(rows[3]!._id, { amountCents: rows[3]!.amountCents + 1n });
    });

    const verification = await t.query(api.verifyFile, { file: "transactions" });
    expect(verification.ok).toBe(false);
    expect(verification.problems.join(" ")).toContain("summed amountCents");
  });

  test("a corrupted row fails the round-trip check even when counts and sums pass", async () => {
    const t = await migrated();
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("transactions").collect();
      const target = rows.find((row) => row.migrationSourceIndex === 5)!;
      // Only provenance is touched: the count is unchanged and no money column moves,
      // so this is exactly the corruption the first two checks cannot see.
      await ctx.db.patch(target._id, {
        migrationRaw: {
          ...(target.migrationRaw as Record<string, unknown>),
          merchant: "Wrong",
        },
      });
    });

    const verification = await t.query(api.verifyFile, { file: "transactions" });
    expect(verification.ok).toBe(false);
    expect(verification.exactRoundTrip).toBe(false);
    expect(verification.firstMismatchIndex).toBe(5);
    expect(verification.tableRowCount).toBe(verification.blobRowCount);
    expect(verification.tableSums.amountCents).toBe(verification.blobSums.amountCents);
  });

  test("a failing verification rolls the whole file back", async () => {
    const t = harness();
    await seedAll(t);

    // A stale row from an earlier, different blob. After migrating, the table
    // would hold 906 rows for a 905-row blob.
    await t.run(async (ctx) => {
      await ctx.db.insert("transactions", {
        sourceFile: "transactions",
        txId: "t-ghost",
        owner: "victor",
        migrationRaw: { id: "t-ghost" },
        migrationSourceIndex: 9999,
        date: "2020-01-01",
        month: "2020-01",
        merchant: "Ghost",
        amountCents: -100n,
        category: "Other",
        updatedAtMs: 0,
      });
    });

    await expect(
      t.mutation(api.migrateFile, { file: "transactions", apply: true }),
    ).rejects.toThrow(/did not verify/);

    // Nothing committed: the ghost is still alone, the 905 rows never landed.
    expect(await rowsIn(t, "transactions")).toHaveLength(1);
  });

  test("rows with no blob to check against are a failure, not a pass", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await ctx.db.insert("btcBuys", {
        sourceFile: "bitcoin-buys",
        buyId: "orphan",
        owner: "victor",
        migrationRaw: {},
        migrationSourceIndex: 0,
        date: "2026-01-01",
        month: "2026-01",
        source: "Strike",
        sats: 1n,
        priceUsdCents: 1n,
        usdCents: 1n,
        updatedAtMs: 0,
      });
    });

    const verification = await t.query(api.verifyFile, { file: "bitcoin-buys" });
    expect(verification.ok).toBe(false);
    expect(verification.problems.join(" ")).toContain("no bitcoin-buys blob");
  });
});

// ─── Refusals ────────────────────────────────────────────────────────────────

describe("refusals", () => {
  test("a shape it does not understand is refused, not guessed at", async () => {
    const t = harness();
    await seedBlob(t, "transactions", { month: "2026-07", total: 1234 });
    await expect(
      t.mutation(api.migrateFile, { file: "transactions", apply: true }),
    ).rejects.toThrow(/not a row collection/);
    expect(await rowsIn(t, "transactions")).toHaveLength(0);
  });

  test("an unknown file is refused", async () => {
    const t = harness();
    await expect(t.mutation(api.migrateFile, { file: "budget", apply: true })).rejects.toThrow(
      /Not a migratable file/,
    );
  });

  test("a missing blob is reported, not invented", async () => {
    const t = harness();
    const result = await t.mutation(api.migrateFile, { file: "todos", apply: true });
    expect(result.blobPresent).toBe(false);
    expect(result.inserted).toBe(0);
    expect(result.done).toBe(true);
  });

  test("nonsense batching is refused", async () => {
    const t = harness();
    await seedAll(t);
    await expect(
      t.mutation(api.migrateFile, { file: "transactions", batchSize: 0 }),
    ).rejects.toThrow(/batchSize/);
    await expect(
      t.mutation(api.migrateFile, { file: "transactions", cursor: -1 }),
    ).rejects.toThrow(/cursor/);
  });
});

// ─── status ──────────────────────────────────────────────────────────────────

describe("status", () => {
  test("names what it is leaving behind", async () => {
    const t = harness();
    await seedAll(t);
    await seedBlob(t, "budget", { month: "2026-07", categories: [] });
    await seedBlob(t, "btc-balance-snapshot", { asOf: "2026-07-18", accounts: {} });

    const status = await t.query(api.status, {});
    expect(status.skippedDocumentShapedFiles).toEqual(["budget", "btc-balance-snapshot"]);

    const transactions = status.files.find((file) => file.file === "transactions")!;
    expect(transactions.blobRowCount).toBe(905);
    expect(transactions.migratedRowCount).toBe(0);
    expect(transactions.blobUnreadable).toBe(false);

    const missing = status.files.find((file) => file.file === "maddox-transactions")!;
    expect(missing.blobPresent).toBe(false);
    expect(missing.blobRowCount).toBeNull();
  });

  test("an unreadable blob is flagged before anyone tries to migrate it", async () => {
    const t = harness();
    await seedBlob(t, "todos", { not: "a todo list" });
    const status = await t.query(api.status, {});
    expect(status.files.find((file) => file.file === "todos")!.blobUnreadable).toBe(true);
  });
});

// ─── Content fingerprint ─────────────────────────────────────────────────────

describe("contentFingerprint", () => {
  test("ignores Convex system fields", () => {
    const doc = {
      txId: "a",
      amountCents: 1n,
      migrationRaw: { id: "a" },
    };
    expect(contentFingerprint({ ...doc, _id: "x", _creationTime: 1 })).toBe(
      contentFingerprint({ ...doc, _id: "y", _creationTime: 3 }),
    );
  });

  test("does not confuse a bigint with the number that prints the same", () => {
    expect(canonicalJson({ a: 1n })).not.toBe(canonicalJson({ a: 1 }));
  });
});
