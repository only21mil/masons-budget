import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { AppStateProvider } from "../src/renderer/app/AppState.tsx"
import { ALL_PAGES } from "../src/renderer/pages/index.ts"
import { TaskClockProvider } from "../src/renderer/pages/tasks/taskClock.tsx"
import {
  adapter,
  capabilities,
  fixtureNow,
  liveEnvelope,
  renderRoute,
} from "./support/renderRoute.ts"

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
    "%s keeps completion, edit, and delete controls in a sticky task-action column",
    (route) => {
      const markup = renderRoute(route)
      expect(markup).toContain("Task actions")
      expect(markup).toContain("vv-task-table")
      expect(markup).toMatch(/aria-label="(?:Complete|Reopen) [^"]+"/)
      expect(markup).toMatch(/aria-label="Edit [^"]+"/)
      expect(markup).toMatch(/aria-label="Delete [^"]+"/)
    },
  )

  it("keeps task controls inside the active profile visibility boundary", () => {
    const adultMarkup = renderRoute("projects", "victor")
    expect(adultMarkup).toContain("Reconcile July statements")
    expect(adultMarkup).toContain("Finish reading assignment")

    const masonMarkup = renderRoute("projects", "mason")
    expect(masonMarkup).toContain("Finish reading assignment")
    expect(masonMarkup).toContain("Tidy room")
    expect(masonMarkup).not.toContain("Reconcile July statements")
    expect(masonMarkup).not.toContain("Plan birthday weekend")
    expect(masonMarkup).not.toContain("Practice piano")
    expect(masonMarkup).toMatch(/aria-label="Complete Finish reading assignment"/)
    expect(masonMarkup).toMatch(/aria-label="Reopen Tidy room"/)
  })

  it("keeps BTC account fiat valuation out of the editable form", () => {
    const markup = renderRoute("bitcoin")
    expect(markup).toContain("USD valuation requires independent provenance")
    expect(markup).not.toContain(">Fiat value<")
    expect(markup).not.toContain(">USD valuation<")
    expect(markup).toContain('aria-label="Edit Canonical Cold Storage"')
    expect(markup).not.toContain('aria-label="Edit Cold Storage"')
  })

  it("shows posted Bitcoin transfers with a revision-fenced correction action", () => {
    const markup = renderRoute("bitcoin")
    expect(markup).toContain("Transfer history")
    expect(markup).toContain("Canonical Exchange → Canonical Cold Storage")
    expect(markup).toContain("Move to cold storage")
    expect(markup).toContain('aria-label="Delete canonical-exchange to canonical-cold transfer"')
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
    for (const route of ["dashboard", "net-worth"]) {
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

  it("accepts the first bill payment into a live but empty remote table", () => {
    const live = liveEnvelope()
    const empty = {
      ...live,
      billPays: { ...live.billPays, status: "empty" as const, value: [], updatedAt: null },
    }
    const markup = renderRoute("bills", "victor", empty)
    expect(markup).not.toMatch(/<button[^>]*disabled[^>]*>Add bill payment<\/button>/)
    expect(markup).not.toContain("Wait for current remote rows before editing.")
    expect(markup).not.toContain("Adding a bill payment is unavailable")
  })

  it("accepts a first row in every table that reports empty at zero remote rows", () => {
    const live = liveEnvelope()
    const empty = {
      ...live,
      billPays: { ...live.billPays, status: "empty" as const, value: [] },
      btcBuys: { ...live.btcBuys, status: "empty" as const, value: [] },
      todos: { ...live.todos, status: "empty" as const, value: [] },
      btcBalanceDocument: { ...live.btcBalanceDocument, status: "empty" as const, value: null },
    }
    for (const [route, label] of [
      ["bills", "Add bill payment"],
      ["bitcoin-buys", "Add buy"],
      ["bitcoin", "Add BTC account"],
      ["today", "Add task"],
    ] as const) {
      const markup = renderRoute(route, "victor", empty)
      expect(markup).toContain(label)
      expect(markup).not.toMatch(
        new RegExp(`<button[^>]*disabled[^>]*>${label}</button>`),
      )
    }
  })

  it("never gates a mutation on the BTC account mirror slice", () => {
    // btcAccount.* reads freshness from the canonical balance document, so an
    // empty account mirror alongside a live document must not disable the add.
    const live = liveEnvelope()
    const markup = renderRoute("bitcoin", "victor", {
      ...live,
      btcAccounts: { ...live.btcAccounts, status: "empty" as const, value: [] },
    })
    expect(markup).not.toMatch(/<button[^>]*disabled[^>]*>Add BTC account<\/button>/)
  })

  it("offers the bill-pay budget choice and shows each row's effect", () => {
    const markup = renderRoute("bills", "victor")
    expect(markup).toContain("Budget effect")
    expect(markup).toContain('value="budget_category"')
    expect(markup).toContain('value="credit_card_payment"')
    expect(markup).toContain("Budget category")
    expect(markup).toContain("Credit card payment")
  })

  it("visibly names the reason a blocked Add bill payment cannot be pressed", () => {
    const markup = renderRoute("bills", "mason")
    const bannerAt = markup.indexOf("Adding a bill payment is unavailable")
    expect(bannerAt).toBeGreaterThan(-1)
    expect(markup.slice(bannerAt - 200, bannerAt)).toContain("vv-banner")
    expect(markup.slice(bannerAt, bannerAt + 400)).toContain(
      "This profile has no supported durable source for that operation.",
    )
  })

  it("renders write controls disabled for fixture origin", () => {
    const page = ALL_PAGES.find((candidate) => candidate.id === "activity")!
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
