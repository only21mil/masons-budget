import { describe, expect, it } from "vitest"

import type {
  VogelVaultRowRequest,
  VogelVaultRowResult,
} from "../shared/ipc.ts"
import { loadConvexRowEnvelope } from "../src/renderer/data/convexRows.ts"

function response(request: VogelVaultRowRequest): VogelVaultRowResult {
  switch (request.kind) {
    case "rowCounts":
      return {
        status: "ok",
        kind: "rowCounts",
        value: {
          transactions: 1,
          todos: 1,
          btcBuys: 1,
          btcBillPays: 1,
          btcAccounts: 1,
          income: 1,
          balanceDocuments: 1,
          budgetDocuments: 1,
          btcBalanceDocuments: 1,
          financeDocuments: 1,
        },
      }
    case "transactions":
      return {
        status: "ok",
        kind: "transactions",
        complete: true,
        rows: [{
          txId: "tx-1",
          owner: "victor",
          date: "2026-07-26",
          month: "2026-07",
          merchant: "Example",
          amountCents: 123n,
          spendAmount: 123n,
          displaySpendAmount: 123n,
          hasOppositeSpendSign: false,
          category: "Food",
          updatedAtMs: 10,
        }],
      }
    case "income":
      return {
        status: "ok",
        kind: "income",
        complete: true,
        rows: [{
          incomeId: "income-1",
          owner: "victor",
          date: "2026-07-20",
          month: "2026-07",
          amountCents: 777_777n,
          source: "Payroll",
          updatedAtMs: 75,
        }],
      }
    case "todos":
      return {
        status: "ok",
        kind: "todos",
        complete: true,
        rows: [{
          todoId: "todo-1",
          owner: "victor",
          title: "Example",
          done: false,
          flagged: true,
          updatedAtMs: 20,
        }],
      }
    case "btcBuys":
      return {
        status: "ok",
        kind: "btcBuys",
        complete: true,
        rows: [{
          buyId: "buy-1",
          owner: "victor",
          date: "2026-07-25",
          month: "2026-07",
          source: "Example",
          sats: 100_000_000n,
          priceUsdCents: 9_000_000n,
          usdCents: 9_000_000n,
          updatedAtMs: 30,
        }],
      }
    case "btcAccounts":
      return {
        status: "ok",
        kind: "btcAccounts",
        complete: true,
        rows: [{
          key: "wallet",
          owner: "victor",
          label: "Wallet",
          custody: "self_custody",
          sats: 100_000_000n,
          fiatCents: 9_000_000n,
          asOf: "2026-07-26T00:00:00Z",
          schemaVersion: 1n,
          updatedAtMs: 40,
        }],
      }
    case "btcBillPays":
      return {
        status: "ok",
        kind: "btcBillPays",
        complete: true,
        rows: [{
          billPayId: "pay-1",
          owner: "victor",
          date: "2026-07-24",
          month: "2026-07",
          merchant: "Example",
          category: "Bills",
          amountUsdCents: 2_500n,
          btcSpentSats: 28_000n,
          btcPriceCents: 9_000_000n,
          feeUsdCents: 50n,
          updatedAtMs: 50,
        }],
      }
    case "budget":
      return {
        status: "ok",
        kind: "budget",
        value: {
          owner: "victor",
          month: "2026-07",
          coinbaseOneBalanceCents: 0n,
          categories: [{ name: "Food", budgetCents: 50_000n }],
          mtdIncomeCents: 100_000n,
          ytdIncomeCents: 700_000n,
          monthlyHistory: [],
          updatedAtMs: 60,
        },
      }
    case "btcSnapshotMeta":
      return {
        status: "ok",
        kind: "btcSnapshotMeta",
        complete: true,
        rows: [{
          owner: "victor",
          schemaVersion: 1n,
          asOf: "2026-07-26T00:00:00Z",
          updatedAtMs: 70,
        }],
      }
    case "btcBalanceDocuments":
      return {
        status: "ok",
        kind: "btcBalanceDocuments",
        complete: true,
        rows: [{
          owner: "victor",
          schemaVersion: 1n,
          asOf: "2026-07-16",
          accounts: [{
            key: "canonical-wallet",
            label: "Canonical Wallet",
            custody: "self_custody",
            sats: 123_456_789n,
            fiatCents: 12_000_000n,
          }],
          totals: {
            sats: 123_456_789n,
            fiatCents: 12_000_000n,
            exchangeSats: 0n,
            selfCustodySats: 123_456_789n,
          },
          updatedAtMs: 80,
        }],
      }
  }
}

describe("renderer Convex row adapter", () => {
  it("loads every bounded table with explicit BTC scopes and preserves bigint money", async () => {
    const requests: VogelVaultRowRequest[] = []
    const result = await loadConvexRowEnvelope(async (request) => {
      requests.push(request)
      return response(request)
    }, "rachel")

    expect(result.status).toBe("loaded")
    if (result.status !== "loaded") return
    expect(requests).toEqual([
      { kind: "rowCounts" },
      { kind: "transactions", viewer: "rachel" },
      { kind: "todos", viewer: "rachel" },
      { kind: "income", viewer: "rachel" },
      { kind: "btcBuys", viewer: "rachel", scope: "visible" },
      { kind: "btcAccounts", viewer: "rachel", scope: "visible" },
      { kind: "btcBillPays", viewer: "rachel", scope: "visible" },
      { kind: "budget", viewer: "rachel", scope: "netWorth" },
      { kind: "btcSnapshotMeta", viewer: "rachel", scope: "visible" },
      { kind: "btcBalanceDocuments", viewer: "rachel", scope: "netWorth" },
    ])
    expect("income" in result.data).toBe(true)
    expect("btcBalanceDocument" in result.data).toBe(true)
    expect(result.data.income.value[0]?.amount).toBe(777_777n)
    expect(result.data.btcBalanceDocument.value?.totals.sats).toBe(123_456_789n)
    expect(result.data.btcBalanceDocument.value?.totals.fiat).toBe(12_000_000n)
    expect(result.data.transactions.value[0]?.amount).toBe(123n)
    expect(typeof result.data.transactions.value[0]?.amount).toBe("bigint")
    expect(result.data.btcAccounts.value[0]?.fiat).toBe(9_000_000n)
    expect(result.data.budget.value?.categories[0]?.spent).toBe(0n)
    expect(result.data.btcPriceUsd).toBe(9_720_000n)
    expect(result.data.generatedAt).toBe(80)
  })

  it("stops at rowCounts and renders an empty state before production is populated", async () => {
    const requests: VogelVaultRowRequest[] = []
    const result = await loadConvexRowEnvelope(async (request) => {
      requests.push(request)
      return {
        status: "ok",
        kind: "rowCounts",
        value: {
          transactions: 0,
          todos: 0,
          btcBuys: 0,
          btcBillPays: 0,
          btcAccounts: 0,
          income: 0,
          balanceDocuments: 0,
          budgetDocuments: 0,
          btcBalanceDocuments: 0,
          financeDocuments: 0,
        },
      }
    }, "victor", () => 123)

    expect(requests).toEqual([{ kind: "rowCounts" }])
    expect(result).toMatchObject({
      status: "loaded",
      data: {
        generatedAt: 123,
        transactions: { status: "empty", value: [] },
        income: { status: "empty", value: [] },
        btcBalanceDocument: { status: "empty", value: null },
        btcAccounts: { status: "empty", value: [] },
      },
    })
  })

  it("keeps disabled reads on fixtures and classifies missing auth separately", async () => {
    await expect(
      loadConvexRowEnvelope(async () => ({ status: "error", code: "disabled" }), "victor"),
    ).resolves.toEqual({ status: "fallback" })

    const unauthorized = await loadConvexRowEnvelope(
      async () => ({ status: "error", code: "unauthorized" }),
      "victor",
      () => 456,
    )
    expect(unauthorized).toMatchObject({
      status: "loaded",
      data: {
        generatedAt: 456,
        transactions: {
          status: "error",
          source: "Convex row tables · authentication required",
          error: "Convex read authentication failed.",
        },
      },
    })
  })

  it("contains a rejected transaction query to the transaction slice", async () => {
    const result = await loadConvexRowEnvelope(
      async (request) =>
        request.kind === "transactions"
          ? { status: "error", code: "unavailable" }
          : response(request),
      "victor",
      () => 999,
    )

    expect(result.status).toBe("loaded")
    if (result.status !== "loaded") return
    expect(result.data.transactions.status).toBe("error")
    expect(result.data.todos.status).toBe("live")
    expect(result.data.income.status).toBe("live")
    expect(result.data.btcBalanceDocument.status).toBe("live")
    expect(result.data.btcBuys.status).toBe("live")
    expect(result.data.billPays.status).toBe("live")
  })

  it("rejects overlapping BTC balance documents instead of combining them", async () => {
    const result = await loadConvexRowEnvelope(
      async (request) => {
        const base = response(request)
        if (base.status !== "ok" || base.kind !== "btcBalanceDocuments") return base
        const document = base.rows[0]
        if (!document) return base
        return { ...base, rows: [document, document] }
      },
      "victor",
    )

    expect(result.status).toBe("loaded")
    if (result.status !== "loaded") return
    expect(result.data.btcBalanceDocument.status).toBe("error")
    expect(result.data.btcBalanceDocument.value).toBeNull()
    expect(result.data.btcAccounts.status).toBe("live")
  })
})
