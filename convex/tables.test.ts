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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import type { FunctionReference, OptionalRestArgs } from "convex/server";
import { readFileSync } from "node:fs";

import schema from "./schema";
import {
  freshSecret,
  seedDataFile,
  setDeploymentEnv,
  useIsolatedDeploymentEnv,
} from "./harness.test-utils";
import {
  projectBtcBalanceDocument,
  projectBudgetDocument,
  projectFinanceDocument,
} from "./documentProjection";
import {
  BITCOIN_PAYMENT_SOURCES,
  FIAT_PAYMENT_SOURCES,
  PUBLIC_QUERY_INDEX_PLAN,
} from "./tables";

const paymentSourceFixture = JSON.parse(
  readFileSync(
    new URL("../shared/domain/fixtures/payment-source-cases.json", import.meta.url),
    "utf8",
  ),
) as {
  contractVersion: number;
  sources: Array<{
    wire: string;
    route: "transaction" | "btc_bill_pay";
    classification: "bill_pay" | "fiat_card" | "bitcoin_native";
  }>;
};

describe("payment-source catalogue conformance", () => {
  it("matches the shared fixture exactly", () => {
    expect(paymentSourceFixture.contractVersion).toBe(2);
    expect([...FIAT_PAYMENT_SOURCES]).toEqual(
      paymentSourceFixture.sources
        .filter((source) => source.classification === "fiat_card")
        .map((source) => source.wire),
    );
    expect([...BITCOIN_PAYMENT_SOURCES]).toEqual(
      paymentSourceFixture.sources
        .filter((source) => source.classification === "bitcoin_native")
        .map((source) => source.wire),
    );
    expect(
      paymentSourceFixture.sources
        .filter((source) => source.classification === "bill_pay")
        .map(({ wire, route }) => ({ wire, route })),
    ).toEqual([{ wire: "river_bitcoin_bill_pay", route: "btc_bill_pay" }]);
  });
});

// A local module map rather than the shared one in harness.test-utils.ts:
// tables.ts is new and other lanes are editing that file right now, so this
// suite registers exactly what it needs and touches nothing shared.
const modules: Record<string, () => Promise<unknown>> = {
  "./_generated/server.ts": () => import("./generatedServer.test-stub"),
  "./btcLedger.ts": () => import("./btcLedger"),
  "./dataFiles.ts": () => import("./dataFiles"),
  "./dateValidation.ts": () => import("./dateValidation"),
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

type RowEnvelope<Row> = { rows: Row[]; complete: boolean };

async function queryRows<Args extends { viewer: Member }, Row>(
  reference: FunctionReference<"query", "public", Args, RowEnvelope<Row>>,
  ...args: OptionalRestArgs<
    FunctionReference<"query", "public", Args, RowEnvelope<Row>>
  >
): Promise<Row[]> {
  return (await t.query(reference, ...args)).rows;
}

const fn = {
  listTransactions: "tables:listTransactions" as unknown as FunctionReference<
    "query",
    "public",
    { viewer: Member; month?: string; limit?: number; token?: string },
    {
      rows: Array<{
        txId: string;
        owner: Member;
        date: string;
        month: string;
        merchant: string;
        amountCents: bigint;
        spendAmount: bigint;
        displaySpendAmount: bigint;
        hasOppositeSpendSign: boolean;
        category: string;
        card?: string;
        note?: string;
        updatedAtMs: number;
      }>;
      complete: boolean;
    }
  >,
  listIncome: "tables:listIncome" as unknown as FunctionReference<
    "query",
    "public",
    { viewer: Member; month?: string; limit?: number; token?: string },
    {
      rows: Array<{
        incomeId: string;
        owner: Member;
        date: string;
        month: string;
        amountCents: bigint;
        source: string;
        loggedBy?: string;
        note?: string;
        archimedesRequestId?: string;
        updatedAtMs: number;
      }>;
      complete: boolean;
    }
  >,
  listTodos: "tables:listTodos" as unknown as FunctionReference<
    "query",
    "public",
    { viewer: Member; done?: boolean; limit?: number; token?: string },
    {
      rows: Array<{
        todoId: string;
        owner: Member;
        title: string;
        done: boolean;
        flagged: boolean;
        due?: string;
        updatedAtMs: number;
      }>;
      complete: boolean;
    }
  >,
  listBtcBuys: "tables:listBtcBuys" as unknown as FunctionReference<
    "query",
    "public",
    {
      viewer: Member;
      scope: Scope;
      month?: string;
      limit?: number;
      token?: string;
    },
    {
      rows: Array<{
        buyId: string;
        owner: Member;
        date: string;
        sats: bigint;
        priceUsdCents: bigint;
        usdCents: bigint;
        updatedAtMs: number;
      }>;
      complete: boolean;
    }
  >,
  listBtcBillPays: "tables:listBtcBillPays" as unknown as FunctionReference<
    "query",
    "public",
    {
      viewer: Member;
      scope: Scope;
      month?: string;
      limit?: number;
      token?: string;
    },
    {
      rows: Array<{
        billPayId: string;
        owner: Member;
        date: string;
        amountUsdCents: bigint;
        btcSpentSats: bigint;
        btcPriceCents: bigint;
        feeUsdCents: bigint;
        updatedAtMs: number;
      }>;
      complete: boolean;
    }
  >,
  listBtcTransfers: "tables:listBtcTransfers" as unknown as FunctionReference<
    "query",
    "public",
    {
      viewer: Member;
      scope: Scope;
      month?: string;
      limit?: number;
      token?: string;
    },
    {
      rows: Array<{
        transferId: string;
        owner: Member;
        date: string;
        month: string;
        fromAccountKey: string;
        toAccountKey: string;
        sats: bigint;
        feeSats: bigint;
        note?: string;
        updatedAtMs: number;
      }>;
      complete: boolean;
    }
  >,
  listBtcAccounts: "tables:listBtcAccounts" as unknown as FunctionReference<
    "query",
    "public",
    { viewer: Member; scope: Scope; limit?: number; token?: string },
    {
      rows: Array<{
        key: string;
        owner: Member;
        label: string;
        custody: "exchange" | "self_custody";
        sats: bigint;
        fiatCents: bigint;
        asOf: string;
        schemaVersion: bigint;
        updatedAtMs: number;
      }>;
      complete: boolean;
    }
  >,
  listBalanceDocuments:
    "tables:listBalanceDocuments" as unknown as FunctionReference<
      "query",
      "public",
      { viewer: Member; scope: Scope; token?: string },
      {
        rows: Array<{
          owner: Member;
          cashAppSats: bigint;
          coldcardSats: bigint;
          riverSats: bigint;
          strikeSats: bigint;
          zeusSats: bigint;
          totalSats: bigint;
          totalFiatCents?: bigint;
          lastRefreshed: string;
          btcSync: {
            anchorBalancesSats: Record<string, bigint | undefined>;
            anchorDate?: string;
            anchorSource?: string;
            notes?: unknown;
            reconciledAt?: string;
            reconciledFromEvents?: unknown;
          };
          updatedAtMs: number;
        }>;
        complete: boolean;
      }
    >,
  getBudgetDocument: "tables:getBudgetDocument" as unknown as FunctionReference<
    "query",
    "public",
    { viewer: Member; scope: "netWorth"; token?: string },
    {
      document: null | {
        owner: Member;
        month: string;
        coinbaseOneBalanceCents: bigint;
        categories: Array<{ name: string; icon?: string; budgetCents: bigint }>;
        income?: {
          weeklyGrossCents: bigint;
          weeklyStrikeCents: bigint;
          weeklyRiverCents: bigint;
          monthlyGrossCents: bigint;
          mtdIncomeCents: bigint;
          ytdIncomeCents: bigint;
        };
        monthlyHistory: Array<{
          month: string;
          incomeCents: bigint;
          expensesCents: bigint;
          savingsBps: bigint;
        }>;
        updatedAtMs: number;
      };
      complete: boolean;
    }
  >,
  getBtcSnapshotMetadata:
    "tables:getBtcSnapshotMetadata" as unknown as FunctionReference<
      "query",
      "public",
      { viewer: Member; scope: Scope; token?: string },
      {
        rows: Array<{
          owner: Member;
          schemaVersion: bigint;
          asOf: string;
          source?: string;
          basis?: string;
          confidence?: string;
          updatedAtMs: number;
        }>;
        complete: boolean;
      }
    >,
  listBtcBalanceDocuments:
    "tables:listBtcBalanceDocuments" as unknown as FunctionReference<
      "query",
      "public",
      { viewer: Member; scope: Scope; token?: string },
      {
        rows: Array<{
          owner: Member;
          schemaVersion: bigint;
          asOf: string;
          accounts: Array<{
            key: string;
            label: string;
            custody: "exchange" | "self_custody";
            sats: bigint;
            fiatCents: bigint;
          }>;
          totals: {
            sats: bigint;
            fiatCents: bigint;
            exchangeSats: bigint;
            selfCustodySats: bigint;
          };
          updatedAtMs: number;
        }>;
        complete: boolean;
      }
    >,
  getFinanceDocument:
    "tables:getFinanceDocument" as unknown as FunctionReference<
      "query",
      "public",
      { viewer: Member; scope: Scope; token?: string },
      {
        document: null | {
          lastUpdated: string;
          retirementTotalCents?: bigint;
          accounts: Array<{
            key: string;
            owner: Member;
            totalValueCents: bigint;
            weeklyContributionCents: bigint;
            // Declared down to the lots because the share quantities are the
            // part of this response with a contract of their own.
            holdings: Array<{
              name: string;
              ticker?: string;
              sharesDecimal: string;
              lots: Array<{ type: string; sharesDecimal: string }>;
            }>;
          }>;
          updatedAtMs: number;
        };
        complete: boolean;
      }
    >,
  rowCounts: "tables:rowCounts" as unknown as FunctionReference<
    "query",
    "public",
    { token?: string },
    {
      transactions: number;
      todos: number;
      btcBuys: number;
      btcBillPays: number;
      btcAccounts: number;
      income: number;
      balanceDocuments: number;
      budgetDocuments: number;
      btcBalanceDocuments: number;
      financeDocuments: number;
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
        kind?: "spend" | "credit";
      };
      sourceFile?: string;
      token?: string;
    },
    { txId: string; owner: Member; month: string; outcome: string }
  >,
  deleteTransaction: "tables:deleteTransaction" as unknown as FunctionReference<
    "mutation",
    "public",
    {
      txId: string;
      owner?: Member;
      sourceFile?: string;
      token?: string;
    },
    { txId: string; owner: Member; removed: boolean }
  >,
  upsertTodo: "tables:upsertTodo" as unknown as FunctionReference<
    "mutation",
    "public",
    {
      todo: Record<string, unknown>;
      token?: string;
    },
    { todoId: string; owner: Member; done: boolean; outcome: string }
  >,
  deleteTodo: "tables:deleteTodo" as unknown as FunctionReference<
    "mutation",
    "public",
    {
      todoId: string;
      token?: string;
    },
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
      baseUpdatedAtMs?: number;
      token?: string;
    },
    { buyId: string; owner: Member; month: string; outcome: string }
  >,
  upsertBtcBillPay: "tables:upsertBtcBillPay" as unknown as FunctionReference<
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
        note?: string;
        feeUsdCents: bigint;
        reference?: string;
        owner?: Member;
      };
      sourceFile?: string;
      baseUpdatedAtMs?: number;
      token?: string;
    },
    { billPayId: string; owner: Member; month: string; outcome: string }
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
      baseUpdatedAtMs?: number;
      token?: string;
    },
    { key: string; owner: Member; outcome: string }
  >,
  upsertBudgetCategory:
    "tables:upsertBudgetCategory" as unknown as FunctionReference<
      "mutation",
      "public",
      {
        viewer: Member;
        month: string;
        category: { name: string; icon?: string; budgetCents: bigint };
        token?: string;
      },
      {
        owner: Member;
        month: string;
        name: string;
        outcome: string;
      }
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
    amount: 84.27,
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
    amount: 1.15,
    category: "Home",
  },
];

// Purchases are positive for every owner.
const MASON_TRANSACTIONS = [
  {
    id: "m-1",
    date: "2026-07-04",
    merchant: "Game Store",
    amount: 60,
    category: "Fun",
  },
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

const BILL_PAYS = {
  bill_pays: [
    {
      id: "bp-1",
      date: "2026-07-17",
      merchant: "Electric Utility",
      category: "Utilities",
      amount_usd: 186.55,
      btc_spent: 0.002,
      btc_price: 93275,
      platform: "river",
      fee_usd: 0.95,
      reference: "invoice-1",
    },
  ],
};

const ADULT_BUDGET = {
  month: "2026-07",
  coinbase_one_balance: 125.5,
  categories: [
    { name: "Groceries", icon: "cart", budget: 900, spent: 123.45 },
    { name: "Utilities", icon: "zap", budget: 400, spent: 186.55 },
  ],
  strategy: { effective_apr: "4.5%", strategy_note: "Synthetic fixture" },
  income: {
    weekly_gross: 1200,
    weekly_strike: 100,
    weekly_river: 50,
    pay_frequency: "weekly",
    monthly_gross: 4800,
    mtd_income: 2500,
    ytd_income: 30000,
    paychecks: [
      {
        date: "2026-07-19",
        platform: "direct",
        source: "employer",
        amount: 2500,
        net: 2500,
      },
    ],
  },
  mtd_income: 2500,
  ytd_income: 30000,
  monthly_history: [
    { month: "2026-06", income: 4800, expenses: 3200, savings_pct: 33.33 },
  ],
};

const MASON_BUDGET = {
  month: "2026-07",
  categories: [{ name: "Fun", icon: "game", budget: 75, spent: 60 }],
  mtd_income: 0,
  ytd_income: 0,
};

const SNAPSHOT = {
  schemaVersion: 2,
  asOf: "2026-07-18T12:00:00Z",
  accounts: {
    strike: { btc: 0.35, fiat: 34300.55, label: "Strike", custody: "exchange" },
    coldcard: {
      btc: 1.5,
      fiat: 147000,
      label: "Coldcard",
      custody: "self_custody",
    },
  },
  totals: { btc: 1.85, fiat: 181300.55 },
  metadata: {
    source: "synthetic",
    basis: "spot",
    confidence: "verified",
  },
};

const SON_BALANCES = {
  strike: 0.004,
  river: 0.002,
  coldcard: 0.01,
  total: 0.016,
  lastUpdated: "2026-07-18T12:00:00Z",
};

const INCOME_ROWS = [
  {
    id: "income-1",
    date: "2026-07-01",
    amount: 2500.55,
    source: "payroll",
    logged_by: "victor",
    note: "shared household",
    archimedes_request_id: "income-arch-1",
  },
];

const LEGACY_BALANCES = {
  cashapp: 0,
  coldcard: 0.12345678,
  river: 0.25,
  strike: 0,
  zeus: 0,
  total: 0.37345678,
  cashapp_fiat: 0,
  coldcard_fiat: 12345.67,
  river_fiat: 25000,
  strike_fiat: 0,
  zeus_fiat: 0,
  total_fiat: 37345.67,
  lastRefreshed: "2026-07-26T23:59:59Z",
  btc_sync: {
    anchor_balances: {
      coldcard: 0.12345677,
      river: 0.25,
      total: 0.37345677,
    },
    anchor_date: "2026-07-20",
    anchor_source: "event-reconciliation",
    notes: "provenance retained",
    reconciled_at: "2026-07-26T23:50:00Z",
    reconciled_from_events: true,
  },
};

const FINANCES = {
  retirement: {
    total: 125000.55,
    accounts: {
      victor_401k: {
        provider: "Adult Provider",
        total: 125000.55,
        weeklyContribution: 250,
        holdings: [
          {
            name: "Index Fund",
            category: "Equity",
            ticker: "INDEX",
            value: 125000.55,
            costBasis: 100000,
            gainPct: 25.0005,
            shares: 321.125,
            avgCost: 311.4,
            currentPricePerShare: 389.21,
            lots: [
              {
                date: "2026-01-15",
                type: "buy",
                pricePerShare: 300.25,
                shares: 10.5,
                amountInvested: 3152.625,
              },
            ],
          },
        ],
      },
    },
  },
  mason_401k: {
    provider: "Child Provider",
    total: 1500.25,
    weeklyContribution: 25,
    owner: "mason",
    holdings: [],
  },
  last_updated: "2026-07-18T12:00:00Z",
};

const TODOS = [
  {
    id: "todo-1",
    title: "Pay the water bill",
    done: false,
    updated_at: "2026-07-10T09:00:00Z",
  },
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
  await seedDataFile(t, "bitcoin-bill-pays", BILL_PAYS);
  await seedDataFile(t, "budget", ADULT_BUDGET);
  await seedDataFile(t, "mason-budget", MASON_BUDGET);
  await seedDataFile(t, "btc-balance-snapshot", SNAPSHOT);
  await seedDataFile(t, "son-balances", SON_BALANCES);
  await seedDataFile(t, "finances", FINANCES);
  await seedDataFile(t, "todos", TODOS);
  await seedDataFile(t, "income", INCOME_ROWS);
  await seedDataFile(t, "balances", LEGACY_BALANCES);
}

async function migrateAll(t: T) {
  for (const name of [
    "transactions",
    "mason-transactions",
    "bitcoin-buys",
    "mason-bitcoin-buys",
    "bitcoin-bill-pays",
    "todos",
    "income",
    "balances",
  ]) {
    const reviewed = (await t.mutation(fn.migrateFile, { file: name })) as {
      frozenPlanFingerprint: string;
    };
    await t.mutation(fn.migrateFile, {
      file: name,
      apply: true,
      expectedPlanFingerprint: reviewed.frozenPlanFingerprint,
    });
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
    await t.mutation(fn.upsertBtcAccount, {
      account,
      sourceFile:
        account.owner === "mason" ? "son-balances" : "btc-balance-snapshot",
    });
  }

  // The document migration is owned by a separate lane. Seed its exact typed
  // projection here so this suite tests the schema and public queries without
  // modifying convex/migrate.ts or inventing a blob-backed runtime fallback.
  await t.run(async (ctx) => {
    await ctx.db.insert(
      "budgetDocuments",
      projectBudgetDocument(JSON.stringify(ADULT_BUDGET), "budget", 1000),
    );
    await ctx.db.insert(
      "budgetDocuments",
      projectBudgetDocument(JSON.stringify(MASON_BUDGET), "mason-budget", 1001),
    );
    await ctx.db.insert(
      "btcBalanceDocuments",
      projectBtcBalanceDocument(
        JSON.stringify(SNAPSHOT),
        "btc-balance-snapshot",
        1002,
      ),
    );
    await ctx.db.insert(
      "btcBalanceDocuments",
      projectBtcBalanceDocument(
        JSON.stringify(SON_BALANCES),
        "son-balances",
        1003,
      ),
    );
    await ctx.db.insert(
      "financeDocuments",
      projectFinanceDocument(JSON.stringify(FINANCES), 1004),
    );
  });
}

async function seedPostingLedgers(t: T) {
  await t.run(async (ctx) => {
    for (const owner of ["victor", "mason"] as const) {
      const sourceFile =
        owner === "victor" ? "btc-balance-snapshot" : "son-balances";
      const mirrorKey = owner === "victor" ? "river" : "son-river-mason";
      await ctx.db.insert("btcBalanceDocuments", {
        sourceFile,
        owner,
        schemaVersion: 2n,
        asOf: "2026-07-30T00:00:00.000Z",
        accounts: [
          {
            key: "river",
            label: "River",
            custody: "exchange",
            sats: 10_000_000n,
            fiatCents: 100_000n,
          },
        ],
        totals: {
          sats: 10_000_000n,
          fiatCents: 100_000n,
          exchangeSats: 10_000_000n,
          selfCustodySats: 0n,
        },
        postingActivatedAtMs: 1,
        updatedAtMs: 1,
      });
      await ctx.db.insert("btcAccounts", {
        key: mirrorKey,
        owner,
        label: "River",
        custody: "exchange",
        sats: 10_000_000n,
        fiatCents: 100_000n,
        asOf: "2026-07-30T00:00:00.000Z",
        schemaVersion: 2n,
        sourceFile,
        updatedAtMs: 1,
      });
    }
  });
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
    await migrateAll(t);
    const before = await blobWorldSnapshot(t);

    await t.mutation(fn.upsertTransaction, {
      transaction: {
        id: "app-1",
        date: "2026-07-20",
        merchant: "Cafe",
        amountCents: 450n,
        category: "Food",
      },
    });
    await t.mutation(fn.deleteTransaction, { txId: "app-1" });
    await t.mutation(fn.upsertTodo, {
      todo: { id: "app-todo", title: "Ship it", owner: "victor" },
    });
    await t.mutation(fn.deleteTodo, {
      todoId: "app-todo",
    });
    await t.mutation(fn.upsertBudgetCategory, {
      viewer: "victor",
      month: "2026-07",
      category: { name: "Groceries", budgetCents: 95000n },
    });

    const after = await blobWorldSnapshot(t);
    expect(after.files).toEqual(before.files);
    expect(after.versions).toEqual(before.versions);
  });

  it("deleteTodo preserves the legacy tombstone while clients still read blobs", async () => {
    await migrateAll(t);
    await t.mutation(fn.deleteTodo, {
      todoId: "todo-1",
    });

    const tombstones = await t.run(async (ctx) =>
      ctx.db.query("todoTombstones").collect(),
    );
    expect(tombstones.map((row) => row.id)).toEqual(["todo-1"]);
    expect(
      await queryRows(fn.listTodos, { viewer: "victor" }),
    ).not.toContainEqual(expect.objectContaining({ todoId: "todo-1" }));
  });

  it("deleteTransaction writes no todo tombstone — transactions need a separate convergence design", async () => {
    await migrateAll(t);
    await t.mutation(fn.deleteTransaction, { txId: "t-1" });

    const tombstones = await t.run(async (ctx) =>
      ctx.db.query("todoTombstones").collect(),
    );
    expect(tombstones).toHaveLength(0);
    expect(
      await queryRows(fn.listTransactions, { viewer: "victor" }),
    ).not.toContainEqual(expect.objectContaining({ txId: "t-1" }));
  });

  it("typed document projection and inserts leave all blob tables byte-identical", async () => {
    const before = await blobWorldSnapshot(t);
    await migrateAll(t);
    expect(await blobWorldSnapshot(t)).toEqual(before);
  });
});

describe("money is integer minor units", () => {
  beforeEach(async () => {
    await migrateAll(t);
  });

  it("projects signed spend, display magnitude, and refund signs", async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert("transactions", {
        txId: "adult-refund",
        owner: "victor",
        date: "2026-07-21",
        month: "2026-07",
        merchant: "Grocer refund",
        amountCents: -2500n,
        category: "Groceries",
        sourceFile: "transactions",
        updatedAtMs: 1,
      });
      await ctx.db.insert("transactions", {
        txId: "adult-refund-2",
        owner: "victor",
        date: "2026-07-22",
        month: "2026-07",
        merchant: "Second refund",
        amountCents: -900n,
        category: "Fun",
        sourceFile: "transactions",
        updatedAtMs: 1,
      });
    });

    const byId = new Map(
      (await queryRows(fn.listTransactions, { viewer: "victor" })).map(
        (row) => [row.txId, row],
      ),
    );

    expect(byId.get("t-1")).toMatchObject({
      spendAmount: 8427n,
      displaySpendAmount: 8427n,
      hasOppositeSpendSign: false,
    });
    expect(byId.get("m-1")).toMatchObject({
      spendAmount: 6000n,
      displaySpendAmount: 6000n,
      hasOppositeSpendSign: false,
    });
    expect(byId.get("t-2")).toMatchObject({
      spendAmount: 0n,
      displaySpendAmount: 0n,
      hasOppositeSpendSign: false,
    });
    expect(byId.get("adult-refund")).toMatchObject({
      spendAmount: -2500n,
      displaySpendAmount: 2500n,
      hasOppositeSpendSign: true,
    });
    expect(byId.get("adult-refund-2")).toMatchObject({
      spendAmount: -900n,
      displaySpendAmount: 900n,
      hasOppositeSpendSign: true,
    });
  });

  it("projects production purchase and refund signs without owner-based inversion", async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert("transactions", {
        txId: "production-adult-purchase",
        owner: "victor",
        date: "2026-03-15",
        month: "2026-03",
        merchant: "Etsy",
        amountCents: 3762n,
        category: "Shopping",
        sourceFile: "transactions",
        updatedAtMs: 1,
      });
      await ctx.db.insert("transactions", {
        txId: "production-adult-refund",
        owner: "victor",
        date: "2026-03-16",
        month: "2026-03",
        merchant: "Paypal *ebay",
        amountCents: -123469n,
        category: "Shopping",
        sourceFile: "transactions",
        updatedAtMs: 1,
      });
      await ctx.db.insert("transactions", {
        txId: "production-child-purchase",
        owner: "mason",
        date: "2026-03-17",
        month: "2026-03",
        merchant: "Mason purchase",
        amountCents: 3762n,
        category: "Shopping",
        sourceFile: "mason-transactions",
        updatedAtMs: 1,
      });
    });

    const byId = new Map(
      (await queryRows(fn.listTransactions, { viewer: "victor" })).map(
        (row) => [row.txId, row],
      ),
    );
    expect(byId.get("production-adult-purchase")).toMatchObject({
      spendAmount: 3762n,
      displaySpendAmount: 3762n,
      hasOppositeSpendSign: false,
    });
    expect(byId.get("production-adult-refund")).toMatchObject({
      spendAmount: -123469n,
      displaySpendAmount: 123469n,
      hasOppositeSpendSign: true,
    });
    expect(byId.get("production-child-purchase")).toMatchObject({
      spendAmount: 3762n,
      displaySpendAmount: 3762n,
      hasOppositeSpendSign: false,
    });
  });

  it("stores cents as bigint, never a float", async () => {
    const rows = await queryRows(fn.listTransactions, { viewer: "victor" });
    for (const row of rows) {
      expect(typeof row.amountCents).toBe("bigint");
      expect(typeof row.spendAmount).toBe("bigint");
      expect(typeof row.displaySpendAmount).toBe("bigint");
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
    const rows = await queryRows(fn.listTransactions, { viewer: "victor" });
    const hardware = rows.find((row) => row.txId === "t-3");
    expect(hardware?.amountCents).toBe(115n);
  });

  it("keeps the sign the source file used", async () => {
    const rows = await queryRows(fn.listTransactions, { viewer: "victor" });
    const adultSpend = rows.find((row) => row.txId === "t-1");
    const childSpend = rows.find((row) => row.txId === "m-1");

    expect(adultSpend?.amountCents).toBe(8427n);
    // sourceFile remains internal migration provenance and is not public.
    expect(childSpend?.amountCents).toBe(6000n);
    expect(adultSpend).not.toHaveProperty("sourceFile");
    expect(childSpend).not.toHaveProperty("sourceFile");
  });

  it("prefers amount_sats over the lossy amount_btc mirror", async () => {
    const buys = await queryRows(fn.listBtcBuys, {
      viewer: "victor",
      scope: "visible",
    });
    const adult = buys.find((buy) => buy.buyId === "b-1");
    expect(adult?.sats).toBe(250000n);
    expect(adult?.priceUsdCents).toBe(9800050n);
    expect(adult?.usdCents).toBe(24500n);

    // …and falls back to amount_btc at 8 dp when the integer field is absent.
    const child = buys.find((buy) => buy.buyId === "mb-1");
    expect(child?.sats).toBe(100000n);
  });

  it("converts snapshot balances to sats and cents", async () => {
    const accounts = await queryRows(fn.listBtcAccounts, {
      viewer: "victor",
      scope: "visible",
    });
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
    const victorRows = await queryRows(fn.listTransactions, {
      viewer: "victor",
    });
    const rachelRows = await queryRows(fn.listTransactions, {
      viewer: "rachel",
    });

    expect(victorRows.map((row) => row.txId).sort()).toEqual(
      rachelRows.map((row) => row.txId).sort(),
    );
    expect(rachelRows.length).toBeGreaterThan(0);
    expect(rachelRows.some((row) => row.owner === "victor")).toBe(true);
  });

  it("returns complete production-shaped income rows to both adults and none to children", async () => {
    const victor = await t.query(fn.listIncome, { viewer: "victor" });
    const rachel = await t.query(fn.listIncome, { viewer: "rachel" });
    const mason = await t.query(fn.listIncome, { viewer: "mason" });

    expect(victor).toEqual(rachel);
    expect(victor.complete).toBe(true);
    expect(victor.rows).toEqual([
      {
        incomeId: "income-1",
        owner: "victor",
        date: "2026-07-01",
        month: "2026-07",
        amountCents: 250055n,
        source: "payroll",
        loggedBy: "victor",
        note: "shared household",
        archimedesRequestId: "income-arch-1",
        updatedAtMs: 0,
      },
    ]);
    expect(mason).toEqual({ rows: [], complete: true });
    expect(victor.rows[0]).not.toHaveProperty("sourceKey");
    expect(victor.rows[0]).not.toHaveProperty("raw");
    expect(victor.rows[0]).not.toHaveProperty("sourceFile");
  });

  it("adults see the kids; kids see only themselves", async () => {
    const adult = await queryRows(fn.listTransactions, { viewer: "rachel" });
    expect(adult.map((row) => row.owner)).toContain("mason");

    const mason = await queryRows(fn.listTransactions, { viewer: "mason" });
    expect(mason.map((row) => row.owner)).toEqual(["mason"]);

    const maddox = await queryRows(fn.listTransactions, { viewer: "maddox" });
    expect(maddox).toEqual([]);
  });

  it("canSee is WIDER than sharesNetWorth, on the same data, for the same adult", async () => {
    const visible = await queryRows(fn.listBtcAccounts, {
      viewer: "victor",
      scope: "visible",
    });
    const netWorth = await queryRows(fn.listBtcAccounts, {
      viewer: "victor",
      scope: "netWorth",
    });

    // Victor can SEE Mason's Coldcard on Mason's profile…
    expect(visible.map((a) => a.owner)).toContain("mason");
    // …and it must NOT be part of adult net worth.
    expect(netWorth.map((a) => a.owner)).not.toContain("mason");
    expect(
      netWorth.every((a) => a.owner === "victor" || a.owner === "rachel"),
    ).toBe(true);
    // Backwards would mean either a leak or an empty screen; assert the gap is
    // real rather than the two queries having quietly become one.
    expect(netWorth.length).toBeLessThan(visible.length);
  });

  it("the same widths hold for btcBuys", async () => {
    const visible = await queryRows(fn.listBtcBuys, {
      viewer: "victor",
      scope: "visible",
    });
    const netWorth = await queryRows(fn.listBtcBuys, {
      viewer: "victor",
      scope: "netWorth",
    });
    expect(visible.map((b) => b.buyId)).toContain("mb-1");
    expect(netWorth.map((b) => b.buyId)).not.toContain("mb-1");
  });

  it("keeps the adult balances document behind its indexed owner boundary", async () => {
    const rachelVisible = await queryRows(fn.listBalanceDocuments, {
      viewer: "rachel",
      scope: "visible",
    });
    const rachelNetWorth = await queryRows(fn.listBalanceDocuments, {
      viewer: "rachel",
      scope: "netWorth",
    });
    const masonVisible = await queryRows(fn.listBalanceDocuments, {
      viewer: "mason",
      scope: "visible",
    });

    expect(rachelVisible).toHaveLength(1);
    expect(rachelVisible[0]).toMatchObject({
      owner: "victor",
      coldcardSats: 12_345_678n,
      totalSats: 37_345_678n,
      totalFiatCents: 3_734_567n,
    });
    expect(rachelNetWorth).toEqual(rachelVisible);
    expect(masonVisible).toEqual([]);
    expect(rachelVisible[0]).not.toHaveProperty("raw");
    expect(rachelVisible[0]).not.toHaveProperty("sourceFile");
  });

  it("a child sharing an account key with an adult stays a separate row", async () => {
    // Both the adults and Mason have a "strike" account. Identity is
    // (owner, key); merging on key alone would put a child's stack in the
    // adult total.
    const accounts = await queryRows(fn.listBtcAccounts, {
      viewer: "victor",
      scope: "visible",
    });
    const mason = accounts.filter((account) => account.owner === "mason");
    expect(mason.map((account) => account.key).sort()).toEqual([
      "son-coldcard-mason",
      "son-river-mason",
      "son-strike-mason",
    ]);
    expect(mason.find((a) => a.key === "son-strike-mason")?.sats).toBe(400000n);
  });

  it("refuses a garbage owner string in a child file instead of coercing it", async () => {
    await seedDataFile(t, "maddox-transactions", [
      {
        id: "x-1",
        date: "2026-07-08",
        merchant: "Sweets",
        amount: 5,
        category: "Fun",
        owner: "Maddox ",
      },
    ]);
    await expect(
      t.mutation(fn.migrateFile, { file: "maddox-transactions" }),
    ).rejects.toThrow(/closed union/);
    expect(
      (await queryRows(fn.listTransactions, { viewer: "victor" })).some(
        (candidate) => candidate.txId === "x-1",
      ),
    ).toBe(false);
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

    const mason = await queryRows(fn.listTodos, { viewer: "mason" });
    expect(mason.map((todo) => todo.todoId)).toContain("todo-3");
  });

  it("todo snapshots are exact-profile even for adult viewers", async () => {
    await t.mutation(fn.upsertTodo, {
      todo: {
        id: "todo-rachel-private",
        title: "Rachel private",
        owner: "rachel",
        updated_at: "2026-07-12T10:00:00Z",
      },
    });
    await t.mutation(fn.upsertTodo, {
      todo: {
        id: "todo-mason-private",
        title: "Mason private",
        owner: "mason",
        updated_at: "2026-07-12T11:00:00Z",
      },
    });

    const victor = await queryRows(fn.listTodos, { viewer: "victor" });
    const rachel = await queryRows(fn.listTodos, { viewer: "rachel" });
    const mason = await queryRows(fn.listTodos, { viewer: "mason" });
    expect(victor.every((todo) => todo.owner === "victor")).toBe(true);
    expect(rachel.map((todo) => todo.todoId)).toEqual(["todo-rachel-private"]);
    expect(mason.map((todo) => todo.todoId)).toContain("todo-mason-private");
    expect(mason.every((todo) => todo.owner === "mason")).toBe(true);
  });
});

describe("indexed month and date", () => {
  beforeEach(async () => {
    await migrateAll(t);
  });

  it("defines every index used by the executable public query plan", () => {
    const tables = (
      schema as unknown as {
        tables: Record<
          string,
          { indexes: Array<{ indexDescriptor: string; fields: string[] }> }
        >;
      }
    ).tables;
    const indexes = (table: string) =>
      new Map(
        tables[table].indexes.map(({ indexDescriptor, fields }) => [
          indexDescriptor,
          fields,
        ]),
      );

    for (const plan of Object.values(PUBLIC_QUERY_INDEX_PLAN)) {
      for (const branch of Object.values(plan)) {
        if (typeof branch === "string") continue;
        expect(
          indexes(plan.table).get(branch.name),
          `${plan.table}.${branch.name}`,
        ).toEqual(branch.fields);
      }
    }
    expect(PUBLIC_QUERY_INDEX_PLAN.listIncome).toEqual({
      table: "income",
      all: {
        name: "by_owner_date_income_id",
        fields: ["owner", "date", "incomeId"],
      },
      month: {
        name: "by_owner_month_date_income_id",
        fields: ["owner", "month", "date", "incomeId"],
      },
    });
  });

  it("reads the dedicated income ledger by indexed owner and month", async () => {
    const rachel = await t.query(fn.listIncome, { viewer: "rachel" });
    expect(rachel).toMatchObject({ complete: true });
    expect(rachel.rows).toEqual([
      expect.objectContaining({
        incomeId: "income-1",
        owner: "victor",
        month: "2026-07",
        amountCents: 250055n,
        source: "payroll",
      }),
    ]);
    expect(rachel.rows[0]).not.toHaveProperty("raw");
    expect(rachel.rows[0]).not.toHaveProperty("sourceFile");
    expect(
      await queryRows(fn.listIncome, {
        viewer: "rachel",
        month: "2026-07",
      }),
    ).toHaveLength(1);
    expect(
      await queryRows(fn.listIncome, {
        viewer: "rachel",
        month: "2026-06",
      }),
    ).toEqual([]);
    expect(await queryRows(fn.listIncome, { viewer: "mason" })).toEqual([]);
  });

  it("bounds tied income rows by the same stable income-id order it returns", async () => {
    await t.run(async (ctx) => {
      for (const incomeId of ["income-z", "income-a"]) {
        await ctx.db.insert("income", {
          sourceKey: `income:${incomeId}`,
          incomeId,
          owner: "victor",
          date: "2026-07-31",
          month: "2026-07",
          amountCents: 1n,
          source: "test",
          sourceFile: "income",
          updatedAtMs: 1,
          raw: { id: incomeId },
          migrationSourceIndex: 1,
        });
      }
    });

    const response = await t.query(fn.listIncome, {
      viewer: "victor",
      month: "2026-07",
      limit: 1,
    });
    expect(response.complete).toBe(false);
    expect(response.rows.map((row) => row.incomeId)).toEqual(["income-z"]);
  });

  it("derives month from date as a prefix, with no timezone in the way", async () => {
    const july = await queryRows(fn.listTransactions, {
      viewer: "victor",
      month: "2026-07",
    });
    expect(july.map((row) => row.txId).sort()).toEqual(["m-1", "t-1", "t-2"]);
    expect(july.every((row) => row.month === "2026-07")).toBe(true);

    const june = await queryRows(fn.listTransactions, {
      viewer: "victor",
      month: "2026-06",
    });
    expect(june.map((row) => row.txId)).toEqual(["t-3"]);
  });

  it("returns newest first and honours limit", async () => {
    const rows = await queryRows(fn.listTransactions, {
      viewer: "victor",
      limit: 2,
    });
    expect(rows.map((row) => row.date)).toEqual(["2026-07-19", "2026-07-04"]);
  });

  it("applies a month limit after date ordering for every month-indexed table", async () => {
    // These rows are inserted after the migrated July rows. by_owner_month
    // contains only (owner, month), so taking one row from that range before
    // sorting by date returns an older creation-order row.
    await t.run(async (ctx) => {
      await ctx.db.insert("transactions", {
        txId: "month-newest-transaction",
        owner: "victor",
        date: "2026-07-31",
        month: "2026-07",
        merchant: "Newest transaction",
        amountCents: 1n,
        category: "Other",
        sourceFile: "transactions",
        updatedAtMs: 1,
      });
      await ctx.db.insert("btcBuys", {
        buyId: "month-newest-buy",
        owner: "victor",
        date: "2026-07-31",
        month: "2026-07",
        source: "strike",
        sats: 1n,
        priceUsdCents: 1n,
        usdCents: 1n,
        sourceFile: "bitcoin-buys",
        updatedAtMs: 1,
      });
      await ctx.db.insert("btcBillPays", {
        billPayId: "month-newest-bill-pay",
        owner: "victor",
        date: "2026-07-31",
        month: "2026-07",
        merchant: "Newest bill pay",
        category: "Utilities",
        amountUsdCents: 1n,
        btcSpentSats: 1n,
        btcPriceCents: 1n,
        feeUsdCents: 0n,
        sourceFile: "bitcoin-bill-pays",
        updatedAtMs: 1,
      });
    });

    expect(
      (
        await queryRows(fn.listTransactions, {
          viewer: "victor",
          month: "2026-07",
          limit: 1,
        })
      ).map((row) => row.txId),
    ).toEqual(["month-newest-transaction"]);
    expect(
      (
        await queryRows(fn.listBtcBuys, {
          viewer: "victor",
          scope: "visible",
          month: "2026-07",
          limit: 1,
        })
      ).map((row) => row.buyId),
    ).toEqual(["month-newest-buy"]);
    expect(
      (
        await queryRows(fn.listBtcBillPays, {
          viewer: "victor",
          scope: "visible",
          month: "2026-07",
          limit: 1,
        })
      ).map((row) => row.billPayId),
    ).toEqual(["month-newest-bill-pay"]);
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
        owner: "victor",
        done: true,
        updated_at: "2026-07-20T09:00:00Z",
      },
    });
    await t.mutation(fn.upsertTodo, {
      todo: {
        id: "recent-open",
        title: "Newest",
        owner: "victor",
        done: false,
        updated_at: "2026-07-30T09:00:00Z",
      },
    });

    const newest = await queryRows(fn.listTodos, {
      viewer: "victor",
      limit: 1,
    });
    expect(newest.map((todo) => todo.todoId)).toEqual(["recent-open"]);
  });

  it("scopes a month query to one owner for a child viewer", async () => {
    const rows = await queryRows(fn.listTransactions, {
      viewer: "mason",
      month: "2026-07",
    });
    expect(rows.map((row) => row.txId)).toEqual(["m-1"]);
  });
});

describe("public Linux/Android read contract", () => {
  beforeEach(async () => {
    await migrateAll(t);
  });

  it("returns allowlisted projections, never Convex internals or migration provenance", async () => {
    const responses = [
      await t.query(fn.listTransactions, { viewer: "victor" }),
      await t.query(fn.listIncome, { viewer: "victor" }),
      await t.query(fn.listTodos, { viewer: "victor" }),
      await t.query(fn.listBtcBuys, { viewer: "victor", scope: "visible" }),
      await t.query(fn.listBtcBillPays, {
        viewer: "victor",
        scope: "visible",
      }),
      await t.query(fn.listBtcAccounts, {
        viewer: "victor",
        scope: "visible",
      }),
      await t.query(fn.listBalanceDocuments, {
        viewer: "victor",
        scope: "visible",
      }),
    ];

    for (const response of responses) {
      expect(response.complete).toBe(true);
      expect(response.rows.length).toBeGreaterThan(0);
      for (const row of response.rows) {
        expect(row).not.toHaveProperty("_id");
        expect(row).not.toHaveProperty("_creationTime");
        expect(row).not.toHaveProperty("migrationRaw");
        expect(row).not.toHaveProperty("migrationSourceIndex");
        expect(row).not.toHaveProperty("sourceFile");
      }
    }
  });

  it("returns scoped Bitcoin transfer history needed for revision-fenced correction", async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert("btcTransfers", {
        transferId: "transfer-read-1",
        owner: "victor",
        date: "2026-08-01",
        month: "2026-08",
        fromAccountKey: "river",
        toAccountKey: "coldcard",
        sats: 50_000n,
        feeSats: 250n,
        note: "Test transfer",
        sourceFile: "btc-transfers",
        balancePostingVersion: 1n,
        updatedAtMs: 123,
      });
    });

    const response = await t.query(fn.listBtcTransfers, {
      viewer: "rachel",
      scope: "netWorth",
    });
    expect(response).toEqual({
      complete: true,
      rows: [{
        transferId: "transfer-read-1",
        owner: "victor",
        date: "2026-08-01",
        month: "2026-08",
        fromAccountKey: "river",
        toAccountKey: "coldcard",
        sats: 50_000n,
        feeSats: 250n,
        note: "Test transfer",
        updatedAtMs: 123,
      }],
    });
  });

  it("marks every explicitly bounded response incomplete", async () => {
    const transactions = await t.query(fn.listTransactions, {
      viewer: "victor",
      limit: 2,
    });
    expect(transactions).toMatchObject({ complete: false });
    expect(transactions.rows).toHaveLength(2);

    const income = await t.query(fn.listIncome, {
      viewer: "victor",
      limit: 1,
    });
    expect(income).toEqual({
      rows: [
        expect.objectContaining({ incomeId: "income-1", amountCents: 250055n }),
      ],
      complete: false,
    });

    const accounts = await t.query(fn.listBtcAccounts, {
      viewer: "victor",
      scope: "netWorth",
      limit: 20,
    });
    expect(accounts.complete).toBe(false);
    expect(accounts.rows.length).toBeGreaterThan(0);
  });

  it("rejects invalid limits instead of interpreting them loosely", async () => {
    await expect(
      t.query(fn.listTransactions, { viewer: "victor", limit: 0 }),
    ).rejects.toThrow(/integer from 1 to 2000/);
    await expect(
      t.query(fn.listTransactions, { viewer: "victor", limit: 1.5 }),
    ).rejects.toThrow(/integer from 1 to 2000/);
    await expect(
      t.query(fn.listTransactions, { viewer: "victor", limit: 2001 }),
    ).rejects.toThrow(/integer from 1 to 2000/);
  });

  it("requires callers to choose BTC visibility scope explicitly", async () => {
    await expect(
      t.query(fn.listBtcBuys as any, { viewer: "victor" }),
    ).rejects.toThrow();
    await expect(
      t.query(fn.listBtcAccounts as any, { viewer: "victor" }),
    ).rejects.toThrow();
    await expect(
      t.query(fn.listBalanceDocuments as any, { viewer: "victor" }),
    ).rejects.toThrow();
  });

  it("fails closed when a full replacement snapshot exceeds the hard maximum", async () => {
    await t.run(async (ctx) => {
      for (let index = 0; index < 2001; index += 1) {
        await ctx.db.insert("transactions", {
          txId: `overflow-${index}`,
          owner: "maddox",
          date: "2026-07-31",
          month: "2026-07",
          merchant: "Synthetic overflow",
          amountCents: 1n,
          category: "Other",
          sourceFile: "maddox-transactions",
          updatedAtMs: index,
        });
      }
    });

    await expect(
      t.query(fn.listTransactions, { viewer: "maddox" }),
    ).rejects.toThrow(
      /complete snapshot exceeds the hard maximum of 2000 rows/,
    );

    const bounded = await t.query(fn.listTransactions, {
      viewer: "maddox",
      limit: 1,
    });
    expect(bounded).toMatchObject({ complete: false });
    expect(bounded.rows).toHaveLength(1);
  });

  it("returns typed budget documents without reported category spend", async () => {
    const adult = await t.query(fn.getBudgetDocument, {
      viewer: "rachel",
      scope: "netWorth",
    });
    expect(adult.complete).toBe(true);
    expect(adult.document).toMatchObject({
      owner: "victor",
      month: "2026-07",
      coinbaseOneBalanceCents: 12550n,
    });
    expect(adult.document?.categories[0]).toEqual({
      name: "Groceries",
      icon: "cart",
      budgetCents: 90000n,
    });
    expect(adult.document?.categories[0]).not.toHaveProperty("spent");
    expect(adult.document?.categories[0]).not.toHaveProperty("spentCents");
    expect(adult.document?.income).toMatchObject({
      weeklyGrossCents: 120000n,
      monthlyGrossCents: 480000n,
      mtdIncomeCents: 250000n,
      ytdIncomeCents: 3000000n,
    });
    expect(adult.document?.monthlyHistory[0]).toEqual({
      month: "2026-06",
      incomeCents: 480000n,
      expensesCents: 320000n,
      savingsBps: 3333n,
    });

    const mason = await t.query(fn.getBudgetDocument, {
      viewer: "mason",
      scope: "netWorth",
    });
    expect(mason.document).toMatchObject({ owner: "mason", month: "2026-07" });
    expect(mason.document?.categories.map((category) => category.name)).toEqual(
      ["Fun"],
    );
  });

  it("returns complete BTC documents while keeping son-balances out of adult net worth", async () => {
    const visible = await t.query(fn.listBtcBalanceDocuments, {
      viewer: "rachel",
      scope: "visible",
    });
    expect(visible.complete).toBe(true);
    expect(visible.rows.map((row) => row.owner)).toEqual(["mason", "victor"]);
    expect(visible.rows.find((row) => row.owner === "mason")?.totals.sats).toBe(
      1600000n,
    );

    const netWorth = await t.query(fn.listBtcBalanceDocuments, {
      viewer: "rachel",
      scope: "netWorth",
    });
    expect(netWorth.rows.map((row) => row.owner)).toEqual(["victor"]);
    expect(
      netWorth.rows
        .flatMap((row) => row.accounts)
        .some(
          (account) => account.key === "strike" && account.sats === 400000n,
        ),
    ).toBe(false);

    const mason = await t.query(fn.listBtcBalanceDocuments, {
      viewer: "mason",
      scope: "netWorth",
    });
    expect(mason.rows.map((row) => row.owner)).toEqual(["mason"]);
  });

  it("returns scoped BTC snapshot metadata without exposing the raw snapshot", async () => {
    const visible = await t.query(fn.getBtcSnapshotMetadata, {
      viewer: "victor",
      scope: "visible",
    });
    expect(visible.complete).toBe(true);
    expect(visible.rows).toEqual([
      expect.objectContaining({
        owner: "mason",
        schemaVersion: 0n,
        asOf: SON_BALANCES.lastUpdated,
      }),
      expect.objectContaining({
        owner: "victor",
        schemaVersion: 2n,
        asOf: SNAPSHOT.asOf,
        source: "synthetic",
        basis: "spot",
        confidence: "verified",
      }),
    ]);

    const netWorth = await t.query(fn.getBtcSnapshotMetadata, {
      viewer: "victor",
      scope: "netWorth",
    });
    expect(netWorth.rows.map((row) => row.owner)).toEqual(["victor"]);
  });

  it("filters nested finance accounts before returning visible and net-worth documents", async () => {
    const visible = await t.query(fn.getFinanceDocument, {
      viewer: "victor",
      scope: "visible",
    });
    expect(visible.complete).toBe(true);
    expect(visible.document?.accounts.map((account) => account.owner)).toEqual([
      "victor",
      "mason",
    ]);
    expect(
      visible.document?.accounts.find((account) => account.owner === "victor"),
    ).toMatchObject({
      key: "victor_401k",
      totalValueCents: 12500055n,
      weeklyContributionCents: 25000n,
    });
    expect(visible.document?.retirementTotalCents).toBe(12500055n);

    const netWorth = await t.query(fn.getFinanceDocument, {
      viewer: "victor",
      scope: "netWorth",
    });
    expect(netWorth.document?.accounts.map((account) => account.owner)).toEqual(
      ["victor"],
    );

    const mason = await t.query(fn.getFinanceDocument, {
      viewer: "mason",
      scope: "visible",
    });
    expect(mason.document?.accounts.map((account) => account.owner)).toEqual([
      "mason",
    ]);
    expect(mason.document?.retirementTotalCents).toBeUndefined();
  });

  it("returns stored canonical share quantities byte-identical", async () => {
    const stored = await t.run(async (ctx) => {
      const document = await ctx.db
        .query("financeDocuments")
        .withIndex("by_source_file", (q) => q.eq("sourceFile", "finances"))
        .unique();
      if (!document) throw new Error("missing seeded finance document");
      return document.accounts.flatMap((account) =>
        account.holdings.flatMap((holding) => [
          holding.sharesDecimal,
          ...holding.lots.map((lot) => lot.sharesDecimal),
        ]),
      );
    });

    const response = await t.query(fn.getFinanceDocument, {
      viewer: "victor",
      scope: "visible",
    });
    const returned = (response.document?.accounts ?? []).flatMap((account) =>
      account.holdings.flatMap((holding) => [
        holding.sharesDecimal,
        ...holding.lots.map((lot) => lot.sharesDecimal),
      ]),
    );
    expect(returned).toEqual(stored);
    expect(returned).toEqual(["321.125", "10.5"]);
  });

  // Pinned verbatim: the read path may emit this line and nothing else. Any
  // future edit that appends an account, a ticker, a count or a quantity to the
  // repair signal fails here and in the sentinel test below.
  const REPAIR_WARNING =
    "financeDocuments: repaired non-canonical stored share quantities at read " +
    "time. Re-run the finances migration to canonicalize the stored row.";

  /** Every console channel a Convex handler can reach, drained together. */
  function captureConsole() {
    const channels = ["warn", "error", "log", "info", "debug"] as const;
    const spies = channels.map((channel) =>
      vi.spyOn(console, channel).mockImplementation(() => {}),
    );
    return {
      drain(): string[] {
        // mockRestore clears the recorded calls, so read them first.
        const lines = spies.flatMap((spy) =>
          spy.mock.calls.map((call) => call.map(String).join(" ")),
        );
        for (const spy of spies) spy.mockRestore();
        return lines;
      },
    };
  }

  /**
   * Everything the read path logged that is not the unrelated auth-gate notice.
   *
   * The suite runs with ALLOW_TOKENLESS_READ, so every query also warns that
   * the deployment is permissive. That line is not about the finance document
   * and carries no identifier, so it is separated out rather than allowed to
   * loosen the exact-match assertions below.
   */
  const financeLogLines = (lines: string[]) =>
    lines.filter((line) => !line.startsWith("PERMISSIVE:"));

  // A financeDocuments row written before both tightenings carries lot
  // quantities straight from IEEE-754 doubles and a negative
  // statement_reconciliation lot. Asserting those took every
  // getFinanceDocument call down.
  it("canonicalizes legacy float-noise and negative reconciliation lots instead of failing the snapshot", async () => {
    await t.run(async (ctx) => {
      const document = await ctx.db
        .query("financeDocuments")
        .withIndex("by_source_file", (q) => q.eq("sourceFile", "finances"))
        .unique();
      if (!document) throw new Error("missing seeded finance document");
      const accounts = document.accounts.map((account, accountIndex) =>
        accountIndex === 0
          ? {
              ...account,
              holdings: account.holdings.map((holding) => {
                const lot = holding.lots[0]!;
                return {
                  ...holding,
                  sharesDecimal: "321.1250000000000004",
                  lots: [
                    { ...lot, sharesDecimal: "10.4999999999999998" },
                    {
                      ...lot,
                      type: "statement_reconciliation",
                      sharesDecimal: "-2.3300000000000002",
                    },
                    { ...lot, sharesDecimal: "-0.0000000000004" },
                  ],
                };
              }),
            }
          : account,
      );
      await ctx.db.patch(document._id, { accounts });
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let lines: string[] = [];
    try {
      for (const scope of ["visible", "netWorth"] as const) {
        const response = await t.query(fn.getFinanceDocument, {
          viewer: "victor",
          scope,
        });
        expect(response.complete, scope).toBe(true);
        const holding = response.document?.accounts.find(
          (account) => account.key === "victor_401k",
        )?.holdings[0];
        expect(holding?.sharesDecimal, scope).toBe("321.125");
        // Half away from zero at the 13th digit, the carry crossing back into
        // the integer part, and a negative that rounds away to plain zero.
        expect(holding?.lots.map((lot) => lot.sharesDecimal), scope).toEqual([
          "10.5",
          "-2.33",
          "0",
        ]);
      }
      // mockRestore clears the recorded calls, so read them first.
      lines = warn.mock.calls.map((call) => String(call[0]));
    } finally {
      warn.mockRestore();
    }

    // Four values were repaired across two reads, and the log carries exactly
    // two lines: one constant line per execution, fired because something was
    // repaired and saying nothing about what.
    expect(financeLogLines(lines)).toEqual([REPAIR_WARNING, REPAIR_WARNING]);
  });

  // Household financial metadata is exactly what a function log must not carry:
  // which account holds which security, and how much of it. The repair path runs
  // on every read of a pre-canonical row, so a leak there is a leak forever.
  it("logs nothing identifying while repairing a document full of sentinel identifiers", async () => {
    const SENTINELS = {
      accountKey: "sentinelAccountKeyZulu",
      holdingName: "Sentinel Holding Name Zulu",
      ticker: "ZQSENTINEL",
      provider: "Sentinel Provider Zulu",
      category: "Sentinel Category Zulu",
      note: "Sentinel Lot Note Zulu",
    };

    await t.run(async (ctx) => {
      const document = await ctx.db
        .query("financeDocuments")
        .withIndex("by_source_file", (q) => q.eq("sourceFile", "finances"))
        .unique();
      if (!document) throw new Error("missing seeded finance document");
      const template = document.accounts[0]!;
      const holding = template.holdings[0]!;
      const lot = holding.lots[0]!;
      await ctx.db.patch(document._id, {
        accounts: [
          {
            ...template,
            key: SENTINELS.accountKey,
            provider: SENTINELS.provider,
            holdings: [
              {
                ...holding,
                name: SENTINELS.holdingName,
                category: SENTINELS.category,
                ticker: SENTINELS.ticker,
                // Every quantity below needs repair, and every one of them
                // carries a digit run that appears nowhere else in the suite.
                sharesDecimal: "77.7770000000000004",
                lots: [
                  { ...lot, sharesDecimal: "88.8880000000000006", note: SENTINELS.note },
                  {
                    ...lot,
                    type: "statement_reconciliation",
                    sharesDecimal: "-99.9990000000000004",
                  },
                  { ...lot, sharesDecimal: "-0.0000000000004" },
                ],
              },
            ],
          },
        ],
      });
    });

    const capture = captureConsole();
    let lines: string[] = [];
    let holding: { sharesDecimal: string; lots: { sharesDecimal: string }[] } | undefined;
    try {
      const response = await t.query(fn.getFinanceDocument, {
        viewer: "victor",
        scope: "visible",
      });
      expect(response.complete).toBe(true);
      holding = response.document?.accounts[0]?.holdings[0];
    } finally {
      lines = capture.drain();
    }

    // The read still succeeds and still repairs, so the silence below is not
    // silence about a no-op.
    expect(holding?.sharesDecimal).toBe("77.777");
    expect(holding?.lots.map((lot) => lot.sharesDecimal)).toEqual([
      "88.888",
      "-99.999",
      "0",
    ]);

    expect(financeLogLines(lines)).toEqual([REPAIR_WARNING]);
    // Checked over *everything* logged, not just the repair line: a leak that
    // moved to another channel or another message would still be a leak.
    for (const line of lines) {
      for (const sentinel of Object.values(SENTINELS)) {
        expect(line).not.toContain(sentinel);
      }
      // No quantity can survive a line with no digits in it at all.
      expect(line).not.toMatch(/\d/);
    }
  });

  it("fails the whole finance snapshot when a schema-valid stored share string is invalid", async () => {
    await t.run(async (ctx) => {
      const document = await ctx.db
        .query("financeDocuments")
        .withIndex("by_source_file", (q) => q.eq("sourceFile", "finances"))
        .unique();
      if (!document) throw new Error("missing seeded finance document");
      const accounts = document.accounts.map((account, accountIndex) =>
        accountIndex === 0
          ? {
              ...account,
              holdings: account.holdings.map((holding, holdingIndex) =>
                holdingIndex === 0
                  ? { ...holding, sharesDecimal: "1e3" }
                  : holding,
              ),
            }
          : account,
      );
      await ctx.db.patch(document._id, { accounts });
    });

    // The thrown text is the other way this path can publish household data: a
    // RangeError message reaches the Convex function log verbatim. It names the
    // failing field positionally and carries no key, name, ticker or quantity.
    const thrown = await t
      .query(fn.getFinanceDocument, { viewer: "victor", scope: "netWorth" })
      .then(
        () => null,
        (error: unknown) => String((error as { message?: unknown }).message),
      );
    expect(thrown).toContain(
      "financeDocuments holding sharesDecimal is not a canonical share quantity",
    );
    for (const identifier of ["victor_401k", "Index Fund", "INDEX", "1e3"]) {
      expect(thrown).not.toContain(identifier);
    }
  });

  it("lists Bitcoin bill payments and includes them in row counts", async () => {
    const response = await t.query(fn.listBtcBillPays, {
      viewer: "victor",
      scope: "netWorth",
    });
    expect(response).toMatchObject({ complete: true });
    expect(response.rows).toEqual([
      expect.objectContaining({
        billPayId: "bp-1",
        owner: "victor",
        amountUsdCents: 18655n,
        btcSpentSats: 200000n,
        btcPriceCents: 9327500n,
        feeUsdCents: 95n,
      }),
    ]);
    expect(await t.query(fn.rowCounts, {})).toMatchObject({
      btcBillPays: 1,
      income: 1,
      balanceDocuments: 1,
      budgetDocuments: 2,
      btcBalanceDocuments: 2,
      financeDocuments: 1,
    });
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
        amountCents: 450n,
        category: "Food",
      },
    });
    expect(first).toMatchObject({ outcome: "inserted", month: "2026-07" });

    const second = await t.mutation(fn.upsertTransaction, {
      transaction: {
        id: "app-1",
        date: "2026-07-21",
        merchant: "Cafe",
        amountCents: 500n,
        category: "Food",
      },
    });
    expect(second.outcome).toBe("updated");

    const rows = await queryRows(fn.listTransactions, { viewer: "victor" });
    expect(rows.filter((row) => row.txId === "app-1")).toHaveLength(1);
    expect(rows.find((row) => row.txId === "app-1")?.amountCents).toBe(500n);
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
    const mason = await queryRows(fn.listTransactions, { viewer: "mason" });
    expect(mason.map((row) => row.txId)).toEqual(["app-m1"]);
  });

  it("canonicalizes a legacy Rachel upsert to the shared adult ledger owner", async () => {
    const result = await t.mutation(fn.upsertTransaction, {
      sourceFile: "transactions",
      transaction: {
        id: "legacy-rachel",
        date: "2026-07-22",
        merchant: "Household",
        amountCents: 900n,
        category: "Other",
        owner: "rachel",
      },
    });

    expect(result.owner).toBe("victor");
    const rows = await queryRows(fn.listTransactions, { viewer: "rachel" });
    expect(rows.find((row) => row.txId === "legacy-rachel")?.owner).toBe(
      "victor",
    );
  });

  it("deletes one source-scoped transaction and is idempotent when retried", async () => {
    await migrateAll(t);

    const removed = await t.mutation(fn.deleteTransaction, { txId: "t-1" });
    expect(removed).toEqual({ txId: "t-1", owner: "victor", removed: true });

    const retried = await t.mutation(fn.deleteTransaction, { txId: "t-1" });
    expect(retried).toEqual({ txId: "t-1", owner: "victor", removed: false });

    const rows = await queryRows(fn.listTransactions, { viewer: "victor" });
    expect(rows.map((row) => row.txId)).not.toContain("t-1");
    expect(rows.map((row) => row.txId)).toContain("t-2");
    expect((await t.query(fn.rowCounts, {})).transactions).toBe(3);
  });

  it("uses source-file ownership and the source/id index to isolate child deletes", async () => {
    await t.mutation(fn.upsertTransaction, {
      transaction: {
        id: "shared-id",
        date: "2026-07-22",
        merchant: "Adult",
        amountCents: 100n,
        category: "Other",
      },
    });
    await t.mutation(fn.upsertTransaction, {
      sourceFile: "mason-transactions",
      transaction: {
        id: "shared-id",
        date: "2026-07-22",
        merchant: "Child",
        amountCents: 200n,
        category: "Other",
      },
    });

    const result = await t.mutation(fn.deleteTransaction, {
      txId: "shared-id",
      sourceFile: "mason-transactions",
    });
    expect(result).toEqual({
      txId: "shared-id",
      owner: "mason",
      removed: true,
    });

    expect(
      (await queryRows(fn.listTransactions, { viewer: "victor" })).map(
        (row) => `${row.owner}:${row.txId}`,
      ),
    ).toEqual(["victor:shared-id"]);
  });

  it("rejects negative purchases for adults and children", async () => {
    await expect(
      t.mutation(fn.upsertTransaction, {
        transaction: {
          id: "adult-wrong-sign",
          date: "2026-07-22",
          merchant: "Adult spend",
          amountCents: -900n,
          category: "Fun",
        },
      }),
    ).rejects.toThrow(
      /purchases are positive and refunds are negative for every owner/,
    );

    await expect(
      t.mutation(fn.upsertTransaction, {
        sourceFile: "mason-transactions",
        transaction: {
          id: "child-wrong-sign",
          date: "2026-07-22",
          merchant: "Child spend",
          amountCents: -900n,
          category: "Fun",
        },
      }),
    ).rejects.toThrow(
      /purchases are positive and refunds are negative for every owner/,
    );
  });

  it("rejects malformed transaction and bill-pay dates before deriving month", async () => {
    await expect(
      t.mutation(fn.upsertTransaction, {
        transaction: {
          id: "malformed-date-transaction",
          date: "2026-7-9",
          merchant: "Invisible spend",
          amountCents: 100n,
          category: "Other",
        },
      }),
    ).rejects.toThrow(/ISO calendar date/);

    await expect(
      t.mutation(fn.upsertBtcBillPay, {
        billPay: {
          id: "malformed-date-bill-pay",
          date: "2026-7-9",
          merchant: "Invisible bill pay",
          category: "Other",
          budgetEffect: "budget_category",
          amountUsdCents: 100n,
          btcSpentSats: 100n,
          btcPriceCents: 100n,
          feeUsdCents: 0n,
        },
      }),
    ).rejects.toThrow(/ISO calendar date/);

    expect(await t.query(fn.rowCounts, {})).toMatchObject({
      transactions: 0,
      btcBillPays: 0,
    });
  });

  it("upserts a btc buy and a btc account idempotently", async () => {
    await seedPostingLedgers(t);
    await expect(
      t.mutation(fn.upsertBtcAccount, {
        account: {
          key: "river",
          owner: "victor",
          label: "River",
          custody: "exchange",
          sats: 99_000_000n,
          fiatCents: 0n,
          asOf: "2026-07-26T00:00:00Z",
        },
      }),
    ).rejects.toThrow(/baseUpdatedAtMs is required/);
    const initialDocument = await t.query(fn.listBtcBalanceDocuments, {
      viewer: "victor",
      scope: "netWorth",
    });
    await expect(
      t.mutation(fn.upsertBtcAccount, {
        baseUpdatedAtMs: initialDocument.rows[0]!.updatedAtMs,
        account: {
          key: "river",
          owner: "victor",
          label: "River",
          custody: "exchange",
          sats: 99_000_000n,
          fiatCents: 0n,
          asOf: "2026-07-26T00:00:00Z",
        },
      }),
    ).rejects.toThrow(/ledger-controlled after activation/);
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

    const beforeInsert = await t.query(fn.listBtcBalanceDocuments, {
      viewer: "victor",
      scope: "netWorth",
    });
    await t.mutation(fn.upsertBtcAccount, {
      baseUpdatedAtMs: beforeInsert.rows[0]!.updatedAtMs,
      account: {
        key: "strike",
        owner: "victor",
        label: "Strike",
        custody: "exchange",
        sats: 0n,
        fiatCents: 0n,
        asOf: "2026-07-26T00:00:00Z",
      },
    });
    const beforeRename = await t.query(fn.listBtcBalanceDocuments, {
      viewer: "victor",
      scope: "netWorth",
    });
    expect(
      (
        await t.mutation(fn.upsertBtcAccount, {
          baseUpdatedAtMs: beforeRename.rows[0]!.updatedAtMs,
          account: {
            key: "strike",
            owner: "victor",
            label: "Strike account",
            custody: "exchange",
            sats: 0n,
            fiatCents: 0n,
            asOf: "2026-07-26T01:00:00Z",
          },
        })
      ).outcome,
    ).toBe("updated");

    const accounts = await queryRows(fn.listBtcAccounts, {
      viewer: "victor",
      scope: "visible",
    });
    expect(accounts.filter((a) => a.key === "strike")).toHaveLength(1);
    expect(accounts.find((a) => a.key === "strike")).toMatchObject({
      label: "Strike account",
      sats: 0n,
    });
    const documents = await t.query(fn.listBtcBalanceDocuments, {
      viewer: "victor",
      scope: "netWorth",
    });
    expect(
      documents.rows[0]?.accounts.find((account) => account.key === "strike"),
    ).toMatchObject({ label: "Strike account", sats: 0n });
  });

  it("keeps activated account retries idempotent and changed revisions monotonic", async () => {
    await seedPostingLedgers(t);
    const account = {
      key: "river",
      owner: "victor" as const,
      label: "River",
      custody: "exchange" as const,
      sats: 10_000_000n,
      fiatCents: 100_000n,
      asOf: "2026-07-30T00:00:00.000Z",
      schemaVersion: 2n,
    };

    await expect(
      t.mutation(fn.upsertBtcAccount, { account }),
    ).resolves.toMatchObject({ outcome: "updated" });
    const before = await t.query(fn.listBtcBalanceDocuments, {
      viewer: "victor",
      scope: "netWorth",
    });
    expect(before.rows[0]!.updatedAtMs).toBe(1);

    const dateNow = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      await expect(
        t.mutation(fn.upsertBtcAccount, {
          baseUpdatedAtMs: before.rows[0]!.updatedAtMs,
          account: { ...account, label: "River exchange" },
        }),
      ).resolves.toMatchObject({ outcome: "updated" });
    } finally {
      dateNow.mockRestore();
    }

    const after = await t.query(fn.listBtcBalanceDocuments, {
      viewer: "victor",
      scope: "netWorth",
    });
    expect(after.rows[0]!.updatedAtMs).toBe(2);
    expect(after.rows[0]!.accounts[0]!.label).toBe("River exchange");
  });

  it("updates and inserts categories without replacing the budget document", async () => {
    await migrateAll(t);

    const updated = await t.mutation(fn.upsertBudgetCategory, {
      viewer: "rachel",
      month: "2026-07",
      category: {
        name: "Groceries",
        icon: "basket",
        budgetCents: 97500n,
      },
    });
    expect(updated).toEqual({
      owner: "victor",
      month: "2026-07",
      name: "Groceries",
      outcome: "updated",
    });

    const inserted = await t.mutation(fn.upsertBudgetCategory, {
      viewer: "victor",
      month: "2026-07",
      category: {
        name: "Travel",
        icon: "airplane",
        budgetCents: 25000n,
      },
    });
    expect(inserted.outcome).toBe("inserted");

    const response = await t.query(fn.getBudgetDocument, {
      viewer: "rachel",
      scope: "netWorth",
    });
    expect(response.document).toMatchObject({
      owner: "victor",
      month: "2026-07",
      coinbaseOneBalanceCents: 12550n,
      categories: [
        { name: "Groceries", icon: "basket", budgetCents: 97500n },
        { name: "Utilities", icon: "zap", budgetCents: 40000n },
        { name: "Travel", icon: "airplane", budgetCents: 25000n },
      ],
      mtdIncomeCents: 250000n,
    });
  });

  it("scopes category edits to the budget document's exact month", async () => {
    await migrateAll(t);

    for (const staleMonth of ["2026-06", "2026-08"]) {
      await expect(
        t.mutation(fn.upsertBudgetCategory, {
          viewer: "victor",
          month: staleMonth,
          category: { name: "Groceries", budgetCents: 1n },
        }),
      ).rejects.toThrow(
        new RegExp(`requested month .*${staleMonth}.*month .*2026-07`),
      );
    }

    await expect(
      t.mutation(fn.upsertBudgetCategory, {
        viewer: "victor",
        month: "2026-07",
        category: { name: "Groceries", budgetCents: 99000n },
      }),
    ).resolves.toMatchObject({ month: "2026-07", outcome: "updated" });

    const response = await t.query(fn.getBudgetDocument, {
      viewer: "victor",
      scope: "netWorth",
    });
    expect(response.document?.categories[0].budgetCents).toBe(99000n);
  });

  it("keeps child category edits in the child's budget", async () => {
    await migrateAll(t);

    await t.mutation(fn.upsertBudgetCategory, {
      viewer: "mason",
      month: "2026-07",
      category: { name: "Fun", icon: "controller", budgetCents: 8000n },
    });

    const mason = await t.query(fn.getBudgetDocument, {
      viewer: "mason",
      scope: "netWorth",
    });
    const adult = await t.query(fn.getBudgetDocument, {
      viewer: "victor",
      scope: "netWorth",
    });
    expect(mason.document?.owner).toBe("mason");
    expect(mason.document?.categories).toEqual([
      { name: "Fun", icon: "controller", budgetCents: 8000n },
    ]);
    expect(adult.document?.categories[0]).toEqual({
      name: "Groceries",
      icon: "cart",
      budgetCents: 90000n,
    });
    await expect(
      t.mutation(fn.upsertBudgetCategory, {
        viewer: "maddox",
        month: "2026-07",
        category: { name: "Fun", budgetCents: 1n },
      }),
    ).rejects.toThrow(/maddox has no budget document/);
  });

  it("does not create a whole budget document from a category edit", async () => {
    await expect(
      t.mutation(fn.upsertBudgetCategory, {
        viewer: "mason",
        month: "2026-07",
        category: { name: "Fun", budgetCents: 1n },
      }),
    ).rejects.toThrow(
      /does not exist.*does not create a whole budget document/,
    );
  });

  it("rejects non-integer category money", async () => {
    await migrateAll(t);
    await expect(
      t.mutation(fn.upsertBudgetCategory, {
        viewer: "victor",
        month: "2026-07",
        category: {
          name: "Groceries",
          budgetCents: 12.5 as unknown as bigint,
        },
      }),
    ).rejects.toThrow();
  });

  it("upserts one BTC bill pay idempotently with separate sats and fiat fields", async () => {
    await seedPostingLedgers(t);
    const inserted = await t.mutation(fn.upsertBtcBillPay, {
      billPay: {
        id: "app-bp-1",
        date: "2026-07-24",
        merchant: "Electric Utility",
        category: "Utilities",
        budgetEffect: "budget_category",
        amountUsdCents: 18_655n,
        btcSpentSats: 200_000n,
        btcPriceCents: 9_327_500n,
        platform: "river",
        feeUsdCents: 95n,
        reference: "invoice-1",
      },
    });
    expect(inserted).toMatchObject({
      billPayId: "app-bp-1",
      owner: "victor",
      month: "2026-07",
      outcome: "inserted",
    });

    const updated = await t.mutation(fn.upsertBtcBillPay, {
      baseUpdatedAtMs: (
        await queryRows(fn.listBtcBillPays, {
          viewer: "victor",
          scope: "visible",
        })
      ).find((row) => row.billPayId === "app-bp-1")!.updatedAtMs,
      billPay: {
        id: "app-bp-1",
        date: "2026-07-24",
        merchant: "Electric Utility",
        category: "Utilities",
        budgetEffect: "budget_category",
        amountUsdCents: 18_700n,
        btcSpentSats: 200_000n,
        btcPriceCents: 9_327_500n,
        feeUsdCents: 95n,
      },
    });
    expect(updated.outcome).toBe("updated");

    const rows = await queryRows(fn.listBtcBillPays, {
      viewer: "victor",
      scope: "visible",
    });
    expect(rows.filter((row) => row.billPayId === "app-bp-1")).toHaveLength(1);
    expect(rows.find((row) => row.billPayId === "app-bp-1")).toMatchObject({
      budgetEffect: "budget_category",
      amountUsdCents: 18_700n,
      btcSpentSats: 200_000n,
      btcPriceCents: 9_327_500n,
      feeUsdCents: 95n,
    });
  });

  it("accepts an omitted legacy bill-pay effect, excludes it, and replays once", async () => {
    await seedPostingLedgers(t);
    const legacy = {
      id: "legacy-bp-effect",
      date: "2026-07-24",
      merchant: "Aven",
      category: "Bills",
      amountUsdCents: 12_000n,
      btcSpentSats: 100_000n,
      btcPriceCents: 12_000_000n,
      feeUsdCents: 0n,
      platform: "river_bitcoin_bill_pay",
    };
    await t.mutation(fn.upsertBtcBillPay, { billPay: legacy });
    const storedRevision = await t.run(async (ctx) => {
      const stored = await ctx.db
        .query("btcBillPays")
        .withIndex("by_source_bill_pay_id", (q) =>
          q.eq("sourceFile", "bitcoin-bill-pays").eq("billPayId", legacy.id),
        )
        .unique();
      expect(stored).not.toBeNull();
      await ctx.db.patch(stored!._id, {
        category: "Bills",
        budgetEffect: undefined,
      });
      return stored!.updatedAtMs;
    });
    await t.mutation(fn.upsertBtcBillPay, { billPay: legacy });
    await t.mutation(fn.upsertBtcBillPay, { billPay: legacy });

    const rows = await queryRows(fn.listBtcBillPays, {
      viewer: "victor",
      scope: "visible",
    });
    expect(rows.filter((row) => row.billPayId === legacy.id)).toHaveLength(1);
    expect(rows.find((row) => row.billPayId === legacy.id)).toMatchObject({
      category: "Credit Card Payment",
      budgetEffect: "credit_card_payment",
    });
    const sats = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("btcBalanceDocuments")
          .withIndex("by_source_file", (q) => q.eq("sourceFile", "btc-balance-snapshot"))
          .unique()
      )!.totals.sats,
    );
    expect(sats).toBe(9_900_000n);
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("btcBillPays")
        .withIndex("by_source_bill_pay_id", (q) =>
          q.eq("sourceFile", "bitcoin-bill-pays").eq("billPayId", legacy.id),
        )
        .unique(),
    );
    expect(stored?.updatedAtMs).toBe(storedRevision);
    expect(stored?.budgetEffect).toBeUndefined();
    expect(stored?.category).toBe("Bills");
  });

  it("resolves BTC bill-pay owners through the existing visibility scopes", async () => {
    await seedPostingLedgers(t);
    await t.mutation(fn.upsertBtcBillPay, {
      billPay: {
        id: "mason-bp-1",
        date: "2026-07-24",
        merchant: "Game Store",
        category: "Fun",
        budgetEffect: "budget_category",
        amountUsdCents: 2_000n,
        btcSpentSats: 20_000n,
        btcPriceCents: 10_000_000n,
        feeUsdCents: 0n,
        owner: "mason",
      },
    });

    const ids = async (viewer: Member, scope: Scope) =>
      (await queryRows(fn.listBtcBillPays, { viewer, scope })).map(
        (row) => row.billPayId,
      );
    expect(await ids("victor", "visible")).toContain("mason-bp-1");
    expect(await ids("victor", "netWorth")).not.toContain("mason-bp-1");
    expect(await ids("mason", "visible")).toContain("mason-bp-1");
    expect(await ids("maddox", "visible")).not.toContain("mason-bp-1");
  });

  it("refuses to delete a transaction that belongs to a different owner", async () => {
    await migrateAll(t);
    // Ids collide across source files on purpose (see the shared-id test), and
    // sourceFile defaults to the ADULT file. Before the owner check, asking to
    // delete a child's id with sourceFile omitted silently deleted the adult's
    // row and reported removed: true. There is no transaction tombstone, so the
    // row would simply be gone.
    const victorRow = await t.query(fn.listTransactions, { viewer: "victor" });
    const target = victorRow.rows[0];
    await expect(
      t.mutation(fn.deleteTransaction, {
        txId: target.txId,
        owner: target.owner === "victor" ? "mason" : "victor",
      }),
    ).rejects.toThrow(/belongs to/);

    const after = await t.query(fn.listTransactions, { viewer: "victor" });
    expect(after.rows.map((r: { txId: string }) => r.txId)).toContain(
      target.txId,
    );
  });

  it("refuses a bill pay whose money is not a positive spend", async () => {
    for (const bad of [
      { amountUsdCents: -18_655n },
      { btcSpentSats: -200_000n },
      { btcPriceCents: 0n },
      { feeUsdCents: -1n },
    ]) {
      await expect(
        t.mutation(fn.upsertBtcBillPay, {
          billPay: {
            id: "bad-bp",
            date: "2026-07-24",
            merchant: "Electric Utility",
            category: "Utilities",
            budgetEffect: "budget_category",
            amountUsdCents: 18_655n,
            btcSpentSats: 200_000n,
            btcPriceCents: 10_000_000n,
            feeUsdCents: 0n,
            ...bad,
          },
        }),
      ).rejects.toThrow();
    }
  });

  it("refuses a bill-pay upsert that would change an existing row's owner", async () => {
    await seedPostingLedgers(t);
    const base = {
      date: "2026-07-24",
      merchant: "Electric Utility",
      category: "Utilities",
      budgetEffect: "budget_category" as const,
      amountUsdCents: 18_655n,
      btcSpentSats: 200_000n,
      btcPriceCents: 10_000_000n,
      feeUsdCents: 0n,
    };
    await t.mutation(fn.upsertBtcBillPay, {
      billPay: { id: "hijack-bp", owner: "victor", ...base },
    });
    // Bill pays share ONE source file, so the natural key is the id alone.
    // Reusing it under another owner used to PATCH the adult's row, flipping
    // its owner and overwriting every money field.
    await expect(
      t.mutation(fn.upsertBtcBillPay, {
        billPay: {
          id: "hijack-bp",
          owner: "mason",
          ...base,
          amountUsdCents: 1n,
        },
      }),
    ).rejects.toThrow(/belongs to victor/);

    const rows = await queryRows(fn.listBtcBillPays, {
      viewer: "victor",
      scope: "visible",
    });
    const survivor = rows.find(
      (r: { billPayId: string }) => r.billPayId === "hijack-bp",
    );
    expect(survivor).toBeDefined();
    expect(survivor?.owner).toBe("victor");
    expect(survivor?.amountUsdCents).toBe(18_655n);
  });

  it("refuses a BTC bill pay source outside the closed source catalogue", async () => {
    await expect(
      t.mutation(fn.upsertBtcBillPay, {
        sourceFile: "mason-bitcoin-bill-pays",
        billPay: {
          id: "unknown-source-bp",
          date: "2026-07-24",
          merchant: "Nope",
          category: "Other",
          budgetEffect: "budget_category",
          amountUsdCents: 1n,
          btcSpentSats: 1n,
          btcPriceCents: 1n,
          feeUsdCents: 0n,
        },
      }),
    ).rejects.toThrow(/Unknown source file "mason-bitcoin-bill-pays"/);
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
          amountCents: 1n,
          category: "Other",
        },
      }),
    ).rejects.toThrow(/holds todos, not transactions/);
  });

  it("refuses a BTC account whose owner disagrees with its source file", async () => {
    await expect(
      t.mutation(fn.upsertBtcAccount, {
        sourceFile: "son-balances",
        account: {
          key: "child-stack-as-adult",
          owner: "victor",
          label: "Must not reach adult net worth",
          custody: "self_custody",
          sats: 1n,
          fiatCents: 1n,
          asOf: "2026-07-26T00:00:00Z",
        },
      }),
    ).rejects.toThrow(/belongs to mason, not victor/);
  });

  it("refuses an unknown todo owner instead of defaulting it to an adult", async () => {
    await expect(
      t.mutation(fn.upsertTodo, {
        todo: {
          id: "bad-owner-todo",
          title: "Must not become Victor's",
          owner: "Mason ",
        },
      }),
    ).rejects.toThrow(/owner must be one of victor, rachel, mason, maddox/);
  });

  it("rejects an owner outside the closed set", async () => {
    await expect(
      t.mutation(fn.upsertTransaction, {
        transaction: {
          id: "bad-1",
          date: "2026-07-24",
          merchant: "Nope",
          amountCents: 1n,
          category: "Other",
          // The schema's literal union is what stops a typo'd owner becoming
          // "victor" by way of coerceOwner.
          owner: "Mason" as Member,
        },
      }),
    ).rejects.toThrow();
  });

  it("the finance schema rejects an unknown nested account owner", async () => {
    await expect(
      t.run(async (ctx) => {
        await ctx.db.insert("financeDocuments", {
          sourceFile: "finances",
          lastUpdated: "2026-07-26",
          accounts: [
            {
              key: "bad-owner",
              owner: "Mason ",
              provider: "Nope",
              totalValueCents: 1n,
              weeklyContributionCents: 0n,
              holdings: [],
            },
          ],
          updatedAtMs: 0,
        } as any);
      }),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("auth: the gates in tables.ts match the gates in dataFiles.ts", () => {
  const readEntryPoints = [
    {
      name: "listTransactions",
      call: (token?: string) =>
        queryRows(fn.listTransactions, { viewer: "victor", token }),
    },
    {
      name: "listTodos",
      call: (token?: string) =>
        queryRows(fn.listTodos, { viewer: "victor", token }),
    },
    {
      name: "listBtcBuys",
      call: (token?: string) =>
        queryRows(fn.listBtcBuys, {
          viewer: "victor",
          scope: "visible",
          token,
        }),
    },
    {
      name: "listBtcBillPays",
      call: (token?: string) =>
        queryRows(fn.listBtcBillPays, {
          viewer: "victor",
          scope: "visible",
          token,
        }),
    },
    {
      name: "listIncome",
      call: (token?: string) =>
        queryRows(fn.listIncome, {
          viewer: "victor",
          token,
        }),
    },
    {
      name: "listBtcAccounts",
      call: (token?: string) =>
        queryRows(fn.listBtcAccounts, {
          viewer: "victor",
          scope: "visible",
          token,
        }),
    },
    {
      name: "listBalanceDocuments",
      call: (token?: string) =>
        queryRows(fn.listBalanceDocuments, {
          viewer: "victor",
          scope: "visible",
          token,
        }),
    },
    {
      name: "listIncome",
      call: (token?: string) =>
        queryRows(fn.listIncome, {
          viewer: "victor",
          token,
        }),
    },
    {
      name: "getBudgetDocument",
      call: (token?: string) =>
        t.query(fn.getBudgetDocument, {
          viewer: "victor",
          scope: "netWorth",
          token,
        }),
    },
    {
      name: "getBtcSnapshotMetadata",
      call: (token?: string) =>
        t.query(fn.getBtcSnapshotMetadata, {
          viewer: "victor",
          scope: "visible",
          token,
        }),
    },
    {
      name: "listBtcBalanceDocuments",
      call: (token?: string) =>
        t.query(fn.listBtcBalanceDocuments, {
          viewer: "victor",
          scope: "visible",
          token,
        }),
    },
    {
      name: "getFinanceDocument",
      call: (token?: string) =>
        t.query(fn.getFinanceDocument, {
          viewer: "victor",
          scope: "visible",
          token,
        }),
    },
    {
      name: "rowCounts",
      call: (token?: string) => t.query(fn.rowCounts, { token }),
    },
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
            amountCents: 1n,
            category: "Other",
          },
          token,
        }),
    },
    {
      name: "upsertTodo",
      call: (token?: string) =>
        t.mutation(fn.upsertTodo, {
          todo: { id: "auth-todo", title: "Probe", owner: "victor" },
          token,
        }),
    },
    {
      name: "deleteTransaction",
      call: (token?: string) =>
        t.mutation(fn.deleteTransaction, { txId: "auth-transaction", token }),
    },
    {
      name: "deleteTodo",
      call: (token?: string) =>
        t.mutation(fn.deleteTodo, {
          todoId: "auth-todo",
          token,
        }),
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
      name: "upsertBtcBillPay",
      call: (token?: string) =>
        t.mutation(fn.upsertBtcBillPay, {
          billPay: {
            id: "auth-bp-1",
            date: "2026-07-25",
            merchant: "Probe",
            category: "Other",
            budgetEffect: "budget_category",
            amountUsdCents: 1n,
            btcSpentSats: 1n,
            btcPriceCents: 1n,
            feeUsdCents: 0n,
          },
          token,
        }),
    },
    {
      name: "upsertBtcAccount",
      call: async (token?: string) => {
        const baseUpdatedAtMs = await t.run(async (ctx) =>
          (
            await ctx.db
              .query("btcBalanceDocuments")
              .withIndex("by_source_file", (q) =>
                q.eq("sourceFile", "btc-balance-snapshot"),
              )
              .unique()
          )!.updatedAtMs,
        );
        return await t.mutation(fn.upsertBtcAccount, {
          baseUpdatedAtMs,
          account: {
            key: "probe",
            owner: "victor",
            label: "Probe",
            custody: "exchange",
            sats: 0n,
            fiatCents: 0n,
            asOf: "2026-07-25T00:00:00Z",
          },
          token,
        });
      },
    },
    {
      name: "upsertBudgetCategory",
      call: (token?: string) =>
        t.mutation(fn.upsertBudgetCategory, {
          viewer: "victor",
          month: "2026-07",
          category: {
            name: "Groceries",
            budgetCents: 90000n,
          },
          token,
        }),
    },
  ] as const;

  beforeEach(async () => {
    // Undo the openGates() in the outer beforeEach — these tests are about the
    // deployed default, which is both gates closed.
    delete process.env.ALLOW_TOKENLESS_READ;
    delete process.env.ALLOW_TOKENLESS_SYNC;
    // Auth succeeds before handler state is consulted. Seed the one document
    // whose mutation needs an existing aggregate so the valid-token and hatch
    // cases can proceed past auth and complete the write.
    await t.run(async (ctx) => {
      await ctx.db.insert(
        "budgetDocuments",
        projectBudgetDocument(JSON.stringify(ADULT_BUDGET), "budget", 1000),
      );
    });
    await seedPostingLedgers(t);
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
        await expect(entry.call(freshSecret())).rejects.toThrow(
          /invalid read token/,
        );
        await expect(entry.call(readToken)).resolves.toBeDefined();
      });
    }

    for (const entry of writeEntryPoints) {
      it(`${entry.name} rejects a missing or wrong token and admits the right one`, async () => {
        await expect(entry.call()).rejects.toThrow(/invalid sync token/);
        await expect(entry.call(freshSecret())).rejects.toThrow(
          /invalid sync token/,
        );
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
      await expect(
        t.query(fn.dataFilesGet, { name: "todos" }),
      ).resolves.toBeDefined();
      await expect(
        queryRows(fn.listTransactions, { viewer: "victor" }),
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
      for (const entry of writeEntryPoints) {
        await expect(entry.call()).resolves.toBeDefined();
      }
    });

    it("both files fail closed identically with neither hatch nor token", async () => {
      await expect(t.query(fn.dataFilesGet, { name: "todos" })).rejects.toThrow(
        /CONVEX_READ_TOKEN is not configured/,
      );
      await expect(
        queryRows(fn.listTransactions, { viewer: "victor" }),
      ).rejects.toThrow(/CONVEX_READ_TOKEN is not configured/);

      await expect(
        t.mutation(fn.dataFilesSync, { name: "probe", data: [] }),
      ).rejects.toThrow(/CONVEX_SYNC_TOKEN is not configured/);
    });
  });
});
