// Headless render matrix.
//
// Renders every page, for every profile, in every slice state. This is stronger
// than opening the window and clicking around: it proves all 20 routes mount
// without throwing, that each renders its five states, and — critically — that
// no page leaks a record the active profile is not allowed to see.
//
// Written with createElement rather than JSX because Node strips TypeScript
// types natively but does not transform JSX, and this suite is deliberately
// free of a build step so it runs anywhere, headless, in CI.

import assert from "node:assert/strict"
import { test } from "vitest"

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { FAMILY_MEMBERS, type FamilyMember, isAdult } from "@vogel-vault/domain/family"
import type { Freshness } from "@vogel-vault/domain/readModel"

import { AppStateProvider, useAppState } from "../src/renderer/app/AppState.tsx"
import { ALL_PAGES, navSectionsFor, resolvePage } from "../src/renderer/pages/index.ts"
import type { PageDefinition } from "../src/renderer/pages/types.ts"

type PageState = Freshness | "normal"

const STATES: PageState[] = ["normal", "stale", "error", "empty", "loading"]

/**
 * Renders whichever page the seeded state resolves to.
 *
 * The profile/route/state are seeded on the provider rather than pushed in from
 * a child: renderToStaticMarkup is a single synchronous pass, so a setState from
 * a child would never be applied and every page would silently render as the
 * default profile — which would make the leak assertions below vacuous.
 */
function Harness({ route }: { route: string }) {
  const { activeProfile } = useAppState()
  const page = resolvePage(route, activeProfile)
  if (!page) return null
  return createElement(page.Component)
}

function renderPage(page: PageDefinition, profile: FamilyMember, state: PageState): string {
  // children goes in the props object: createElement's variadic children
  // overload does not satisfy a props type that requires `children`.
  return renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: profile,
      initialRoute: page.id,
      initialStateOverride: state,
      children: createElement(Harness, { route: page.id }),
    }),
  )
}

// ── Structure ───────────────────────────────────────────────────────────────

test("the cockpit has exactly 20 primary pages", () => {
  assert.equal(ALL_PAGES.length, 20, ALL_PAGES.map((page) => page.id).join(", "))
})

test("route ids are unique", () => {
  const ids = ALL_PAGES.map((page) => page.id)
  assert.equal(new Set(ids).size, ids.length)
})

test("every page appears in the nav for an adult", () => {
  const navIds = navSectionsFor("victor").flatMap((section) => section.items.map((item) => item.id))
  for (const page of ALL_PAGES) {
    assert.ok(navIds.includes(page.id), `${page.id} missing from adult nav`)
  }
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

// ── Render matrix ───────────────────────────────────────────────────────────

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
  // 20 pages x 4 profiles x 5 states, minus adult-only pages for the 2 children.
  assert.ok(rendered >= 300, `expected a full matrix, rendered ${rendered}`)
})

/**
 * Pages that render no synced MC2 data, and so have no loading/stale/error
 * state to show. These are configuration and system surfaces derived from the
 * domain contract or the runtime bridge, not from the read model.
 */
const STATIC_PAGES = new Set([
  "family", // profile matrix, derived from the shared visibility contract
  "settings", // runtime info from the preload bridge plus the QA control
  "export", // a form; the export path itself is gated
  "csv-import", // a form; the import path is gated
  "onboarding", // static first-run copy
  "lock", // static
])

test("data-backed pages surface an explicit marker for every non-normal state", () => {
  const markers: Record<string, string[]> = {
    loading: ["Loading", "vv-loading", "aria-busy"],
    error: ["Could not load", "vv-state--error", "Read failed"],
    empty: ["vv-state--empty", "No data", "Nothing", "not wired"],
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

test("every page in STATIC_PAGES actually exists", () => {
  // Guards against a page being renamed and silently dropping out of the
  // state-marker check above.
  for (const id of STATIC_PAGES) {
    assert.ok(
      ALL_PAGES.some((page) => page.id === id),
      `STATIC_PAGES lists "${id}", which is not a real route`,
    )
  }
})

// ── Visibility leaks ────────────────────────────────────────────────────────

/**
 * Adult-owned fixture values that must never appear on a child's screen. If a
 * page forgets to filter, one of these shows up in the markup and this fails.
 */
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

test("Rachel sees the same household records as Victor", () => {
  // The v0.3 regression, checked at the rendered-page level rather than only in
  // the domain unit tests: adult records are tagged owner "victor", so a strict
  // equality filter anywhere in a page would empty Rachel's screen.
  for (const pageId of ["activity", "dashboard", "projects"]) {
    const page = ALL_PAGES.find((candidate) => candidate.id === pageId)
    assert.ok(page, `${pageId} not found`)
    const victorMarkup = renderPage(page, "victor", "normal")
    const rachelMarkup = renderPage(page, "rachel", "normal")

    let comparedRecords = 0
    for (const shared of ["Neighborhood Market", "Payroll Deposit", "Reconcile July statements"]) {
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

test("a child's stack never appears in an adult net-worth total", () => {
  const netWorth = ALL_PAGES.find((page) => page.id === "net-worth")
  assert.ok(netWorth)
  const markup = renderPage(netWorth, "victor", "normal")

  // Mason's stack is visible on the page — under "visible but excluded" — but
  // the in-scope table must not contain it.
  const splitAt = markup.indexOf("Visible but excluded")
  assert.ok(splitAt > 0, "expected an excluded-accounts section")
  assert.ok(
    !markup.slice(0, splitAt).includes("Mason Stack"),
    "Mason's stack leaked into adult net worth",
  )
  assert.ok(markup.includes("Mason Stack"), "Mason's stack should still be visible to an adult")
})

test("required empty financial sources render unavailable instead of confident zeroes", () => {
  for (const pageId of ["dashboard", "bitcoin", "net-worth"]) {
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
})

test("dashboard and net worth use canonical income and BTC document totals", () => {
  const dashboard = ALL_PAGES.find((candidate) => candidate.id === "dashboard")
  const netWorth = ALL_PAGES.find((candidate) => candidate.id === "net-worth")
  assert.ok(dashboard)
  assert.ok(netWorth)

  const dashboardMarkup = renderPage(dashboard, "victor", "normal")
  assert.ok(
    dashboardMarkup.includes("$7,777.77"),
    "dashboard did not render the dedicated income-table total",
  )
  assert.ok(
    dashboardMarkup.includes("1.23456789 BTC"),
    "dashboard did not render the canonical BTC balance document total",
  )

  const netWorthMarkup = renderPage(netWorth, "victor", "normal")
  assert.ok(
    netWorthMarkup.includes("$120,000.00"),
    "net worth did not render the canonical BTC balance document fiat total",
  )
  assert.ok(
    netWorthMarkup.includes("1.23456789 BTC"),
    "net worth did not render the canonical BTC balance document sats total",
  )
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
