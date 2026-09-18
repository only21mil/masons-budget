// Copy the budget plan forward, renderer side.
//
// The decision is the shared contract in @vogel-vault/domain/budgetPlanCarry;
// this file only turns an eligible intent into the one IPC request the paired
// device sends, and names months for the copy the action shows.

import {
  type BudgetPlanCarryEligibility,
  budgetPlanCarryEligibility,
} from "@vogel-vault/domain/budgetPlanCarry"
import type { FamilyMember } from "@vogel-vault/domain/family"
import type { Budget } from "@vogel-vault/domain/readModel"

import type { RendererMutationRequest } from "./mutations.ts"

export type BudgetPlanCarryRequest = Extract<
  RendererMutationRequest,
  { kind: "budgetPlan.copyForward" }
>

export interface BudgetPlanCarryInput {
  readonly activeProfile: FamilyMember
  /** Trusted current month, yyyy-MM. */
  readonly currentMonth: string
  /** The month the Budget page is scoped to, when the person picked one. */
  readonly selectedMonth?: string | null
  readonly budget: Budget
}

/** The shared eligibility decision for this page's budget document. */
function budgetPlanCarryOffer(input: BudgetPlanCarryInput): BudgetPlanCarryEligibility {
  return budgetPlanCarryEligibility({
    activeProfile: input.activeProfile,
    currentMonth: input.currentMonth,
    selectedMonth: input.selectedMonth ?? null,
    budget: input.budget,
    baseUpdatedAtMs: input.budget.updatedAtMs,
  })
}

/**
 * The exact `budgetPlan.copyForward` request for an eligible plan, or null.
 *
 * The intent's `sourceFile` is not sent: main derives it from the canonical
 * owner exactly as it does for category writes, so the renderer cannot name a
 * source the owner does not have.
 */
export function budgetPlanCarryRequest(
  input: BudgetPlanCarryInput & { readonly requestId: string },
): BudgetPlanCarryRequest | null {
  const offer = budgetPlanCarryOffer(input)
  if (!offer.eligible) return null
  return {
    kind: "budgetPlan.copyForward",
    requestId: input.requestId,
    actor: input.activeProfile,
    owner: offer.intent.owner,
    fromMonth: offer.intent.fromMonth,
    toMonth: offer.intent.toMonth,
    baseUpdatedAtMs: offer.intent.baseUpdatedAtMs,
  }
}

const FULL_MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const

/**
 * `2026-09` becomes `September`. A fixed table rather than a date formatter so
 * the label matches Android and the design packet; an unexpected key falls
 * through to itself.
 */
export function budgetMonthName(month: string): string {
  const index = Number(month.split("-")[1])
  return FULL_MONTH_NAMES[index - 1] ?? month
}
