import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
  type BudgetCategoryDeletionRejection,
  budgetCategoryDeletionEligibility,
} from "../src/budgetCategoryDeletion.ts"
import type { FamilyMember } from "../src/family.ts"
import type { Budget } from "../src/readModel.ts"

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/budget-category-deletion-cases.json", import.meta.url), "utf8"),
) as {
  contractVersion: number
  accepted: {
    activeProfile: FamilyMember
    currentMonth: string
    sourceFile: string
    categoryName: string
    baseUpdatedAtMs: number
  }
  rejected: Array<{
    name: string
    replace?: Partial<typeof fixture.accepted>
    budgetOwner?: FamilyMember
    reason: BudgetCategoryDeletionRejection
  }>
}

const budget = (owner: FamilyMember = "victor"): Budget => ({
  updatedAtMs: 1787654321000,
  month: "2026-08",
  coinbaseOneBalance: 0n,
  categories: [
    { name: "Groceries", icon: null, budget: 10000n, spent: 0n },
    { name: "groceries", icon: null, budget: 500n, spent: 0n },
  ],
  effectiveApr: null,
  strategyNote: null,
  income: null,
  mtdIncome: 0n,
  ytdIncome: 0n,
  monthlyHistory: [],
  owner,
})

test("current-month category deletion returns canonical exact-revision intent only", () => {
  assert.equal(fixture.contractVersion, 1)
  assert.deepEqual(
    budgetCategoryDeletionEligibility({ ...fixture.accepted, budget: budget() }),
    {
      eligible: true,
      intent: {
        owner: "victor",
        sourceFile: "budget",
        month: "2026-08",
        categoryName: "Groceries",
        baseUpdatedAtMs: 1787654321000,
      },
    },
  )
})

test("both adult profiles can delete from the shared current-month budget", () => {
  for (const [activeProfile, budgetOwner] of [
    ["victor", "rachel"],
    ["rachel", "victor"],
  ] as const) {
    const result = budgetCategoryDeletionEligibility({
      ...fixture.accepted,
      activeProfile,
      budget: budget(budgetOwner),
    })
    assert.equal(result.eligible, true)
    if (result.eligible) assert.equal(result.intent.owner, "victor")
  }
})

test("category deletion rejects month, source, category, revision, and child mismatches", () => {
  for (const row of fixture.rejected) {
    const result = budgetCategoryDeletionEligibility({
      ...fixture.accepted,
      ...row.replace,
      budget: budget(row.budgetOwner),
    })
    assert.deepEqual(result, { eligible: false, reason: row.reason }, row.name)
  }
})

test("category matching is exact, including case", () => {
  const result = budgetCategoryDeletionEligibility({
    ...fixture.accepted,
    categoryName: "groceries",
    budget: budget(),
  })
  assert.equal(result.eligible, true)
  if (result.eligible) assert.equal(result.intent.categoryName, "groceries")
})
