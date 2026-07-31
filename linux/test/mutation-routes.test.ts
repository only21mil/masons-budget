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
import { TaskClockProvider } from "../src/renderer/pages/tasks/taskClock.tsx"

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
  getPairingStatus: async () => ({
    status: "paired",
    pairedAt: 1,
    capabilities,
    writesEnabled: true,
  }),
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

const fixtureNow = () => new Date(2026, 6, 26, 12, 0, 0)

function liveEnvelope(profile: "victor" | "rachel" | "mason" | "maddox" = "victor") {
  const data = buildSanitizedFixtureEnvelope(profile)
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

function renderRoute(
  route: string,
  profile: "victor" | "rachel" | "mason" | "maddox" = "victor",
): string {
  const page = ALL_PAGES.find((candidate) => candidate.id === route)!
  return renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: profile,
      initialRoute: route,
      initialData: liveEnvelope(profile),
      initialDataOrigin: "remote",
      initialMutationCapabilities: capabilities,
      mutationAdapter: adapter,
      children: createElement(
        TaskClockProvider,
        { now: fixtureNow },
        createElement(page.Component),
      ),
    }),
  )
}

describe("renderer CRUD routes", () => {
  it.each([
    ["activity", "Add transaction"],
    ["budget", "Add category"],
    ["bitcoin-buys", "Add buy"],
    ["bills", "Add bill payment"],
    ["bitcoin", "Add BTC account"],
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

  it.each(["today", "inbox", "upcoming", "flagged", "projects"])(
    "%s keeps explicit task edit and delete controls in a sticky action column",
    (route) => {
      const markup = renderRoute(route)
      expect(markup).toContain("Task actions")
      expect(markup).toContain("vv-task-table")
      expect(markup).toMatch(/aria-label="Edit [^"]+"/)
      expect(markup).toMatch(/aria-label="Delete [^"]+"/)
    },
  )

  it("keeps BTC account fiat valuation out of the editable form", () => {
    const markup = renderRoute("bitcoin")
    expect(markup).toContain("USD valuation requires independent provenance")
    expect(markup).not.toContain(">Fiat value<")
    expect(markup).not.toContain(">USD valuation<")
    expect(markup).toContain('aria-label="Edit Canonical Cold Storage"')
    expect(markup).not.toContain('aria-label="Edit Cold Storage"')
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
      expect(markup).not.toMatch(/Add (transaction|category|buy|bill payment|BTC account|task)/)
      expect(markup).not.toContain(">Delete<")
    }
  })

  it("disables unsupported child financial sources before they reach IPC", () => {
    const masonBills = renderRoute("bills", "mason")
    expect(masonBills).toMatch(
      /<button[^>]*disabled[^>]*title="This profile has no supported durable source for that operation\."[^>]*>Add bill payment<\/button>/,
    )

    const maddoxBuys = renderRoute("bitcoin-buys", "maddox")
    expect(maddoxBuys).toMatch(
      /<button[^>]*disabled[^>]*title="This profile has no supported durable source for that operation\."[^>]*>Add buy<\/button>/,
    )

    const masonBuys = renderRoute("bitcoin-buys", "mason")
    expect(masonBuys).not.toMatch(/<button[^>]*disabled[^>]*>Add buy<\/button>/)
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

  it("visibly explains why task edit and delete actions are disabled", () => {
    const page = ALL_PAGES.find((candidate) => candidate.id === "projects")!
    const markup = renderToStaticMarkup(
      createElement(AppStateProvider, {
        initialData: liveEnvelope(),
        initialDataOrigin: "fixture",
        initialMutationCapabilities: capabilities,
        mutationAdapter: adapter,
        children: createElement(
          TaskClockProvider,
          { now: fixtureNow },
          createElement(page.Component),
        ),
      }),
    )
    expect(markup).toContain("Task actions are limited")
    expect(markup).toContain(
      "Editing and deleting tasks are unavailable: Sample and fallback data cannot be edited.",
    )
    expect(markup).toMatch(
      /<button[^>]*disabled[^>]*title="Sample and fallback data cannot be edited\."[^>]*aria-label="Edit [^"]+"/,
    )
    expect(markup).toMatch(
      /<button[^>]*disabled[^>]*title="Sample and fallback data cannot be edited\."[^>]*aria-label="Delete [^"]+"/,
    )
  })

  it("renders bounded, credential-free pairing controls in Settings", () => {
    const page = ALL_PAGES.find((candidate) => candidate.id === "settings")!
    const unpaired = renderToStaticMarkup(
      createElement(AppStateProvider, {
        initialPairingStatus: { status: "unpaired", writesEnabled: true },
        mutationAdapter: adapter,
        children: createElement(page.Component),
      }),
    )
    expect(unpaired).toContain("One-time pairing code")
    expect(unpaired).toContain('type="password"')
    expect(unpaired).toContain("Copy only the pairingCode secret")
    expect(unpaired).toContain("stored by the server as this device")
    expect(unpaired).toContain('maxLength="2048"')
    expect(unpaired).toContain('maxLength="80"')
    expect(unpaired).not.toMatch(/device id|credential value|backend response/i)

    const pairingDisabled = renderToStaticMarkup(
      createElement(AppStateProvider, {
        initialPairingStatus: { status: "unpaired", writesEnabled: false },
        mutationAdapter: adapter,
        children: createElement(page.Component),
      }),
    )
    expect(pairingDisabled).toContain("Paired-device writes are disabled")
    expect(pairingDisabled).toMatch(
      /<button[^>]*disabled[^>]*>Pair device<\/button>/,
    )

    const paired = renderToStaticMarkup(
      createElement(AppStateProvider, {
        initialPairingStatus: {
          status: "paired",
          pairedAt: 1,
          capabilities,
          writesEnabled: true,
        },
        initialMutationCapabilities: capabilities,
        mutationAdapter: adapter,
        children: createElement(page.Component),
      }),
    )
    expect(paired).toContain("Enabled write capabilities")
    expect(paired).toContain("Unpair device")
    expect(paired).not.toMatch(/device id|credential value/i)

    const writesDisabled = renderToStaticMarkup(
      createElement(AppStateProvider, {
        initialPairingStatus: {
          status: "paired",
          pairedAt: 1,
          capabilities: [],
          writesEnabled: false,
        },
        mutationAdapter: adapter,
        children: createElement(page.Component),
      }),
    )
    expect(writesDisabled).toContain("Paired · writes disabled")
    expect(writesDisabled).toContain("No write capabilities granted.")
    expect(writesDisabled).toContain("Unpair device")
  })
})
