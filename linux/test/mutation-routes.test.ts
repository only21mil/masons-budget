import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { AppStateProvider } from "../src/renderer/app/AppState.tsx"
import { buildSanitizedFixtureEnvelope } from "../src/renderer/data/fixtures.ts"
import type {
  RendererMutationAdapter,
  RendererMutationKind,
} from "../src/renderer/data/mutations.ts"
import { ALL_PAGES } from "../src/renderer/pages/index.ts"

const capabilities: readonly RendererMutationKind[] = [
  "transaction.upsert",
  "transaction.delete",
  "todo.upsert",
  "todo.delete",
  "budgetCategory.upsert",
  "budgetCategory.delete",
  "btcBuy.upsert",
  "btcBuy.delete",
  "btcBillPay.upsert",
  "btcBillPay.delete",
  "btcAccount.upsert",
  "btcAccount.delete",
]

const adapter: RendererMutationAdapter = {
  getPairingStatus: async () => ({ status: "paired", pairedAt: 1, capabilities }),
  pairDevice: async () => ({ status: "paired", pairedAt: 1, capabilities }),
  mutateConvexRow: async (request) => ({
    status: "ok",
    requestId: request.requestId,
    kind: request.kind,
    outcome: request.kind.endsWith(".delete") ? "deleted" : "updated",
    entityId: "id" in request ? request.id : "key" in request ? request.key : request.name,
  }),
  unpairDevice: async () => ({ status: "ok", revoked: true }),
}

function liveEnvelope() {
  const data = buildSanitizedFixtureEnvelope("victor")
  return {
    ...data,
    transactions: { ...data.transactions, status: "live" as const },
    budget: { ...data.budget, status: "live" as const },
    btcAccounts: { ...data.btcAccounts, status: "live" as const },
    btcBuys: { ...data.btcBuys, status: "live" as const },
    billPays: { ...data.billPays, status: "live" as const },
    todos: { ...data.todos, status: "live" as const },
  }
}

function renderRoute(route: string): string {
  const page = ALL_PAGES.find((candidate) => candidate.id === route)!
  return renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: "victor",
      initialRoute: route,
      initialData: liveEnvelope(),
      initialDataOrigin: "remote",
      initialMutationCapabilities: capabilities,
      mutationAdapter: adapter,
      children: createElement(page.Component),
    }),
  )
}

describe("renderer CRUD routes", () => {
  it.each([
    ["activity", "Add transaction"],
    ["budget", "Add category"],
    ["bitcoin-buys", "Add buy"],
    ["bills", "Add bill payment"],
    ["bitcoin", "Add synced account"],
    ["today", "Add task"],
    ["inbox", "Add task"],
    ["upcoming", "Add task"],
    ["flagged", "Add task"],
    ["projects", "Add task"],
  ])("%s exposes its accessible add flow", (route, label) => {
    const markup = renderRoute(route)
    expect(markup).toContain(label)
    expect(markup).toContain("<dialog")
  })

  it("provides named task completion, flag, edit, and delete controls", () => {
    const markup = renderRoute("projects")
    expect(markup).toContain("Complete Reconcile July statements")
    expect(markup).toContain("Unflag Reconcile July statements")
    expect(markup).toContain("Edit Reconcile July statements")
    expect(markup).toContain("Delete Reconcile July statements")
  })

  it("keeps BTC account fiat valuation out of the editable form", () => {
    const markup = renderRoute("bitcoin")
    expect(markup).toContain("USD valuation requires independent provenance")
    expect(markup).not.toContain(">Fiat value<")
    expect(markup).not.toContain(">USD valuation<")
  })

  it("names dialogs and mutation controls without relying on color or row clicks", () => {
    const markup = renderRoute("activity")
    expect(markup).toMatch(/<dialog[^>]*aria-labelledby="[^"]+"[^>]*aria-describedby="[^"]+"/)
    expect(markup).toContain('aria-label="Edit Neighborhood Market"')
    expect(markup).toContain('aria-label="Delete Neighborhood Market"')
    expect(markup).toContain("Stable and immutable after creation.")
    expect(markup).toMatch(/aria-describedby="[^"]+-message"/)
  })

  it("keeps derived-only routes free of create and delete controls", () => {
    for (const route of ["dashboard", "retirement", "net-worth"]) {
      const markup = renderRoute(route)
      expect(markup).not.toMatch(/Add (transaction|category|buy|bill payment|synced account|task)/)
      expect(markup).not.toContain(">Delete<")
    }
  })

  it("renders write controls disabled for fixture origin", () => {
    const page = ALL_PAGES.find((candidate) => candidate.id === "activity")!
    const markup = renderToStaticMarkup(
      createElement(AppStateProvider, {
        initialData: liveEnvelope(),
        initialDataOrigin: "fixture",
        initialMutationCapabilities: capabilities,
        mutationAdapter: adapter,
        children: createElement(page.Component),
      }),
    )
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Add transaction<\/button>/)
  })

  it("renders bounded, credential-free pairing controls in Settings", () => {
    const page = ALL_PAGES.find((candidate) => candidate.id === "settings")!
    const unpaired = renderToStaticMarkup(
      createElement(AppStateProvider, {
        initialPairingStatus: { status: "unpaired" },
        mutationAdapter: adapter,
        children: createElement(page.Component),
      }),
    )
    expect(unpaired).toContain("Pairing input")
    expect(unpaired).toContain('maxLength="2048"')
    expect(unpaired).toContain('maxLength="80"')
    expect(unpaired).not.toMatch(/device id|credential value|backend response/i)

    const paired = renderToStaticMarkup(
      createElement(AppStateProvider, {
        initialPairingStatus: { status: "paired", pairedAt: 1, capabilities },
        initialMutationCapabilities: capabilities,
        mutationAdapter: adapter,
        children: createElement(page.Component),
      }),
    )
    expect(paired).toContain("Enabled write capabilities")
    expect(paired).toContain("Unpair device")
    expect(paired).not.toMatch(/device id|credential value/i)
  })
})
