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

import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  FunctionReference,
} from "convex/server";
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
  jsonNumberToMinorUnits as migrateJsonNumberToMinorUnits,
  parseMinorUnits as migrateParseMinorUnits,
  projectFile,
  resolveClosedAdultOwner,
  resolveOwner,
  sha256,
  sourceKeyFor,
  writeProjectedDocument,
} from "./migrate";

// The domain parser, imported for real rather than re-implemented, so the
// copy inside convex/migrate.ts is checked against its source of truth.
import {
  jsonNumberToMinorUnits as domainJsonNumberToMinorUnits,
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
type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type MigratedTableName =
  | "transactions"
  | "btcBuys"
  | "btcBillPays"
  | "todos"
  | "income"
  | "balanceDocuments"
  | "btcAccounts"
  | "budgetDocuments"
  | "btcBalanceDocuments"
  | "financeDocuments";

interface Verification {
  file: string;
  table: string;
  ok: boolean;
  blobRowCount: number;
  projectedRowCount: number;
  tableRowCount: number;
  rowCountMatches: boolean;
  blobSums: Record<string, string>;
  tableSums: Record<string, string>;
  moneySumsMatch: boolean;
  roundTripRowsMatch: boolean;
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
  planFingerprint: string;
  frozenPlanFingerprint: string;
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
        projectedRowCount: number;
        blobUnreadable: boolean;
        migratedRowCount: number;
        targetTables: { table: string; rows: number }[];
        planFingerprint: string;
      }[];
      skippedDocumentShapedFiles: string[];
      frozenPlanFingerprint: string;
    }
  >,
  migrateFile: "migrate:migrateFile" as unknown as FunctionReference<
    "mutation",
    "internal",
    {
      file: string;
      apply?: boolean;
      expectedPlanFingerprint?: string;
      cursor?: number;
      batchSize?: number;
    },
    MigrateResult
  >,
  verifyFile: "migrate:verifyFile" as unknown as FunctionReference<
    "query",
    "internal",
    { file: string },
    Verification
  >,
};

/**
 * Review the current backend plan immediately before an apply in tests that
 * exercise another property. Fingerprint-specific tests below deliberately
 * retain and reuse an older dry-run value instead.
 */
async function applyFile(
  t: Harness,
  args: { file: string; cursor?: number; batchSize?: number },
): Promise<MigrateResult> {
  const plan = await t.mutation(api.migrateFile, {
    file: args.file,
    cursor: args.cursor,
    batchSize: args.batchSize,
  });
  return await t.mutation(api.migrateFile, {
    ...args,
    apply: true,
    expectedPlanFingerprint: plan.frozenPlanFingerprint,
  });
}

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

const ADULT_BUDGET = {
  month: "2026-07",
  coinbase_one_balance: 101.01,
  categories: Array.from({ length: 8 }, (_, index) => ({
    name: `Adult category ${index}`,
    icon: "•",
    budget: 100.05 + index,
    spent: 99_999.99,
  })),
  income: {
    weekly_gross: 1_001.01,
    weekly_strike: 501.01,
    weekly_river: 500,
    monthly_gross: 4_004.04,
    mtd_income: 2_002.02,
    ytd_income: 24_024.24,
    pay_frequency: "weekly",
    paychecks: Array.from({ length: 60 }, (_, index) => ({
      date: `2026-07-${String(1 + (index % 28)).padStart(2, "0")}`,
      source: "payroll",
      amount: 1_001.01,
      net: 751.01,
      note: index === 0 ? "production-shaped adult paycheck" : null,
    })),
  },
  mtd_income: 2_002.02,
  ytd_income: 24_024.24,
  monthly_history: Array.from({ length: 5 }, (_, index) => ({
    month: `2026-${String(index + 1).padStart(2, "0")}`,
    income: 4_004.04,
    expenses: 3_003.03,
    savings_pct: 25.01,
  })),
};

const MASON_BUDGET = {
  month: "2026-07",
  owner: "mason",
  coinbase_one_balance: 0,
  categories: Array.from({ length: 4 }, (_, index) => ({
    name: `Mason category ${index}`,
    icon: "•",
    budget: 25.05 + index,
    spent: 9_999.99,
  })),
  income: {
    weekly_gross: 20.05,
    weekly_strike: 0,
    weekly_river: 0,
    monthly_gross: 80.2,
    mtd_income: 0,
    ytd_income: 0,
    pay_frequency: "weekly",
    paychecks: Array.from({ length: 19 }, (_, index) => ({
      date: `2026-07-${String(1 + (index % 28)).padStart(2, "0")}`,
      source: "allowance",
      amount: 20.05,
      net: 20.05,
      owner: "mason",
    })),
  },
  mtd_income: 0,
  ytd_income: 0,
  monthly_history: [],
};

const BTC_SNAPSHOT = {
  schemaVersion: 2,
  asOf: "2026-07-18T12:00:00Z",
  accounts: Object.fromEntries(
    [
      ["cashapp", "exchange"],
      ["coldcard", "self_custody"],
      ["river", "exchange"],
      ["strike", "exchange"],
      ["zeus", "self_custody"],
    ].map(([key, custody], index) => [
      key,
      {
        btc: Number((0.01 + index * 0.001).toFixed(8)),
        fiat: 1_000.05 + index,
        label: key,
        custody,
      },
    ]),
  ),
  totals: {
    btc: 0.06,
    fiat: 5_010.25,
    exchange_btc: 0.034,
    self_custody_btc: 0.026,
  },
  metadata: {
    source: "reconciliation",
    basis: "account snapshot",
    confidence: "reviewed",
  },
};

const SON_BALANCES = {
  strike: 0.004,
  river: 0.002,
  coldcard: 0.01,
  total: 0.016,
  lastUpdated: "2026-07-18T12:00:00Z",
};

const FINANCES = {
  lastUpdated: "2026-07-18T12:00:00Z",
  retirement: {
    "401k": {
      provider: "Adult provider",
      total: 1_000.05,
      weeklyContribution: 25.05,
      weeklyContributionDay: "Friday",
      holdings: [
        {
          name: "Adult fund",
          category: "Equity",
          value: 1_000.05,
          costBasis: 900.05,
          gainPct: 11.11,
          shares: 3.14159265,
          avgCost: 286.05,
          currentPricePerShare: 318.35,
          lots: [
            {
              date: "2026-01-01",
              type: "buy",
              pricePerShare: 300.05,
              shares: 1.125,
              amountInvested: 337.55,
            },
          ],
        },
      ],
    },
    wap: {
      provider: "Adult WAP",
      total: 50.05,
      weeklyContribution: 5.05,
      holdings: [],
    },
    total: 1_050.1,
  },
  mason_401k: {
    owner: "mason",
    provider: "Mason provider",
    total: 50.05,
    weeklyContribution: 5.05,
    holdings: [],
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
  await seedBlob(t, "budget", ADULT_BUDGET);
  await seedBlob(t, "mason-budget", MASON_BUDGET);
  await seedBlob(t, "btc-balance-snapshot", BTC_SNAPSHOT);
  await seedBlob(t, "finances", FINANCES);
  await seedBlob(t, "son-balances", SON_BALANCES);
  await t.run(async (ctx) => {
    await ctx.db.insert("todoTombstones", {
      id: "deleted-before-migration",
      deletedAt: 1_699_999_999_999,
    });
  });
}

async function rowsIn<TableName extends MigratedTableName>(
  t: Harness,
  table: TableName,
): Promise<Array<DocumentByName<DataModel, TableName>>> {
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
    expect(ADULT_BUDGET.categories).toHaveLength(8);
    expect(ADULT_BUDGET.income.paychecks).toHaveLength(60);
    expect(MASON_BUDGET.categories).toHaveLength(4);
    expect(MASON_BUDGET.income.paychecks).toHaveLength(19);
    expect(Object.keys(BTC_SNAPSHOT.accounts)).toHaveLength(5);
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

  test("the Convex JSON-number converter mirrors the domain safety boundary", () => {
    const cases: [number, number][] = [
      [0.1 + 0.2, 2],
      [1.005, 2],
      [-1.005, 2],
      [5e-9, 8],
      [21_000_000.99999999, 8],
    ];
    for (const [value, scale] of cases) {
      expect(migrateJsonNumberToMinorUnits(value, scale)).toBe(
        domainJsonNumberToMinorUnits(value, scale),
      );
    }

    expect(() =>
      migrateJsonNumberToMinorUnits(90_071_992.54740992, 8),
    ).toThrow(RangeError);
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
      budget: ADULT_BUDGET,
      "mason-budget": MASON_BUDGET,
      "btc-balance-snapshot": BTC_SNAPSHOT,
      finances: FINANCES,
      "son-balances": SON_BALANCES,
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
        if (Array.isArray(value)) {
          for (const nested of value) collectBigints(nested, `${path}[]`);
          return;
        }
        if (typeof value !== "object" || value === null) {
          return;
        }
        for (const [key, nested] of Object.entries(value)) {
          collectBigints(nested, path === "" ? key : `${path}.${key}`);
        }
      };
      for (const doc of projected!.docs) {
        collectBigints(doc);
      }
      expect(
        [...bigintColumns].filter(
          (column) => !MONEY_COLUMNS[source.kind].includes(column),
        ),
      ).toEqual([]);
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

describe("owner resolution is closed", () => {
  test("absent owner takes the file's fallback", () => {
    expect(resolveOwner(undefined, "mason")).toBe("mason");
    expect(resolveOwner(undefined, "victor")).toBe("victor");
  });

  test("an explicit owner is kept", () => {
    expect(resolveOwner("rachel", "victor")).toBe("rachel");
    expect(resolveOwner("maddox", "victor")).toBe("maddox");
  });

  test("an unrecognised owner is refused rather than coerced", () => {
    expect(() => resolveOwner("nobody", "mason")).toThrow(/closed union/);
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
  test("refuses an unhandled migration table at the write boundary", async () => {
    await expect(
      writeProjectedDocument(
        {} as never,
        { ...MIGRATION_SOURCES[0], table: "seventhTable" } as never,
        {},
        undefined,
      ),
    ).rejects.toThrow("Unhandled migration table: seventhTable");
  });

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
    const applied = await t.mutation(api.migrateFile, {
      file: "transactions",
      apply: true,
      expectedPlanFingerprint: planned.frozenPlanFingerprint,
    });
    expect(applied.inserted).toBe(planned.inserted);
    expect(applied.updated).toBe(planned.updated);
    expect(applied.unchanged).toBe(planned.unchanged);
    expect(applied.frozenPlanFingerprint).toBe(planned.frozenPlanFingerprint);
  });
});

// ─── Frozen plan binding ─────────────────────────────────────────────────────

describe("frozen plan fingerprint", () => {
  test.each([
    [
      "abc",
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    ],
    [
      "Café Grumpy",
      "2f8153f064a983f7bd75f2f0bfb690bf5c7a5e19cd3ee16961984f22ce2f50ef",
    ],
  ])("uses standard SHA-256 bytes for %s", (input, expected) => {
    expect(sha256(input)).toBe(expected);
  });

  test("is stable across runs over identical input", async () => {
    const first = harness();
    const second = harness();
    await seedAll(first);
    await seedAll(second);

    const firstPlan = await first.mutation(api.migrateFile, {
      file: "transactions",
    });
    const firstAgain = await first.mutation(api.migrateFile, {
      file: "transactions",
    });
    const secondPlan = await second.mutation(api.migrateFile, {
      file: "transactions",
    });

    expect(firstPlan.frozenPlanFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(firstPlan.planFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(firstAgain.frozenPlanFingerprint).toBe(
      firstPlan.frozenPlanFingerprint,
    );
    expect(firstAgain.planFingerprint).toBe(firstPlan.planFingerprint);
    expect(secondPlan.frozenPlanFingerprint).toBe(
      firstPlan.frozenPlanFingerprint,
    );
    expect(secondPlan.planFingerprint).toBe(firstPlan.planFingerprint);
  });

  test("a matching reviewed fingerprint applies", async () => {
    const t = harness();
    await seedAll(t);
    const dryRun = await t.mutation(api.migrateFile, {
      file: "transactions",
    });

    const applied = await t.mutation(api.migrateFile, {
      file: "transactions",
      apply: true,
      expectedPlanFingerprint: dryRun.frozenPlanFingerprint,
    });

    expect(applied.inserted).toBe(905);
    expect(applied.frozenPlanFingerprint).toBe(
      dryRun.frozenPlanFingerprint,
    );
    expect(await rowsIn(t, "transactions")).toHaveLength(905);
  });

  test("a mutated blob between dry run and apply is refused before any write", async () => {
    const t = harness();
    await seedAll(t);
    const dryRun = await t.mutation(api.migrateFile, {
      file: "transactions",
    });

    await t.run(async (ctx) => {
      const blob = await ctx.db
        .query("dataFiles")
        .withIndex("by_name", (q) => q.eq("name", "transactions"))
        .first();
      const changed = [...(blob!.data as Record<string, unknown>[])];
      changed[0] = { ...changed[0]!, amount: "-999.99" };
      await ctx.db.patch(blob!._id, { data: changed, version: 8 });
    });

    await expect(
      t.mutation(api.migrateFile, {
        file: "transactions",
        apply: true,
        expectedPlanFingerprint: dryRun.frozenPlanFingerprint,
      }),
    ).rejects.toThrow(/fingerprint mismatch/i);
    expect(await rowsIn(t, "transactions")).toHaveLength(0);
  });

  test("apply without a reviewed fingerprint is refused", async () => {
    const t = harness();
    await seedAll(t);
    await expect(
      t.mutation(api.migrateFile, {
        file: "transactions",
        apply: true,
      }),
    ).rejects.toThrow(/without expectedPlanFingerprint/);
    expect(await rowsIn(t, "transactions")).toHaveLength(0);
  });
});

// ─── The migration ───────────────────────────────────────────────────────────

describe("migrating every file", () => {
  test("the full production-shaped path dry-runs, applies, and preserves every blob byte", async () => {
    const t = harness();
    await seedAll(t);
    const blobBytesBefore = canonicalJson(await snapshotBlobWorld(t));

    const dryRuns: MigrateResult[] = [];
    for (const source of MIGRATION_SOURCES) {
      dryRuns.push(await t.mutation(api.migrateFile, { file: source.file }));
    }

    expect(dryRuns.find((result) => result.file === "transactions")).toMatchObject({
      applied: false,
      blobRowCount: 905,
      inserted: 905,
      updated: 0,
      unchanged: 0,
      verification: null,
    });
    expect(dryRuns.find((result) => result.file === "bitcoin-buys")).toMatchObject({
      blobRowCount: 31,
      inserted: 31,
    });
    expect(dryRuns.find((result) => result.file === "todos")).toMatchObject({
      blobRowCount: 25,
      inserted: 25,
    });
    expect(
      dryRuns.find((result) => result.file === "btc-balance-snapshot"),
    ).toMatchObject({
      blobRowCount: 1,
      projectedRowCount: 6,
      inserted: 6,
    });
    expect(
      dryRuns.find((result) => result.file === "son-balances"),
    ).toMatchObject({
      blobRowCount: 1,
      projectedRowCount: 4,
      inserted: 4,
    });
    expect(await rowsIn(t, "transactions")).toHaveLength(0);
    expect(await rowsIn(t, "btcBuys")).toHaveLength(0);
    expect(await rowsIn(t, "btcBillPays")).toHaveLength(0);
    expect(await rowsIn(t, "todos")).toHaveLength(0);
    expect(await rowsIn(t, "btcAccounts")).toHaveLength(0);
    expect(await rowsIn(t, "budgetDocuments")).toHaveLength(0);
    expect(await rowsIn(t, "btcBalanceDocuments")).toHaveLength(0);
    expect(await rowsIn(t, "financeDocuments")).toHaveLength(0);
    expect(canonicalJson(await snapshotBlobWorld(t))).toBe(blobBytesBefore);

    const applied: MigrateResult[] = [];
    for (const source of MIGRATION_SOURCES) {
      applied.push(await applyFile(t, { file: source.file }));
    }

    for (const result of applied) {
      if (!result.blobPresent) continue;
      expect(result.verifiedInTransaction).toBe(true);
      expect(result.verification).toMatchObject({
        ok: true,
        rowCountMatches: true,
        moneySumsMatch: true,
        roundTripRowsMatch: true,
        exactRoundTrip: true,
        problems: [],
      });
    }
    expect(await rowsIn(t, "transactions")).toHaveLength(908);
    expect(await rowsIn(t, "btcBuys")).toHaveLength(31);
    expect(await rowsIn(t, "btcBillPays")).toHaveLength(2);
    expect(await rowsIn(t, "todos")).toHaveLength(25);
    expect(await rowsIn(t, "btcAccounts")).toHaveLength(8);
    expect(await rowsIn(t, "budgetDocuments")).toHaveLength(2);
    expect(await rowsIn(t, "btcBalanceDocuments")).toHaveLength(2);
    expect(await rowsIn(t, "financeDocuments")).toHaveLength(1);
    expect(canonicalJson(await snapshotBlobWorld(t))).toBe(blobBytesBefore);
  });

  test("every declared source lands and verifies in-transaction", async () => {
    const t = harness();
    await seedAll(t);

    const results: MigrateResult[] = [];
    for (const source of MIGRATION_SOURCES) {
      results.push(await applyFile(t, { file: source.file }));
    }

    const byFile = new Map(results.map((result) => [result.file, result]));

    expect(byFile.get("transactions")!.inserted).toBe(905);
    expect(byFile.get("bitcoin-buys")!.inserted).toBe(31);
    expect(byFile.get("todos")!.inserted).toBe(25);
    expect(byFile.get("mason-transactions")!.inserted).toBe(3);
    expect(byFile.get("bitcoin-bill-pays")!.inserted).toBe(2);
    expect(byFile.get("income")!.inserted).toBe(16);
    expect(byFile.get("balances")!.inserted).toBe(1);
    expect(byFile.get("budget")!.inserted).toBe(1);
    expect(byFile.get("mason-budget")!.inserted).toBe(1);
    expect(byFile.get("btc-balance-snapshot")!.inserted).toBe(6);
    expect(byFile.get("finances")!.inserted).toBe(1);
    expect(byFile.get("son-balances")!.inserted).toBe(4);
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
    expect(await rowsIn(t, "btcAccounts")).toHaveLength(8);
    expect(await rowsIn(t, "budgetDocuments")).toHaveLength(2);
    expect(await rowsIn(t, "btcBalanceDocuments")).toHaveLength(2);
    expect(await rowsIn(t, "financeDocuments")).toHaveLength(1);
  });

  test("the summed amounts equal the blob, computed independently", async () => {
    const t = harness();
    await seedAll(t);
    await applyFile(t, { file: "transactions" });

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
    await applyFile(t, { file: "bitcoin-buys" });

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
    await applyFile(t, { file: "income" });
    await applyFile(t, { file: "balances" });

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

  test("the five atomic blobs populate all four empty table families exactly", async () => {
    const t = harness();
    await seedAll(t);
    for (const file of [
      "budget",
      "mason-budget",
      "btc-balance-snapshot",
      "finances",
      "son-balances",
    ]) {
      await applyFile(t, { file });
    }

    const budgets = await rowsIn(t, "budgetDocuments");
    expect(budgets).toHaveLength(2);
    expect(
      budgets.find((row) => row.sourceFile === "budget"),
    ).toMatchObject({
      owner: "victor",
      migrationRawJson: expect.any(String),
      categories: expect.arrayContaining([
        expect.objectContaining({ budgetCents: 10_005n }),
      ]),
      migrationSourceIndex: 0,
    });
    expect(
      budgets.find((row) => row.sourceFile === "mason-budget"),
    ).toMatchObject({
      owner: "mason",
      migrationRawJson: expect.any(String),
      categories: expect.arrayContaining([
        expect.objectContaining({ budgetCents: 2_505n }),
      ]),
      migrationSourceIndex: 0,
    });

    const balanceDocuments = await rowsIn(t, "btcBalanceDocuments");
    expect(balanceDocuments).toHaveLength(2);
    expect(
      balanceDocuments.find(
        (row) => row.sourceFile === "btc-balance-snapshot",
      ),
    ).toMatchObject({
      owner: "victor",
      schemaVersion: 2n,
      migrationRawJson: expect.any(String),
      accounts: expect.arrayContaining([
        expect.objectContaining({
          key: "cashapp",
          sats: 1_000_000n,
          fiatCents: 100_005n,
        }),
      ]),
    });
    expect(
      balanceDocuments.find((row) => row.sourceFile === "son-balances"),
    ).toMatchObject({
      owner: "mason",
      migrationRawJson: expect.any(String),
      totals: {
        sats: 1_600_000n,
        fiatCents: 0n,
        exchangeSats: 600_000n,
        selfCustodySats: 1_000_000n,
      },
    });

    const btcAccounts = await rowsIn(t, "btcAccounts");
    expect(btcAccounts).toHaveLength(8);
    expect(
      btcAccounts
        .filter((row) => row.owner === "mason")
        .map((row) => row.key)
        .sort(),
    ).toEqual([
      "son-coldcard-mason",
      "son-river-mason",
      "son-strike-mason",
    ]);
    expect(
      btcAccounts.every(
        (row) =>
          typeof row.sats === "bigint" &&
          typeof row.fiatCents === "bigint",
      ),
    ).toBe(true);

    const [finances] = await rowsIn(t, "financeDocuments");
    expect(finances).toMatchObject({
      sourceFile: "finances",
      retirementTotalCents: 105_010n,
      migrationRawJson: expect.any(String),
      accounts: expect.arrayContaining([
        expect.objectContaining({ key: "401k", owner: "victor" }),
        expect.objectContaining({ key: "mason_401k", owner: "mason" }),
      ]),
      migrationSourceIndex: 0,
    });

    for (const row of [
      ...budgets,
      ...balanceDocuments,
      ...btcAccounts,
      finances,
    ]) {
      expect(row).not.toHaveProperty("migrationRaw");
    }

    for (const file of [
      "budget",
      "mason-budget",
      "btc-balance-snapshot",
      "finances",
      "son-balances",
    ]) {
      const verification = await t.query(api.verifyFile, { file });
      expect(verification).toMatchObject({
        ok: true,
        rowCountMatches: true,
        moneySumsMatch: true,
        exactRoundTrip: true,
        problems: [],
      });
    }
  });

  test("child files keep their positive spend and adult files keep their negative", async () => {
    const t = harness();
    await seedAll(t);
    await applyFile(t, { file: "mason-transactions" });
    await applyFile(t, { file: "transactions" });

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
    await applyFile(t, { file: "bitcoin-buys" });
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
    await applyFile(t, { file: "todos" });
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
  test("atomic documents and derived BTC accounts are idempotent together", async () => {
    const t = harness();
    await seedAll(t);

    for (const [file, projectedRows] of [
      ["budget", 1],
      ["mason-budget", 1],
      ["btc-balance-snapshot", 6],
      ["finances", 1],
      ["son-balances", 4],
    ] as const) {
      const first = await applyFile(t, { file });
      const second = await applyFile(t, { file });
      expect(first).toMatchObject({
        inserted: projectedRows,
        updated: 0,
        unchanged: 0,
      });
      expect(second).toMatchObject({
        inserted: 0,
        updated: 0,
        unchanged: projectedRows,
      });
    }

    expect(await rowsIn(t, "btcAccounts")).toHaveLength(8);
    expect(await rowsIn(t, "budgetDocuments")).toHaveLength(2);
    expect(await rowsIn(t, "btcBalanceDocuments")).toHaveLength(2);
    expect(await rowsIn(t, "financeDocuments")).toHaveLength(1);
  });

  test("income rows and the balances document insert zero rows on a second run", async () => {
    const t = harness();
    await seedAll(t);

    const incomeFirst = await applyFile(t, { file: "income" });
    const incomeSecond = await applyFile(t, { file: "income" });
    const balancesFirst = await applyFile(t, { file: "balances" });
    const balancesSecond = await applyFile(t, { file: "balances" });

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

    const first = await applyFile(t, { file: "transactions" });
    const second = await applyFile(t, { file: "transactions" });
    const third = await applyFile(t, { file: "transactions" });

    expect(first.inserted).toBe(905);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(905);
    expect(third.inserted).toBe(0);
    expect(third.updated).toBe(0);
    expect(third.unchanged).toBe(905);
    expect(await rowsIn(t, "transactions")).toHaveLength(905);
  });

  test("a re-run does not rewrite updatedAtMs", async () => {
    const t = harness();
    await seedAll(t);
    await applyFile(t, { file: "bitcoin-buys" });
    const before = (await rowsIn(t, "btcBuys")).map((row) => row.updatedAtMs);
    await applyFile(t, { file: "bitcoin-buys" });
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
      const result = await applyFile(t, {
        file: "transactions",
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

    const rerun = await applyFile(t, { file: "transactions" });
    expect(rerun.inserted).toBe(0);
    expect(rerun.unchanged).toBe(905);
  });

  test("BTC document batching covers the atomic row and every account row", async () => {
    const t = harness();
    await seedAll(t);

    let cursor: number | null = 0;
    let inserted = 0;
    while (cursor !== null) {
      const result = await applyFile(t, {
        file: "btc-balance-snapshot",
        cursor,
        batchSize: 2,
      });
      inserted += result.inserted;
      cursor = result.nextCursor;
    }

    expect(inserted).toBe(6);
    expect(await rowsIn(t, "btcBalanceDocuments")).toHaveLength(1);
    expect(await rowsIn(t, "btcAccounts")).toHaveLength(5);
    expect(
      (await t.query(api.verifyFile, { file: "btc-balance-snapshot" })).ok,
    ).toBe(true);
  });

  test("an interrupted run is repaired, not duplicated", async () => {
    const t = harness();
    await seedAll(t);
    // Simulate a run that died after the first 300 rows.
    await applyFile(t, {
      file: "transactions",
      cursor: 0,
      batchSize: 300,
    });
    expect(await rowsIn(t, "transactions")).toHaveLength(300);

    const repair = await applyFile(t, { file: "transactions" });
    expect(repair.inserted).toBe(605);
    expect(repair.unchanged).toBe(300);
    expect(await rowsIn(t, "transactions")).toHaveLength(905);
    expect(repair.verification!.ok).toBe(true);
  });

  test("an edited blob updates the row in place instead of adding one", async () => {
    const t = harness();
    await seedAll(t);
    await applyFile(t, { file: "mason-transactions" });

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

    const result = await applyFile(t, { file: "mason-transactions" });
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
      await applyFile(t, { file: source.file });
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
    await applyFile(t, { file: "transactions" });
    return t;
  }

  test("a missing final non-money row is visible to the count check alone", async () => {
    const t = harness();
    await seedAll(t);
    await applyFile(t, { file: "todos" });
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("todos").collect();
      const final = rows.find((row) => row.migrationSourceIndex === 24)!;
      await ctx.db.delete(final._id);
    });

    const verification = await t.query(api.verifyFile, { file: "todos" });
    expect(verification.ok).toBe(false);
    expect(verification.tableRowCount).toBe(24);
    expect(verification.blobRowCount).toBe(25);
    expect(verification.rowCountMatches).toBe(false);
    expect(verification.moneySumsMatch).toBe(true);
    expect(verification.roundTripRowsMatch).toBe(true);
    expect(verification.exactRoundTrip).toBe(false);
    expect(verification.problems.join(" ")).toContain("row count");
    expect(verification.problems).toHaveLength(1);
  });

  test("a single altered cent is visible to the money-sum check alone", async () => {
    const t = await migrated();
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("transactions").collect();
      await ctx.db.patch(rows[3]!._id, { amountCents: rows[3]!.amountCents + 1n });
    });

    const verification = await t.query(api.verifyFile, { file: "transactions" });
    expect(verification.ok).toBe(false);
    expect(verification.rowCountMatches).toBe(true);
    expect(verification.moneySumsMatch).toBe(false);
    expect(verification.roundTripRowsMatch).toBe(true);
    expect(verification.exactRoundTrip).toBe(true);
    expect(verification.problems.join(" ")).toContain("summed amountCents");
    expect(verification.problems).toHaveLength(1);
  });

  test("corrupted provenance is visible to the round-trip check alone", async () => {
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
    expect(verification.rowCountMatches).toBe(true);
    expect(verification.moneySumsMatch).toBe(true);
    expect(verification.roundTripRowsMatch).toBe(false);
    expect(verification.exactRoundTrip).toBe(false);
    expect(verification.firstMismatchIndex).toBe(5);
    expect(verification.tableRowCount).toBe(verification.blobRowCount);
    expect(verification.tableSums.amountCents).toBe(verification.blobSums.amountCents);
    expect(verification.problems).toHaveLength(1);
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
      applyFile(t, { file: "transactions" }),
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
    await expect(applyFile(t, { file: "transactions" })).rejects.toThrow(
      /not a row collection/,
    );
    expect(await rowsIn(t, "transactions")).toHaveLength(0);
  });

  test("an unknown file is refused", async () => {
    const t = harness();
    await expect(applyFile(t, { file: "maddox-budget" })).rejects.toThrow(
      /Not a migratable file/,
    );
  });

  test("a missing blob is reported, not invented", async () => {
    const t = harness();
    const result = await applyFile(t, { file: "todos" });
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
  test("declares all five formerly skipped documents as frozen migration sources", async () => {
    const t = harness();
    await seedAll(t);

    const status = await t.query(api.status, {});
    expect(status.skippedDocumentShapedFiles).toEqual([]);
    for (const [file, projectedRows] of [
      ["budget", 1],
      ["mason-budget", 1],
      ["btc-balance-snapshot", 6],
      ["finances", 1],
      ["son-balances", 4],
    ] as const) {
      expect(status.files.find((entry) => entry.file === file)).toMatchObject({
        blobPresent: true,
        blobRowCount: 1,
        projectedRowCount: projectedRows,
        migratedRowCount: 0,
        blobUnreadable: false,
      });
    }

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
