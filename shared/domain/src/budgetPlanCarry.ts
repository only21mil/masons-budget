import { type FamilyMember, isAdult, ledgerOwner } from "./family.ts"
import type { Budget } from "./readModel.ts"

// Copy a budget plan forward to the next month.
//
// Convex stores exactly one plan per budget source and that plan names one
// month. "Copying forward" therefore asks the server to advance the document's
// month in place while keeping every category and amount. The server mutation
// is `tables:copyBudgetPlanForwardFromDevice`; this contract decides, on the
// device, whether the screen should offer the action and what it should send.
//
// The action is offered only when the plan lags the month the person is
// looking at (the trusted current month, or a later month they selected). It
// always moves the plan one month, never further, so a plan that is two
// months stale is copied in two visible steps rather than skipping a month.

export const BUDGET_PLAN_CARRY_MUTATION = "tables:copyBudgetPlanForwardFromDevice" as const

export type BudgetPlanCarryRejection =
  | "invalid-current-month"
  | "invalid-selected-month"
  | "unsupported-profile"
  | "owner-mismatch"
  | "invalid-plan-month"
  | "plan-is-current"
  | "invalid-revision"
  | "revision-mismatch"

export interface BudgetPlanCarryIntent {
  readonly owner: "victor" | "mason"
  readonly sourceFile: "budget" | "mason-budget"
  readonly fromMonth: string
  readonly toMonth: string
  readonly baseUpdatedAtMs: number
}

export type BudgetPlanCarryEligibility =
  | { readonly eligible: true; readonly intent: BudgetPlanCarryIntent }
  | { readonly eligible: false; readonly reason: BudgetPlanCarryRejection }

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/

/** The server and every client use the UTC calendar month for eligibility. */
export function budgetCurrentMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7)
}

function monthIndex(month: string): number {
  const [year, monthOfYear] = month.split("-").map(Number)
  return year! * 12 + (monthOfYear! - 1)
}

/** `2026-12` becomes `2027-01`. Input must already be canonical yyyy-MM. */
export function nextBudgetMonth(month: string): string {
  const index = monthIndex(month) + 1
  const year = Math.floor(index / 12)
  const monthOfYear = (index % 12) + 1
  return `${String(year).padStart(4, "0")}-${String(monthOfYear).padStart(2, "0")}`
}

function carryOwnerAndSource(
  activeProfile: FamilyMember,
): Pick<BudgetPlanCarryIntent, "owner" | "sourceFile"> | null {
  if (isAdult(activeProfile)) return { owner: "victor", sourceFile: "budget" }
  if (activeProfile === "mason") return { owner: "mason", sourceFile: "mason-budget" }
  return null
}

/** Decide whether to offer the copy-forward action. Performs no mutation. */
export function budgetPlanCarryEligibility(input: {
  readonly activeProfile: FamilyMember
  readonly currentMonth: string
  readonly selectedMonth?: string | null | undefined
  readonly budget: Budget
  readonly baseUpdatedAtMs: number
}): BudgetPlanCarryEligibility {
  if (!MONTH_KEY.test(input.currentMonth)) {
    return { eligible: false, reason: "invalid-current-month" }
  }
  const selectedMonth = input.selectedMonth ?? null
  if (selectedMonth !== null && !MONTH_KEY.test(selectedMonth)) {
    return { eligible: false, reason: "invalid-selected-month" }
  }
  const identity = carryOwnerAndSource(input.activeProfile)
  if (identity === null) {
    return { eligible: false, reason: "unsupported-profile" }
  }
  if (ledgerOwner(input.budget.owner) !== identity.owner) {
    return { eligible: false, reason: "owner-mismatch" }
  }
  if (!MONTH_KEY.test(input.budget.month)) {
    return { eligible: false, reason: "invalid-plan-month" }
  }
  const viewed = Math.max(
    monthIndex(input.currentMonth),
    selectedMonth === null ? Number.NEGATIVE_INFINITY : monthIndex(selectedMonth),
  )
  if (viewed <= monthIndex(input.budget.month)) {
    return { eligible: false, reason: "plan-is-current" }
  }
  if (!Number.isSafeInteger(input.baseUpdatedAtMs) || input.baseUpdatedAtMs <= 0) {
    return { eligible: false, reason: "invalid-revision" }
  }
  if (input.baseUpdatedAtMs !== input.budget.updatedAtMs) {
    return { eligible: false, reason: "revision-mismatch" }
  }
  return {
    eligible: true,
    intent: {
      ...identity,
      fromMonth: input.budget.month,
      toMonth: nextBudgetMonth(input.budget.month),
      baseUpdatedAtMs: input.baseUpdatedAtMs,
    },
  }
}
