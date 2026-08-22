import type { Cents } from "@vogel-vault/domain/money"
import {
  type FamilyMember,
  isAdult,
  netWorthScopeFor,
  visibleTo,
} from "@vogel-vault/domain/family"
import {
  type Budget,
  type BudgetSpend,
  type CategorySpend,
  type Transaction,
  transactionsInMonth,
} from "@vogel-vault/domain/readModel"

import type { LinuxBillPay } from "./billPayBudgetEffect.ts"

/** Signed budget contribution: positive spend, negative credit, zero income. */
export function spendAmount(transaction: Transaction): Cents {
  if (transaction.category === "Income") return 0n
  return transaction.amount
}

/** Rendering magnitude; budget arithmetic must use spendAmount instead. */
export function displaySpendAmount(transaction: Transaction): Cents {
  const contribution = spendAmount(transaction)
  return contribution < 0n ? -contribution : contribution
}

export function hasOppositeSpendSign(transaction: Transaction): boolean {
  return spendAmount(transaction) < 0n
}

/** Apply the household-budget scope to Bitcoin bill pays. */
export function budgetBillPaysFor(
  viewer: FamilyMember,
  billPays: readonly LinuxBillPay[],
): LinuxBillPay[] {
  return isAdult(viewer)
    ? netWorthScopeFor(viewer, billPays)
    : visibleTo(viewer, billPays)
}

/** Derive the selected month's actuals from signed transactions and budgeted bill pays. */
export function deriveBudgetSpend(
  budget: Budget,
  transactions: readonly Transaction[],
  billPays: readonly LinuxBillPay[] = [],
): BudgetSpend {
  const spentByCategory = new Map<string, Cents>()
  for (const transaction of transactionsInMonth(transactions, budget.month)) {
    const contribution = spendAmount(transaction)
    if (contribution === 0n) continue
    spentByCategory.set(
      transaction.category,
      (spentByCategory.get(transaction.category) ?? 0n) + contribution,
    )
  }
  for (const billPay of billPays) {
    if (
      billPay.date.slice(0, 7) !== budget.month ||
      billPay.budgetEffect !== "budget_category"
    ) continue
    spentByCategory.set(
      billPay.category,
      (spentByCategory.get(billPay.category) ?? 0n) + billPay.amountUsd,
    )
  }

  const categories: CategorySpend[] = budget.categories.map((category) => {
    const spent = spentByCategory.get(category.name) ?? 0n
    spentByCategory.delete(category.name)
    return {
      name: category.name,
      icon: category.icon,
      budget: category.budget,
      spent,
      remaining: category.budget - spent,
      isOverBudget: spent > category.budget,
    }
  })

  let uncategorised = 0n
  for (const contribution of spentByCategory.values()) uncategorised += contribution

  const planned = categories.reduce((total, category) => total + category.budget, 0n)
  const actual = categories.reduce((total, category) => total + category.spent, 0n)
  return {
    month: budget.month,
    categories,
    planned,
    actual,
    remaining: planned - actual,
    overBudgetCount: categories.filter((category) => category.isOverBudget).length,
    uncategorised,
  }
}
