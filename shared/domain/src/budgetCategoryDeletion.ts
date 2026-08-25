import { type FamilyMember, isAdult } from "./family.ts"
import type { Budget } from "./readModel.ts"

export const CANONICAL_ADULT_BUDGET_OWNER = "victor" as const
export const CANONICAL_ADULT_BUDGET_SOURCE = "budget" as const

export type BudgetCategoryDeletionRejection =
  | "invalid-current-month"
  | "unsupported-child-budget"
  | "month-mismatch"
  | "source-mismatch"
  | "missing-category"
  | "invalid-revision"
  | "revision-mismatch"

export interface BudgetCategoryDeletionIntent {
  readonly owner: typeof CANONICAL_ADULT_BUDGET_OWNER
  readonly sourceFile: typeof CANONICAL_ADULT_BUDGET_SOURCE
  readonly month: string
  readonly categoryName: string
  readonly baseUpdatedAtMs: number
}

export type BudgetCategoryDeletionEligibility =
  | { readonly eligible: true; readonly intent: BudgetCategoryDeletionIntent }
  | { readonly eligible: false; readonly reason: BudgetCategoryDeletionRejection }

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/

/** Build a deletion intent only. This contract does not perform or stage a mutation. */
export function budgetCategoryDeletionEligibility(input: {
  readonly activeProfile: FamilyMember
  readonly currentMonth: string
  readonly budget: Budget
  readonly sourceFile: string
  readonly categoryName: string
  readonly baseUpdatedAtMs: number
}): BudgetCategoryDeletionEligibility {
  if (!MONTH_KEY.test(input.currentMonth)) {
    return { eligible: false, reason: "invalid-current-month" }
  }
  if (!isAdult(input.activeProfile) || !isAdult(input.budget.owner)) {
    return { eligible: false, reason: "unsupported-child-budget" }
  }
  if (input.budget.month !== input.currentMonth) {
    return { eligible: false, reason: "month-mismatch" }
  }
  if (input.sourceFile !== CANONICAL_ADULT_BUDGET_SOURCE) {
    return { eligible: false, reason: "source-mismatch" }
  }
  if (!input.budget.categories.some((category) => category.name === input.categoryName)) {
    return { eligible: false, reason: "missing-category" }
  }
  if (!Number.isSafeInteger(input.baseUpdatedAtMs) || input.baseUpdatedAtMs < 0) {
    return { eligible: false, reason: "invalid-revision" }
  }
  if (input.baseUpdatedAtMs !== input.budget.updatedAtMs) {
    return { eligible: false, reason: "revision-mismatch" }
  }

  return {
    eligible: true,
    intent: {
      owner: CANONICAL_ADULT_BUDGET_OWNER,
      sourceFile: CANONICAL_ADULT_BUDGET_SOURCE,
      month: input.currentMonth,
      categoryName: input.categoryName,
      baseUpdatedAtMs: input.baseUpdatedAtMs,
    },
  }
}
