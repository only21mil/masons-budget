import assert from "node:assert/strict"
import { test } from "vitest"

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import type { MonthKey } from "@vogel-vault/domain/readModel"

import { AppStateProvider, useAppState } from "../src/renderer/app/AppState.tsx"
import {
  BudgetProgress,
  budgetProgressState,
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

test("budget progress uses the exact iOS 85% and over-budget thresholds", () => {
  assert.deepEqual(budgetProgressState(8_499n, 10_000n), {
    tone: "positive",
    statusLabel: "ON TRACK",
    percentageLabel: "15% left",
    progressPercent: 84.99,
    hasPositiveLimit: true,
  })
  assert.deepEqual(budgetProgressState(8_500n, 10_000n), {
    tone: "warning",
    statusLabel: "CLOSE",
    percentageLabel: "15% left",
    progressPercent: 85,
    hasPositiveLimit: true,
  })
  assert.deepEqual(budgetProgressState(10_000n, 10_000n), {
    tone: "warning",
    statusLabel: "CLOSE",
    percentageLabel: "0% left",
    progressPercent: 100,
    hasPositiveLimit: true,
  })
  assert.deepEqual(budgetProgressState(10_001n, 10_000n), {
    tone: "negative",
    statusLabel: "OVER",
    percentageLabel: "+0% over",
    progressPercent: 100,
    hasPositiveLimit: true,
  })
})

test("budget progress matches iOS truncation and its 200% percentage cap", () => {
  assert.equal(budgetProgressState(19_999n, 10_000n).percentageLabel, "+99% over")
  assert.equal(budgetProgressState(20_000n, 10_000n).percentageLabel, "+100% over")
  assert.deepEqual(budgetProgressState(25_000n, 10_000n), {
    tone: "negative",
    statusLabel: "OVER",
    percentageLabel: "+100% over",
    progressPercent: 100,
    hasPositiveLimit: true,
  })
})

test("non-positive limits remain deterministic without a fake percentage", () => {
  assert.deepEqual(budgetProgressState(500n, 0n), {
    tone: "negative",
    statusLabel: "OVER",
    percentageLabel: "No positive limit",
    progressPercent: 0,
    hasPositiveLimit: false,
  })
  assert.deepEqual(budgetProgressState(-500n, -100n), {
    tone: "positive",
    statusLabel: "ON TRACK",
    percentageLabel: "No positive limit",
    progressPercent: 0,
    hasPositiveLimit: false,
  })
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
  assert.ok(markup.includes("vv-budget-progress--warning"))
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
