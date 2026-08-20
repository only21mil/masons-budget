// The per-bill-pay budget choice (bill-pay contract amendment, 2026-08-20).
//
// A River bill pay either comes out of a budget category or is a credit-card
// payment that never touches the budget. One closed wire field on the bill-pay
// row carries the choice — there is still exactly one row and one write.
//
// Rows written before the amendment carry no field at all. They decode as
// credit_card_payment, which is precisely how they already behaved: budget
// spend was computed from transactions alone, so a bill pay never came out of
// a budget no matter what category it named.

import type { BTCBillPay } from "@vogel-vault/domain/readModel"

export const BILL_PAY_BUDGET_EFFECTS = [
  "budget_category",
  "credit_card_payment",
] as const

export type BillPayBudgetEffect = (typeof BILL_PAY_BUDGET_EFFECTS)[number]

/** The one category a credit-card payment is allowed to carry. */
export const CREDIT_CARD_PAYMENT_CATEGORY = "Credit Card Payment"

export const BILL_PAY_BUDGET_EFFECT_LABELS: Readonly<Record<BillPayBudgetEffect, string>> = {
  budget_category: "Budget category",
  credit_card_payment: "Credit card payment",
}

/**
 * The domain read-model row plus the amendment field.
 *
 * `BTCBillPay` lives in shared/domain, which the contract branch owns. The
 * Linux client carries the decoded choice alongside it until that branch
 * absorbs the field, so nothing here edits the shared read model.
 */
export interface LinuxBillPay extends BTCBillPay {
  readonly budgetEffect: BillPayBudgetEffect
}

export function isBillPayBudgetEffect(value: unknown): value is BillPayBudgetEffect {
  return BILL_PAY_BUDGET_EFFECTS.includes(value as BillPayBudgetEffect)
}

/** An absent or unreadable field is a pre-amendment row: it never hit a budget. */
export function decodeBillPayBudgetEffect(value: unknown): BillPayBudgetEffect {
  return isBillPayBudgetEffect(value) ? value : "credit_card_payment"
}

export interface BillPayBudgetTreatment {
  readonly effect: BillPayBudgetEffect
  /** Exact category the row must persist for this choice. */
  readonly category: string
  /** Whether the form lets the user name the category. */
  readonly categorySelectable: boolean
  /**
   * Whether shared budget math counts this row's positive amountUsdCents
   * against `category` for the bill-pay month.
   */
  readonly countsTowardBudget: boolean
}

/**
 * The single seam between bill-pay form state and the budget contract.
 *
 * Both the submitted payload and the form's own category field read their
 * category from here, so the two can never disagree about what a credit-card
 * payment stores.
 */
export function billPayBudgetTreatmentFor(form: {
  readonly budgetEffect: BillPayBudgetEffect
  readonly category: string
}): BillPayBudgetTreatment {
  if (form.budgetEffect === "credit_card_payment") {
    return {
      effect: "credit_card_payment",
      category: CREDIT_CARD_PAYMENT_CATEGORY,
      categorySelectable: false,
      countsTowardBudget: false,
    }
  }
  return {
    effect: "budget_category",
    category: form.category.trim(),
    categorySelectable: true,
    countsTowardBudget: true,
  }
}
