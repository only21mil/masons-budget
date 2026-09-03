import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { resolveRemoteReadSettings } from "../electron/convexRead.ts"
import { createConvexRowRepository } from "../electron/convexRows.ts"
import type {
  VogelVaultBtcBillPayRow,
  VogelVaultBtcBuyRow,
  VogelVaultRowResult,
  VogelVaultTodoRow,
} from "../shared/ipc.ts"

const GOLDEN_ROOT = new URL("../../shared/domain/fixtures/convex-wire-golden/", import.meta.url)
const QUERY_NAMES = new Map<string, string>([
  ["tables:rowCounts", "rowCounts"],
  ["tables:listTransactions", "listTransactions"],
  ["tables:listTodos", "listTodos"],
  ["tables:listBtcBuys", "listBtcBuys"],
  ["tables:listBtcAccounts", "listBtcAccounts"],
  ["tables:listBtcBillPays", "listBtcBillPays"],
  ["tables:getBudgetDocument", "getBudgetDocument"],
])
const settings = resolveRemoteReadSettings({
  VOGEL_VAULT_REMOTE_READ: "1",
  VOGEL_VAULT_CONVEX_URL: "https://keen-elephant-452.convex.cloud",
  VOGEL_VAULT_CONVEX_READ_TOKEN: "fixture-only-token",
})

const repository = createConvexRowRepository({
  configuration: () => ({ generation: 1, settings }),
  post: async (_endpoint, body) => {
    const request = JSON.parse(body) as { path: string; format: string }
    const query = QUERY_NAMES.get(request.path)
    if (query === undefined) throw new Error(`no committed production golden for ${request.path}`)
    return {
      httpStatus: 200,
      body: readFileSync(new URL(`${query}.${request.format}.json`, GOLDEN_ROOT), "utf8"),
    }
  },
})

function requireOk(
  result: VogelVaultRowResult,
  query: string,
): Extract<VogelVaultRowResult, { status: "ok" }> {
  if (result.status !== "ok") {
    throw new Error(`production golden ${query} did not decode: ${result.status}/${result.code}`)
  }
  return result
}

describe("real Convex wire values", () => {
  it("derives spend projection locally from the synthetic capture", async () => {
    const capture = JSON.parse(
      readFileSync(new URL("listTransactions.json.json", GOLDEN_ROOT), "utf8"),
    ) as {
      value: {
        rows: Array<{
          amountCents: string
          spendAmount: string
          hasOppositeSpendSign: boolean
        }>
      }
    }
    expect(capture.value.rows[0]).toMatchObject({
      amountCents: "1000",
      spendAmount: "1000",
      hasOppositeSpendSign: false,
    })
    const encodedCapture = JSON.parse(
      readFileSync(new URL("listTransactions.convex_encoded_json.json", GOLDEN_ROOT), "utf8"),
    ) as {
      value: {
        rows: Array<Record<string, unknown>>
      }
    }
    Object.assign(encodedCapture.value.rows[0] ?? {}, {
      spendAmount: "must not be trusted",
      displaySpendAmount: null,
      hasOppositeSpendSign: true,
    })
    const derivationRepository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => ({
        httpStatus: 200,
        body: JSON.stringify(encodedCapture),
      }),
    })
    const result = requireOk(
      await derivationRepository.query({
        kind: "transactions",
        limit: 3,
      }, "victor"),
      "listTransactions",
    )
    if (result.kind !== "transactions") {
      throw new Error(`production golden listTransactions decoded as ${result.kind}`)
    }
    expect(result.rows[0]).toMatchObject({
      amountCents: 1_000n,
      spendAmount: 1_000n,
      displaySpendAmount: 1_000n,
      hasOppositeSpendSign: false,
    })
  })

  it("decodes todo priority through the production repository", async () => {
    const result = requireOk(
      await repository.query({
        kind: "todos",
        limit: 3,
      }, "victor"),
      "listTodos",
    )
    if (result.kind !== "todos") {
      throw new Error(`production golden listTodos decoded as ${result.kind}`)
    }
    const row = result.rows[0] as VogelVaultTodoRow
    expect(row.todoId).toBe("00000000-0000-4000-8000-000000000001")
    expect(row.priority).toBe(0n)
    expect(row.updatedAtMs).toBe(1_700_000_000_000)
  })

  it("decodes BTC buy values through the production repository", async () => {
    const result = requireOk(
      await repository.query({
        kind: "btcBuys",
        scope: "visible",
        limit: 3,
      }, "victor"),
      "listBtcBuys",
    )
    if (result.kind !== "btcBuys") {
      throw new Error(`production golden listBtcBuys decoded as ${result.kind}`)
    }
    const row = result.rows[0] as VogelVaultBtcBuyRow
    expect(row.buyId).toBe("sample-buy-0000000001")
    expect(row.sats).toBe(100_000n)
    expect(row.priceUsdCents).toBe(500_000n)
    expect(row.usdCents).toBe(500_000n)
  })

  it("decodes BTC bill-pay values through the production repository", async () => {
    const result = requireOk(
      await repository.query({
        kind: "btcBillPays",
        scope: "visible",
        limit: 3,
      }, "victor"),
      "listBtcBillPays",
    )
    if (result.kind !== "btcBillPays") {
      throw new Error(`production golden listBtcBillPays decoded as ${result.kind}`)
    }
    const row = result.rows[0] as VogelVaultBtcBillPayRow
    expect(row.billPayId).toBe("sample-billpay-000000001")
    expect(row.amountUsdCents).toBe(120_000n)
    expect(row.btcSpentSats).toBe(24_000_000n)
    expect(row.btcPriceCents).toBe(500_000n)
    expect(row.feeUsdCents).toBe(0n)
  })

  it("decodes the production row counts", async () => {
    const result = requireOk(
      await repository.query({ kind: "rowCounts" }, "victor"),
      "rowCounts",
    )
    if (result.kind !== "rowCounts") {
      throw new Error(`production golden rowCounts decoded as ${result.kind}`)
    }
    expect(result.value).toEqual({
      transactions: 10,
      todos: 3,
      btcBuys: 5,
      btcBillPays: 5,
      btcTransfers: 0,
      btcAccounts: 3,
      income: 2,
      balanceDocuments: 1,
      budgetDocuments: 1,
      btcBalanceDocuments: 1,
      financeDocuments: 1,
    })
  })

  it("decodes the populated production budget document", async () => {
    const result = requireOk(
      await repository.query({
        kind: "budget",
        scope: "netWorth",
      }, "victor"),
      "getBudgetDocument",
    )
    if (result.kind !== "budget") {
      throw new Error(`production golden getBudgetDocument decoded as ${result.kind}`)
    }
    expect(result.value).not.toBeNull()
    if (result.value === null) {
      throw new Error("production golden getBudgetDocument unexpectedly contained null")
    }
    expect(result.value).toMatchObject({
      owner: "victor",
      month: "June 2099",
      coinbaseOneBalanceCents: 0n,
      updatedAtMs: 1_700_000_000_000,
    })
    expect(result.value.categories[0]).toMatchObject({
      name: "Sample Category 1",
      budgetCents: 400_000n,
    })
    expect(result.value.monthlyHistory[0]).toMatchObject({
      month: "January 2099",
      savingsBps: 2_500,
    })
  })

  it("retains null budget document handling with a synthetic response", async () => {
    const nullRepository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => ({
        httpStatus: 200,
        body: JSON.stringify({
          status: "success",
          value: { complete: true, document: null },
        }),
      }),
    })
    const result = requireOk(
      await nullRepository.query({
        kind: "budget",
        scope: "netWorth",
      }, "victor"),
      "synthetic null getBudgetDocument",
    )
    if (result.kind !== "budget") {
      throw new Error(`synthetic null getBudgetDocument decoded as ${result.kind}`)
    }
    expect(result.value).toBeNull()
  })

  it("retains the bounded empty BTC-account signal", async () => {
    await expect(repository.query({
      kind: "btcAccounts",
      scope: "visible",
    }, "victor")).resolves.toEqual({ status: "error", code: "incomplete-response" })
  })
})
