import { Buffer } from "node:buffer"

import { describe, expect, it } from "vitest"

import { resolveRemoteReadSettings } from "../electron/convexRead.ts"
import {
  createConvexRowRepository,
  validateRowRequest,
} from "../electron/convexRows.ts"
import type {
  VogelVaultFinanceAccount,
  VogelVaultFinanceDocument,
  VogelVaultMarketQuoteSnapshot,
  VogelVaultRowRequest,
  VogelVaultRowResult,
} from "../shared/ipc.ts"
import {
  adaptFinanceDocument,
  loadLinuxFinanceReadModel,
  selectFinanceNetWorth,
} from "../src/renderer/data/financeReadModel.ts"

const settings = resolveRemoteReadSettings({
  VOGEL_VAULT_REMOTE_READ: "1",
  VOGEL_VAULT_CONVEX_URL: "https://example.invalid",
  VOGEL_VAULT_CONVEX_READ_TOKEN: "not-a-real-secret",
})

function int64(value: bigint): { readonly $integer: string } {
  const bytes = Buffer.alloc(8)
  bytes.writeBigInt64LE(value)
  return { $integer: bytes.toString("base64") }
}

function success(value: unknown) {
  return {
    httpStatus: 200,
    body: JSON.stringify({ status: "success", value }),
  }
}

function wireHolding(overrides: Record<string, unknown> = {}) {
  return {
    name: "Vanguard S&P 500",
    category: "Index Fund",
    ticker: "VOO",
    valueCents: int64(90_000n),
    costBasisCents: int64(80_000n),
    gainBps: int64(1_250n),
    sharesDecimal: "2.5000",
    avgCostCents: int64(32_000n),
    currentPricePerShareCents: int64(36_000n),
    isProxy: false,
    lots: [{
      date: "2026-07-01",
      type: "401k contribution",
      pricePerShareCents: int64(32_000n),
      sharesDecimal: "2.5000",
      amountInvestedCents: int64(80_000n),
      note: "Friday auto-buy projection",
    }],
    ...overrides,
  }
}

function wireAccount(owner = "victor", overrides: Record<string, unknown> = {}) {
  return {
    key: owner === "mason" ? "mason_401k" : "victor_401k",
    owner,
    provider: "Fidelity",
    totalValueCents: int64(90_000n),
    weeklyContributionCents: int64(25_00n),
    weeklyContributionDay: "Friday",
    holdings: [wireHolding()],
    ...overrides,
  }
}

function ipcAccount(owner: "victor" | "mason"): VogelVaultFinanceAccount {
  return {
    key: owner === "mason" ? "mason_401k" : "victor_401k",
    owner,
    provider: "Fidelity",
    totalValueCents: owner === "mason" ? 9_000_000n : 90_000n,
    weeklyContributionCents: 2_500n,
    weeklyContributionDay: "Friday",
    holdings: owner === "mason"
      ? []
      : [{
          name: "Vanguard S&P 500",
          category: "Index Fund",
          ticker: "VOO",
          valueCents: 90_000n,
          costBasisCents: 80_000n,
          gainBps: 1_250n,
          sharesDecimal: "2.5000",
          avgCostCents: 32_000n,
          currentPricePerShareCents: 36_000n,
          isProxy: false,
          lots: [],
        }],
  }
}

const quotes: VogelVaultMarketQuoteSnapshot = {
  quotes: [
    {
      symbol: "BTC",
      priceCents: 6_000_000n,
      source: "reviewed-btc-source",
      fetchedAt: "2026-07-30T12:00:00Z",
      status: "live",
    },
    {
      symbol: "VOO",
      priceCents: 40_000n,
      source: "reviewed-equity-source",
      fetchedAt: "2026-07-30T12:00:01Z",
      status: "stale",
    },
    {
      symbol: "IBIT",
      priceCents: null,
      source: "reviewed-equity-source",
      fetchedAt: null,
      status: "unavailable",
    },
  ],
}

describe("main-process finance and quote transport", () => {
  it("keeps finance scoped and market quotes fixed-symbol", () => {
    expect(validateRowRequest({
      kind: "finance",
      viewer: "rachel",
      scope: "netWorth",
    })).toEqual({
      kind: "finance",
      viewer: "rachel",
      scope: "netWorth",
    })
    expect(validateRowRequest({ kind: "finance", viewer: "rachel" })).toBeNull()
    expect(validateRowRequest({
      kind: "finance",
      viewer: "rachel",
      scope: "visible",
    })).toBeNull()
    expect(validateRowRequest({ kind: "marketQuotes" })).toEqual({ kind: "marketQuotes" })
    expect(validateRowRequest({ kind: "marketQuotes", symbol: "BTC" })).toBeNull()
    expect(validateRowRequest({
      kind: "marketQuotes",
      url: "https://attacker.invalid",
    })).toBeNull()
  })

  it("uses fixed authenticated paths and preserves exact retirement units", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async (_endpoint, body) => {
        const request = JSON.parse(body) as Record<string, unknown>
        bodies.push(request)
        if (request["path"] === "tables:getFinanceDocument") {
          return success({
            complete: true,
            document: {
              lastUpdated: "2026-07-30",
              retirementTotalCents: int64(90_000n),
              accounts: [wireAccount()],
              updatedAtMs: 1_722_345_678_901,
            },
          })
        }
        return success({
          complete: true,
          quotes: [
            {
              symbol: "BTC",
              priceCents: int64(6_000_000n),
              source: "reviewed-btc-source",
              fetchedAt: "2026-07-30T12:00:00Z",
              status: "live",
            },
            {
              symbol: "VOO",
              priceCents: int64(40_000n),
              source: "reviewed-equity-source",
              fetchedAt: "2026-07-30T12:00:01Z",
              status: "stale",
            },
            {
              symbol: "IBIT",
              priceCents: null,
              source: "reviewed-equity-source",
              fetchedAt: null,
              status: "unavailable",
            },
          ],
        })
      },
    })

    await expect(repository.query({
      kind: "finance",
      viewer: "rachel",
      scope: "netWorth",
    })).resolves.toMatchObject({
      status: "ok",
      kind: "finance",
      value: {
        retirementTotalCents: 90_000n,
        accounts: [{
          owner: "victor",
          totalValueCents: 90_000n,
          weeklyContributionCents: 2_500n,
          weeklyContributionDay: "Friday",
          holdings: [{
            sharesDecimal: "2.5000",
            valueCents: 90_000n,
            gainBps: 1_250n,
            lots: [{ amountInvestedCents: 80_000n }],
          }],
        }],
      },
    })
    await expect(repository.query({ kind: "marketQuotes" })).resolves.toMatchObject({
      status: "ok",
      kind: "marketQuotes",
      value: {
        quotes: [
          { symbol: "BTC", priceCents: 6_000_000n, status: "live" },
          { symbol: "VOO", priceCents: 40_000n, status: "stale" },
          { symbol: "IBIT", priceCents: null, status: "unavailable" },
        ],
      },
    })

    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toMatchObject({
      path: "tables:getFinanceDocument",
      args: { viewer: "rachel", scope: "netWorth" },
    })
    expect(bodies[1]).toMatchObject({
      path: "marketQuotes:getSnapshot",
      args: {},
    })
    expect(JSON.stringify(bodies)).not.toContain("symbol")
    expect(JSON.stringify(bodies)).not.toContain("url")
  })

  it("rejects child accounts leaked into an adult net-worth response", async () => {
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({
        complete: true,
        document: {
          lastUpdated: "2026-07-30",
          accounts: [wireAccount("mason")],
          updatedAtMs: 1,
        },
      }),
    })
    await expect(repository.query({
      kind: "finance",
      viewer: "victor",
      scope: "netWorth",
    })).resolves.toEqual({ status: "error", code: "invalid-response" })
  })

  it.each([
    ["missing symbol", [
      { symbol: "BTC", priceCents: int64(6_000_000n), source: "a", fetchedAt: "now", status: "live" },
      { symbol: "VOO", priceCents: int64(40_000n), source: "b", fetchedAt: "now", status: "live" },
    ], "incomplete-response"],
    ["duplicate symbol", [
      { symbol: "BTC", priceCents: int64(6_000_000n), source: "a", fetchedAt: "now", status: "live" },
      { symbol: "VOO", priceCents: int64(40_000n), source: "b", fetchedAt: "now", status: "live" },
      { symbol: "VOO", priceCents: int64(41_000n), source: "b", fetchedAt: "now", status: "stale" },
    ], "incomplete-response"],
    ["float price", [
      { symbol: "BTC", priceCents: 6_000_000, source: "a", fetchedAt: "now", status: "live" },
      { symbol: "VOO", priceCents: int64(40_000n), source: "b", fetchedAt: "now", status: "live" },
      { symbol: "IBIT", priceCents: null, source: "b", fetchedAt: null, status: "unavailable" },
    ], "invalid-response"],
    ["contradictory unavailable price", [
      { symbol: "BTC", priceCents: int64(6_000_000n), source: "a", fetchedAt: "now", status: "live" },
      { symbol: "VOO", priceCents: int64(40_000n), source: "b", fetchedAt: "now", status: "live" },
      { symbol: "IBIT", priceCents: int64(3_000n), source: "b", fetchedAt: null, status: "unavailable" },
    ], "invalid-response"],
  ])("rejects a %s quote snapshot", async (_label, wireQuotes, code) => {
    const repository = createConvexRowRepository({
      configuration: () => ({ generation: 1, settings }),
      post: async () => success({ complete: true, quotes: wireQuotes }),
    })
    await expect(repository.query({ kind: "marketQuotes" })).resolves.toEqual({
      status: "error",
      code,
    })
  })
})

describe("renderer finance read model", () => {
  it("maps nullable metadata and derives net worth once with scoped accounts", async () => {
    const document: VogelVaultFinanceDocument = {
      lastUpdated: "2026-07-30",
      retirementTotalCents: 99_999_999n,
      accounts: [ipcAccount("victor"), ipcAccount("mason")],
      updatedAtMs: 123,
    }
    const query = async (request: VogelVaultRowRequest): Promise<VogelVaultRowResult> =>
      request.kind === "finance"
        ? { status: "ok", kind: "finance", value: document }
        : request.kind === "marketQuotes"
          ? { status: "ok", kind: "marketQuotes", value: quotes }
          : { status: "error", code: "invalid-request" }

    const model = await loadLinuxFinanceReadModel(query, "victor")
    expect(model.finance.status).toBe("live")
    expect(model.marketQuotes.status).toBe("live")

    const netWorth = selectFinanceNetWorth({
      viewer: "victor",
      bitcoinSats: 100_000_000n,
      model,
    })
    expect(netWorth.accounts.map((account) => account.account.key)).toEqual(["victor_401k"])
    expect(netWorth.retirementValueCents).toBe(100_000n)
    expect(netWorth.bitcoinValueCents).toBe(6_000_000n)
    expect(netWorth.totalValueCents).toBe(6_100_000n)
    expect(netWorth.accounts[0]?.holdings[0]).toMatchObject({
      basis: "market-quote",
      valueCents: 100_000n,
      quote: { symbol: "VOO", status: "stale", source: "reviewed-equity-source" },
    })
  })

  it("keeps retirement live when quotes fail and reports conversions unavailable", async () => {
    const document: VogelVaultFinanceDocument = {
      lastUpdated: "2026-07-30",
      accounts: [ipcAccount("victor")],
      updatedAtMs: 123,
    }
    const model = await loadLinuxFinanceReadModel(
      async (request): Promise<VogelVaultRowResult> =>
        request.kind === "finance"
          ? { status: "ok", kind: "finance", value: document }
          : { status: "error", code: "unavailable" },
      "rachel",
    )
    expect(model.finance.status).toBe("live")
    expect(model.marketQuotes).toEqual({
      status: "error",
      value: null,
      code: "unavailable",
    })
    expect(selectFinanceNetWorth({
      viewer: "rachel",
      bitcoinSats: 100_000_000n,
      model,
    })).toMatchObject({
      retirementValueCents: 90_000n,
      bitcoinValueCents: null,
      totalValueCents: null,
    })
  })

  it("maps omitted finance optionals to explicit domain nulls", () => {
    const adapted = adaptFinanceDocument({
      lastUpdated: "2026-07-30",
      accounts: [{
        ...ipcAccount("victor"),
        weeklyContributionDay: undefined,
        holdings: [{
          ...ipcAccount("victor").holdings[0]!,
          ticker: undefined,
          proxyNote: undefined,
          lots: [{
            date: "2026-07-01",
            type: "contribution",
            pricePerShareCents: 1n,
            sharesDecimal: "1",
            amountInvestedCents: 1n,
          }],
        }],
      }],
      updatedAtMs: 123,
    })
    expect(adapted.retirementTotalCents).toBeNull()
    expect(adapted.accounts[0]?.weeklyContributionDay).toBeNull()
    expect(adapted.accounts[0]?.holdings[0]?.ticker).toBeNull()
    expect(adapted.accounts[0]?.holdings[0]?.proxyNote).toBeNull()
    expect(adapted.accounts[0]?.holdings[0]?.lots[0]?.note).toBeNull()
  })
})
