import { type FamilyMember, isAdult, ledgerOwner } from "./family.ts"
import type { Budget } from "./readModel.ts"

export const CANONICAL_ADULT_BUDGET_OWNER = "victor" as const
export const CANONICAL_ADULT_BUDGET_SOURCE = "budget" as const
export const CANONICAL_MASON_BUDGET_OWNER = "mason" as const
export const CANONICAL_MASON_BUDGET_SOURCE = "mason-budget" as const

export type BudgetCategoryDeletionRejection =
  | "invalid-current-month"
  | "unsupported-profile"
  | "owner-mismatch"
  | "month-mismatch"
  | "source-mismatch"
  | "invalid-category"
  | "missing-category"
  | "ambiguous-category"
  | "invalid-revision"
  | "revision-mismatch"

export interface BudgetCategoryDeletionIntent {
  readonly owner: typeof CANONICAL_ADULT_BUDGET_OWNER | typeof CANONICAL_MASON_BUDGET_OWNER
  readonly sourceFile: typeof CANONICAL_ADULT_BUDGET_SOURCE | typeof CANONICAL_MASON_BUDGET_SOURCE
  readonly month: string
  readonly categoryName: string
  readonly baseUpdatedAtMs: number
}

export type BudgetCategoryDeletionEligibility =
  | { readonly eligible: true; readonly intent: BudgetCategoryDeletionIntent }
  | { readonly eligible: false; readonly reason: BudgetCategoryDeletionRejection }

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/

function deletionOwnerAndSource(activeProfile: FamilyMember): Pick<
  BudgetCategoryDeletionIntent,
  "owner" | "sourceFile"
> | null {
  if (isAdult(activeProfile)) {
    return {
      owner: CANONICAL_ADULT_BUDGET_OWNER,
      sourceFile: CANONICAL_ADULT_BUDGET_SOURCE,
    }
  }
  if (activeProfile === CANONICAL_MASON_BUDGET_OWNER) {
    return {
      owner: CANONICAL_MASON_BUDGET_OWNER,
      sourceFile: CANONICAL_MASON_BUDGET_SOURCE,
    }
  }
  return null
}

function foldedCategoryName(name: string): string {
  return name.trim().toLocaleLowerCase("en-US")
}

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
  const identity = deletionOwnerAndSource(input.activeProfile)
  if (identity === null) {
    return { eligible: false, reason: "unsupported-profile" }
  }
  if (ledgerOwner(input.budget.owner) !== identity.owner) {
    return { eligible: false, reason: "owner-mismatch" }
  }
  if (input.budget.month !== input.currentMonth) {
    return { eligible: false, reason: "month-mismatch" }
  }
  if (input.sourceFile !== identity.sourceFile) {
    return { eligible: false, reason: "source-mismatch" }
  }
  const categoryName = input.categoryName.trim()
  if (categoryName === "" || categoryName !== input.categoryName) {
    return { eligible: false, reason: "invalid-category" }
  }
  const foldedName = foldedCategoryName(categoryName)
  const foldedMatches = input.budget.categories.filter(
    (category) => foldedCategoryName(category.name) === foldedName,
  )
  if (foldedMatches.length > 1) {
    return { eligible: false, reason: "ambiguous-category" }
  }
  if (foldedMatches.length !== 1) {
    return { eligible: false, reason: "missing-category" }
  }
  const canonicalCategoryName = foldedMatches[0]!.name
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
      month: input.currentMonth,
      categoryName: canonicalCategoryName,
      baseUpdatedAtMs: input.baseUpdatedAtMs,
    },
  }
}
