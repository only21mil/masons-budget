// @vitest-environment happy-dom

import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { VogelVaultRowRequest, VogelVaultRowResult } from "../shared/ipc.ts"
import { AppStateProvider, useAppState } from "../src/renderer/app/AppState.tsx"
import { FreshnessTag } from "../src/renderer/components/StateBlock.tsx"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function ReadStateProbe() {
  const { data, dataOrigin } = useAppState()
  return createElement(
    "output",
    null,
    [
      dataOrigin,
      data.transactions.status,
      data.transactions.source,
      data.checkedAt ?? "never",
      `todos:${data.todos.value.length}`,
      `btc:${data.btcAccounts.value.length}`,
    ].join("|"),
  )
}

function installReadBridge(
  queryConvexRows: (request: VogelVaultRowRequest) => Promise<VogelVaultRowResult>,
) {
  Object.defineProperty(window, "vogelVault", {
    configurable: true,
    value: {
      setReadProfile: async (profile: "victor" | "rachel" | "mason" | "maddox") => ({
        status: "active" as const,
        profile,
      }),
      queryConvexRows,
    } as unknown as NonNullable<typeof window.vogelVault>,
  })
}

afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(window, "vogelVault")
  document.body.replaceChildren()
})

describe("Linux read state and freshness copy", () => {
  it("shows loading until an unconfigured remote attempt settles, then uses demo fallback", async () => {
    const pending: Array<(result: VogelVaultRowResult) => void> = []
    installReadBridge(() => new Promise((resolve) => pending.push(resolve)))
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(createElement(AppStateProvider, {
          mutationAdapter: null,
          children: createElement(ReadStateProbe),
        }))
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(container.textContent).toMatch(
        /^fixture\|loading\|Demo fixtures · transactions\|never\|todos:0\|btc:0$/,
      )
      expect(container.textContent).not.toContain("fixture|demo")
      expect(pending).toHaveLength(3)

      await act(async () => {
        for (const resolve of pending) resolve({ status: "error", code: "disabled" })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(container.textContent).toContain("fixture|demo|Demo fixtures")
      expect(container.textContent).not.toContain("todos:0|btc:0")
    } finally {
      await act(async () => root.unmount())
    }
  })

  it("records the completed check separately from row mutation time", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2030-01-02T03:04:05.000Z"))
    installReadBridge(async (request) => {
      if (request.kind === "rowCounts") {
        return {
          status: "ok",
          kind: "rowCounts",
          value: {
            transactions: 0,
            todos: 0,
            btcBuys: 0,
            btcBillPays: 0,
            btcTransfers: 0,
            btcAccounts: 0,
            income: 0,
            balanceDocuments: 0,
            budgetDocuments: 0,
            btcBalanceDocuments: 0,
            financeDocuments: 0,
          },
        }
      }
      if (request.kind === "finance") {
        return { status: "ok", kind: "finance", value: null }
      }
      if (request.kind === "marketQuotes") {
        return {
          status: "ok",
          kind: "marketQuotes",
          value: {
            quotes: [
              { symbol: "BTC", priceCents: 10_000_000n, source: "test", fetchedAt: "2030-01-02T03:00:00Z", status: "live" },
              { symbol: "VOO", priceCents: null, source: "test", fetchedAt: null, status: "unavailable" },
              { symbol: "IBIT", priceCents: null, source: "test", fetchedAt: null, status: "unavailable" },
            ],
          },
        }
      }
      return { status: "error", code: "invalid-request" }
    })
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(createElement(AppStateProvider, {
          mutationAdapter: null,
          children: createElement(ReadStateProbe),
        }))
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(container.textContent).toBe(
        `remote|empty|Convex row tables · transactions|${Date.now()}|todos:0|btc:0`,
      )
    } finally {
      await act(async () => root.unmount())
    }
  })

  it("labels check time and row change time without calling row age sync age", () => {
    vi.useFakeTimers()
    const now = Date.parse("2030-01-10T12:00:00Z")
    vi.setSystemTime(now)
    const markup = renderToStaticMarkup(
      <FreshnessTag
        status="live"
        checkedAt={now - 2 * 60_000}
        updatedAt={now - 2 * 24 * 60 * 60_000}
      />,
    )

    expect(markup).toContain("Last checked 2m ago")
    expect(markup).toContain("Rows changed 2d ago")
    expect(markup).not.toContain("Synced")
  })
})
