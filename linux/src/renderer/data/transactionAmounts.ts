import type { Cents } from "@vogel-vault/domain/money"
import type { FamilyMember } from "@vogel-vault/domain/family"
import {
  type Budget,
  type BudgetSpend,
  type CategorySpend,
  type MonthKey,
  type Transaction,
  budgetTransactionsFor,
  transactionsInMonth,
} from "@vogel-vault/domain/readModel"

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

/**
 * Rows behind one Budget category drilldown.
 *
 * Scope ownership before month/category filtering. Adults may oversee child
 * activity elsewhere, but a household budget drilldown follows the narrower
 * shared-budget rule; a child remains self-only.
 */
export function budgetCategoryTransactions(
  viewer: FamilyMember,
  transactions: readonly Transaction[],
  month: MonthKey,
  category: string,
): Transaction[] {
  return transactionsInMonth(
    budgetTransactionsFor(viewer, transactions),
    month,
  ).filter((transaction) => transaction.category === category)
}

/** Derive the selected month's actuals exclusively from signed transaction contributions. */
export function deriveBudgetSpend(
  budget: Budget,
  transactions: readonly Transaction[],
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
