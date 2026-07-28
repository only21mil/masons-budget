import { Buffer } from "node:buffer"

import { describe, expect, it } from "vitest"

import { resolveRemoteReadSettings } from "../electron/convexRead.ts"
import {
  createConvexRowRepository,
  validateRowRequest,
} from "../electron/convexRows.ts"

const SECRET = "not-a-real-row-read-secret"
const settings = resolveRemoteReadSettings({
  VOGEL_VAULT_REMOTE_READ: "1",
  VOGEL_VAULT_CONVEX_URL: "https://example.invalid",
  VOGEL_VAULT_CONVEX_READ_TOKEN: SECRET,
})

function int64(value: bigint): { readonly $integer: string } {
  const bytes = Buffer.alloc(8)
  bytes.writeBigInt64LE(value)
  return { $integer: bytes.toString("base64") }
}

function transaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    txId: "tx-1",
    owner: "victor",
    date: "2026-07-26",
    month: "2026-07",
    merchant: "Example",
    amountCents: int64(115n),
    spendAmount: int64(115n),
    displaySpendAmount: int64(115n),
    hasOppositeSpendSign: false,
    category: "Other",
    updatedAtMs: 1,
    ...overrides,
  }
}

function success(value: unknown) {
  return {
    httpStatus: 200,
    body: JSON.stringify({ status: "success", value }),
  }
}

describe("row request validation", () => {
  it("accepts only the closed request union", () => {
    expect(validateRowRequest({ kind: "rowCounts" })).toEqual({ kind: "rowCounts" })
    expect(validateRowRequest({ kind: "rowCounts", viewer: "victor" })).toBeNull()
    expect(validateRowRequest({ kind: "transactions", viewer: "victor" })).toEqual({
      kind: "transactions",
      viewer: "victor",
    })
    expect(validateRowRequest({ kind: "transactions", viewer: "victor", query: "anything" })).toBeNull()
    expect(validateRowRequest({ kind: "transactions", viewer: "Mason" })).toBeNull()
    expect(validateRowRequest({ kind: "transactions", viewer: "victor", limit: 0 })).toBeNull()
  })

  it("requires explicit visibility and budget scopes", () => {
    expect(validateRowRequest({ kind: "btcAccounts", viewer: "victor" })).toBeNull()
    expect(validateRowRequest({ kind: "btcAccounts", viewer: "victor", scope: "netWorth" })).toEqual({
      kind: "btcAccounts",
      viewer: "victor",
      scope: "netWorth",
    })
    expect(validateRowRequest({ kind: "btcBillPays", viewer: "victor" })).toBeNull()
    expect(validateRowRequest({ kind: "btcBillPays", viewer: "victor", scope: "visible" })).toEqual({
      kind: "btcBillPays",
      viewer: "victor",
      scope: "visible",
    })
    expect(validateRowRequest({ kind: "budget", viewer: "victor" })).toBeNull()
    expect(validateRowRequest({ kind: "budget", viewer: "victor", scope: "netWorth" })).toEqual({
      kind: "budget",
      viewer: "victor",
      scope: "netWorth",
    })
  })
})

describe("main-process row repository", () => {
  it("opens no socket while remote reads are disabled", async () => {
    let calls = 0
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings: resolveRemoteReadSettings({}) }),
      post: async () => {
        calls += 1
        return success({ complete: true, rows: [] })
      },
    })
    await expect(repository.query({ kind: "transactions", viewer: "victor" })).resolves.toEqual({
      status: "error",
      code: "disabled",
    })
    expect(calls).toBe(0)
  })

  it("classifies a missing read token as auth and opens no socket", async () => {
    let calls = 0
    const repository = createConvexRowRepository({
      configuration: () => ({
        generation: 1,
        settings: resolveRemoteReadSettings({
          VOGEL_VAULT_REMOTE_READ: "1",
          VOGEL_VAULT_CONVEX_URL: "https://example.invalid",
        }),
      }),
      post: async () => {
        calls += 1
        return success({
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
        })
      },
    })
    await expect(repository.query({ kind: "rowCounts" })).resolves.toEqual({
      status: "error",
      code: "unauthorized",
    })
    expect(calls).toBe(0)
  })

  it("sends the read token on rowCounts", async () => {
    let sent: Record<string, unknown> | null = null
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async (_endpoint, body) => {
        sent = JSON.parse(body) as Record<string, unknown>
        return success({
          transactions: 1,
          todos: 2,
          btcBuys: 3,
          btcBillPays: 4,
          btcAccounts: 5,
          income: 6,
          balanceDocuments: 7,
          budgetDocuments: 8,
          btcBalanceDocuments: 9,
          financeDocuments: 10,
          futureTable: 11,
        })
      },
    })
    await expect(repository.query({ kind: "rowCounts" })).resolves.toEqual({
      status: "ok",
      kind: "rowCounts",
      value: {
        transactions: 1,
        todos: 2,
        btcBuys: 3,
        btcBillPays: 4,
        btcAccounts: 5,
        income: 6,
        balanceDocuments: 7,
        budgetDocuments: 8,
        btcBalanceDocuments: 9,
        financeDocuments: 10,
      },
    })
    expect(sent).toEqual({
      path: "tables:rowCounts",
      args: { token: SECRET },
      format: "convex_encoded_json",
    })
  })

  it("uses a fixed path, carries configuration only on the wire, and decodes bigint", async () => {
    const sent: Array<Record<string, unknown>> = []
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async (_endpoint, body) => {
        sent.push(JSON.parse(body) as Record<string, unknown>)
        return success({ complete: true, rows: [transaction()] })
      },
    })

    const result = await repository.query({ kind: "transactions", viewer: "rachel" })
    expect(result).toEqual({
      status: "ok",
      kind: "transactions",
      complete: true,
      rows: [
        {
          txId: "tx-1",
          owner: "victor",
          date: "2026-07-26",
          month: "2026-07",
          merchant: "Example",
          amountCents: 115n,
          spendAmount: 115n,
          displaySpendAmount: 115n,
          hasOppositeSpendSign: false,
          category: "Other",
          updatedAtMs: 1,
        },
      ],
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      path: "tables:listTransactions",
      args: { viewer: "rachel", token: SECRET },
      format: "convex_encoded_json",
    })
    expect(JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain(SECRET)
    expect(JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain("example.invalid")
  })

  it("keys both completed and in-flight caches by request plus config generation", async () => {
    let generation = 1
    let calls = 0
    const repository = createConvexRowRepository({
      configuration: () => ({ generation, settings }),
      post: async () => {
        calls += 1
        await Promise.resolve()
        return success({ complete: true, rows: [transaction()] })
      },
      now: () => 1,
    })

    await Promise.all([
      repository.query({ kind: "transactions", viewer: "victor" }),
      repository.query({ kind: "transactions", viewer: "victor" }),
    ])
    expect(calls).toBe(1)
    await repository.query({ kind: "transactions", viewer: "victor" })
    expect(calls).toBe(1)

    generation = 2
    await repository.query({ kind: "transactions", viewer: "victor" })
    expect(calls).toBe(2)
  })

  it("fails a full request when the backend envelope is incomplete", async () => {
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({ complete: false, rows: [transaction()] }),
    })
    await expect(repository.query({ kind: "transactions", viewer: "victor" })).resolves.toEqual({
      status: "error",
      code: "incomplete-response",
    })
  })

  it("allows incomplete only when the renderer requested a bound", async () => {
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({ complete: false, rows: [transaction()] }),
    })
    await expect(repository.query({ kind: "transactions", viewer: "victor", limit: 1 })).resolves.toMatchObject({
      status: "ok",
      kind: "transactions",
      complete: false,
    })
  })

  it("ignores unexpected response fields while projecting only the public DTO", async () => {
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({
        complete: true,
        rows: [transaction({
          sourceFile: "transactions",
          _id: "hidden",
          futureServerField: { nested: true },
        })],
        futureEnvelopeField: "ignored",
      }),
    })

    const result = await repository.query({ kind: "transactions", viewer: "victor" })
    expect(result).toMatchObject({
      status: "ok",
      kind: "transactions",
      complete: true,
      rows: [{ txId: "tx-1", spendAmount: 115n }],
    })
    expect(result).not.toHaveProperty("futureEnvelopeField")
    expect(result).not.toHaveProperty("rows.0.sourceFile")
    expect(result).not.toHaveProperty("rows.0._id")
    expect(result).not.toHaveProperty("rows.0.futureServerField")
  })

  it("keeps canonical transaction fields fail-closed", async () => {
    const missingAmount = transaction()
    delete missingAmount["amountCents"]

    for (const invalid of [
      transaction({ amountCents: 115 }),
      missingAmount,
      transaction({ owner: "future-owner" }),
      transaction({ date: "2026-08-26", month: "2026-07" }),
    ]) {
      const repository = createConvexRowRepository({
        configuration: () => ({ generation: 1, settings }),
        post: async () => success({ complete: true, rows: [invalid] }),
      })
      await expect(repository.query({ kind: "transactions", viewer: "victor" })).resolves.toEqual({
        status: "error",
        code: "invalid-response",
      })
    }
  })

  it("accepts disagreeing server projections and derives all spend values from amountCents", async () => {
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({
        complete: true,
        rows: [
          transaction({
            txId: "adult-refund",
            amountCents: int64(-2_500n),
            spendAmount: int64(2_500n),
            displaySpendAmount: int64(-2_500n),
            hasOppositeSpendSign: false,
          }),
          transaction({
            txId: "child-spend",
            owner: "mason",
            amountCents: int64(2_000n),
            spendAmount: 2_000,
            displaySpendAmount: "wrong",
            hasOppositeSpendSign: true,
          }),
          transaction({
            txId: "income",
            amountCents: int64(10_000n),
            spendAmount: int64(10_000n),
            displaySpendAmount: int64(10_000n),
            hasOppositeSpendSign: true,
            category: "Income",
          }),
        ],
      }),
    })

    await expect(repository.query({ kind: "transactions", viewer: "victor" })).resolves.toMatchObject({
      status: "ok",
      rows: [
        {
          txId: "adult-refund",
          spendAmount: -2_500n,
          displaySpendAmount: 2_500n,
          hasOppositeSpendSign: true,
        },
        {
          txId: "child-spend",
          spendAmount: 2_000n,
          displaySpendAmount: 2_000n,
          hasOppositeSpendSign: false,
        },
        {
          txId: "income",
          spendAmount: 0n,
          displaySpendAmount: 0n,
          hasOppositeSpendSign: false,
        },
      ],
    })
  })

  it("asserts visibility locally even if the backend returns the wrong owner", async () => {
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({ complete: true, rows: [transaction({ owner: "victor" })] }),
    })
    await expect(repository.query({ kind: "transactions", viewer: "mason" })).resolves.toEqual({
      status: "error",
      code: "invalid-response",
    })
  })

  it("projects todos, BTC buys, accounts, and bill pays through public allowlists", async () => {
    const cases: ReadonlyArray<{
      readonly request: Record<string, unknown>
      readonly path: string
      readonly row: Record<string, unknown>
      readonly expected: Record<string, unknown>
    }> = [
      {
        request: { kind: "todos", viewer: "victor" },
        path: "tables:listTodos",
        row: {
          todoId: "todo-1",
          owner: "mason",
          title: "Example todo",
          done: false,
          flagged: true,
          priority: int64(2n),
          updatedAtMs: 10,
        },
        expected: { todoId: "todo-1", owner: "mason", priority: 2n },
      },
      {
        request: { kind: "btcBuys", viewer: "victor", scope: "visible" },
        path: "tables:listBtcBuys",
        row: {
          buyId: "buy-1",
          owner: "mason",
          date: "2026-07-02",
          month: "2026-07",
          source: "example",
          sats: int64(100n),
          priceUsdCents: int64(10_000_000n),
          usdCents: int64(10_000n),
          updatedAtMs: 20,
        },
        expected: { buyId: "buy-1", owner: "mason", sats: 100n },
      },
      {
        request: { kind: "btcAccounts", viewer: "victor", scope: "netWorth" },
        path: "tables:listBtcAccounts",
        row: {
          key: "coldcard",
          owner: "victor",
          label: "Coldcard",
          custody: "self_custody",
          sats: int64(1_000n),
          fiatCents: int64(500_000n),
          asOf: "2026-07-26T00:00:00Z",
          schemaVersion: int64(2n),
          updatedAtMs: 30,
        },
        expected: { key: "coldcard", sats: 1_000n, schemaVersion: 2n },
      },
      {
        request: { kind: "btcBillPays", viewer: "victor", scope: "visible" },
        path: "tables:listBtcBillPays",
        row: {
          billPayId: "pay-1",
          owner: "mason",
          date: "2026-07-03",
          month: "2026-07",
          merchant: "Example",
          category: "Bills",
          amountUsdCents: int64(5_000n),
          btcSpentSats: int64(50n),
          btcPriceCents: int64(10_000_000n),
          feeUsdCents: int64(100n),
          updatedAtMs: 40,
        },
        expected: { billPayId: "pay-1", owner: "mason", feeUsdCents: 100n },
      },
    ]

    for (const entry of cases) {
      let requestBody: Record<string, unknown> | null = null
      const repository = createConvexRowRepository({
        configuration: () => ({ generation: 1, settings }),
        post: async (_endpoint, body) => {
          requestBody = JSON.parse(body) as Record<string, unknown>
          return success({ complete: true, rows: [entry.row] })
        },
      })
      const result = await repository.query(entry.request)
      expect(result).toMatchObject({ status: "ok", rows: [entry.expected], complete: true })
      expect(requestBody).toMatchObject({
        path: entry.path,
        args: { token: SECRET },
        format: "convex_encoded_json",
      })
    }
  })

  it("decodes tagged budget savingsBps and BTC snapshot metadata envelopes", async () => {
    const sent: Array<Record<string, unknown>> = []
    const responses = [
      success({
        complete: true,
        document: {
          owner: "victor",
          month: "2026-07",
          coinbaseOneBalanceCents: int64(12_345n),
          categories: [{ name: "Food", budgetCents: int64(50_000n) }],
          mtdIncomeCents: int64(100_000n),
          ytdIncomeCents: int64(700_000n),
          monthlyHistory: [{
            month: "2026-06",
            incomeCents: int64(90_000n),
            expensesCents: int64(60_000n),
            savingsBps: int64(3_333n),
          }],
          updatedAtMs: 123,
        },
      }),
      success({
        complete: true,
        rows: [
          {
            owner: "victor",
            schemaVersion: int64(2n),
            asOf: "2026-07-26T00:00:00Z",
            source: "fixture",
            updatedAtMs: 456,
          },
        ],
      }),
    ]
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async (_endpoint, body) => {
        sent.push(JSON.parse(body) as Record<string, unknown>)
        const response = responses.shift()
        if (response === undefined) throw new Error("missing response")
        return response
      },
    })

    await expect(repository.query({ kind: "budget", viewer: "rachel", scope: "netWorth" })).resolves.toMatchObject({
      status: "ok",
      kind: "budget",
      value: {
        owner: "victor",
        coinbaseOneBalanceCents: 12_345n,
        monthlyHistory: [{ savingsBps: 3_333 }],
      },
    })
    await expect(
      repository.query({ kind: "btcSnapshotMeta", viewer: "rachel", scope: "netWorth" }),
    ).resolves.toMatchObject({
      status: "ok",
      kind: "btcSnapshotMeta",
      complete: true,
      rows: [{ owner: "victor", schemaVersion: 2n }],
    })
    expect(sent).toEqual([
      {
        path: "tables:getBudgetDocument",
        args: { viewer: "rachel", scope: "netWorth", token: SECRET },
        format: "convex_encoded_json",
      },
      {
        path: "tables:getBtcSnapshotMetadata",
        args: { viewer: "rachel", scope: "netWorth", token: SECRET },
        format: "convex_encoded_json",
      },
    ])
  })

  it("requires backend budget ownership and scoped bill-pay visibility", async () => {
    const badBudget = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({
        complete: true,
        document: {
          owner: "mason",
          month: "2026-07",
          coinbaseOneBalanceCents: int64(0n),
          categories: [],
          mtdIncomeCents: int64(0n),
          ytdIncomeCents: int64(0n),
          monthlyHistory: [],
          updatedAtMs: 1,
        },
      }),
    })
    await expect(
      badBudget.query({ kind: "budget", viewer: "victor", scope: "netWorth" }),
    ).resolves.toEqual({ status: "error", code: "invalid-response" })

    const badBillPay = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({
        complete: true,
        rows: [{
          billPayId: "bp-1",
          owner: "mason",
          date: "2026-07-01",
          month: "2026-07",
          merchant: "Example",
          category: "Bills",
          amountUsdCents: int64(100n),
          btcSpentSats: int64(10n),
          btcPriceCents: int64(1_000_000n),
          feeUsdCents: int64(0n),
          updatedAtMs: 1,
        }],
      }),
    })
    await expect(
      badBillPay.query({ kind: "btcBillPays", viewer: "victor", scope: "netWorth" }),
    ).resolves.toEqual({ status: "error", code: "invalid-response" })
  })

  it("enforces response byte and row-count bounds", async () => {
    const truncated = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => ({ httpStatus: 200, body: "{}", truncated: true }),
    })
    await expect(truncated.query({ kind: "transactions", viewer: "victor" })).resolves.toEqual({
      status: "error",
      code: "response-too-large",
    })

    const tooMany = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({
        complete: true,
        rows: Array.from({ length: 2_001 }, (_, index) => transaction({ txId: `tx-${index}` })),
      }),
    })
    await expect(tooMany.query({ kind: "transactions", viewer: "victor" })).resolves.toEqual({
      status: "error",
      code: "invalid-response",
    })
  })

  it("keeps transport and server failures local", async () => {
    const thrown = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => {
        throw new Error(`failed at https://example.invalid with ${SECRET}`)
      },
    })
    await expect(thrown.query({ kind: "transactions", viewer: "victor" })).resolves.toEqual({
      status: "error",
      code: "unavailable",
    })

    const server = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => ({
        httpStatus: 200,
        body: JSON.stringify({ status: "error", errorData: "balance 424218 at private bank" }),
      }),
    })
    await expect(server.query({ kind: "transactions", viewer: "victor" })).resolves.toEqual({
      status: "error",
      code: "invalid-response",
    })

    const unauthorized = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => ({
        httpStatus: 200,
        body: JSON.stringify({ status: "error", errorData: `Unauthorized: ${SECRET}` }),
      }),
    })
    await expect(unauthorized.query({ kind: "transactions", viewer: "victor" })).resolves.toEqual({
      status: "error",
      code: "unauthorized",
    })
  })
})
