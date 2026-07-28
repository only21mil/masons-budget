// The Budget month picker.
//
// The Budget page used to be pinned to whatever month the legacy budget record said,
// which made June unreachable even though the transactions were sitting right
// there. These tests hold the fix: the picker offers the months that are
// actually present, selecting one re-derives the totals from that month, and
// the Dashboard headline moves with it so the two screens never disagree.
//
// createElement rather than JSX for the same reason as routes.test.ts: this
// suite runs with no transform step.

import assert from "node:assert/strict"
import { test } from "vitest"

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import type { FamilyMember } from "@vogel-vault/domain/family"
import type { MonthKey } from "@vogel-vault/domain/readModel"

import { AppStateProvider, useAppState } from "../src/renderer/app/AppState.tsx"
import { resolvePage } from "../src/renderer/pages/index.ts"

// The fixture envelope is generated from a frozen NOW (2026-07-26), so these
// months are stable and can be asserted on literally.
const JULY: MonthKey = "2026-07"
const JUNE: MonthKey = "2026-06"

function Harness({ route }: { route: string }) {
  const { activeProfile } = useAppState()
  const page = resolvePage(route, activeProfile)
  if (!page) return null
  return createElement(page.Component)
}

/**
 * Render one page with a month already selected.
 *
 * Seeded on the provider, not clicked: renderToStaticMarkup is one synchronous
 * pass, so a change event dispatched from a child would never be applied and
 * every assertion below would silently be testing the default month.
 */
function render(route: string, profile: FamilyMember, month: MonthKey | null): string {
  return renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: profile,
      initialRoute: route,
      initialSelectedMonth: month,
      children: createElement(Harness, { route }),
    }),
  )
}

// ── The picker itself ───────────────────────────────────────────────────────

test("the Budget page offers every month present in the visible transactions", () => {
  const markup = render("budget", "victor", null)

  assert.ok(markup.includes('aria-label="Budget month"'), "no month picker on the Budget page")
  for (const month of [JULY, JUNE]) {
    assert.ok(markup.includes(`value="${month}"`), `picker does not offer ${month}`)
  }
  assert.ok(markup.includes("June 2026"), "months should be labelled, not printed as yyyy-MM")
})

test("the picker defaults to the budget's own month", () => {
  const markup = render("budget", "victor", null)
  assert.ok(markup.includes("July 2026"), "expected the July budget to open on July")
})

test("a month the profile has no records in is ignored", () => {
  // The selection is app-wide, so it can outlive the data it was made against.
  // Reporting an empty May would look like a broken screen, not a filter.
  const markup = render("budget", "victor", "2026-05")
  assert.ok(markup.includes("July 2026"), "a month with no transactions should fall back")
  assert.ok(!markup.includes("May 2026"), "May was never a real option")
})

// ── Selecting June changes the totals ───────────────────────────────────────

test("selecting June re-derives the category spend from June transactions", () => {
  const july = render("budget", "victor", JULY)
  const june = render("budget", "victor", JUNE)

  // Groceries: July is 142.18 + 52.00, June is a single 388.90 row.
  assert.ok(july.includes("$194.18"), "July groceries missing")
  assert.ok(!july.includes("$388.90"), "July must not count a June transaction")
  assert.ok(june.includes("$388.90"), "June groceries missing")
  assert.ok(!june.includes("$194.18"), "June must not count July transactions")
})

test("selecting June changes the Budget totals strip", () => {
  const july = render("budget", "victor", JULY)
  const june = render("budget", "victor", JUNE)

  // Adult budget totals use adult household scope. Child rows remain visible on
  // Activity but do not roll into Victor/Rachel's actuals.
  assert.ok(july.includes("$673.46"), "July adult actual missing")
  assert.ok(june.includes("$741.05"), "June adult actual missing")

  // Planned is the budget file's, so it does not move; remaining must.
  assert.ok(july.includes("$1,996.54"), "July remaining missing")
  assert.ok(june.includes("$1,928.95"), "June remaining missing")
})

test("adult oversight keeps child rows visible without adding them to budget spend", () => {
  const budget = render("budget", "victor", JULY)
  const activity = render("activity", "victor", JULY)

  assert.ok(budget.includes("$673.46"), "adult July actual should exclude child spend")
  assert.ok(!budget.includes("$711.45"), "child spend rolled into the adult budget")
  assert.ok(activity.includes("Game Store"), "Mason's row should remain visible for adult oversight")
  assert.ok(activity.includes("App Store"), "Maddox's row should remain visible for adult oversight")
})

test("viewing a month other than the budget's own says where planned came from", () => {
  // The actuals are June's but the planned column is still July's file. Saying
  // so is the difference between a comparison and a wrong number.
  const june = render("budget", "victor", JUNE)
  assert.ok(june.includes("Planned amounts are from the July 2026 budget"), "no provenance notice")

  const july = render("budget", "victor", JULY)
  assert.ok(!july.includes("Planned amounts are from"), "notice should not show on the budget's own month")
})

// ── The Dashboard follows ───────────────────────────────────────────────────

test("the Dashboard headline moves with the Budget month", () => {
  const july = render("dashboard", "victor", JULY)
  const june = render("dashboard", "victor", JUNE)

  assert.ok(july.includes("July 2026"), "Dashboard should name the month it is reporting")
  assert.ok(june.includes("June 2026"), "Dashboard did not follow the selection")

  // Spend: the same adult-only 741.05 the Budget screen derives for June.
  assert.ok(june.includes("$741.05"), "Dashboard June spend disagrees with the Budget screen")
  assert.ok(!june.includes("$673.46"), "Dashboard is still totalling July")

  // Income: two July paycheques, one in June.
  assert.ok(july.includes("$7,777.77"), "July canonical income missing")
  assert.ok(june.includes("$3,333.33"), "June canonical income missing")
})

test("the Dashboard activity list is scoped to the selected month", () => {
  const june = render("dashboard", "victor", JUNE)
  assert.ok(june.includes("Book Fair"), "a June row should be listed")
  assert.ok(!june.includes("Hardware Store"), "a July row leaked into June")
})

// ── Children ────────────────────────────────────────────────────────────────

test("a child's picker offers only the months in that child's own records", () => {
  // Maddox has no June transactions, and he must not learn that June exists
  // from someone else's ledger.
  const maddox = render("dashboard", "maddox", JUNE)
  assert.ok(maddox.includes("July 2026"), "Maddox should fall back to July")
  assert.ok(!maddox.includes("June 2026"), "Maddox has no June records to report on")

  // Mason does have a June row, so June is a real month for him.
  const mason = render("budget", "mason", JUNE)
  assert.ok(mason.includes("June 2026"), "Mason's June should be reachable")
  assert.ok(!mason.includes("Neighborhood Market"), "adult June rows leaked to a child")
})
