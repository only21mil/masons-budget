import assert from "node:assert/strict"
import { test } from "vitest"

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import type { SliceState } from "@vogel-vault/domain/readModel"

import { AppStateProvider, useAppState } from "../src/renderer/app/AppState.tsx"
import {
  type FixtureEnvelope,
  buildSanitizedFixtureEnvelope,
} from "../src/renderer/data/fixtures.ts"
import { resolvePage } from "../src/renderer/pages/index.ts"

function Harness() {
  const { activeProfile } = useAppState()
  const page = resolvePage("budget", activeProfile)
  return page ? createElement(page.Component) : null
}

function renderBudget(data: FixtureEnvelope): string {
  return renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: "victor",
      initialRoute: "budget",
      initialData: data,
      children: createElement(Harness),
    }),
  )
}

function liveBudgetEnvelope(transactions: SliceState<FixtureEnvelope["transactions"]["value"]>) {
  const base = buildSanitizedFixtureEnvelope("victor")
  return {
    ...base,
    transactions,
    budget: { ...base.budget, status: "live" as const },
  }
}

test("budget actuals and category actuals are unavailable when transactions fail", () => {
  const base = buildSanitizedFixtureEnvelope("victor")
  const markup = renderBudget(liveBudgetEnvelope({
    ...base.transactions,
    status: "error",
    value: [],
    updatedAt: null,
    error: "transaction read failed",
  }))

  assert.ok(markup.includes("$2,670.00"), "planned budget disappeared with transaction actuals")
  assert.ok(!markup.includes("$0.00"), "a failed transaction read rendered a confident zero")
  assert.ok(
    (markup.match(/Unavailable/g) ?? []).length >= 3,
    "actual, remaining, and over-budget figures were not all unavailable",
  )
  assert.ok(markup.includes("Could not load"), "category actuals did not show unavailable")
  assert.ok(!markup.includes("Groceries"), "category rows rendered actuals from failed transactions")
})

test("a live transaction slice with no spending renders a genuine zero", () => {
  const base = buildSanitizedFixtureEnvelope("victor")
  const markup = renderBudget(liveBudgetEnvelope({
    ...base.transactions,
    status: "live",
    value: [],
    updatedAt: 1,
  }))

  assert.ok(markup.includes("$0.00"), "a genuine zero-spend month was suppressed")
  assert.ok(markup.includes("Groceries"), "zero-spend category rows were suppressed")
  assert.ok(!markup.includes("Could not load"), "a usable empty ledger was called unavailable")
})
