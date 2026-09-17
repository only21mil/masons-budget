// Headless render matrix.
//
// Renders every page, for every profile, in every slice state. This is stronger
// than opening the window and clicking around: it proves all routes mount
// without throwing, that each renders its five states, and — critically — that
// no page leaks a record the active profile is not allowed to see.

import assert from "node:assert/strict"
import { test } from "vitest"

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { FAMILY_MEMBERS, type FamilyMember, isAdult } from "@vogel-vault/domain/family"
import type { Freshness } from "@vogel-vault/domain/readModel"

import { AppStateProvider, useAppState } from "../src/renderer/app/AppState.tsx"
import type { DisplayUnit } from "../src/renderer/data/bitcoinDisplay.ts"
import {
  ALL_PAGES,
  PRIMARY_NAV_IDS,
  canonicalRoute,
  navSectionsFor,
  resolvePage,
} from "../src/renderer/pages/index.ts"
import { TaskClockProvider } from "../src/renderer/pages/tasks/taskClock.tsx"
import type { PageDefinition } from "../src/renderer/pages/types.ts"

type PageState = Freshness | "normal"

const STATES: PageState[] = ["normal", "stale", "error", "empty", "loading"]
const FIXTURE_MONTH = "2026-07"
const fixtureNow = () => new Date(2026, 6, 26, 12, 0, 0)

function Harness({ route }: { route: string }) {
  const { activeProfile } = useAppState()
  const page = resolvePage(route, activeProfile)
  if (!page) return null
  return createElement(page.Component)
}

function renderPage(
  page: PageDefinition,
  profile: FamilyMember,
  state: PageState,
  displayUnit: DisplayUnit = "btc",
  routeId = page.id,
): string {
  return renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: profile,
      initialRoute: routeId,
      initialStateOverride: state,
      initialCurrentMonth: FIXTURE_MONTH,
      initialDisplayUnit: displayUnit,
      children: createElement(
        TaskClockProvider,
        { now: fixtureNow },
        createElement(Harness, { route: routeId }),
      ),
    }),
  )
}

test("the cockpit has 14 registered pages and five primary tabs", () => {
  assert.equal(PRIMARY_NAV_IDS.length, 5)
  assert.equal(ALL_PAGES.length, 14, ALL_PAGES.map((page) => page.id).join(", "))
})

test("adults see exactly five primary tabs in order", () => {
  const navIds = navSectionsFor("victor").flatMap((section) => section.items.map((item) => item.id))
  assert.deepEqual(navIds, [...PRIMARY_NAV_IDS])
})

test("retirement and net worth deep links land on Bitcoin with the right segment", () => {
  assert.ok(!ALL_PAGES.some((page) => page.id === "retirement"))
  assert.ok(!ALL_PAGES.some((page) => page.id === "net-worth"))

  for (const member of FAMILY_MEMBERS) {
    const navIds = navSectionsFor(member).flatMap((section) =>
      section.items.map((item) => item.id))
    assert.ok(!navIds.includes("retirement"), `retirement still in the nav for ${member}`)
    assert.ok(!navIds.includes("net-worth"), `net-worth still in the nav for ${member}`)

    assert.equal(canonicalRoute("retirement"), "bitcoin")
    assert.equal(canonicalRoute("net-worth"), "bitcoin")
    assert.equal(resolvePage("retirement", member)?.id, "bitcoin")
    assert.equal(resolvePage("net-worth", member)?.id, "bitcoin")
  }
})

test("dashboard and today aliases land on home and tasks", () => {
  assert.equal(canonicalRoute("dashboard"), "home")
  assert.equal(canonicalRoute("today"), "tasks")
  assert.equal(resolvePage("dashboard", "victor")?.id, "home")
  assert.equal(resolvePage("today", "victor")?.id, "tasks")
})

test("route ids are unique", () => {
  const ids = ALL_PAGES.map((page) => page.id)
  assert.equal(new Set(ids).size, ids.length)
})

test("gear-menu routes resolve but do not appear in the primary nav", () => {
  const navIds = navSectionsFor("victor").flatMap((section) => section.items.map((item) => item.id))
  for (const route of ["family", "settings", "export"] as const) {
    assert.ok(resolvePage(route, "victor"), `${route} should still resolve`)
    assert.ok(!navIds.includes(route), `${route} should not appear in primary nav`)
  }
})

test("the unit selector appears only on opted-in non-Budget financial pages", () => {
  const optedIn = new Set([
    "home",
    "activity",
    "bitcoin",
    "bitcoin-buys",
    "bills",
  ])
  for (const page of ALL_PAGES) {
    const markup = renderPage(page, "victor", "normal")
    assert.equal(
      markup.includes('aria-label="Bitcoin display unit"'),
      optedIn.has(page.id),
      `${page.id} has the wrong unit-selector visibility`,
    )
  }
})

test("net-worth segment renders the unit selector through the Bitcoin hub", () => {
  const bitcoin = ALL_PAGES.find((page) => page.id === "bitcoin")
  assert.ok(bitcoin)
  const markup = renderPage(bitcoin, "victor", "normal", "btc", "net-worth")
  assert.ok(markup.includes('aria-label="Bitcoin display unit"'))
  assert.ok(markup.includes("Net Worth"))
})

test("children get a reduced nav and cannot resolve adult-only routes", () => {
  const adultOnly = ALL_PAGES.filter((page) => page.adultOnly)
  assert.ok(adultOnly.length > 0, "expected at least one adult-only page")

  for (const child of ["mason", "maddox"] as const) {
    const navIds = navSectionsFor(child).flatMap((section) => section.items.map((item) => item.id))
    for (const page of adultOnly) {
      assert.ok(!navIds.includes(page.id), `${page.id} should be hidden from ${child}`)
      assert.equal(resolvePage(page.id, child), null, `${page.id} should not resolve for ${child}`)
    }
  }
})

test("every page renders for every profile in every state", () => {
  let rendered = 0
  for (const page of ALL_PAGES) {
    for (const profile of FAMILY_MEMBERS) {
      if (!resolvePage(page.id, profile)) continue
      for (const state of STATES) {
        const markup = renderPage(page, profile, state)
        assert.ok(markup.length > 0, `${page.id} rendered empty for ${profile} in state ${state}`)
        rendered += 1
      }
    }
  }
  assert.ok(rendered >= 220, `expected a full matrix, rendered ${rendered}`)
})

const STATIC_PAGES = new Set([
  "family",
  "settings",
  "export",
  "onboarding",
  "lock",
])

test("data-backed pages surface an explicit marker for every non-normal state", () => {
  const markers: Record<string, string[]> = {
    loading: ["Loading", "vv-loading", "aria-busy"],
    error: ["Could not load", "vv-state--error", "Read failed"],
    empty: ["vv-state--empty", "No rows", "Nothing", "not wired"],
    stale: ["stale", "Stale"],
  }

  let checked = 0
  for (const page of ALL_PAGES) {
    if (STATIC_PAGES.has(page.id)) continue
    for (const [state, needles] of Object.entries(markers)) {
      const markup = renderPage(page, "victor", state as Freshness)
      assert.ok(
        needles.some((needle) => markup.includes(needle)),
        `${page.id} in state ${state} showed no marker for that state`,
      )
      checked += 1
    }
  }
  assert.equal(checked, (ALL_PAGES.length - STATIC_PAGES.size) * 4)
})

test("loading tasks and Bitcoin surfaces contain no demo counts or rows", () => {
  const tasks = ALL_PAGES.find((page) => page.id === "tasks")
  const bitcoin = ALL_PAGES.find((page) => page.id === "bitcoin")
  assert.ok(tasks)
  assert.ok(bitcoin)

  const tasksMarkup = renderPage(tasks, "victor", "loading")
  assert.match(tasksMarkup, /Loading tasks/)
  assert.match(tasksMarkup, /aria-busy="true"/)
  assert.doesNotMatch(tasksMarkup, /Reconcile July statements|Schedule annual checkup/)

  const bitcoinMarkup = renderPage(bitcoin, "victor", "loading")
  assert.match(bitcoinMarkup, /Loading/)
  assert.doesNotMatch(bitcoinMarkup, /account\(s\) visible but outside/)
  assert.doesNotMatch(bitcoinMarkup, /Cold Storage|Mason Stack/)
})

test("every page in STATIC_PAGES actually exists", () => {
  for (const id of STATIC_PAGES) {
    assert.ok(
      ALL_PAGES.some((page) => page.id === id),
      `STATIC_PAGES lists "${id}", which is not a real route`,
    )
  }
})

test("system pages describe current Convex row reads instead of retired file routing", () => {
  const syncHealth = ALL_PAGES.find((page) => page.id === "sync-health")
  const onboarding = ALL_PAGES.find((page) => page.id === "onboarding")
  assert.ok(syncHealth)
  assert.ok(onboarding)

  const syncMarkup = renderPage(syncHealth, "victor", "normal")
  assert.ok(syncMarkup.includes("Convex row tables"))
  assert.ok(!syncMarkup.includes("Legacy blob compatibility names"))

  const onboardingMarkup = renderPage(onboarding, "victor", "normal")
  assert.ok(onboardingMarkup.includes("Row access"))
  assert.ok(!onboardingMarkup.includes("Transactions file"))
})

const ADULT_ONLY_STRINGS = [
  "Neighborhood Market",
  "Payroll Deposit",
  "Electric Utility",
  "Cold Storage",
  "Lightning Wallet",
  "Reconcile July statements",
  "Schedule annual checkup",
]

test("no page leaks adult-owned records to a child profile", () => {
  for (const page of ALL_PAGES) {
    for (const child of ["mason", "maddox"] as const) {
      if (!resolvePage(page.id, child)) continue
      const markup = renderPage(page, child, "normal")
      for (const secret of ADULT_ONLY_STRINGS) {
        assert.ok(!markup.includes(secret), `${page.id} leaked "${secret}" to ${child}`)
      }
    }
  }
})

test("siblings cannot see each other's records", () => {
  for (const page of ALL_PAGES) {
    if (!resolvePage(page.id, "mason")) continue
    const masonMarkup = renderPage(page, "mason", "normal")
    for (const maddoxOnly of ["Maddox Stack", "App Store", "Ice Cream", "Practice piano"]) {
      assert.ok(!masonMarkup.includes(maddoxOnly), `${page.id} leaked "${maddoxOnly}" to mason`)
    }
  }
})

test("Rachel sees the same household financial records as Victor", () => {
  for (const pageId of ["activity", "home"]) {
    const page = ALL_PAGES.find((candidate) => candidate.id === pageId)
    assert.ok(page, `${pageId} not found`)
    const victorMarkup = renderPage(page, "victor", "normal")
    const rachelMarkup = renderPage(page, "rachel", "normal")

    let comparedRecords = 0
    for (const shared of ["Neighborhood Market", "Payroll Deposit"]) {
      if (victorMarkup.includes(shared)) {
        comparedRecords += 1
        assert.ok(
          rachelMarkup.includes(shared),
          `${pageId}: Rachel cannot see "${shared}" but Victor can`,
        )
      }
    }
    assert.ok(comparedRecords > 0, `${pageId}: Victor rendered no household record to compare`)
  }
})

test("adult todos remain private to the active profile", () => {
  const tasks = ALL_PAGES.find((page) => page.id === "tasks")
  assert.ok(tasks)
  const victorMarkup = renderPage(tasks, "victor", "normal", "btc", "projects")
  const rachelMarkup = renderPage(tasks, "rachel", "normal", "btc", "projects")

  assert.ok(victorMarkup.includes("Reconcile July statements"))
  assert.ok(!rachelMarkup.includes("Reconcile July statements"))
  assert.ok(rachelMarkup.includes("Plan birthday weekend"))
  assert.ok(!victorMarkup.includes("Plan birthday weekend"))
})

test("a child's stack never appears in an adult net-worth total", () => {
  const bitcoin = ALL_PAGES.find((page) => page.id === "bitcoin")
  assert.ok(bitcoin)
  const markup = renderPage(bitcoin, "victor", "normal", "btc", "net-worth")

  const splitAt = markup.indexOf("Visible but excluded")
  assert.ok(splitAt > 0, "expected an excluded-accounts section")
  assert.ok(
    !markup.slice(0, splitAt).includes("Mason Stack"),
    "Mason's stack leaked into adult net worth",
  )
  assert.ok(markup.includes("Mason Stack"), "Mason's stack should still be visible to an adult")
})

test("required empty financial sources render unavailable instead of confident zeroes", () => {
  for (const pageId of ["home", "bitcoin"] as const) {
    const page = ALL_PAGES.find((candidate) => candidate.id === pageId)
    assert.ok(page, `${pageId} not found`)
    const markup = renderPage(page, "victor", "empty")

    assert.ok(
      !markup.includes("$0.00"),
      `${pageId} rendered $0.00 from an empty required financial source`,
    )
    assert.ok(
      !markup.includes("0.00000000 BTC"),
      `${pageId} rendered 0.00000000 BTC from an empty required financial source`,
    )
  }

  const bitcoin = ALL_PAGES.find((candidate) => candidate.id === "bitcoin")
  assert.ok(bitcoin)
  const netWorthMarkup = renderPage(bitcoin, "victor", "empty", "btc", "net-worth")
  assert.ok(!netWorthMarkup.includes("$0.00"))
})

test("home and net-worth segment use canonical income and BTC document totals", () => {
  const home = ALL_PAGES.find((candidate) => candidate.id === "home")
  const bitcoin = ALL_PAGES.find((candidate) => candidate.id === "bitcoin")
  assert.ok(home)
  assert.ok(bitcoin)

  const homeMarkup = renderPage(home, "victor", "normal", "usd")
  assert.ok(homeMarkup.includes("$7,777.77"))
  assert.ok(renderPage(home, "victor", "normal", "btc").includes("1.23456789 BTC"))

  const netWorthMarkup = renderPage(bitcoin, "victor", "normal", "usd", "net-worth")
  assert.ok(netWorthMarkup.includes("$120,000.00"))
  assert.ok(renderPage(bitcoin, "victor", "normal", "btc", "net-worth").includes("1.23456789 BTC"))
})

test("adults and children get different budget surfaces", () => {
  const budget = ALL_PAGES.find((page) => page.id === "budget")
  assert.ok(budget)
  for (const member of FAMILY_MEMBERS) {
    const markup = renderPage(budget, member, "normal")
    if (isAdult(member)) {
      assert.ok(markup.includes("Groceries"), `${member} should see the household budget`)
    } else {
      assert.ok(!markup.includes("Groceries"), `${member} should not see household categories`)
    }
  }
})
