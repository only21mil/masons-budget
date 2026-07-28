// A budget is for one month. Its spend must come from that month's transactions
// and no others — "July should only show July transactions, June should only
// show June" (Victor, 2026-07-26).
//
// iOS has always derived budget spend this way. These tests pin the same rule
// for the shared contract so the Linux and Android clients cannot drift from it.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import type { FamilyMember } from "../src/family.ts"
import { parseCents } from "../src/money.ts"
import {
  type Budget,
  type Transaction,
  budgetMonthsFor,
  budgetTransactionsFor,
  deriveBudgetSpend,
  isInMonth,
  monthOf,
  monthsPresent,
  transactionsInMonth,
} from "../src/readModel.ts"

function tx(date: string, category: string, amount: string, id = date + category): Transaction {
  return {
    id,
    date,
    merchant: "Sample",
    amount: parseCents(amount),
    category,
    card: null,
    note: null,
    owner: "victor",
  }
}

function budget(month: string, categories: Array<[string, string]>): Budget {
  return {
    month,
    coinbaseOneBalance: 0n,
    categories: categories.map(([name, planned]) => ({
      name,
      icon: null,
      budget: parseCents(planned),
      // Deliberately wrong. Nothing should read it — spend is derived.
      spent: parseCents("99999"),
    })),
    effectiveApr: null,
    strategyNote: null,
    income: null,
    mtdIncome: 0n,
    ytdIncome: 0n,
    monthlyHistory: [],
    owner: "victor",
  }
}

interface MonthFixtureTransaction {
  id: string
  date: string
  merchant: string
  amount: string
  category: string
  owner: FamilyMember
}

interface MonthProfileCase {
  viewer: FamilyMember
  budgetMonth: string | null
  expectedOwners: FamilyMember[]
  expectedMonths: string[]
  spendByMonth: Record<string, string>
}

interface MonthFixtures {
  transactions: MonthFixtureTransaction[]
  profiles: MonthProfileCase[]
}

const here = dirname(fileURLToPath(import.meta.url))
const monthFixtures = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "month-cases.json"), "utf8"),
) as MonthFixtures
const ownerTransactions: Transaction[] = monthFixtures.transactions.map((transaction) => ({
  ...transaction,
  amount: parseCents(transaction.amount),
  card: null,
  note: null,
}))

// ── monthOf ─────────────────────────────────────────────────────────────────

test("monthOf takes the yyyy-MM prefix without parsing a Date", () => {
  assert.equal(monthOf("2026-07-26"), "2026-07")
  assert.equal(monthOf("2026-01-01"), "2026-01")
  assert.equal(monthOf("2025-12-31"), "2025-12")
})

test("month boundaries do not shift with timezone", () => {
  // The whole reason this is string slicing rather than Date arithmetic: a
  // transaction dated the 1st must belong to that month for every reader.
  assert.equal(monthOf("2026-07-01"), "2026-07")
  assert.equal(monthOf("2026-07-31"), "2026-07")
  assert.equal(monthOf("2026-08-01"), "2026-08")
})

// ── Filtering ───────────────────────────────────────────────────────────────

const MIXED: Transaction[] = [
  tx("2026-07-26", "Groceries", "100"),
  tx("2026-07-02", "Groceries", "50"),
  tx("2026-06-30", "Groceries", "999"),
  tx("2026-06-01", "Dining", "40"),
  tx("2026-05-15", "Groceries", "777"),
  tx("2026-08-01", "Groceries", "888"),
]

test("transactionsInMonth keeps only that month", () => {
  const july = transactionsInMonth(MIXED, "2026-07")
  assert.deepEqual(july.map((t) => t.date), ["2026-07-26", "2026-07-02"])

  const june = transactionsInMonth(MIXED, "2026-06")
  assert.deepEqual(june.map((t) => t.date), ["2026-06-30", "2026-06-01"])
})

test("adjacent months do not bleed across the boundary", () => {
  // 2026-06-30 and 2026-08-01 are one day either side of July.
  const july = transactionsInMonth(MIXED, "2026-07")
  assert.ok(!july.some((t) => t.date === "2026-06-30"), "June 30 leaked into July")
  assert.ok(!july.some((t) => t.date === "2026-08-01"), "August 1 leaked into July")
})

test("a month with no transactions yields an empty list, not everything", () => {
  assert.deepEqual(transactionsInMonth(MIXED, "2026-03"), [])
  assert.deepEqual(transactionsInMonth([], "2026-07"), [])
})

test("isInMonth agrees with transactionsInMonth", () => {
  for (const transaction of MIXED) {
    assert.equal(isInMonth(transaction, "2026-07"), transactionsInMonth(MIXED, "2026-07").includes(transaction))
  }
})

test("monthsPresent lists distinct months newest first", () => {
  assert.deepEqual(monthsPresent(MIXED), ["2026-08", "2026-07", "2026-06", "2026-05"])
  assert.deepEqual(monthsPresent([]), [])
})

test("shared owner vectors define which transactions contribute to each budget", () => {
  for (const profile of monthFixtures.profiles) {
    const scoped = budgetTransactionsFor(profile.viewer, ownerTransactions)
    assert.deepEqual(
      [...new Set(scoped.map((transaction) => transaction.owner))],
      profile.expectedOwners,
      `${profile.viewer} budget owners`,
    )
  }
})

test("shared month vectors exclude child-only months from adult budget choices", () => {
  for (const profile of monthFixtures.profiles) {
    assert.deepEqual(
      budgetMonthsFor(profile.viewer, ownerTransactions, profile.budgetMonth),
      profile.expectedMonths,
      `${profile.viewer} budget months`,
    )
  }
})

test("shared month vectors preserve month derivation inside each owner scope", () => {
  for (const profile of monthFixtures.profiles) {
    const scoped = budgetTransactionsFor(profile.viewer, ownerTransactions)
    for (const [month, expected] of Object.entries(profile.spendByMonth)) {
      const result = deriveBudgetSpend(budget(month, [["Spending", "1000"]]), scoped)
      assert.equal(result.actual, parseCents(expected), `${profile.viewer} ${month} spend`)
    }
  }
})

// ── deriveBudgetSpend ───────────────────────────────────────────────────────

test("July's budget counts only July's transactions", () => {
  const result = deriveBudgetSpend(budget("2026-07", [["Groceries", "900"], ["Dining", "250"]]), MIXED)

  const groceries = result.categories.find((c) => c.name === "Groceries")!
  assert.equal(groceries.spent, parseCents("150"), "100 + 50 from July only")
  assert.equal(result.categories.find((c) => c.name === "Dining")!.spent, 0n, "the Dining row is June's")
  assert.equal(result.actual, parseCents("150"))
})

test("June's budget counts only June's transactions", () => {
  const result = deriveBudgetSpend(budget("2026-06", [["Groceries", "900"], ["Dining", "250"]]), MIXED)

  assert.equal(result.categories.find((c) => c.name === "Groceries")!.spent, parseCents("999"))
  assert.equal(result.categories.find((c) => c.name === "Dining")!.spent, parseCents("40"))
  assert.equal(result.actual, parseCents("1039"))
})

test("the same transactions give different answers for different months", () => {
  // The regression this whole file exists for.
  const july = deriveBudgetSpend(budget("2026-07", [["Groceries", "900"]]), MIXED)
  const june = deriveBudgetSpend(budget("2026-06", [["Groceries", "900"]]), MIXED)
  assert.notEqual(july.actual, june.actual)
  assert.equal(july.actual, parseCents("150"))
  assert.equal(june.actual, parseCents("999"))
})

test("the reported spent field is ignored entirely", () => {
  // The fixture sets every category's reported spent to 99999. If any of it
  // reached the output, transactions would not be the source of truth.
  const result = deriveBudgetSpend(budget("2026-07", [["Groceries", "900"]]), MIXED)
  assert.equal(result.categories[0]!.spent, parseCents("150"))
  assert.notEqual(result.actual, parseCents("99999"))
})

test("income is not spend", () => {
  const withIncome = [...MIXED, tx("2026-07-15", "Income", "5000")]
  const result = deriveBudgetSpend(budget("2026-07", [["Groceries", "900"], ["Income", "0"]]), withIncome)
  assert.equal(result.categories.find((c) => c.name === "Income")!.spent, 0n)
  assert.equal(result.actual, parseCents("150"))
})

test("child rows count as spend despite a positive amount", () => {
  // Production stores child purchases with the same positive sign as adults.
  const childRow: Transaction = { ...tx("2026-07-10", "Entertainment", "24"), owner: "mason" }
  const result = deriveBudgetSpend(budget("2026-07", [["Entertainment", "40"]]), [childRow])
  assert.equal(result.categories[0]!.spent, parseCents("24"))
})

test("spend with no matching category is surfaced, not dropped", () => {
  const result = deriveBudgetSpend(budget("2026-07", [["Dining", "250"]]), MIXED)
  assert.equal(result.actual, 0n, "no July Dining")
  assert.equal(result.uncategorised, parseCents("150"), "July Groceries has no budget row")
})

test("totals are internally consistent", () => {
  const result = deriveBudgetSpend(
    budget("2026-06", [["Groceries", "900"], ["Dining", "250"]]),
    MIXED,
  )
  assert.equal(result.planned, parseCents("1150"))
  assert.equal(result.actual, result.categories.reduce((total, c) => total + c.spent, 0n))
  assert.equal(result.remaining, result.planned - result.actual)
  assert.equal(result.overBudgetCount, result.categories.filter((c) => c.isOverBudget).length)
  assert.equal(result.overBudgetCount, 1, "June Groceries 999 exceeds 900")
})

test("an empty transaction set gives zero spend, not a crash", () => {
  const result = deriveBudgetSpend(budget("2026-07", [["Groceries", "900"]]), [])
  assert.equal(result.actual, 0n)
  assert.equal(result.remaining, parseCents("900"))
  assert.equal(result.overBudgetCount, 0)
  assert.equal(result.uncategorised, 0n)
})
