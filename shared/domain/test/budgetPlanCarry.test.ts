import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
  BUDGET_PLAN_CARRY_MUTATION,
  type BudgetPlanCarryRejection,
  budgetPlanCarryEligibility,
  nextBudgetMonth,
} from "../src/budgetPlanCarry.ts"
import type { FamilyMember } from "../src/family.ts"
import type { Budget } from "../src/readModel.ts"

type Accepted = {
  name: string
  activeProfile: FamilyMember
  budgetOwner: FamilyMember
  budgetMonth: string
  currentMonth: string
  selectedMonth?: string
  baseUpdatedAtMs: number
  expectedOwner: "victor" | "mason"
  expectedSourceFile: "budget" | "mason-budget"
  expectedFromMonth: string
  expectedToMonth: string
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/budget-plan-carry-cases.json", import.meta.url), "utf8"),
) as {
  contractVersion: number
  mutation: string
  accepted: Accepted[]
  rejected: Array<{
    name: string
    replace?: Partial<Pick<Accepted, "activeProfile" | "currentMonth" | "selectedMonth" | "baseUpdatedAtMs">>
    budgetOwner?: FamilyMember
    budgetMonth?: string
    reason: BudgetPlanCarryRejection
  }>
}

const budget = (owner: FamilyMember, month: string, updatedAtMs = 1787654321000): Budget => ({
  updatedAtMs,
  month,
  coinbaseOneBalance: 0n,
  categories: [{ name: "Groceries", icon: null, budget: 90000n, spent: 0n }],
  effectiveApr: null,
  strategyNote: null,
  income: null,
  mtdIncome: 0n,
  ytdIncome: 0n,
  monthlyHistory: [],
  owner,
})

test("the fixture names the device mutation this contract feeds", () => {
  assert.equal(fixture.contractVersion, 1)
  assert.equal(fixture.mutation, BUDGET_PLAN_CARRY_MUTATION)
})

test("copy forward is offered one month at a time for adult and Mason budgets", () => {
  for (const row of fixture.accepted) {
    const result = budgetPlanCarryEligibility({
      activeProfile: row.activeProfile,
      currentMonth: row.currentMonth,
      selectedMonth: row.selectedMonth,
      budget: budget(row.budgetOwner, row.budgetMonth),
      baseUpdatedAtMs: row.baseUpdatedAtMs,
    })
    assert.equal(result.eligible, true, row.name)
    if (!result.eligible) continue
    assert.deepEqual(
      result.intent,
      {
        owner: row.expectedOwner,
        sourceFile: row.expectedSourceFile,
        fromMonth: row.expectedFromMonth,
        toMonth: row.expectedToMonth,
        baseUpdatedAtMs: row.baseUpdatedAtMs,
      },
      row.name,
    )
  }
})

test("copy forward is withheld for bad months, identity, or revision", () => {
  const accepted = fixture.accepted[0]!
  for (const row of fixture.rejected) {
    const result = budgetPlanCarryEligibility({
      activeProfile: accepted.activeProfile,
      currentMonth: accepted.currentMonth,
      selectedMonth: accepted.selectedMonth,
      baseUpdatedAtMs: accepted.baseUpdatedAtMs,
      ...row.replace,
      budget: budget(row.budgetOwner ?? accepted.budgetOwner, row.budgetMonth ?? accepted.budgetMonth),
    })
    assert.deepEqual(result, { eligible: false, reason: row.reason }, row.name)
  }
})

test("nextBudgetMonth rolls the year", () => {
  assert.equal(nextBudgetMonth("2026-08"), "2026-09")
  assert.equal(nextBudgetMonth("2026-12"), "2027-01")
})
