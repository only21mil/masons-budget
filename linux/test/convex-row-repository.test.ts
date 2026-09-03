import { Buffer } from "node:buffer"

import { describe, expect, it } from "vitest"

import { resolveRemoteReadSettings } from "../electron/convexRead.ts"
import {
  createConvexRowRepository,
  validateRowRequest,
} from "../electron/convexRows.ts"
import type { VogelVaultRowRequest } from "../shared/ipc.ts"

const SECRET = "not-a-real-row-read-secret"
const settings = resolveRemoteReadSettings({
  VOGEL_VAULT_REMOTE_READ: "1",
  VOGEL_VAULT_CONVEX_URL: "https://keen-elephant-452.convex.cloud",
  VOGEL_VAULT_CONVEX_READ_TOKEN: SECRET,
})

const PROFILE_SCOPED_REQUESTS: readonly VogelVaultRowRequest[] = [
  { kind: "transactions" },
  { kind: "todos" },
  { kind: "income" },
  { kind: "btcBuys", scope: "visible" },
  { kind: "btcAccounts", scope: "netWorth" },
  { kind: "btcBillPays", scope: "visible" },
  { kind: "btcTransfers", scope: "netWorth" },
  { kind: "budget", scope: "netWorth" },
  { kind: "btcSnapshotMeta", scope: "visible" },
  { kind: "btcBalanceDocuments", scope: "netWorth" },
  { kind: "finance", scope: "netWorth" },
]

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

function income(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    incomeId: "income-01",
    owner: "victor",
    date: "2026-01-01",
    month: "2026-01",
    amountCents: int64(123_456n),
    source: "payroll",
    loggedBy: "victor",
    note: "production-shaped income fixture",
    archimedesRequestId: "income-arch-0",
    updatedAtMs: 0,
    ...overrides,
  }
}

function billPay(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    billPayId: "pay-1",
    owner: "victor",
    date: "2026-07-03",
    month: "2026-07",
    merchant: "Example",
    category: "Bills",
    amountUsdCents: int64(5_000n),
    btcSpentSats: int64(50n),
    btcPriceCents: int64(10_000_000n),
    feeUsdCents: int64(100n),
    updatedAtMs: 40,
    ...overrides,
  }
}

function btcBalanceDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    owner: "victor",
    schemaVersion: int64(2n),
    asOf: "2026-07-18T12:00:00Z",
    accounts: [
      {
        key: "strike",
        label: "Strike",
        custody: "exchange",
        sats: int64(35_000_000n),
        fiatCents: int64(3_430_055n),
      },
      {
        key: "coldcard",
        label: "Multisig",
        custody: "self_custody",
        sats: int64(150_000_000n),
        fiatCents: int64(14_700_000n),
      },
    ],
    totals: {
      sats: int64(185_000_000n),
      fiatCents: int64(18_130_055n),
      exchangeSats: int64(35_000_000n),
      selfCustodySats: int64(150_000_000n),
    },
    source: "synthetic",
    basis: "spot",
    confidence: "verified",
    updatedAtMs: 0,
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
    expect(validateRowRequest({ kind: "transactions" })).toEqual({ kind: "transactions" })
    expect(validateRowRequest({ kind: "transactions", viewer: "victor", query: "anything" })).toBeNull()
    expect(validateRowRequest({ kind: "transactions", viewer: "Mason" })).toBeNull()
    expect(validateRowRequest({ kind: "transactions", limit: 0 })).toBeNull()
  })

  it("requires explicit visibility and budget scopes", () => {
    expect(validateRowRequest({ kind: "btcAccounts" })).toBeNull()
    expect(validateRowRequest({ kind: "btcAccounts", scope: "netWorth" })).toEqual({
      kind: "btcAccounts",
      scope: "netWorth",
    })
    expect(validateRowRequest({ kind: "btcBillPays" })).toBeNull()
    expect(validateRowRequest({ kind: "btcBillPays", scope: "visible" })).toEqual({
      kind: "btcBillPays",
      scope: "visible",
    })
    expect(validateRowRequest({ kind: "btcTransfers" })).toBeNull()
    expect(validateRowRequest({ kind: "btcTransfers", scope: "netWorth" })).toEqual({
      kind: "btcTransfers",
      scope: "netWorth",
    })
    expect(validateRowRequest({ kind: "budget" })).toBeNull()
    expect(validateRowRequest({ kind: "budget", scope: "netWorth" })).toEqual({
      kind: "budget",
      scope: "netWorth",
    })
    expect(validateRowRequest({ kind: "btcBalanceDocuments" })).toBeNull()
    expect(validateRowRequest({ kind: "btcBalanceDocuments", scope: "netWorth" })).toEqual({
      kind: "btcBalanceDocuments",
      scope: "netWorth",
    })
  })
})

describe("main-process row repository", () => {
  it("injects the main-owned Mason profile across every scoped route and rejects renderer spoofing", async () => {
    const sent: Array<Record<string, unknown>> = []
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async (_endpoint, body) => {
        sent.push(JSON.parse(body) as Record<string, unknown>)
        return success({ complete: true, rows: [] })
      },
    })

    for (const request of PROFILE_SCOPED_REQUESTS) {
      await repository.query(request, "mason")
    }

    expect(sent).toHaveLength(PROFILE_SCOPED_REQUESTS.length)
    for (const body of sent) {
      expect(body).toMatchObject({ args: { viewer: "mason", token: SECRET } })
      expect(body).not.toMatchObject({ args: { viewer: "victor" } })
    }

    for (const request of PROFILE_SCOPED_REQUESTS) {
      await expect(repository.query({ ...request, viewer: "victor" }, "mason")).resolves.toEqual({
        status: "error",
        code: "invalid-request",
      })
    }
    expect(sent).toHaveLength(PROFILE_SCOPED_REQUESTS.length)
  })

  it("fails every route before configuration or network use without valid main-owned authority", async () => {
    let configured = 0
    let calls = 0
    const repository = createConvexRowRepository({
      configuration: () => {
        configured += 1
        return { generation: 1, settings }
      },
      post: async () => {
        calls += 1
        return success({ complete: true, rows: [] })
      },
    })
    const everyRoute: readonly VogelVaultRowRequest[] = [
      { kind: "rowCounts" },
      ...PROFILE_SCOPED_REQUESTS,
      { kind: "marketQuotes" },
    ]

    for (const request of everyRoute) {
      await expect(repository.query(request)).resolves.toEqual({ status: "error", code: "invalid-request" })
      await expect(repository.query(request, "unknown")).resolves.toEqual({
        status: "error",
        code: "invalid-request",
      })
    }
    expect(configured).toBe(0)
    expect(calls).toBe(0)
  })

  it("opens no socket while remote reads are disabled", async () => {
    let calls = 0
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings: resolveRemoteReadSettings({}) }),
      post: async () => {
        calls += 1
        return success({ complete: true, rows: [] })
      },
    })
    await expect(repository.query({ kind: "transactions" }, "victor")).resolves.toEqual({
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
          VOGEL_VAULT_CONVEX_URL: "https://keen-elephant-452.convex.cloud",
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
    await expect(repository.query({ kind: "rowCounts" }, "victor")).resolves.toEqual({
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
    await expect(repository.query({ kind: "rowCounts" }, "victor")).resolves.toEqual({
      status: "ok",
      kind: "rowCounts",
      value: {
        transactions: 1,
        todos: 2,
        btcBuys: 3,
        btcBillPays: 4,
        btcTransfers: 0,
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

    const result = await repository.query({ kind: "transactions" }, "rachel")
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
    expect(JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain("convex.cloud")
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
      repository.query({ kind: "transactions" }, "victor"),
      repository.query({ kind: "transactions" }, "victor"),
    ])
    expect(calls).toBe(1)
    await repository.query({ kind: "transactions" }, "victor")
    expect(calls).toBe(1)

    generation = 2
    await repository.query({ kind: "transactions" }, "victor")
    expect(calls).toBe(2)
  })

  it("keeps exact buy fees in the completed cache", async () => {
    let calls = 0
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => {
        calls += 1
        return success({
          complete: true,
          rows: [{
            buyId: "buy-cached-fee",
            owner: "victor",
            date: "2026-08-25",
            month: "2026-08",
            source: "river",
            sats: int64(1_000n),
            priceUsdCents: int64(10_000_000n),
            usdCents: int64(100n),
            feeUsdCents: int64(25n),
            updatedAtMs: 1,
          }],
        })
      },
      now: () => 1,
    })

    const request = { kind: "btcBuys", scope: "visible" } as const
    const first = await repository.query(request, "victor")
    const second = await repository.query(request, "victor")
    expect(first).toMatchObject({ rows: [{ feeUsdCents: 25n }] })
    expect(second).toEqual(first)
    expect(calls).toBe(1)
  })

  it("admits every row request in one renderer refresh", async () => {
    const releases: Array<() => void> = []
    let calls = 0
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => {
        calls += 1
        await new Promise<void>((resolve) => releases.push(resolve))
        return success({ complete: true, rows: [] })
      },
    })
    const requests = [
      { kind: "transactions" },
      { kind: "todos" },
      { kind: "income" },
      { kind: "btcBuys", scope: "visible" },
      { kind: "btcAccounts", scope: "visible" },
      { kind: "btcBillPays", scope: "visible" },
      { kind: "btcTransfers", scope: "netWorth" },
      { kind: "budget", scope: "netWorth" },
      { kind: "btcSnapshotMeta", scope: "visible" },
      { kind: "btcBalanceDocuments", scope: "netWorth" },
    ]

    const pending = requests.map((request) => repository.query(request, "victor"))
    expect(calls).toBe(10)
    for (const release of releases) release()

    const results = await Promise.all(pending)
    expect(results.at(-1)).toEqual({
      status: "ok",
      kind: "btcBalanceDocuments",
      complete: true,
      rows: [],
    })
  })

  it("fails a full request when the backend envelope is incomplete", async () => {
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({ complete: false, rows: [transaction()] }),
    })
    await expect(repository.query({ kind: "transactions" }, "victor")).resolves.toEqual({
      status: "error",
      code: "incomplete-response",
    })
  })

  it("allows incomplete only when the renderer requested a bound", async () => {
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({ complete: false, rows: [transaction()] }),
    })
    await expect(repository.query({ kind: "transactions", limit: 1 }, "victor")).resolves.toMatchObject({
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

    const result = await repository.query({ kind: "transactions" }, "victor")
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
      await expect(repository.query({ kind: "transactions" }, "victor")).resolves.toEqual({
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

    await expect(repository.query({ kind: "transactions" }, "victor")).resolves.toMatchObject({
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

  // A Bitcoin-native spend is a positive-sats row with a non-Income category and
  // an account key. The ledger's own contract writes exactly this shape through
  // api.transaction (convex/btcLedger.test.ts:418-422) and the write validator
  // accepts it (electron/convexMutations.ts bitcoin branch). The read decoder
  // must surface it, not fail the whole envelope. Positivity and the account
  // requirement are pinned in the same test so the admission cannot widen again.
  it("decodes a bitcoin-native spend and keeps non-positive sats fail-closed", async () => {
    const decode = (row: Record<string, unknown>) => {
      const repository = createConvexRowRepository({
        configuration: () => ({ generation: 1, settings }),
        post: async () => success({ complete: true, rows: [transaction(row)] }),
      })
      return repository.query({ kind: "transactions" }, "victor")
    }

    const spend = {
      txId: "btc-spend",
      merchant: "Merchant",
      amountCents: int64(10_000n),
      category: "Shopping",
      card: "zeus_lightning",
      bitcoinAccountKey: "zeus",
    }

    // Positive sats, non-Income, account present -> decodes.
    const ok = await decode({ ...spend, amountSats: int64(25_000n) })
    expect(ok.status).toBe("ok")
    expect(ok).toMatchObject({ kind: "transactions" })
    if (ok.status !== "ok" || ok.kind !== "transactions") return
    expect(ok.rows[0]).toMatchObject({
      txId: "btc-spend",
      category: "Shopping",
      amountSats: 25_000n,
      bitcoinAccountKey: "zeus",
      card: "zeus_lightning",
      spendAmount: 10_000n,
      hasOppositeSpendSign: false,
    })

    // Negative sats, non-Income, account present -> fail closed.
    const negative = await decode({ ...spend, amountSats: int64(-25_000n) })
    expect(negative.status).toBe("error")
    expect(negative).toMatchObject({ code: "invalid-response" })

    // Zero sats, non-Income, account present -> fail closed.
    const zero = await decode({ ...spend, amountSats: int64(0n) })
    expect(zero.status).toBe("error")
    expect(zero).toMatchObject({ code: "invalid-response" })
  })

  it("asserts visibility locally even if the backend returns the wrong owner", async () => {
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({ complete: true, rows: [transaction({ owner: "victor" })] }),
    })
    await expect(repository.query({ kind: "transactions" }, "mason")).resolves.toEqual({
      status: "error",
      code: "invalid-response",
    })
  })

  it("rejects another profile's todo even for an adult viewer", async () => {
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({
        complete: true,
        rows: [{
          todoId: "todo-rachel-private",
          owner: "rachel",
          title: "Private",
          done: false,
          flagged: false,
          updatedAtMs: 1,
        }],
      }),
    })
    await expect(repository.query({ kind: "todos" }, "victor")).resolves.toEqual({
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
        request: { kind: "todos" },
        path: "tables:listTodos",
        row: {
          todoId: "todo-1",
          owner: "victor",
          title: "Example todo",
          done: false,
          flagged: true,
          priority: int64(2n),
          updatedAtMs: 10,
        },
        expected: { todoId: "todo-1", owner: "victor", priority: 2n },
      },
      {
        request: { kind: "btcBuys", scope: "visible" },
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
        expected: { buyId: "buy-1", owner: "mason", sats: 100n, feeUsdCents: 0n },
      },
      {
        request: { kind: "btcAccounts", scope: "netWorth" },
        path: "tables:listBtcAccounts",
        row: {
          key: "coldcard",
          owner: "victor",
          label: "Multisig",
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
        request: { kind: "btcBillPays", scope: "visible" },
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
      {
        request: { kind: "btcTransfers", scope: "netWorth" },
        path: "tables:listBtcTransfers",
        row: {
          transferId: "transfer-1",
          owner: "victor",
          date: "2026-07-03",
          month: "2026-07",
          fromAccountKey: "river",
          toAccountKey: "coldcard",
          sats: int64(50n),
          feeSats: int64(2n),
          updatedAtMs: 45,
        },
        expected: {
          transferId: "transfer-1",
          owner: "victor",
          sats: 50n,
          feeSats: 2n,
        },
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
      const result = await repository.query(entry.request, "victor")
      expect(result).toMatchObject({ status: "ok", rows: [entry.expected], complete: true })
      expect(requestBody).toMatchObject({
        path: entry.path,
        args: { token: SECRET },
        format: "convex_encoded_json",
      })
    }
  })

  it("rejects negative buy fees at the HTTP-to-IPC boundary", async () => {
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({
        complete: true,
        rows: [{
          buyId: "buy-negative-fee",
          owner: "victor",
          date: "2026-08-25",
          month: "2026-08",
          source: "river",
          sats: int64(1_000n),
          priceUsdCents: int64(10_000_000n),
          usdCents: int64(100n),
          feeUsdCents: int64(-1n),
          updatedAtMs: 1,
        }],
      }),
    })
    await expect(
      repository.query({ kind: "btcBuys", scope: "visible" }, "victor"),
    ).resolves.toEqual({ status: "error", code: "invalid-response" })
  })

  it("decodes legacy budget month labels, tagged savingsBps, and BTC snapshot metadata", async () => {
    const sent: Array<Record<string, unknown>> = []
    const responses = [
      success({
        complete: true,
        document: {
          owner: "victor",
          month: "July 2026",
          coinbaseOneBalanceCents: int64(12_345n),
          categories: [{ name: "Food", budgetCents: int64(50_000n) }],
          mtdIncomeCents: int64(100_000n),
          ytdIncomeCents: int64(700_000n),
          monthlyHistory: [{
            month: "June 2026",
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

    await expect(repository.query({ kind: "budget", scope: "netWorth" }, "rachel")).resolves.toMatchObject({
      status: "ok",
      kind: "budget",
      value: {
        owner: "victor",
        month: "July 2026",
        coinbaseOneBalanceCents: 12_345n,
        monthlyHistory: [{ month: "June 2026", savingsBps: 3_333 }],
      },
    })
    await expect(
      repository.query({ kind: "btcSnapshotMeta", scope: "netWorth" }, "rachel"),
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

  it("rejects malformed budget month labels without weakening row month validation", async () => {
    const malformedBudget = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({
        complete: true,
        document: {
          owner: "victor",
          month: "June-2026",
          coinbaseOneBalanceCents: int64(0n),
          categories: [],
          mtdIncomeCents: int64(0n),
          ytdIncomeCents: int64(0n),
          monthlyHistory: [],
          updatedAtMs: 0,
        },
      }),
    })
    await expect(
      malformedBudget.query({ kind: "budget", scope: "netWorth" }, "victor"),
    ).resolves.toEqual({ status: "error", code: "invalid-response" })

    const malformedTransaction = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({
        complete: true,
        rows: [transaction({ month: "June 2026" })],
      }),
    })
    await expect(
      malformedTransaction.query({ kind: "transactions" }, "victor"),
    ).resolves.toEqual({ status: "error", code: "invalid-response" })
  })

  it("decodes production-shaped income rows and rejects malformed money", async () => {
    const sent: Array<Record<string, unknown>> = []
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async (_endpoint, body) => {
        sent.push(JSON.parse(body) as Record<string, unknown>)
        return success({ complete: true, rows: [income()] })
      },
    })

    await expect(
      repository.query({ kind: "income", month: "2026-01" }, "rachel"),
    ).resolves.toEqual({
      status: "ok",
      kind: "income",
      complete: true,
      rows: [{
        incomeId: "income-01",
        owner: "victor",
        date: "2026-01-01",
        month: "2026-01",
        amountCents: 123_456n,
        source: "payroll",
        loggedBy: "victor",
        note: "production-shaped income fixture",
        archimedesRequestId: "income-arch-0",
        updatedAtMs: 0,
      }],
    })
    expect(sent).toEqual([{
      path: "tables:listIncome",
      args: { viewer: "rachel", month: "2026-01", token: SECRET },
      format: "convex_encoded_json",
    }])

    const malformed = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({ complete: true, rows: [income({ amountCents: "123456" })] }),
    })
    await expect(
      malformed.query({ kind: "income" }, "rachel"),
    ).resolves.toEqual({ status: "error", code: "invalid-response" })
  })

  it("decodes production-shaped BTC balance documents and rejects malformed sats", async () => {
    const sent: Array<Record<string, unknown>> = []
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async (_endpoint, body) => {
        sent.push(JSON.parse(body) as Record<string, unknown>)
        return success({ complete: true, rows: [btcBalanceDocument()] })
      },
    })

    await expect(
      repository.query({ kind: "btcBalanceDocuments", scope: "netWorth" }, "rachel"),
    ).resolves.toMatchObject({
      status: "ok",
      kind: "btcBalanceDocuments",
      complete: true,
      rows: [{
        owner: "victor",
        schemaVersion: 2n,
        accounts: [
          { key: "strike", sats: 35_000_000n, fiatCents: 3_430_055n },
          { key: "coldcard", sats: 150_000_000n, fiatCents: 14_700_000n },
        ],
        totals: {
          sats: 185_000_000n,
          fiatCents: 18_130_055n,
          exchangeSats: 35_000_000n,
          selfCustodySats: 150_000_000n,
        },
      }],
    })
    expect(sent).toEqual([{
      path: "tables:listBtcBalanceDocuments",
      args: { viewer: "rachel", scope: "netWorth", token: SECRET },
      format: "convex_encoded_json",
    }])

    const malformed = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({
        complete: true,
        rows: [btcBalanceDocument({
          totals: {
            sats: 1.85,
            fiatCents: int64(18_130_055n),
            exchangeSats: int64(35_000_000n),
            selfCustodySats: int64(150_000_000n),
          },
        })],
      }),
    })
    await expect(
      malformed.query({ kind: "btcBalanceDocuments", scope: "netWorth" }, "rachel"),
    ).resolves.toEqual({ status: "error", code: "invalid-response" })
  })

  it("keeps known sats live while decoding unavailable and explicit-zero fiat valuation", async () => {
    const legacyUnavailableDocument = btcBalanceDocument({
      accounts: [{
        key: "coldcard",
        label: "Multisig",
        custody: "self_custody",
        sats: int64(541_782_856n),
        fiatCents: int64(0n),
      }],
      totals: {
        sats: int64(541_782_856n),
        fiatCents: int64(0n),
        exchangeSats: int64(0n),
        selfCustodySats: int64(541_782_856n),
      },
      balanceConfidence: "high",
    })
    const explicitUnavailableDocument = btcBalanceDocument({
      accounts: [{
        key: "coldcard",
        label: "Multisig",
        custody: "self_custody",
        sats: int64(541_782_856n),
        fiatCents: int64(0n),
        fiatValuation: null,
      }],
      totals: {
        sats: int64(541_782_856n),
        fiatCents: int64(0n),
        fiatValuation: null,
        exchangeSats: int64(0n),
        selfCustodySats: int64(541_782_856n),
      },
      balanceConfidence: "high",
    })
    const tinyExplicitZero = btcBalanceDocument({
      accounts: [{
        key: "tiny",
        label: "Tiny",
        custody: "self_custody",
        sats: int64(1n),
        fiatCents: int64(0n),
        fiatValuation: {
          cents: int64(0n),
          priceCents: int64(6_000_000n),
          quotedAt: "2026-07-29T12:00:00Z",
          source: "fixture quote",
          confidence: "verified",
        },
      }],
      totals: {
        sats: int64(1n),
        fiatCents: int64(0n),
        fiatValuation: {
          cents: int64(0n),
          priceCents: int64(6_000_000n),
          quotedAt: "2026-07-29T12:00:00Z",
          source: "fixture quote",
          confidence: "verified",
        },
        exchangeSats: int64(0n),
        selfCustodySats: int64(1n),
      },
    })
    const repository = (document: Record<string, unknown>) => createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({ complete: true, rows: [document] }),
    })

    await expect(
      repository(legacyUnavailableDocument).query({
        kind: "btcBalanceDocuments",
        scope: "netWorth",
      }, "victor"),
    ).resolves.toMatchObject({
      status: "ok",
      rows: [{
        balanceConfidence: "high",
        accounts: [{ sats: 541_782_856n, fiatValuation: null }],
        totals: { sats: 541_782_856n, fiatValuation: null },
      }],
    })
    await expect(
      repository(explicitUnavailableDocument).query({
        kind: "btcBalanceDocuments",
        scope: "netWorth",
      }, "victor"),
    ).resolves.toMatchObject({
      status: "ok",
      rows: [{
        accounts: [{ sats: 541_782_856n, fiatValuation: null }],
        totals: { sats: 541_782_856n, fiatValuation: null },
      }],
    })
    await expect(
      repository(tinyExplicitZero).query({
        kind: "btcBalanceDocuments",
        scope: "netWorth",
      }, "victor"),
    ).resolves.toMatchObject({
      status: "ok",
      rows: [{
        accounts: [{
          sats: 1n,
          fiatValuation: {
            cents: 0n,
            priceCents: 6_000_000n,
            source: "fixture quote",
          },
        }],
        totals: { sats: 1n, fiatValuation: { cents: 0n } },
      }],
    })
  })

  it("rejects malformed fiat valuation instead of reviving the legacy zero", async () => {
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({
        complete: true,
        rows: [btcBalanceDocument({
          totals: {
            sats: int64(1n),
            fiatCents: int64(0n),
            fiatValuation: { cents: 0 },
            exchangeSats: int64(0n),
            selfCustodySats: int64(1n),
          },
        })],
      }),
    })

    await expect(
      repository.query({ kind: "btcBalanceDocuments", scope: "netWorth" }, "victor"),
    ).resolves.toEqual({ status: "error", code: "invalid-response" })
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
      badBudget.query({ kind: "budget", scope: "netWorth" }, "victor"),
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
      badBillPay.query({ kind: "btcBillPays", scope: "netWorth" }, "victor"),
    ).resolves.toEqual({ status: "error", code: "invalid-response" })
  })

  describe("the bill-pay budget effect at the read boundary", () => {
    function readBillPay(row: Record<string, unknown>) {
      const repository = createConvexRowRepository({
        configuration: () => ({ generation: 1, settings }),
        post: async () => success({ complete: true, rows: [row] }),
      })
      return repository.query({ kind: "btcBillPays", scope: "visible" }, "victor")
    }

    // toStrictEqual, not toMatchObject: the claim is that the property is
    // ABSENT from the decoded row, not that it decoded to undefined. Only an
    // absent property lets the renderer apply its credit_card_payment default.
    it("passes a pre-amendment row through with no budgetEffect property", async () => {
      await expect(readBillPay(billPay())).resolves.toStrictEqual({
        status: "ok",
        kind: "btcBillPays",
        complete: true,
        rows: [{
          billPayId: "pay-1",
          owner: "victor",
          date: "2026-07-03",
          month: "2026-07",
          merchant: "Example",
          category: "Bills",
          amountUsdCents: 5_000n,
          btcSpentSats: 50n,
          btcPriceCents: 10_000_000n,
          feeUsdCents: 100n,
          updatedAtMs: 40,
        }],
      })
    })

    it("accepts a budget-category effect against a real category", async () => {
      await expect(
        readBillPay(billPay({ budgetEffect: "budget_category", category: "Utilities" })),
      ).resolves.toMatchObject({
        status: "ok",
        rows: [{ category: "Utilities", budgetEffect: "budget_category" }],
      })
    })

    it("accepts a credit-card payment under the one category that names it", async () => {
      await expect(
        readBillPay(billPay({
          budgetEffect: "credit_card_payment",
          category: "Credit Card Payment",
        })),
      ).resolves.toMatchObject({
        status: "ok",
        rows: [{ category: "Credit Card Payment", budgetEffect: "credit_card_payment" }],
      })
    })

    it.each([
      ["an unknown wire value", { budgetEffect: "budget" }],
      ["an empty string", { budgetEffect: "" }],
      ["a null", { budgetEffect: null }],
      ["a non-string", { budgetEffect: 1 }],
      [
        "a credit-card payment under some other category",
        { budgetEffect: "credit_card_payment", category: "Utilities" },
      ],
    ])("rejects the whole row for %s", async (_reason, overrides) => {
      await expect(readBillPay(billPay(overrides))).resolves.toEqual({
        status: "error",
        code: "invalid-response",
      })
    })
  })

  it("enforces response byte and row-count bounds", async () => {
    const truncated = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => ({ httpStatus: 200, body: "{}", truncated: true }),
    })
    await expect(truncated.query({ kind: "transactions" }, "victor")).resolves.toEqual({
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
    await expect(tooMany.query({ kind: "transactions" }, "victor")).resolves.toEqual({
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
    await expect(thrown.query({ kind: "transactions" }, "victor")).resolves.toEqual({
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
    await expect(server.query({ kind: "transactions" }, "victor")).resolves.toEqual({
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
    await expect(unauthorized.query({ kind: "transactions" }, "victor")).resolves.toEqual({
      status: "error",
      code: "unauthorized",
    })
  })

  it("drops cached answers for invalidated kinds so a write is not masked by a stale read", async () => {
    let calls = 0
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => {
        calls += 1
        return {
          httpStatus: 200,
          body: JSON.stringify({ status: "success", value: { rows: [], complete: true } }),
        }
      },
    })

    await repository.query({ kind: "transactions" }, "victor")
    await repository.query({ kind: "transactions" }, "victor")
    expect(calls).toBe(1)

    // A Bitcoin mutation lands; the next read must reach the server rather than
    // replay the pre-write answer that is still inside the cache window.
    repository.invalidate(["transactions"])
    await repository.query({ kind: "transactions" }, "victor")
    expect(calls).toBe(2)
  })

  it("leaves unrelated cached kinds alone when invalidating", async () => {
    let calls = 0
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => {
        calls += 1
        return {
          httpStatus: 200,
          body: JSON.stringify({ status: "success", value: { rows: [], complete: true } }),
        }
      },
    })

    await repository.query({ kind: "todos" }, "victor")
    expect(calls).toBe(1)
    repository.invalidate(["transactions"])
    await repository.query({ kind: "todos" }, "victor")
    expect(calls).toBe(1)
  })
})
