import assert from "node:assert/strict"
import { test } from "vitest"

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import type { MonthKey } from "@vogel-vault/domain/readModel"
import { budgetHealth } from "@vogel-vault/domain/finance"

import { AppStateProvider, useAppState } from "../src/renderer/app/AppState.tsx"
import {
  BudgetProgress,
} from "../src/renderer/components/BudgetProgress.tsx"
import { resolvePage } from "../src/renderer/pages/index.ts"

function BudgetPageHarness() {
  const { activeProfile } = useAppState()
  const page = resolvePage("budget", activeProfile)
  return page ? createElement(page.Component) : null
}

function renderBudgetMonth(month: MonthKey): string {
  return renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: "victor",
      initialRoute: "budget",
      initialSelectedMonth: month,
      children: createElement(BudgetPageHarness),
    }),
  )
}

test("budget progress presents the shared health contract without recalculating it", () => {
  for (const [spent, limit] of [
    [8_499n, 10_000n],
    [8_500n, 10_000n],
    [10_000n, 10_000n],
    [10_001n, 10_000n],
    [25_000n, 10_000n],
  ] as const) {
    const health = budgetHealth(limit, spent)
    const percentage = health.overPercent === null
      ? `${health.remainingPercent}% left`
      : `+${health.overPercent}% over`
    const markup = renderToStaticMarkup(
      createElement(BudgetProgress, { category: "Food", spent, limit }),
    )

    assert.ok(markup.includes(`vv-budget-progress--${health.status}`))
    assert.ok(markup.includes(`aria-valuenow="${health.barBasisPoints / 100}"`))
    assert.ok(markup.includes(`aria-valuetext="${health.label}, ${percentage}"`))
  }
})

test("non-positive limits retain safe accessible copy around the shared state", () => {
  for (const [spent, limit] of [[500n, 0n], [-500n, -100n]] as const) {
    const health = budgetHealth(limit, spent)
    const markup = renderToStaticMarkup(
      createElement(BudgetProgress, { category: "Food", spent, limit }),
    )

    assert.ok(markup.includes(`vv-budget-progress--${health.status}`))
    assert.ok(markup.includes("No positive limit"))
    assert.ok(markup.includes(`${health.label}, no positive limit`))
  }
})

test("budget progress exposes its status and percentage to assistive technology", () => {
  const markup = renderToStaticMarkup(
    createElement(BudgetProgress, {
      category: "Groceries",
      spent: 8_500n,
      limit: 10_000n,
    }),
  )

  assert.ok(markup.includes('role="progressbar"'))
  assert.ok(markup.includes('aria-label="Groceries budget use"'))
  assert.ok(markup.includes('aria-valuenow="85"'))
  assert.ok(markup.includes('aria-valuetext="CLOSE, 15% left"'))
  assert.ok(markup.includes("vv-budget-progress--close"))
})

test("the category progress follows the selected Budget month", () => {
  const july = renderBudgetMonth("2026-07")
  const june = renderBudgetMonth("2026-06")

  assert.match(
    july,
    /aria-label="Groceries budget use"[^>]+aria-valuetext="ON TRACK, 78% left"/,
  )
  assert.match(
    june,
    /aria-label="Groceries budget use"[^>]+aria-valuetext="ON TRACK, 56% left"/,
  )
})
