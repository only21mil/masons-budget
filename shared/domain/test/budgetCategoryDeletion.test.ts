import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
  type BudgetCategoryDeletionRejection,
  budgetCategoryDeletionEligibility,
} from "../src/budgetCategoryDeletion.ts"
import type { FamilyMember } from "../src/family.ts"
import type { Budget } from "../src/readModel.ts"

type Accepted = {
  name: string
  activeProfile: FamilyMember
  budgetOwner: FamilyMember
  currentMonth: string
  sourceFile: string
  categoryName: string
  baseUpdatedAtMs: number
  expectedOwner: "victor" | "mason"
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/budget-category-deletion-cases.json", import.meta.url), "utf8"),
) as {
  contractVersion: number
  accepted: Accepted[]
  rejected: Array<{
    name: string
    replace?: Partial<Omit<Accepted, "name" | "budgetOwner" | "expectedOwner">>
    budgetOwner?: FamilyMember
    budgetMonth?: string
    reason: BudgetCategoryDeletionRejection
  }>
}

const budget = (
  owner: FamilyMember = "victor",
  month = "2026-08",
  categories = ["Groceries", "School"],
): Budget => ({
  updatedAtMs: 1787654321000,
  month,
  coinbaseOneBalance: 0n,
  categories: categories.map((name) => ({ name, icon: null, budget: 10000n, spent: 0n })),
  effectiveApr: null,
  strategyNote: null,
  income: null,
  mtdIncome: 0n,
  ytdIncome: 0n,
  monthlyHistory: [],
  owner,
})

test("current-month category deletion supports canonical adult and Mason budgets", () => {
  assert.equal(fixture.contractVersion, 2)
  for (const row of fixture.accepted) {
    const result = budgetCategoryDeletionEligibility({
      activeProfile: row.activeProfile,
      currentMonth: row.currentMonth,
      budget: budget(row.budgetOwner),
      sourceFile: row.sourceFile,
      categoryName: row.categoryName,
      baseUpdatedAtMs: row.baseUpdatedAtMs,
    })
    assert.equal(result.eligible, true, row.name)
    if (!result.eligible) continue
    assert.equal(result.intent.owner, row.expectedOwner, row.name)
    assert.equal(
      result.intent.sourceFile,
      row.expectedOwner === "victor" ? "budget" : "mason-budget",
      row.name,
    )
  }
})

test("category deletion rejects invalid identity, month, name, and revision", () => {
  const accepted = fixture.accepted[0]!
  for (const row of fixture.rejected) {
    const result = budgetCategoryDeletionEligibility({
      activeProfile: accepted.activeProfile,
      currentMonth: accepted.currentMonth,
      sourceFile: accepted.sourceFile,
      categoryName: accepted.categoryName,
      baseUpdatedAtMs: accepted.baseUpdatedAtMs,
      ...row.replace,
      budget: budget(row.budgetOwner ?? accepted.budgetOwner, row.budgetMonth),
    })
    assert.deepEqual(result, { eligible: false, reason: row.reason }, row.name)
  }
})

test("folded collisions fail closed instead of deleting an arbitrary category", () => {
  const accepted = fixture.accepted[0]!
  const result = budgetCategoryDeletionEligibility({
    activeProfile: accepted.activeProfile,
    currentMonth: accepted.currentMonth,
    sourceFile: accepted.sourceFile,
    categoryName: accepted.categoryName,
    baseUpdatedAtMs: accepted.baseUpdatedAtMs,
    budget: budget("victor", "2026-08", ["Groceries", "groceries"]),
  })
  assert.deepEqual(result, { eligible: false, reason: "ambiguous-category" })
})

test("a unique folded match resolves to the stored canonical category name", () => {
  const accepted = fixture.accepted[0]!
  const result = budgetCategoryDeletionEligibility({
    activeProfile: accepted.activeProfile,
    currentMonth: accepted.currentMonth,
    sourceFile: accepted.sourceFile,
    categoryName: "groceries",
    baseUpdatedAtMs: accepted.baseUpdatedAtMs,
    budget: budget(),
  })
  assert.equal(result.eligible, true)
  if (result.eligible) assert.equal(result.intent.categoryName, "Groceries")
})
